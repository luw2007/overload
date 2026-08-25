#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DRAIN_GRACE_MS,
  ENVELOPE_VERSION,
  SEGMENT_MAX_AGE_MS,
  SEGMENT_MAX_BYTES,
  STALL_PROFILE_MS,
  TURN_HANG_MS,
  type EventEnvelope,
  type EventKind,
  type HostId,
} from "../shared/types";

const DEFAULT_RECON_INTERVAL_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const GAP_RATE_LIMIT_MS = 60 * 60_000;
/** After the host loses an address, a working turn that has not progressed for
 *  this long is checked for sockets stranded on the vanished address. */
const NETWORK_HANG_GRACE_MS = 60_000;
const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;
const SPOOL_FILE = /^(?:active|seg)-([A-Za-z0-9._-]+)-(\d+)(?:-recovered)?\.ndjson$/;

type FindingKind = Extract<EventKind,
  "emitter_dead" | "emitter_drained" | "emitter_stalled" | "telemetry_gap" |
  "session_vanished" | "source_outage" | "source_recovered" | "attachment_observed" |
  "turn_hung" | "dead_connection" | "network_changed">;

export type ReconConfig = {
  recon_interval_ms: number;
  drain_grace_ms: number;
  stall_profile_ms: number;
  turn_hang_ms: number;
  command_timeout_ms: number;
  host: HostId;
  ledger: string;
  spool: string;
  herdr_cmd: string;
  orca_cmd: string;
  cmux_sessions_file: string;
};

export type ReconSummary = { total: number; byKind: Partial<Record<FindingKind, number>> };

type Incarnation = {
  stable_id: string;
  writer_id: string;
  pid: number | null;
  proc_boot_id: string | null;
  started_at: number | null;
  last_seen_at: number | null;
  cwd: string | null;
  runtime: string | null;
  session: string | null;
  last_event_at: number | null;
};

type CurrentView = { state: string | null; last_progress_at: number | null; last_event_at: number | null };

export type Socket = { local: string; peer: string };
/** Host probes, injectable so hang detection is testable without real sockets. */
export type ReconProbes = {
  localAddresses: () => Set<string>;
  establishedSockets: (pid: number, timeoutMs: number) => Promise<Socket[]>;
  spoolLstat?: typeof lstat;
};

type NativeSession = { native_id: string; cwd?: string; visible: boolean; parent?: string };
type SourceSnapshot = { sessions: NativeSession[] };
type AttachmentRow = { stable_id: string; platform: string; binding: string };
type SessionRow = { stable_id: string; host: string; cwd: string | null };

type ProcessState = { alive: boolean; verified?: "kill0" | "comm_mismatch"; comm?: string };

export class ReconDaemon {
  private readonly config: ReconConfig;
  private readonly emitterId: string;
  private seq = 0;
  private generation = 0;
  private segmentOpenedAt = 0;
  private deadAt = new Map<string, number>();
  private deadReported = new Set<string>();
  private drained = new Set<string>();
  private outages = new Set<string>();
  private gaps = new Map<string, number>();
  private attachments = new Map<string, string>();
  private vanished = new Set<string>();
  private networkSnapshot: string | null = null;

  private readonly probes: ReconProbes;

