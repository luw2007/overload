import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";

/** App IDs are case-sensitive. Do not normalize distinct apps onto one another. */
export function canonicalAppId(appId: string): string {
  const id = appId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(id)) {
    throw new Error("Invalid Feishu app_id");
  }
  return id;
}

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`App lock directory must be owned by this user and private (0700): ${path}`);
  }
}

/** Never create the OS runtime ancestor or accept environment-selected roots. */
async function runtimeDirectory(uid: number): Promise<string> {
  const runtime = `/run/user/${uid}`;
  const preflight = `App lock runtime ancestor must be canonical, nonsymlink, correctly owned and not group/world writable: ${runtime}. Provision it through systemd-logind (enable user linger for unattended services) and preflight it before starting the daemon; no /tmp fallback is permitted.`;
  if (process.platform !== "linux") {
    throw new Error("App locking requires a Linux systemd-logind runtime directory and flock");
  }
  try {
    for (const [path, owner] of [["/run", 0], ["/run/user", 0], [runtime, uid]] as const) {
      const stat = await lstat(path);
      // A real mount at this literal path is allowed; a symlink/alias is not.
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== owner
        || (stat.mode & 0o022) !== 0 || await realpath(path) !== path) {
        throw new Error(`Unsafe ancestor: ${path}`);
      }
    }
  } catch (error) {
    throw new Error(`${preflight} (${String(error)})`);
  }
  return runtime;
}

/**
 * Fixed OS per-UID location, independent of HOME, XDG, instance and deployment paths.
 * Requires the OS flock binary. The child holds the lock only while our stdin pipe
 * is open: explicit release or parent process death closes it. Never unlink lock
 * files, since replacing their inode would permit two holders.
 */
export async function acquireAppLock(appId: string): Promise<{ release(): Promise<void> }> {
  const id = canonicalAppId(appId);
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("App locking requires an OS user ID");
  }
  const runtime = await runtimeDirectory(uid);
  const directory = join(runtime, "overload-channel-locks");
  await privateDirectory(directory);
  const file = await open(join(directory, `${id}.lock`), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw new Error("App lock file must be a private, single-link regular file owned by this user");
    }
    const child = spawn("sh", ["-c", "flock --exclusive --nonblock --conflict-exit-code 73 3 || exit $?; printf 'locked\\n'; cat >/dev/null"], {
      stdio: ["pipe", "pipe", "pipe", file.fd],
    });
    // A failed acquisition may close stdin before cleanup ends the pipe.
    child.stdin!.on("error", () => {});
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    let holding = false;
    let releasing = false;
    const holderLost = () => {
      if (holding && !releasing) {
        console.error(`Feishu app ${id} OS lock holder was lost; terminating to prevent an unlocked daemon`);
        process.exit(1);
      }
    };
    child.on("exit", holderLost);
    child.on("error", holderLost);
    const completion = Promise.withResolvers<number | null>();
    child.once("error", completion.reject);
    child.once("exit", completion.resolve);
    const exited = completion.promise;
    void exited.catch(() => {});
    try {
      const handshake = Promise.withResolvers<void>();
      child.stdout!.once("data", chunk => {
        if (String(chunk) === "locked\n") { holding = true; handshake.resolve(); }
        else handshake.reject(new Error("Unexpected app lock handshake"));
      });
      child.once("error", handshake.reject);
      child.once("exit", code => handshake.reject(new Error(code === 73
        ? `Feishu app ${id} is already running`
        : `Unable to acquire Feishu app lock (${code}): ${stderr}`)));
      await handshake.promise;
    } catch (error) {
      child.stdin!.end();
      await exited.catch(() => {});
      throw error;
    }
    let release: Promise<void> | undefined;
    return { release: () => release ??= (async () => {
      releasing = true;
      child.stdin!.end();
      await exited;
    })() };
  } finally {
    // Only the flock child retains the descriptor once acquisition completes.
    await file.close();
  }
}
