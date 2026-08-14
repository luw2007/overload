/**
 * §3 reconciliation findings — N8 reference implementation of the FROZEN P2
 * contract (p2-freeze.md protocol 6 + 3; docs/plans/…-tech-solution.md §3).
 *
 * This reference models the recon daemon's DECISION core so the frozen rules
 * are directly testable with fake platform CLIs (tiny scripts echoing captured
 * JSON shapes — never the real herdr/orca/cmux):
 *
 *  - Output is ONLY admin-spool events (runtime="overload", emitter
 *    overload-<pid>-<boot8>, monotonic seq, newline-terminated lines). The
 *    ledger is NEVER written (read-only queries).
 *  - source_outage aggregation: one event per outage START; source_recovered
 *    on return; while a source is out, ZERO per-session findings derived from
 *    it (the reducer freezes sessions per incident).
 *  - CLI failure = non-zero rc OR unparseable JSON = source outage (NOT an
 *    empty snapshot). A missing cmux sessions file is "cmux unused" (no
 *    findings, no outage); a malformed one is an outage.
 *  - emitter_dead: kill-0 fail (verified:"kill0") or comm mismatch
 *    (verified:"comm_mismatch"). emitter_drained ONLY when dead ∧
 *    DRAIN_GRACE_MS elapsed since the emitter's last liveness evidence ∧ ALL
 *    its spool files have cursors.bytes == file size (the cursor==size gate).
 *    Drained is emitted ONCE per emitter.
 *  - telemetry_gap: platform session visible ∧ cwd joins a ledger session with
 *    no live spool writer; rate-limited to once per native_id per hour.
 *  - session_vanished: ONLY on a COMPLETE snapshot (rc=0 ∧ JSON parsed) that
 *    provably lacks a previously-attached session.
 *
 * Real-implementation sections of test/p2-recon.test.ts drive N6's
 * src/recon/recon.ts (--once --herdr-cmd --orca-cmd --cmux-sessions-file
 * --ledger --spool) against the same fixtures and assert identical observable
 * behavior in the admin spool.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  DRAIN_GRACE_MS,
  STALL_PROFILE_MS,
  type EventEnvelope,
  type HostId,
} from "../../../src/shared/types";
import { SCHEMA_SQL_P2 } from "./schema";

export type SourceName = "herdr" | "orca" | "cmux";

export interface Finding {
  kind: string;
  detail: Record<string, unknown>;
}

/** Cross-pass recon memory (in-process for tests; the daemon keeps it in its
 * loop and reconstructs outage/rate-limit state from its own journal/spool). */
export interface ReconState {
  outages: SourceName[];
  gapSentAt: Map<string, number>;
  drained: Set<string>;
  adminSeq: number;
}

export function freshReconState(): ReconState {
  return { outages: [], gapSentAt: new Map(), drained: new Set(), adminSeq: 0 };
}

export type LivenessProbe = (
  pid: number | null,
  emitterId: string,
) => "alive" | "dead" | "comm_mismatch";

/** Default probe: kill-0 only (comm comparison needs runtime knowledge N6
 * derives from the recorded runtime; the contract tests inject stubs). */
export function defaultProbeAlive(pid: number | null, _emitterId: string): "alive" | "dead" | "comm_mismatch" {
  if (pid === null) return "alive"; // inconclusive → freeze, never judge dead (§3)
  try {
    process.kill(pid, 0);
    return "alive";
  } catch {
    return "dead";
  }
}

export interface ReconTimings {
  drainGraceMs: number;
  gapRateLimitMs: number;
  stallNarrowMs: number;
}

export interface ReconDeps {
  ledger: string;
  spoolRoot: string;
  host?: HostId;
  /** Shell command whose stdout is `herdr agent list --json` output. */
  herdrCmd?: string;
  /** Shell command whose stdout is `orca worktree ps --json` output. */
  orcaCmd?: string;
  /** Path to a `<agent>-hook-sessions.json`-shaped file. */
  cmuxSessionsFile?: string;
  now: number;
  probeAlive?: LivenessProbe;
  timings?: Partial<ReconTimings>;
}

type CmdResult = { ok: true; stdout: string } | { ok: false; reason: "rc" | "spawn" | "parse" };

