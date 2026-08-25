#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { constants as fsConstants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { reduceJournal } from "./reducer";
import { appendClassifierActivated, CLASSIFIER_VERSION } from "./classifier";
import { scanCmux } from "./cmux";
import { PROGRESS_KINDS } from "../shared/types";
import { pruneSpool } from "./prune";

const DEFAULT_SCAN_INTERVAL_MS = 2_000;
const DEFAULT_REDUCER_BATCH_SIZE = 500;
const DEFAULT_PRUNE_INTERVAL_MS = 3_600_000;
const DEFAULT_SPOOL_RETENTION_MS = 86_400_000;
const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;
const SEGMENT_FILE = /^(?:active|seg)-[A-Za-z0-9._-]+-\d+(?:-recovered)?\.ndjson$/;

export type IngestConfig = {
  scan_interval_ms: number;
  reducer_batch_size: number;
  cmux_workstream_path: string;
  /** How often consumed spool bytes are swept. */
  prune_interval_ms: number;
  /** How long a consumed spool file is kept before it is swept. */
  spool_retention_ms: number;
};

type SpoolFile = { path: string; size: number };

type Envelope = {
  v: 1;
  at: number;
  host: string;
  runtime: string;
  session: string;
  emitter_id: string;
  writer_id: string;
  seq: number;
  kind: string;
  detail?: Record<string, unknown>;
};

export type PendingFile = {
  key: string;
  path: string;
  end: number;
  events: Array<{ envelope: Envelope; lineStart: number }>;
};