  constructor(config: ReconConfig, probes: ReconProbes = defaultProbes) {
    this.config = config;
    this.probes = probes;
    this.emitterId = `overload-${process.pid}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  }

  async runOnce(now = Date.now()): Promise<ReconSummary> {
    const summary: ReconSummary = { total: 0, byKind: {} };
    const db = new Database(this.config.ledger, { readonly: true, create: false });
    try {
      const addresses = this.probes.localAddresses();
      const lostAddress = await this.syncNetwork(db, addresses, summary, now);
      const hangGraceMs = lostAddress ? Math.min(NETWORK_HANG_GRACE_MS, this.config.turn_hang_ms) : this.config.turn_hang_ms;
      const pipelineFresh = this.pipelineFresh(db, now);
      const incarnations = this.liveProcessIncarnations(db);
      const liveWriters = new Set<string>();
      for (const incarnation of incarnations) {
        const state = await inspectProcess(incarnation.pid, incarnation.runtime);
        if (!state.alive) {
          const firstDeadAt = this.deadAt.get(incarnation.writer_id) ?? now;
          this.deadAt.set(incarnation.writer_id, firstDeadAt);
          if (!this.deadReported.has(incarnation.writer_id) && !this.wasDead(db, incarnation.writer_id)) {
            await this.emit(summary, "emitter_dead", incarnation.session ?? "admin", now, {
              emitter_id: incarnation.writer_id, stable_id: incarnation.stable_id,
              pid: incarnation.pid, verified: state.verified,
            });
            this.deadReported.add(incarnation.writer_id);
          }
          const graceOrigin = incarnation.last_event_at ?? incarnation.last_seen_at ?? incarnation.started_at ?? firstDeadAt;
          if (!this.drained.has(incarnation.writer_id) &&
              now - graceOrigin >= this.config.drain_grace_ms &&
              await this.spoolAtEof(db, incarnation.writer_id) &&
              !this.wasDrained(db, incarnation.writer_id)) {
            await this.emit(summary, "emitter_drained", incarnation.session ?? "admin", now, {
              emitter_id: incarnation.writer_id, stable_id: incarnation.stable_id,
            });
            this.drained.add(incarnation.writer_id);
          }
          continue;
        }

        liveWriters.add(incarnation.writer_id);
        this.deadAt.delete(incarnation.writer_id);
        this.deadReported.delete(incarnation.writer_id);
        const lastSeen = incarnation.last_event_at ?? incarnation.last_seen_at ?? incarnation.started_at ?? now;
        const silentMs = Math.max(0, now - lastSeen);
        // Read separately from the liveness query: a missing or older `current`
        // must degrade hang detection only, never dead-emitter detection.
        const view = this.currentView(db, incarnation.stable_id);
        // Idle and awaiting_human sessions are silent by design: the extension
        // heartbeats only while working. Only a working turn's silence is a fault.
        if (view?.state === "working" && silentMs > this.config.stall_profile_ms &&
            this.findingIsStale(db, "emitter_stalled", incarnation.writer_id, lastSeen)) {
          await this.emit(summary, "emitter_stalled", incarnation.session ?? "admin", now, {
            emitter_id: incarnation.writer_id, stable_id: incarnation.stable_id, silent_ms: silentMs,
          });
        }
        if (pipelineFresh && view?.state === "working") {
          await this.inspectTurn(db, incarnation, view, addresses, hangGraceMs, summary, now);
        }
      }

      const sources: Array<[string, () => Promise<SourceSnapshot>]> = [
        ["herdr", () => commandSnapshot(this.config.herdr_cmd, this.config.command_timeout_ms, parseHerdr)],
        ["orca", () => commandSnapshot(this.config.orca_cmd, this.config.command_timeout_ms, parseOrca)],
        ["cmux", () => cmuxSnapshot(this.config.cmux_sessions_file)],
      ];
      for (const [source, load] of sources) {
        let snapshot: SourceSnapshot;
        try {
          snapshot = await load();
        } catch {
          if (!this.outages.has(source) && !this.sourceOutageOpen(db, source)) {
            await this.emit(summary, "source_outage", "admin", now, { source });
            this.outages.add(source);
          }
          continue;
        }
        if (this.outages.delete(source) || this.sourceOutageOpen(db, source)) {
          await this.emit(summary, "source_recovered", "admin", now, { source });
        }
        await this.reconcileSource(db, source, snapshot, liveWriters, summary, now);
      }
      return summary;
    } finally {
      db.close();
    }
  }

  private liveProcessIncarnations(db: Database): Incarnation[] {
    return safeAll<Incarnation>(db, `SELECT i.stable_id, i.writer_id, i.pid, i.proc_boot_id,
      i.started_at, i.last_seen_at, s.cwd, s.runtime, s.session,
      (SELECT MAX(j.at) FROM journal j WHERE j.emitter_id=i.writer_id) AS last_event_at
      FROM session_incarnations i JOIN sessions s ON s.stable_id=i.stable_id
      WHERE i.liveness_domain='process' AND s.host=?
        AND NOT EXISTS (SELECT 1 FROM journal e WHERE e.stable_id=i.stable_id
          AND e.writer_id=i.writer_id AND e.kind='session_ended')`, this.config.host);
  }

  /** A hung turn is invisible without `current`: heartbeat keeps the emitter
   *  "alive" and even "recent", while the turn itself has not moved. */
  private currentView(db: Database, stableId: string): CurrentView | null {
    return safeGet(db, "SELECT state, last_progress_at, last_event_at FROM current WHERE stable_id=?",
      stableId) as CurrentView | null;
  }

  /** One finding per silence episode: a finding newer than the last real event
   *  means this episode is already reported. Survives recon restarts. */
  private findingIsStale(db: Database, kind: FindingKind, emitterId: string, since: number): boolean {
    const row = safeGet(db, `SELECT MAX(at) AS at FROM journal WHERE kind=?
      AND json_extract(detail, '$.emitter_id')=?`, kind, emitterId);
    return typeof row?.at === "number" ? row.at < since : true;
  }

  /** Ingest owns the journal clock: if it stopped, every session looks hung. */
  private pipelineFresh(db: Database, now: number): boolean {
    const row = safeGet(db, "SELECT MAX(at) AS at FROM journal WHERE host=?", this.config.host);
    return typeof row?.at === "number" ? now - row.at < this.config.turn_hang_ms / 2 : false;
  }

  /** Emits network_changed on any address-set change; returns true only when an
   *  address was LOST, which is what strands in-flight sockets. */
  private async syncNetwork(db: Database, addresses: Set<string>, summary: ReconSummary, now: number): Promise<boolean> {
    const current = [...addresses].sort().join(",");
    if (this.networkSnapshot === current) return false;
    const previous = this.lastNetworkAddresses(db);
    this.networkSnapshot = current;
    if (previous && previous.join(",") === current) return false;
    await this.emit(summary, "network_changed", "admin", now, { previous: previous ?? [], current: [...addresses].sort() });
    return previous !== null && previous.some((address) => !addresses.has(address));
  }

  private lastNetworkAddresses(db: Database): string[] | null {
    const row = safeGet(db, `SELECT json_extract(detail, '$.current') AS current FROM journal
      WHERE kind='network_changed' ORDER BY ingest_seq DESC LIMIT 1`);
    if (typeof row?.current !== "string") return null;
    try {
      const parsed = JSON.parse(row.current);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
    } catch { return null; }
  }

  /** Progress silence is the symptom; a socket bound to an address this host no
   *  longer owns is proof, so it outranks the heuristic finding. */
  private async inspectTurn(db: Database, incarnation: Incarnation, view: CurrentView, addresses: Set<string>,
    hangGraceMs: number, summary: ReconSummary, now: number): Promise<void> {
    if (!incarnation.pid) return;
    const progressAt = view.last_progress_at ?? view.last_event_at ?? incarnation.started_at ?? now;
    const hungMs = Math.max(0, now - progressAt);
    if (hungMs <= hangGraceMs) return;
    const sockets = await this.probes.establishedSockets(incarnation.pid, this.config.command_timeout_ms);
    const stranded = sockets.find((socket) => !addresses.has(socketHost(socket.local)));
    if (hungMs <= this.config.turn_hang_ms && !stranded) return;
    const kind: FindingKind = stranded ? "dead_connection" : "turn_hung";
    if (!this.findingIsStale(db, kind, incarnation.writer_id, progressAt)) return;
    await this.emit(summary, kind, incarnation.session ?? "admin", now, {
      emitter_id: incarnation.writer_id, stable_id: incarnation.stable_id, hung_ms: hungMs,
      ...(stranded ? { local: stranded.local, peer: stranded.peer } : {}),
    });
  }

  private sourceOutageOpen(db: Database, source: string): boolean {
    const row = safeGet(db, `SELECT kind FROM journal
      WHERE kind IN ('source_outage','source_recovered')
        AND json_extract(detail, '$.source')=?
      ORDER BY ingest_seq DESC LIMIT 1`, source);
    return row?.kind === "source_outage";
  }

  private wasDead(db: Database, emitterId: string): boolean {
    return this.hasJournalFinding(db, "emitter_dead", emitterId);
  }

  private wasDrained(db: Database, emitterId: string): boolean {
    return this.hasJournalFinding(db, "emitter_drained", emitterId);
  }

  private hasJournalFinding(db: Database, kind: FindingKind, emitterId: string): boolean {
    return safeGet(db, "SELECT 1 AS found FROM journal WHERE kind=? AND json_extract(detail, '$.emitter_id')=? LIMIT 1", kind, emitterId) !== null;
  }

  private async spoolAtEof(db: Database, emitterId: string): Promise<boolean> {
    if (!SAFE_COMPONENT.test(emitterId)) return false;
    const emitterDir = join(this.config.spool, this.config.host, emitterId);
    let entries;
    try { entries = await readdir(emitterDir, { withFileTypes: true }); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    for (const entry of entries) {
      if (!entry.isFile() || !SPOOL_FILE.test(entry.name)) continue;
      const file = join(emitterDir, entry.name);
      let info;
      try { info = await (this.probes.spoolLstat ?? lstat)(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink()) return false;
      const key = relative(resolve(this.config.spool), file).split(sep).join("/");
      const cursor = safeGet(db, "SELECT bytes FROM cursors WHERE file_name=?", key) as { bytes: number } | null;
      if (!cursor || cursor.bytes !== info.size) return false;
    }
    return true;
  }

  private async reconcileSource(db: Database, platform: string, snapshot: SourceSnapshot,
    liveWriters: Set<string>, summary: ReconSummary, now: number): Promise<void> {
    const sessions = safeAll<SessionRow>(db, "SELECT stable_id, host, cwd FROM sessions");
    const byCwd = new Map<string, SessionRow[]>();
    for (const session of sessions) {
      if (!session.cwd) continue;
      const key = normalizeCwd(session.cwd);
      byCwd.set(key, [...(byCwd.get(key) ?? []), session]);
    }

    const visibleBindings = new Set(snapshot.sessions.map((item) => item.native_id));
    for (const native of snapshot.sessions) {
      if (!native.cwd) continue;
      const matches = byCwd.get(normalizeCwd(native.cwd)) ?? [];
      if (matches.length > 0) {
        const match = matches[0]!;
        const attachmentKey = `${platform}:${match.stable_id}`;
        const knownBinding = this.attachments.get(attachmentKey) ?? this.ledgerBinding(db, match.stable_id, platform);
        if (knownBinding !== native.native_id || this.sessionStillVanished(db, match.stable_id, platform)) {
          // Dedup remains binding-keyed: parent lineage only piggybacks when a
          // binding emission occurs, so a parent-only change is not re-emitted.
          await this.emit(summary, "attachment_observed", sessionPart(match.stable_id), now, {
            stable_id: match.stable_id, platform, binding: native.native_id,
            ...(native.parent ? { parent: native.parent } : {}),
          });
          this.attachments.set(attachmentKey, native.native_id);
        }
      }
      const localMatches = matches.filter((match) => match.host === this.config.host);
      if (native.visible && localMatches.length > 0 &&
          !localMatches.some((match) => this.sessionHasLiveWriter(db, match.stable_id, liveWriters))) {
        const key = `${platform}:${native.native_id}`;
        const journalAt = this.latestTelemetryGapAt(db, native.native_id);
        const latestAt = Math.max(this.gaps.get(key) ?? 0, journalAt ?? 0);
        if (now - latestAt >= GAP_RATE_LIMIT_MS) {
          await this.emit(summary, "telemetry_gap", "admin", now, {
            platform, native_id: native.native_id, cwd: native.cwd,
            stable_id: localMatches[0]!.stable_id,
          });
          this.gaps.set(key, now);
        }
      }
    }

    const attachments = safeAll<AttachmentRow>(db,
      "SELECT stable_id, platform, binding FROM attachments WHERE valid=1 AND platform=?", platform);
    for (const attachment of attachments) {
      const key = `${platform}:${attachment.stable_id}:${attachment.binding}`;
      if (!visibleBindings.has(attachment.binding) &&
          !this.vanished.has(key) && !this.sessionStillVanished(db, attachment.stable_id, platform)) {
        await this.emit(summary, "session_vanished", sessionPart(attachment.stable_id), now, {
          stable_id: attachment.stable_id, platform,
        });
        this.vanished.add(key);
      } else if (visibleBindings.has(attachment.binding)) {
        this.vanished.delete(key);
      }
    }
  }

  private latestTelemetryGapAt(db: Database, nativeId: string): number | undefined {
    const row = safeGet(db, `SELECT at FROM journal WHERE kind='telemetry_gap'
      AND json_extract(detail, '$.native_id')=? ORDER BY ingest_seq DESC LIMIT 1`, nativeId);
    return typeof row?.at === "number" ? row.at : undefined;
  }

  private sessionStillVanished(db: Database, stableId: string, platform: string): boolean {
    const row = safeGet(db, `SELECT kind FROM journal
      WHERE kind IN ('session_vanished','attachment_observed')
        AND json_extract(detail, '$.stable_id')=?
        AND json_extract(detail, '$.platform')=?
      ORDER BY ingest_seq DESC LIMIT 1`, stableId, platform);
    return row?.kind === "session_vanished";
  }

  private ledgerBinding(db: Database, stableId: string, platform: string): string | undefined {
    const row = safeGet(db, "SELECT binding FROM attachments WHERE stable_id=? AND platform=? AND valid=1", stableId, platform);
    return typeof row?.binding === "string" ? row.binding : undefined;
  }

  private sessionHasLiveWriter(db: Database, stableId: string, liveWriters: Set<string>): boolean {
    const rows = safeAll<{ writer_id: string }>(db,
      "SELECT writer_id FROM session_incarnations WHERE stable_id=?", stableId);
    return rows.some((row) => liveWriters.has(row.writer_id));
  }

  private async emit(summary: ReconSummary, kind: FindingKind, session: string, at: number,
    detail: Record<string, unknown>): Promise<void> {
    const envelope: EventEnvelope = {
      v: ENVELOPE_VERSION, at, host: this.config.host, runtime: "overload", session,
      emitter_id: this.emitterId, writer_id: this.emitterId, seq: ++this.seq, kind,
      dropped_total: 0, write_error_total: 0, detail,
    };
    await this.append(JSON.stringify(envelope) + "\n", at);
    summary.total++;
    summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1;
  }

  private async append(line: string, now: number): Promise<void> {
    const directory = join(this.config.spool, this.config.host, this.emitterId);
    await secureDirectory(this.config.spool);
    await secureDirectory(join(this.config.spool, this.config.host));
    await secureDirectory(directory);
    let active = join(directory, `active-${this.emitterId}-${this.generation}.ndjson`);
    let size = 0;
    try { size = (await lstat(active)).size; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (size > 0 && (size + Buffer.byteLength(line) > SEGMENT_MAX_BYTES ||
        now - this.segmentOpenedAt >= SEGMENT_MAX_AGE_MS)) {
      await rename(active, join(directory, `seg-${this.emitterId}-${this.generation}.ndjson`));
      this.generation++;
      active = join(directory, `active-${this.emitterId}-${this.generation}.ndjson`);
      size = 0;
    }
    if (size === 0) this.segmentOpenedAt = now;
    const handle = await open(active, fsConstants.O_WRONLY | fsConstants.O_APPEND |
      fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.write(line); await handle.sync(); } finally { await handle.close(); }
    await chmod(active, 0o600);
  }
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe spool directory: ${path}`);
  await chmod(path, 0o700);
}

