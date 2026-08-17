export type JumpResult = { opened: boolean; error?: string };

export type Executor = (
  command: string,
  args: string[],
  timeoutMs?: number,
) => Promise<{ ok: boolean; error?: string; stdout?: string }>;

const JUMP_TIMEOUT_MS = 5000;

export const defaultExecutor: Executor = async (command, args, timeoutMs = JUMP_TIMEOUT_MS) => {
  try {
    const process = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    const stdoutPromise = new Response(process.stdout).text();
    const stderrPromise = new Response(process.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const outcome = await Promise.race([process.exited, timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") {
      process.kill(9);
      return { ok: false, error: "command timed out" };
    }
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (outcome !== 0) return { ok: false, error: shortCommandError(stderr) };
    return { ok: true, stdout };
  } catch {
    return { ok: false, error: "command unavailable" };
  }
};

function shortCommandError(stderr: string): string {
  const firstLine = stderr.trim().split("\n", 1)[0];
  return firstLine ? firstLine.slice(0, 160) : "command failed";
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rowsFrom(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  const envelope = object(value);
  if (!envelope) return [];
  if (Array.isArray(envelope[key])) return envelope[key];
  return envelope.result ? rowsFrom(envelope.result, key) : [];
}

function stringField(value: unknown, fields: string[]): string | null {
  const row = object(value);
  if (!row) return null;
  for (const field of fields) {
    if (typeof row[field] === "string" && row[field]) return row[field] as string;
  }
  return null;
}

function failed(result: { ok: boolean; error?: string }): JumpResult {
  return { opened: false, error: result.error ?? "command failed" };
}

/** Pure dispatcher for platform-specific terminal focus. Never throws. */
export async function performJump(
  input: { platform: string | null; binding: string | null; host: string | null },
  exec: Executor = defaultExecutor,
): Promise<JumpResult> {
  try {
    if (!input.binding) return { opened: false };

    if (input.platform === "herdr") {
      const result = await exec("herdr", ["agent", "focus", input.binding], JUMP_TIMEOUT_MS);
      return result.ok ? { opened: true } : failed(result);
    }

    if (input.platform === "cmux") {
      const result = await exec("open", [`cmux://workspace/${input.binding}`], JUMP_TIMEOUT_MS);
      return result.ok ? { opened: true } : failed(result);
    }

    if (input.platform === "orca") {
      const worktrees = await exec("orca", ["worktree", "ps", "--json"], JUMP_TIMEOUT_MS);
      if (!worktrees.ok) return failed(worktrees);
      let path: string | null = null;
      try {
        const row = rowsFrom(JSON.parse(worktrees.stdout ?? ""), "worktrees")
          .find((candidate) => stringField(candidate, ["worktreeInstanceId"]) === input.binding);
        path = stringField(row, ["path"]);
      } catch {
        path = null;
      }
      if (!path) return { opened: false, error: "orca worktree not found" };

      const terminals = await exec("orca", ["terminal", "list", "--worktree", `path:${path}`, "--json"], JUMP_TIMEOUT_MS);
      if (!terminals.ok) return failed(terminals);
      let handle: string | null = null;
      try {
        const first = rowsFrom(JSON.parse(terminals.stdout ?? ""), "terminals")[0];
        handle = stringField(first, ["handle", "id", "terminalId"]);
      } catch {
        handle = null;
      }
      if (!handle) return { opened: false, error: "orca terminal not found" };

      const switched = await exec("orca", ["terminal", "switch", "--terminal", handle], JUMP_TIMEOUT_MS);
      return switched.ok ? { opened: true } : failed(switched);
    }

    return { opened: false };
  } catch {
    return { opened: false, error: "jump failed" };
  }
}