export async function loadConfig(path = join(homedir(), ".overload", "config.json")): Promise<IngestConfig> {
  let value: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`overload ingest: ignoring invalid config ${path}`);
    }
  }
  return {
    scan_interval_ms: positiveInteger(value.scan_interval_ms, DEFAULT_SCAN_INTERVAL_MS),
    reducer_batch_size: positiveInteger(value.reducer_batch_size, DEFAULT_REDUCER_BATCH_SIZE),
    cmux_workstream_path: typeof value.cmux_workstream_path === "string" && value.cmux_workstream_path.length > 0
      ? value.cmux_workstream_path : join(homedir(), ".cmuxterm", "workstream.jsonl"),
    prune_interval_ms: positiveInteger(value.prune_interval_ms, DEFAULT_PRUNE_INTERVAL_MS),
    spool_retention_ms: positiveInteger(value.spool_retention_ms, DEFAULT_SPOOL_RETENTION_MS),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export async function openLedger(path = join(homedir(), ".overload", "ledger.db")): Promise<Database> {
  const directory = resolve(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`refusing symlink ledger: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const db = new Database(path, { create: true });
  initializeLedger(db);
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try { await chmod(file, 0o600); } catch { /* Sidecars are created lazily. */ }
  }
  return db;
}

export function initializeLedger(db: Database): void {
  const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
  db.exec(requireText(schemaPath));
  migrateProgressColumn(db);
  dropNotificationOutbox(db);
  db.query("INSERT OR IGNORE INTO reducer_cursor(id, journal_seq) VALUES (1, 0)").run();
}

/** The outbox had no delivery daemon and no reader; its rows and the reminder
 *  clock that fed it are unreachable state, so they leave with it. */
function dropNotificationOutbox(db: Database): void {
  db.exec("DROP TABLE IF EXISTS notifications");
  const columns = db.query("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "next_reminder_at")) {
    db.exec("ALTER TABLE requests DROP COLUMN next_reminder_at");
  }
}

/** Ledgers created before the liveness/progress split carry no progress clock.
 *  Backfill it from the journal so hang detection starts from a real event. */
function migrateProgressColumn(db: Database): void {
  const columns = db.query("PRAGMA table_info(current)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "last_progress_at")) return;
  db.exec("ALTER TABLE current ADD COLUMN last_progress_at INTEGER");
  const kinds = Object.keys(PROGRESS_KINDS).map((kind) => `'${kind}'`).join(",");
  db.exec(`UPDATE current SET last_progress_at=(SELECT MAX(j.at) FROM journal j
    WHERE j.stable_id=current.stable_id AND j.kind IN (${kinds}))`);
}

function requireText(path: string): string {
  return readFileSync(path, "utf8");
}

export function activateClassifier(db: Database, home = homedir(), spoolRoot = join(home, ".overload", "spool"), at = Date.now()): boolean {
  const existing = db.query("SELECT 1 FROM classifier_activations WHERE version=?").get(CLASSIFIER_VERSION);
  if (existing) return false;
  const watermark = (db.query("SELECT COALESCE(MAX(ingest_seq), 0) AS seq FROM journal").get() as { seq: number }).seq;
  appendClassifierActivated(CLASSIFIER_VERSION, at, home, spoolRoot);
  db.query("INSERT INTO classifier_activations(version, activated_at_journal_seq, activated_at) VALUES (?, ?, ?)")
    .run(CLASSIFIER_VERSION, watermark, at);
  return true;
}

export async function scanOnce(db: Database, spoolRoot = join(homedir(), ".overload", "spool"), reducerBatchSize = DEFAULT_REDUCER_BATCH_SIZE, cmuxWorkstreamPath?: string): Promise<{ files: number; inserted: number }> {
  const files = await discoverSpoolFiles(spoolRoot);
  const pending: PendingFile[] = [];
  const cursorFor = db.query("SELECT bytes FROM cursors WHERE file_name=?");
  for (const file of files) {
    const key = relative(resolve(spoolRoot), file.path).split(sep).join("/");
    const cursor = (cursorFor.get(key) as { bytes: number } | null)?.bytes ?? 0;
    // A file already read to its last observed byte has nothing to offer; not
    // opening it is what keeps the scan flat as the spool grows.
    if (cursor === file.size) continue;
    const parsed = await readCompleteLines(file.path, key, cursor);
    if (parsed) pending.push(parsed);
  }

  let inserted = 0;
  const transaction = db.transaction(() => {
    for (const file of pending) {
      for (const event of file.events) {
        if (insertEnvelope(db, event.envelope, `${file.key}:${event.lineStart}`)) inserted++;
      }
      db.query(`INSERT INTO cursors(file_name, bytes) VALUES (?, ?)
        ON CONFLICT(file_name) DO UPDATE SET bytes=excluded.bytes`).run(file.key, file.end);
    }
  });
  transaction.immediate();

  while (reduceJournal(db, reducerBatchSize) === reducerBatchSize) { /* drain */ }
  if (cmuxWorkstreamPath) inserted += (await scanCmux(db, cmuxWorkstreamPath, reducerBatchSize)).inserted;
  return { files: pending.length, inserted };
}

async function discoverSpoolFiles(root: string): Promise<SpoolFile[]> {
  const found: SpoolFile[] = [];
  let hosts;
  try { hosts = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return found;
    throw error;
  }
  for (const host of hosts.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!host.isDirectory() || !SAFE_COMPONENT.test(host.name)) continue;
    const hostPath = join(root, host.name);
    for (const emitter of (await readdir(hostPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!emitter.isDirectory() || !SAFE_COMPONENT.test(emitter.name)) continue;
      const emitterPath = join(hostPath, emitter.name);
      for (const entry of (await readdir(emitterPath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !SEGMENT_FILE.test(entry.name)) continue;
        const path = join(emitterPath, entry.name);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        found.push({ path, size: stat.size });
      }
    }
  }
  return found;
}

export async function readCompleteLines(path: string, key: string, cursor: number): Promise<PendingFile | null> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    // The emitter can seal (rename active-*.ndjson -> seg-*.ndjson) between
    // discoverSpoolFiles listing this path and this open call. The sealed
    // file reappears under its new name on the next scan; content and the
    // (host, emitter_id, seq) unique constraint make re-reading it from
    // scratch idempotent, so a vanished active file is a skip, not a crash.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    const start = stat.size < cursor ? 0 : cursor;
    if (stat.size === start) return null;
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const chunk = buffer.subarray(0, bytesRead);
    const newline = chunk.lastIndexOf(0x0a);
    if (newline < 0) return null;
    const complete = chunk.subarray(0, newline + 1);
    const events: PendingFile["events"] = [];
    let offset = 0;
    for (const bytes of complete.toString("utf8").split("\n").slice(0, -1)) {
      const lineBytes = Buffer.byteLength(bytes) + 1;
      const envelope = parseEnvelope(bytes, key);
      if (envelope) events.push({ envelope, lineStart: start + offset });
      offset += lineBytes;
    }
    return { key, path, end: start + complete.length, events };
  } finally {
    await handle.close();
  }
}

function parseEnvelope(line: string, key: string): Envelope | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const parts = key.split("/");
    if (value.v !== 1 || !Number.isSafeInteger(value.at) || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1 ||
      typeof value.host !== "string" || value.host !== parts[0] || typeof value.runtime !== "string" ||
      typeof value.session !== "string" || !value.session || typeof value.emitter_id !== "string" || value.emitter_id !== parts[1] ||
      typeof value.writer_id !== "string" || !value.writer_id || typeof value.kind !== "string" || !value.kind) return null;
    return value as unknown as Envelope;
  } catch {
    return null;
  }
}

function insertEnvelope(db: Database, envelope: Envelope, spoolRef: string): boolean {
  const stableId = `${envelope.host}:${envelope.runtime}:${envelope.session}`;
  const detail = envelope.detail && typeof envelope.detail === "object" && !Array.isArray(envelope.detail)
    ? envelope.detail : {};
  const result = db.query(`INSERT OR IGNORE INTO journal(host, emitter_id, seq, at, stable_id, writer_id, kind, detail, spool_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(envelope.host, envelope.emitter_id, envelope.seq, envelope.at,
      stableId, envelope.writer_id, envelope.kind, JSON.stringify(detail), spoolRef);
  if (Number(result.changes) === 0) return false;

  if (envelope.kind === "session_started") {
    const origin = typeof detail.origin === "string" ? detail.origin : typeof detail.parent === "string" ? detail.parent : "unknown";
    db.query(`INSERT INTO sessions(stable_id, host, runtime, session, origin, cwd, branch, created_at, first_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stable_id) DO UPDATE SET origin=CASE WHEN sessions.origin='unknown' THEN excluded.origin ELSE sessions.origin END,
        cwd=COALESCE(excluded.cwd, sessions.cwd), branch=COALESCE(excluded.branch, sessions.branch)`)
      .run(stableId, envelope.host, envelope.runtime, envelope.session, origin,
        stringOrNull(detail.cwd), stringOrNull(detail.branch), envelope.at, envelope.at);
    const domain = envelope.runtime === "claude" ? "lifecycle" : "process";
    // Contract (types.ts session_started): the incarnation lease is nested as
    // detail.lease = {pid, proc_boot_id}; flat detail.pid kept for admin/harness emitters.
    const lease = detail.lease && typeof detail.lease === "object" && !Array.isArray(detail.lease)
      ? detail.lease as Record<string, unknown> : {};
    db.query(`INSERT INTO session_incarnations(stable_id, writer_id, liveness_domain, pid, proc_boot_id, started_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stable_id, writer_id) DO UPDATE SET last_seen_at=MAX(last_seen_at, excluded.last_seen_at)`)
      .run(stableId, envelope.writer_id, domain, integerOrNull(lease.pid ?? detail.pid),
        stringOrNull(lease.proc_boot_id ?? detail.proc_boot_id), envelope.at, envelope.at);
  } else {
    db.query("UPDATE session_incarnations SET last_seen_at=MAX(last_seen_at, ?) WHERE stable_id=? AND writer_id=?")
      .run(envelope.at, stableId, envelope.writer_id);
  }
  return true;
}

function stringOrNull(value: unknown): string | null { return typeof value === "string" ? value : null; }
function integerOrNull(value: unknown): number | null { return Number.isSafeInteger(value) ? value as number : null; }

async function main(): Promise<void> {
  process.umask(0o077);
  const args = Bun.argv.slice(2);
  if (args.some((argument) => argument !== "--once") || args.filter((argument) => argument === "--once").length > 1) {
    console.error("usage: bun src/ingest/ingest.ts [--once]");
    process.exit(2);
  }
  const once = args.includes("--once");
  const home = join(homedir(), ".overload");
  const config = await loadConfig(join(home, "config.json"));
  const db = await openLedger(join(home, "ledger.db"));
  activateClassifier(db, homedir(), join(home, "spool"));
  const heartbeatPath = join(home, "ingest.heartbeat");
  const spool = join(home, "spool");
  let host = "local";
  try { host = (await readFile(join(home, "host"), "utf8")).trim() || "local"; } catch { /* single-machine default */ }
  let lastPruneAt = 0;
  const run = async () => {
    const result = await scanOnce(db, spool, config.reducer_batch_size, config.cmux_workstream_path);
    // Watchdog liveness contract (review P2 m4): the ingest loop owns this touch.
    try { await Bun.write(heartbeatPath, String(Date.now())); } catch { /* watchdog will alarm */ }
    if (once) console.log(`ingested ${result.inserted} new event(s) from ${result.files} file(s)`);
    if (Date.now() - lastPruneAt < config.prune_interval_ms) return;
    lastPruneAt = Date.now();
    const swept = await pruneSpool(db, spool, { host, retentionMs: config.spool_retention_ms });
    if (swept.files || once) console.log(`pruned ${swept.files} consumed spool file(s), ${swept.directories} directory(ies)`);
  };
  try {
    do {
      await run();
      if (!once) await Bun.sleep(config.scan_interval_ms);
    } while (!once);
  } finally {
    db.close();
  }
}

if (import.meta.main) await main();
