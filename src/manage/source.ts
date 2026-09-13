import { readFile as fsReadFile, readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type SourceHost = { host: string; kind: "local" } | { host: string; kind: "ssh"; remote: string; ssh_cmd?: string };
export type SourceFile = { path: string; mtimeMs: number; size: number };
export interface SourceFs {
  readonly host: SourceHost;
  listFiles(dir: string, opts: { sinceMs: number; suffix: string }): Promise<SourceFile[]>;
  readRange(path: string, fromByte: number, maxBytes: number): Promise<{ bytes: Uint8Array; nextByte: number; eof: boolean; generation: string } | null>;
  readFile(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean; sha256: string } | null>;
  exec(cwd: string, argv: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
}

function validRange(fromByte: number, maxBytes: number) {
  if (!Number.isSafeInteger(fromByte) || fromByte < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("byte offsets must be non-negative safe integers");
}
function unavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR";
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function defaultHost(): string {
  try { return readFileSync(join(homedir(), ".overload", "host"), "utf8").trim() || "local"; }
  catch (error) { if (unavailable(error)) return "local"; throw error; }
}
async function spawnBytes(argv: string[], cwd: string | undefined, timeoutMs: number) {
  if (!argv.length || argv.some((value) => typeof value !== "string")) throw new TypeError("argv must contain a command");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError("timeoutMs must be non-negative");
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = timeoutMs ? setTimeout(() => proc.kill(), timeoutMs) : null;
  try {
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
    return { code, stdout: new Uint8Array(stdout), stderr };
  } finally { if (timer) clearTimeout(timer); }
}
async function spawn(argv: string[], cwd: string | undefined, timeoutMs: number) {
  const result = await spawnBytes(argv, cwd, timeoutMs);
  return { ...result, stdout: new TextDecoder().decode(result.stdout) };
}

export function localSourceFs(host?: string): SourceFs {
  const sourceHost: SourceHost = { host: host ?? defaultHost(), kind: "local" };
  return {
    host: sourceHost,
    async listFiles(dir, opts) {
      if (!Number.isFinite(opts.sinceMs) || typeof opts.suffix !== "string") throw new TypeError("invalid list options");
      const found: SourceFile[] = [];
      async function walk(current: string): Promise<void> {
        let entries;
        try { entries = await readdir(current, { withFileTypes: true }); }
        catch (error) { if (unavailable(error)) return; throw error; }
        for (const entry of entries) {
          const path = join(current, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() && path.endsWith(opts.suffix)) {
            try { const info = await stat(path); if (info.mtimeMs >= opts.sinceMs) found.push({ path, mtimeMs: info.mtimeMs, size: info.size }); }
            catch (error) { if (!unavailable(error)) throw error; }
          }
        }
      }
      await walk(dir);
      return found.sort((a, b) => a.path.localeCompare(b.path));
    },
    async readRange(path, fromByte, maxBytes) {
      validRange(fromByte, maxBytes);
      try {
        const [all, info] = await Promise.all([fsReadFile(path), stat(path)]);
        const bytes = all.subarray(fromByte, fromByte + maxBytes);
        return { bytes, nextByte: fromByte + bytes.length, eof: fromByte + bytes.length >= all.length, generation: `${info.ino}:${info.size}` };
      } catch (error) { if (unavailable(error)) return null; throw error; }
    },
    async readFile(path, maxBytes) {
      validRange(0, maxBytes);
      try { const all = await fsReadFile(path); const bytes = all.subarray(0, maxBytes); return { bytes, truncated: all.length > maxBytes, sha256: digest(bytes) }; }
      catch (error) { if (unavailable(error)) return null; throw error; }
    },
    exec(cwd, argv, timeoutMs) { return spawn(argv, cwd, timeoutMs); },
  };
}

export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
export function buildSshArgv(host: SourceHost & { kind: "ssh" }, command: string): string[] {
  return [host.ssh_cmd ?? "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", host.remote, command];
}
function remoteUnavailable(stderr: string): boolean { return /no such file|not found|permission denied|operation not permitted|could not resolve hostname|connection timed out/i.test(stderr); }
export function sshSourceFs(host: SourceHost & { kind: "ssh" }): SourceFs {
  async function remote(command: string, timeoutMs = 30_000) { return spawn(buildSshArgv(host, command), undefined, timeoutMs); }
  async function remoteBytes(command: string, timeoutMs = 30_000) { return spawnBytes(buildSshArgv(host, command), undefined, timeoutMs); }
  let platform: Promise<"bsd" | "gnu"> | undefined;
  function flavor() {
    return platform ??= remote("uname -s").then((result) => {
      if (result.code !== 0) throw new Error(result.stderr);
      return result.stdout.trim() === "Darwin" ? "bsd" : "gnu";
    });
  }
  function touchTime(ms: number): string {
    const date = new Date(ms);
    const part = (value: number) => String(value).padStart(2, "0");
    return `${date.getUTCFullYear()}${part(date.getUTCMonth() + 1)}${part(date.getUTCDate())}${part(date.getUTCHours())}${part(date.getUTCMinutes())}.${part(date.getUTCSeconds())}`;
  }
  async function statFormat(kind: "bsd" | "gnu", fields: "list" | "generation") {
    if (fields === "list") return kind === "bsd" ? "stat -f '%m %z %N'" : "stat -c '%Y %s %n'";
    return kind === "bsd" ? "stat -f '%i %z'" : "stat -c '%i %s'";
  }
  return {
    host,
    async listFiles(dir, opts) {
      if (!Number.isFinite(opts.sinceMs) || typeof opts.suffix !== "string") throw new TypeError("invalid list options");
      let kind: "bsd" | "gnu";
      try { kind = await flavor(); } catch (error) { if (remoteUnavailable(String(error))) return []; throw error; }
      const ref = `${"${TMPDIR:-/tmp}"}/overload-source-$$-${Math.random().toString(36).slice(2)}`;
      const find = `find ${shellQuote(dir)} -type f -name ${shellQuote(`*${opts.suffix}`)}`;
      const stat = await statFormat(kind, "list");
      const filtered = `ref=${ref}; if TZ=UTC touch -t ${shellQuote(touchTime(opts.sinceMs))} "$ref"; then ${find} -newer "$ref" -print0; rm -f "$ref"; else ${find} -print0; fi`;
      const statArgs = shellQuote(`test "$#" -eq 0 || ${stat} -- "$@"`);
      const result = await remote(`${filtered} | xargs -0 sh -c ${statArgs} sh`);
      if (result.code !== 0) { if (remoteUnavailable(result.stderr)) return []; throw new Error(`remote find failed: ${result.stderr.trim()}`); }
      return result.stdout.split("\n").filter(Boolean).map((line) => {
        const match = /^(\d+) (\d+) (.*)$/.exec(line);
        if (!match) throw new Error(`invalid remote stat output: ${line}`);
        return { path: match[3]!, mtimeMs: Number(match[1]) * 1000, size: Number(match[2]) };
      }).filter((file) => file.mtimeMs >= opts.sinceMs).sort((a, b) => a.path.localeCompare(b.path));
    },
    async readRange(path, fromByte, maxBytes) {
      validRange(fromByte, maxBytes);
      let kind: "bsd" | "gnu";
      try { kind = await flavor(); } catch (error) { if (remoteUnavailable(String(error))) return null; throw error; }
      const stat = await statFormat(kind, "generation");
      const result = await remoteBytes(`{ ${stat} -- ${shellQuote(path)} || exit; tail -c +${fromByte + 1} -- ${shellQuote(path)} | head -c ${maxBytes}; }`);
      if (result.code !== 0) { if (remoteUnavailable(result.stderr)) return null; throw new Error(`remote read failed: ${result.stderr.trim()}`); }
      const newline = result.stdout.indexOf(10);
      if (newline < 0) throw new Error("remote stat returned no metadata");
      const [inode, rawSize] = new TextDecoder().decode(result.stdout.subarray(0, newline)).trim().split(" ");
      const bytes = result.stdout.subarray(newline + 1), size = Number(rawSize);
      return { bytes, nextByte: fromByte + bytes.length, eof: fromByte + bytes.length >= size, generation: `${inode}:${size}` };
    },
    async readFile(path, maxBytes) {
      validRange(0, maxBytes);
      const result = await remoteBytes(`cat -- ${shellQuote(path)}`);
      if (result.code !== 0) { if (remoteUnavailable(result.stderr)) return null; throw new Error(`remote read failed: ${result.stderr.trim()}`); }
      const bytes = result.stdout.subarray(0, maxBytes);
      return { bytes, truncated: result.stdout.length > maxBytes, sha256: digest(bytes) };
    },
    async exec(cwd, argv, timeoutMs) {
      const command = `cd -- ${shellQuote(cwd)} && exec ${argv.map(shellQuote).join(" ")}`;
      return remote(command, timeoutMs);
    },
  };
}