/** Every address this host currently owns, loopback included. */
function localAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(stripZone(entry.address));
  }
  return addresses;
}

/** lsof -F n prints one `n<local>-><peer>` line per matching socket. */
async function establishedSockets(pid: number, timeoutMs: number): Promise<Socket[]> {
  const proc = Bun.spawn(["lsof", "-nP", "-p", String(pid), "-a", "-i", "-sTCP:ESTABLISHED", "-F", "n"],
    { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.split("\n").filter((line) => line.startsWith("n") && line.includes("->"))
      .map((line) => {
        const [local, peer] = line.slice(1).split("->");
        return { local: local!, peer: peer ?? "" };
      });
  } catch { return []; } finally { clearTimeout(timer); }
}

/** `192.168.1.5:55373` → `192.168.1.5`; `[fe80::1%en0]:443` → `fe80::1`. */
function socketHost(endpoint: string): string {
  if (endpoint.startsWith("[")) return stripZone(endpoint.slice(1, endpoint.indexOf("]")));
  return stripZone(endpoint.slice(0, endpoint.lastIndexOf(":")));
}

function stripZone(address: string): string {
  const zone = address.indexOf("%");
  return zone === -1 ? address : address.slice(0, zone);
}

const defaultProbes: ReconProbes = { localAddresses, establishedSockets };

async function inspectProcess(pid: number | null, runtime: string | null): Promise<ProcessState> {
  if (!pid || pid < 1) return { alive: false, verified: "kill0" };
  try { process.kill(pid, 0); } catch { return { alive: false, verified: "kill0" }; }
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "comm="], { stdout: "pipe", stderr: "ignore" });
  const comm = (await new Response(proc.stdout).text()).trim();
  const rc = await proc.exited;
  if (rc !== 0 || !comm) return { alive: true };
  if (!commMatchesRuntime(comm, runtime)) return { alive: false, verified: "comm_mismatch", comm };
  return { alive: true, comm };
}

