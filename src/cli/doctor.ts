// Read-only diagnostic for the local Overload install. Never mutates state;
// `scripts/setup.sh` / `scripts/install-*.sh` own installation, this only
// confirms it worked. All I/O is injected so tests never touch the real
// filesystem, launchctl, or ledger.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { STALL_PROFILE_MS } from "../shared/types";
import { defaultExecutor, type Executor } from "../web/jump";

export type Status = "OK" | "WARN" | "FAIL";
export type CheckResult = { status: Status; label: string; detail: string };

export type StatInfo = { mtimeMs: number; mode: number } | null;

export type DoctorDeps = {
  ledgerPath: string;
  overloadRoot: string;
  extensionTargets: Array<{ label: string; path: string }>;
  uid: string;
  exec: Executor;
  stat: (path: string) => Promise<StatInfo>;
  now: () => number;
};

export function defaultDoctorDeps(): DoctorDeps {
  const overloadRoot = process.env.OVERLOAD_LEDGER_PATH
    ? join(process.env.OVERLOAD_LEDGER_PATH, "..")
    : join(homedir(), ".overload");
  return {
    ledgerPath: process.env.OVERLOAD_LEDGER_PATH ?? join(overloadRoot, "ledger.db"),
    overloadRoot,
    extensionTargets: [
      { label: "pi", path: join(homedir(), ".pi", "agent", "extensions", "overload.ts") },
      { label: "omp", path: join(homedir(), ".omp", "agent", "extensions", "overload.ts") },
    ],
    uid: String(process.getuid?.() ?? 0),
    exec: defaultExecutor,
    stat: async (path) => {
      try {
        const info = await Bun.file(path).stat();
        return { mtimeMs: info.mtimeMs, mode: info.mode };
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
  };
}

const LAUNCHD_LABEL_PREFIX = "works.earendil.overload.";
const KEEPALIVE_LABELS = ["ingest", "web"];
const INGEST_HEARTBEAT_MAX_AGE_MS = 30_000;
const PULL_HEARTBEAT_MAX_AGE_MS = 90_000; // pull.plist runs every 60s; allow one missed tick
// Event kinds a live session actually emits. Admin/self-observation kinds
// (telemetry_gap, source_outage, classifier_activated, ...) are excluded so
// this check reflects real agent activity, not recon's own bookkeeping.
const LIVE_SESSION_KINDS = [
  "session_started", "working", "settled", "decision_requested", "decision_resolved",
  "tool_activity", "heartbeat", "commit_observed", "session_ended",
];

async function checkLedger(deps: DoctorDeps): Promise<{ result: CheckResult; db: Database | null }> {
  try {
    const db = new Database(deps.ledgerPath, { readonly: true });
    db.query("SELECT 1 FROM journal LIMIT 1").get();
    return { result: { status: "OK", label: "ledger", detail: deps.ledgerPath }, db };
  } catch (error) {
    return { result: { status: "FAIL", label: "ledger", detail: `unreachable: ${(error as Error).message}` }, db: null };
  }
}

async function checkExtension(deps: DoctorDeps, target: { label: string; path: string }): Promise<CheckResult> {
  const info = await deps.stat(target.path);
  return info
    ? { status: "OK", label: `extension:${target.label}`, detail: target.path }
    : { status: "WARN", label: `extension:${target.label}`, detail: `missing at ${target.path} (run scripts/install-extension.sh --install)` };
}

async function launchctlPrint(deps: DoctorDeps, label: string): Promise<{ ok: boolean; state: string | null; lastExit: number | null; error?: string }> {
  const result = await deps.exec("launchctl", ["print", `gui/${deps.uid}/${LAUNCHD_LABEL_PREFIX}${label}`]);
  if (!result.ok || !result.stdout) return { ok: false, state: null, lastExit: null, error: result.error ?? "not loaded" };
  const state = /^\tstate = (.+?)\s*$/m.exec(result.stdout)?.[1] ?? null;
  const lastExitRaw = /^\tlast exit code = (-?\d+)/m.exec(result.stdout)?.[1];
  return { ok: true, state, lastExit: lastExitRaw == null ? null : Number(lastExitRaw) };
}

async function checkKeepAlive(deps: DoctorDeps, label: string): Promise<CheckResult> {
  const info = await launchctlPrint(deps, label);
  if (!info.ok) return { status: "FAIL", label: `launchd:${label}`, detail: info.error ?? "not loaded" };
  if (info.state === "running") return { status: "OK", label: `launchd:${label}`, detail: "running" };
  return { status: "FAIL", label: `launchd:${label}`, detail: `state=${info.state ?? "unknown"}` };
}

/** maintenance/pull are StartInterval jobs: "not running" between ticks is
 *  expected, so health is read from the last exit code instead of state. */
async function checkInterval(deps: DoctorDeps, label: string, severity: "FAIL" | "WARN"): Promise<CheckResult> {
  const info = await launchctlPrint(deps, label);
  if (!info.ok) return { status: severity, label: `launchd:${label}`, detail: info.error ?? "not loaded" };
  if (info.lastExit === 0 || info.lastExit === null) {
    return { status: "OK", label: `launchd:${label}`, detail: info.lastExit === null ? "loaded, not yet run" : "last run succeeded" };
  }
  return { status: severity, label: `launchd:${label}`, detail: `last exit code ${info.lastExit}` };
}

async function checkHeartbeat(deps: DoctorDeps, name: string, path: string, maxAgeMs: number, severity: "FAIL" | "WARN"): Promise<CheckResult> {
  const info = await deps.stat(path);
  if (!info) return { status: severity, label: `heartbeat:${name}`, detail: `missing ${path}` };
  const ageSec = Math.round((deps.now() - info.mtimeMs) / 1000);
  return ageSec <= maxAgeMs / 1000
    ? { status: "OK", label: `heartbeat:${name}`, detail: `${ageSec}s old` }
    : { status: severity, label: `heartbeat:${name}`, detail: `stale (${ageSec}s old)` };
}

async function checkTelemetryLiveness(deps: DoctorDeps, db: Database | null): Promise<CheckResult> {
  if (!db) return { status: "FAIL", label: "telemetry:liveness", detail: "ledger unavailable" };
  const placeholders = LIVE_SESSION_KINDS.map(() => "?").join(",");
  const row = db.query(`SELECT max(at) at FROM journal WHERE kind IN (${placeholders})`).get(...LIVE_SESSION_KINDS) as { at: number | null } | null;
  const lastAt = row?.at ?? null;
  const now = deps.now();
  if (lastAt != null && now - lastAt <= STALL_PROFILE_MS.narrow) {
    return { status: "OK", label: "telemetry:liveness", detail: `last session event ${Math.round((now - lastAt) / 60_000)}m ago` };
  }
  const ageLabel = lastAt == null ? "no session events recorded" : `no session events for ${Math.round((now - lastAt) / 60_000)}m`;
  const windowStart = lastAt ?? now - STALL_PROFILE_MS.narrow;
  const corroboration = db.query("SELECT count(*) n FROM journal WHERE kind='telemetry_gap' AND at >= ?").get(windowStart) as { n: number };
  if (corroboration.n > 0) {
    return {
      status: "FAIL", label: "telemetry:liveness",
      detail: `${ageLabel}, but telemetry_gap evidence of a live agent process exists — extension likely missing; run scripts/install-extension.sh --install then restart the runtime`,
    };
  }
  return { status: "WARN", label: "telemetry:liveness", detail: `${ageLabel} (no corroborating activity evidence — may just be idle)` };
}

async function checkPermissions(deps: DoctorDeps): Promise<CheckResult[]> {
  const dirInfo = await deps.stat(deps.overloadRoot);
  const dirMode = dirInfo ? dirInfo.mode & 0o777 : null;
  const dbInfo = await deps.stat(deps.ledgerPath);
  const dbMode = dbInfo ? dbInfo.mode & 0o777 : null;
  return [
    dirMode === 0o700
      ? { status: "OK", label: "permissions:dir", detail: "0700" }
      : { status: "WARN", label: "permissions:dir", detail: dirMode == null ? "missing" : `mode ${dirMode.toString(8)} (expected 0700)` },
    dbMode === 0o600
      ? { status: "OK", label: "permissions:db", detail: "0600" }
      : { status: "WARN", label: "permissions:db", detail: dbMode == null ? "missing" : `mode ${dbMode.toString(8)} (expected 0600)` },
  ];
}

/** Runs every check independently — one broken probe never hides the rest. */
export async function runDoctor(deps: DoctorDeps): Promise<{ checks: CheckResult[]; exitCode: number }> {
  const { result: ledgerResult, db } = await checkLedger(deps);
  const checks: CheckResult[] = [ledgerResult];
  for (const target of deps.extensionTargets) checks.push(await checkExtension(deps, target));
  for (const label of KEEPALIVE_LABELS) checks.push(await checkKeepAlive(deps, label));
  checks.push(await checkInterval(deps, "maintenance", "FAIL"));
  checks.push(await checkInterval(deps, "pull", "WARN"));
  checks.push(await checkHeartbeat(deps, "ingest", join(deps.overloadRoot, "ingest.heartbeat"), INGEST_HEARTBEAT_MAX_AGE_MS, "FAIL"));
  checks.push(await checkHeartbeat(deps, "pull", join(deps.overloadRoot, "pull.heartbeat"), PULL_HEARTBEAT_MAX_AGE_MS, "WARN"));
  checks.push(await checkTelemetryLiveness(deps, db));
  checks.push(...await checkPermissions(deps));
  db?.close();
  return { checks, exitCode: checks.some((check) => check.status === "FAIL") ? 1 : 0 };
}

if (import.meta.main) {
  const { checks, exitCode } = await runDoctor(defaultDoctorDeps());
  for (const check of checks) console.log(`[${check.status}] ${check.label}: ${check.detail}`);
  process.exitCode = exitCode;
}
