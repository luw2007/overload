/**
 * test/harness/overload-probe.ts — V-2' matrix probe extension.
 *
 * PURPOSE (N3-TASK #5): the V-2' behavior matrix validates cross-runtime SDK
 * EVENT API compatibility (which event names fire, on pi/omp/prime). Because
 * N1's real overload.ts extension does not exist on this branch, this probe is
 * the deterministic instrument the matrix runner loads instead. It:
 *
 *   1. Registers handlers for the full V-2' event-name set from the frozen
 *      contract mapping (session/agent/turn/tool lifecycle).
 *   2. On EACH fired event, appends the event name to a probe log file
 *      ($OVERLOAD_PROBE_LOG) — one name per line.
 *   3. On the first session_start, writes ONE well-formed EventEnvelope
 *      (matching src/shared/types.ts exactly) to a spool active file under
 *      $OVERLOAD_SPOOL_ROOT — so the matrix can assert "spool file appears
 *      with a valid envelope".
 *
 * It uses only the runtime-agnostic extension API (`export default (api) =>`).
 * Env vars drive it so the matrix runner can point it at a temp dir (never real
 * ~/.overload). Zero npm deps; only node: builtins.
 *
 * Capability-probe pattern (§3): we try to register each event and degrade
 * silently if a runtime lacks it — the probe records only what actually fires.
 */
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// V-2' event-name set to instrument (from §2.4a lifecycle mapping +
// types.ts EventKind → SDK event). These are the names the matrix records.
const PROBE_EVENTS = [
  "session_start",
  "session_shutdown",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "tool_call",
  "tool_execution_end",
] as const;

function env(k: string, dflt: string): string {
  return (process.env[k] ?? dflt).trim();
}

function ensureProbeLog(): string {
  const log = env("OVERLOAD_PROBE_LOG", "");
  if (!log) throw new Error("OVERLOAD_PROBE_LOG not set");
  if (!existsSync(log)) writeFileSync(log, "");
  return log;
}

function recordEvent(name: string): void {
  try {
    const log = ensureProbeLog();
    appendFileSync(log, name + "\n");
  } catch {
    // never throw from a handler (§3: zero throw)
  }
}

function writeEnvelope(seq: number, kind: string): void {
  try {
    const root = env("OVERLOAD_SPOOL_ROOT", "");
    if (!root) return;
    const host = env("OVERLOAD_HOST", "local");
    const runtime = env("OVERLOAD_RUNTIME", "pi");
    const session = env("OVERLOAD_SESSION", "00000000-0000-4000-8000-000000000000");
    const emitter = env("OVERLOAD_EMITTER", `${runtime}-0-probe00000`);
    const dir = join(root, "spool", host, emitter);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `active-${emitter}-1.ndjson`);
    const env_obj = {
      v: 1,
      at: Date.now(),
      host,
      runtime,
      session,
      emitter_id: emitter,
      writer_id: emitter,
      seq,
      kind,
      dropped_total: 0,
      write_error_total: 0,
    };
    appendFileSync(file, JSON.stringify(env_obj) + "\n");
  } catch {
    // never throw
  }
}

// Module-level state to keep seq monotonic per probe process.
let probeSeq = 0;
let wroteStart = false;

export default function overloadProbe(api: any): void {
  // session_start → session_started envelope (and a probe record)
  const onSessionStart = () => {
    recordEvent("session_start");
    if (!wroteStart) {
      probeSeq += 1;
      writeEnvelope(probeSeq, "session_started");
      wroteStart = true;
    }
  };
  const onShutdown = () => {
    recordEvent("session_shutdown");
    probeSeq += 1;
    writeEnvelope(probeSeq, "session_ended");
  };
  const onAgentStart = () => {
    recordEvent("agent_start");
    probeSeq += 1;
    writeEnvelope(probeSeq, "working");
  };
  const onAgentEnd = () => {
    recordEvent("agent_end");
    probeSeq += 1;
    writeEnvelope(probeSeq, "settled");
  };
  const onAgentSettled = () => {
    recordEvent("agent_settled");
    probeSeq += 1;
    writeEnvelope(probeSeq, "settled");
  };
  const onTurnStart = () => {
    recordEvent("turn_start");
    probeSeq += 1;
    writeEnvelope(probeSeq, "working");
  };
  const onTurnEnd = () => {
    recordEvent("turn_end");
    probeSeq += 1;
    writeEnvelope(probeSeq, "settled");
  };
  const onToolCall = () => {
    recordEvent("tool_call");
    probeSeq += 1;
    writeEnvelope(probeSeq, "tool_activity");
  };
  const onToolExecEnd = () => {
    recordEvent("tool_execution_end");
    probeSeq += 1;
    writeEnvelope(probeSeq, "tool_activity");
  };

  // Register each event defensively; degrade silently if a runtime's API lacks
  // a given name (capability probe, §3).
  const tryOn = (name: string, fn: () => void) => {
    try {
      if (typeof api?.on === "function") api.on(name, fn);
    } catch {
      // unsupported event on this runtime — skip
    }
  };
  tryOn("session_start", onSessionStart);
  tryOn("session_shutdown", onShutdown);
  tryOn("agent_start", onAgentStart);
  tryOn("agent_end", onAgentEnd);
  tryOn("agent_settled", onAgentSettled);
  tryOn("turn_start", onTurnStart);
  tryOn("turn_end", onTurnEnd);
  tryOn("tool_call", onToolCall);
  tryOn("tool_execution_end", onToolExecEnd);

  void PROBE_EVENTS;
}