function commMatchesRuntime(comm: string, runtime: string | null): boolean {
  const name = basename(comm).toLowerCase();
  const allowed: Record<string, string[]> = {
    pi: ["pi", "bun", "node"], omp: ["omp", "bun", "node"], prime: ["prime", "prime-agent"],
    overload: ["overload", "bun", "node"],
  };
  return (allowed[runtime ?? ""] ?? [runtime ?? ""]).some((part) => part && name.includes(part));
}

async function commandSnapshot(command: string, timeoutMs: number,
  parse: (value: unknown) => SourceSnapshot): Promise<SourceSnapshot> {
  const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, rc] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (rc !== 0) throw new Error(`command failed (${rc}): ${stderr.trim()}`);
    return parse(JSON.parse(stdout));
  } finally { clearTimeout(timer); }
}

/** Peels an optional {result: {...}} envelope; a JSON error response (result
 *  absent, e.g. herdr server_not_running) falls through and fails the array()
 *  check below — correctly treated as a source outage. */
function resultEnvelope(root: Record<string, unknown>): Record<string, unknown> {
  return root.result && typeof root.result === "object" && !Array.isArray(root.result)
    ? root.result as Record<string, unknown> : root;
}

function parseHerdr(value: unknown): SourceSnapshot {
  const root = record(value);
  const agents = array(resultEnvelope(root).agents);
  return { sessions: agents.map((item) => {
    const row = record(item);
    return {
      native_id: requiredString(row.terminal_id), cwd: optionalString(row.cwd),
      visible: optionalString(row.agent_status) !== "done" && optionalString(row.agent_status) !== "unknown",
    };
  }) };
}