function runCmd(cmd: string): CmdResult {
  try {
    const proc = Bun.spawnSync(["/bin/sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return { ok: false, reason: "rc" };
    return { ok: true, stdout: proc.stdout.toString() };
  } catch {
    return { ok: false, reason: "spawn" };
  }
}

function parseJson(stdout: string): unknown | null {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// ── captured platform shapes (docs/research/…-probe-findings.md §1/§2/§3) ──

export interface HerdrAgent {
  terminal_id: string;
  agent_status: string;
  cwd: string;
  [k: string]: unknown;
}
export interface OrcaWorktree {
  worktreeInstanceId: string;
  workspaceStatus: string;
  status: string;
  path: string;
  parentWorktreeId: string | null;
  [k: string]: unknown;
}

function parseHerdr(value: unknown): HerdrAgent[] | null {
  // `herdr agent list --json` → result.agents[] (probe §1).
  if (!value || typeof value !== "object") return null;
  const agents = (value as { result?: { agents?: unknown } }).result?.agents;
  if (!Array.isArray(agents)) return null;
  return agents.filter(
    (a): a is HerdrAgent =>
      !!a && typeof a === "object" && typeof (a as HerdrAgent).terminal_id === "string",
  );
}

function parseOrca(value: unknown): OrcaWorktree[] | null {
  // `orca worktree ps --json` → array of worktrees (probe §2).
  if (!Array.isArray(value)) return null;
  return value.filter(
    (w): w is OrcaWorktree =>
      !!w && typeof w === "object" && typeof (w as OrcaWorktree).worktreeInstanceId === "string",
  );
}

// ── spool drain gate ──

const SEGMENT_RE = /^(?:active|seg)-.+-\d+(?:-recovered)?\.ndjson$/;

/**
 * The frozen drained gate: EVERY active/seg file of this emitter (across all
 * host dirs) must have a ledger cursor with bytes == file size. An emitter with
 * no spool files is trivially drained (nothing left to tail).
 */
export function allSpoolFilesDrained(db: Database, spoolRoot: string, emitterId: string): boolean {
  let files = 0;
  for (const host of listDir(spoolRoot)) {
    const dir = join(spoolRoot, host, emitterId);
    for (const f of listDir(dir)) {
      if (!SEGMENT_RE.test(f)) continue;
      files++;
      const row = db.query("SELECT bytes FROM cursors WHERE file_name=?").get(`${host}/${emitterId}/${f}`) as
        | { bytes: number }
        | undefined;
      let size = -1;
      try {
        size = statSync(join(dir, f)).size;
      } catch {
        return false;
      }
      if (!row || row.bytes !== size) return false;
    }
  }
  return true;
}

function listDir(p: string): string[] {
  try {
    return readdirSync(p).sort();
  } catch {
    return [];
  }
}

// ── the pass ──

export function runReconPass(deps: ReconDeps, state: ReconState): Finding[] {
  const t: ReconTimings = {
    drainGraceMs: DRAIN_GRACE_MS,
    gapRateLimitMs: 3_600_000,
    stallNarrowMs: STALL_PROFILE_MS.narrow,
    ...deps.timings,
  };
  const findings: Finding[] = [];
  let db: Database;
  if (existsSync(deps.ledger)) {
    db = new Database(deps.ledger, { readonly: true });
  } else {
    // No ledger yet (fresh host): platform-only pass over an empty schema so
    // the read-only queries below stay well-defined.
    db = new Database(":memory:");
    db.exec(SCHEMA_SQL_P2);
  }
  try {
    // 1. Source snapshots with outage aggregation.
    const herdrAgents = sourceSnapshot("herdr", deps.herdrCmd, runCmd, parseHerdr, state, findings);
    const orcaWorktrees = sourceSnapshot("orca", deps.orcaCmd, runCmd, parseOrca, state, findings);
    const cmux = cmuxSnapshot(deps.cmuxSessionsFile, state, findings);
    void cmux; // cmux is attachment-refresh only in v1 (§ probe §3); no findings here

    // 2. Process liveness for known live process-domain emitters (ledger-only
    //    derivation; independent of platform source outages).
    const incarnations = db
      .query(
        `SELECT si.stable_id, si.writer_id, si.pid, si.last_seen_at
         FROM session_incarnations si
         WHERE si.liveness_domain='process'
           AND NOT EXISTS (
             SELECT 1 FROM journal j WHERE j.stable_id=si.stable_id AND j.kind='session_ended')`,
      )
      .all() as Array<{ stable_id: string; writer_id: string; pid: number | null; last_seen_at: number | null }>;

    for (const inc of incarnations) {
      const probe = (deps.probeAlive ?? defaultProbeAlive)(inc.pid, inc.writer_id);
      const silence = inc.last_seen_at === null ? t.drainGraceMs + 1 : deps.now - inc.last_seen_at;
      if (probe === "dead" || probe === "comm_mismatch") {
        findings.push({
          kind: "emitter_dead",
          detail: {
            emitter_id: inc.writer_id,
            stable_id: inc.stable_id,
            pid: inc.pid,
            verified: probe === "dead" ? "kill0" : "comm_mismatch",
          },
        });
        if (
          silence >= t.drainGraceMs &&
          !state.drained.has(inc.writer_id) &&
          allSpoolFilesDrained(db, deps.spoolRoot, inc.writer_id)
        ) {
          state.drained.add(inc.writer_id);
          findings.push({
            kind: "emitter_drained",
            detail: { emitter_id: inc.writer_id, stable_id: inc.stable_id },
          });
        }
      } else if (silence > t.stallNarrowMs) {
        findings.push({
          kind: "emitter_stalled",
          detail: { emitter_id: inc.writer_id, stable_id: inc.stable_id, silent_ms: silence },
        });
      }
    }

    // 3. Per-source derivations — only while the source snapshot is COMPLETE.
    if (herdrAgents) deriveHerdr(db, deps, state, t, herdrAgents, findings);
    if (orcaWorktrees) deriveOrca(db, deps, state, t, orcaWorktrees, findings);
  } finally {
    db.close();
  }
  return findings;
}

function sourceSnapshot<T>(
  source: SourceName,
  cmd: string | undefined,
  runCmd: (c: string) => CmdResult,
  parse: (v: unknown) => T | null,
  state: ReconState,
  findings: Finding[],
): T | null {
  if (cmd === undefined) return null; // source not configured → not tracked
  const res = runCmd(cmd);
  let snapshot: T | null = null;
  if (res.ok) snapshot = parse(parseJson(res.stdout));
  const failed = !res.ok || snapshot === null;
  if (failed) {
    if (!state.outages.includes(source)) {
      state.outages.push(source);
      findings.push({ kind: "source_outage", detail: { source } });
    }
    return null; // no derivations while out
  }
  if (state.outages.includes(source)) {
    state.outages = state.outages.filter((s) => s !== source);
    findings.push({ kind: "source_recovered", detail: { source } });
  }
  return snapshot;
}

function cmuxSnapshot(
  path: string | undefined,
  state: ReconState,
  findings: Finding[],
): boolean {
  if (path === undefined) return false;
  if (!existsSync(path)) return false; // cmux unused: no findings, no outage
  const parsed = parseJson(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (!state.outages.includes("cmux")) {
      state.outages.push("cmux");
      findings.push({ kind: "source_outage", detail: { source: "cmux" } });
    }
    return false;
  }
  if (state.outages.includes("cmux")) {
    state.outages = state.outages.filter((s) => s !== "cmux");
    findings.push({ kind: "source_recovered", detail: { source: "cmux" } });
  }
  return true;
}

function deriveHerdr(
  db: Database,
  deps: ReconDeps,
  state: ReconState,
  t: ReconTimings,
  agents: HerdrAgent[],
  findings: Finding[],
): void {
  const ids = new Set(agents.map((a) => a.terminal_id));
  for (const agent of agents) {
    const session = sessionByCwd(db, agent.cwd);
    if (!session) continue;
    maybeTelemetryGap(db, deps, state, t, "herdr", agent.terminal_id, agent.cwd, session.stable_id, findings);
    maybeAttachment(db, deps, session.stable_id, "herdr", agent.terminal_id, findings);
  }
  vanishedOnCompleteSnapshot(db, deps, "herdr", ids, findings);
}

function deriveOrca(
  db: Database,
  deps: ReconDeps,
  state: ReconState,
  t: ReconTimings,
  worktrees: OrcaWorktree[],
  findings: Finding[],
): void {
  const ids = new Set(worktrees.map((w) => w.worktreeInstanceId));
  for (const w of worktrees) {
    const session = sessionByCwd(db, w.path);
    if (!session) continue;
    maybeTelemetryGap(db, deps, state, t, "orca", w.worktreeInstanceId, w.path, session.stable_id, findings);
    maybeAttachment(db, deps, session.stable_id, "orca", w.worktreeInstanceId, findings);
  }
  vanishedOnCompleteSnapshot(db, deps, "orca", ids, findings);
}

function sessionByCwd(db: Database, cwd: string): { stable_id: string } | undefined {
  return db
    .query("SELECT stable_id FROM sessions WHERE cwd=? ORDER BY first_seen_at LIMIT 1")
    .get(cwd) as { stable_id: string } | undefined;
}

function maybeTelemetryGap(
  db: Database,
  deps: ReconDeps,
  state: ReconState,
  t: ReconTimings,
  platform: SourceName,
  nativeId: string,
  cwd: string,
  stableId: string,
  findings: Finding[],
): void {
  const last = db
    .query("SELECT COALESCE(MAX(last_seen_at), 0) AS m FROM session_incarnations WHERE stable_id=?")
    .get(stableId) as { m: number };
  const writerAlive = deps.now - last.m < t.stallNarrowMs;
  if (writerAlive) return; // a live spool writer covers this session
  const lastSent = state.gapSentAt.get(nativeId);
  if (lastSent !== undefined && deps.now - lastSent < t.gapRateLimitMs) return; // anti-storm
  state.gapSentAt.set(nativeId, deps.now);
  findings.push({ kind: "telemetry_gap", detail: { platform, native_id: nativeId, cwd } });
}

function maybeAttachment(
  db: Database,
  deps: ReconDeps,
  stableId: string,
  platform: SourceName,
  binding: string,
  findings: Finding[],
): void {
  const row = db
    .query("SELECT binding, valid FROM attachments WHERE stable_id=? AND platform=?")
    .get(stableId, platform) as { binding: string; valid: number } | undefined;
  if (row && row.valid === 1 && row.binding === binding) return; // unchanged, still valid
  findings.push({ kind: "attachment_observed", detail: { stable_id: stableId, platform, binding } });
}

function vanishedOnCompleteSnapshot(
  db: Database,
  deps: ReconDeps,
  platform: SourceName,
  presentIds: Set<string>,
  findings: Finding[],
): void {
  const rows = db
    .query("SELECT stable_id, binding FROM attachments WHERE platform=? AND valid=1")
    .all(platform) as Array<{ stable_id: string; binding: string }>;
  for (const r of rows) {
    if (!presentIds.has(r.binding)) {
      findings.push({ kind: "session_vanished", detail: { stable_id: r.stable_id, platform } });
    }
  }
  void deps;
}

// ── admin spool writing (P1 spool rules; NEVER touches the ledger) ──

export interface AdminSpoolOpts {
  host?: HostId;
  /** Deterministic emitter identity for tests (default overload-<pid>-<boot8>). */
  adminEmitter?: string;
  session?: string;
}

/** Append findings as contract envelopes (newline-terminated, monotonic seq). */
export function writeFindingsToSpool(
  deps: ReconDeps,
  state: ReconState,
  findings: Finding[],
  opts: AdminSpoolOpts = {},
): string | null {
  if (findings.length === 0) return null;
  const host = opts.host ?? "local";
  const emitter =
    opts.adminEmitter ?? `overload-${process.pid}-${Date.now().toString(16).slice(0, 8).padStart(8, "0")}`;
  const dir = join(deps.spoolRoot, host, emitter);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `active-${emitter}-1.ndjson`);
  let payload = "";
  for (const f of findings) {
    state.adminSeq += 1;
    const env: EventEnvelope = {
      v: 1,
      at: deps.now,
      host,
      runtime: "overload",
      session: opts.session ?? "00000000-0000-4000-8000-00000000f1nd",
      emitter_id: emitter,
      writer_id: emitter,
      seq: state.adminSeq,
      kind: f.kind as EventEnvelope["kind"],
      dropped_total: 0,
      write_error_total: 0,
      detail: f.detail,
    };
    payload += JSON.stringify(env) + "\n";
  }
  appendFileSync(file, payload);
  return file;
}

/** Scan every *.ndjson under a spool root; return parsed overload envelopes. */
export function scanSpoolFindings(
  spoolRoot: string,
): Array<{ kind: string; detail: Record<string, unknown>; at: number; seq: number; emitter_id: string; runtime: string }> {
  const out: ReturnType<typeof scanSpoolFindings> = [];
  for (const host of listDir(spoolRoot)) {
    for (const emitter of listDir(join(spoolRoot, host))) {
      for (const f of listDir(join(spoolRoot, host, emitter))) {
        if (!f.endsWith(".ndjson")) continue;
        const text = readFileSync(join(spoolRoot, host, emitter, f), "utf8");
        for (const line of text.split("\n")) {
          if (line.trim() === "") continue;
          try {
            const env = JSON.parse(line);
            if (env && typeof env === "object" && typeof env.kind === "string") {
              out.push({
                kind: env.kind,
                detail: env.detail ?? {},
                at: env.at,
                seq: env.seq,
                emitter_id: env.emitter_id,
                runtime: env.runtime,
              });
            }
          } catch {
            // partial trailing line — not consumable, skip
          }
        }
      }
    }
  }
  return out;
}