function parseOrca(value: unknown): SourceSnapshot {
  const rows = Array.isArray(value) ? value
    : array(resultEnvelope(record(value)).worktrees);
  return { sessions: rows.map((item) => {
    const row = record(item);
    const status = optionalString(row.status);
    const parentWorktreeId = optionalString(row.parentWorktreeId);
    return {
      native_id: requiredString(row.worktreeInstanceId), cwd: optionalString(row.path),
      visible: status === "active" || status === "working",
      ...(parentWorktreeId ? { parent: `orca:${parentWorktreeId}` } : {}),
    };
  }) };
}

async function cmuxSnapshot(pattern: string): Promise<SourceSnapshot> {
  const paths = await resolveCmuxFiles(pattern);
  const sessions: NativeSession[] = [];
  for (const path of paths) {
    const value = JSON.parse(await readFile(path, "utf8"));
    collectCmux(record(value), sessions);
  }
  return { sessions };
}

async function resolveCmuxFiles(pattern: string): Promise<string[]> {
  if (!pattern.includes("*")) {
    const info = await stat(pattern);
    if (info.isDirectory()) {
      return (await readdir(pattern)).filter((name) => name.endsWith("-hook-sessions.json")).map((name) => join(pattern, name));
    }
    return [pattern];
  }
  const directory = dirname(pattern);
  const glob = new Bun.Glob(basename(pattern));
  return Array.fromAsync(glob.scan({ cwd: directory, absolute: true, onlyFiles: true }));
}

function collectCmux(root: Record<string, unknown>, output: NativeSession[]): void {
  const container = record(root.sessions ?? root);
  for (const [key, value] of Object.entries(container)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = record(value);
    const native = optionalString(row.workspaceId) ?? optionalString(row.workspace_id) ??
      optionalString(row.workstreamId) ?? optionalString(row.id) ?? key;
    output.push({ native_id: native, cwd: optionalString(row.cwd), visible: optionalString(row.agentLifecycle) !== "unknown" });
  }
}

function safeAll<T>(db: Database, sql: string, ...params: unknown[]): T[] {
  try { return db.query(sql).all(...params) as T[]; } catch { return []; }
}
function safeGet(db: Database, sql: string, ...params: unknown[]): Record<string, unknown> | null {
  try { return db.query(sql).get(...params) as Record<string, unknown> | null; } catch { return null; }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("expected array"); return value; }
function requiredString(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("expected string"); return value; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function normalizeCwd(path: string): string { return resolve(path); }
function sessionPart(stableId: string): string { return stableId.split(":").slice(2).join(":") || "admin"; }
function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

async function loadConfig(args: string[]): Promise<{ config: ReconConfig; once: boolean }> {
  const values = new Map<string, string>();
  let once = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--once") { once = true; continue; }
    if (!arg.startsWith("--") || !args[index + 1]) throw new Error(`invalid argument: ${arg}`);
    values.set(arg.slice(2), args[++index]!);
  }
  const home = join(homedir(), ".overload");
  let file: Record<string, unknown> = {};
  try { file = record(JSON.parse(await readFile(join(home, "config.json"), "utf8"))); } catch { /* defaults */ }
  const hostPath = join(home, "host");
  let host = "local";
  try { host = (await readFile(hostPath, "utf8")).trim(); } catch { /* local */ }
  if (host !== "local" && host !== "devbox") throw new Error(`invalid host id: ${host}`);
  const numberValue = (flag: string, key: string, fallback: number) => {
    const raw = values.get(flag);
    return raw === undefined ? positive(file[key], fallback) : positive(Number(raw), fallback);
  };
  return { once, config: {
    recon_interval_ms: numberValue("recon-interval-ms", "recon_interval_ms", DEFAULT_RECON_INTERVAL_MS),
    drain_grace_ms: numberValue("drain-grace-ms", "drain_grace_ms", DRAIN_GRACE_MS),
    stall_profile_ms: numberValue("stall-profile-ms", "stall_profile_ms", STALL_PROFILE_MS.narrow),
    turn_hang_ms: numberValue("turn-hang-ms", "turn_hang_ms", TURN_HANG_MS),
    command_timeout_ms: numberValue("command-timeout-ms", "command_timeout_ms", DEFAULT_COMMAND_TIMEOUT_MS),
    host: host as HostId,
    ledger: values.get("ledger") ?? join(home, "ledger.db"),
    spool: values.get("spool") ?? join(home, "spool"),
    // herdr prints JSON by default and rejects a --json flag (loop-1 E4).
    herdr_cmd: values.get("herdr-cmd") ?? "herdr agent list",
    orca_cmd: values.get("orca-cmd") ?? "orca worktree ps --json",
    cmux_sessions_file: values.get("cmux-sessions-file") ?? join(homedir(), ".cmuxterm", "*-hook-sessions.json"),
  } };
}

async function main(): Promise<void> {
  process.umask(0o077);
  let loaded;
  try { loaded = await loadConfig(Bun.argv.slice(2)); }
  catch (error) { console.error(`overload recon: ${(error as Error).message}`); process.exit(2); }
  const daemon = new ReconDaemon(loaded.config);
  do {
    const summary = await daemon.runOnce();
    if (loaded.once) console.log(`recon emitted ${summary.total} finding(s): ${JSON.stringify(summary.byKind)}`);
    if (!loaded.once) await Bun.sleep(loaded.config.recon_interval_ms);
  } while (!loaded.once);
}

if (import.meta.main) await main();
