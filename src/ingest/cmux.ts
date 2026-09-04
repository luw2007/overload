import { Database } from "bun:sqlite";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { reduceJournal } from "./reducer";

type Generation = {
  generation_uuid: string;
  dev_inode: string | null;
  head_fp: string | null;
  fp_len: number | null;
  cursor_bytes: number;
  cursor_tail_fp: string | null;
};

type JournalEvent = {
  at: number;
  session: string;
  writerId: string;
  kind: string;
  detail: Record<string, unknown>;
  byteStart: number;
};

export type CmuxScanResult = { inserted: number; generation: string | null };

const ACTION_KINDS = new Set(["permissionRequest", "question", "exitPlan"]);
const RESOLVED_STATUSES = new Set(["approved", "answered", "resolved", "completed", "accepted"]);
const CANCELLED_STATUSES = new Set(["denied", "rejected", "cancelled", "canceled", "dismissed", "timedOut", "timed_out", "expired"]);

// Read-only probe on 2026-08-15 observed kinds sessionStart, userPrompt, stop,
// sessionEnd, toolUse, permissionRequest, toolResult, question, and exitPlan.
// Status objects observed were telemetry for lifecycle/tool rows and pending for
// all three actionable kinds; no terminal status was present in the local file.
// The terminal sets above therefore conservatively accept the protocol's named
// outcomes while unknown status keys are skipped rather than guessed.
export async function scanCmux(db: Database, path: string, reducerBatchSize = 500): Promise<CmuxScanResult> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { inserted: 0, generation: null };
    throw error;
  }

  try {
    const stat = await handle.stat();
    const devInode = `${stat.dev}:${stat.ino}`;
    let generation = db.query(`SELECT generation_uuid, dev_inode, head_fp, fp_len, cursor_bytes, cursor_tail_fp
      FROM source_generations WHERE path=? AND retired=0 ORDER BY first_seen DESC, rowid DESC LIMIT 1`).get(path) as Generation | null;
    const hadGeneration = generation != null;
    let headLine: Buffer | null = null;
    let changed = generation != null && (
      generation.dev_inode !== devInode || stat.size < generation.cursor_bytes
    );

    if (generation && !changed) {
      headLine = generation.head_fp != null && generation.fp_len != null
        ? await readExact(handle, generation.fp_len, 0, path)
        : await readHeadLine(handle, stat.size, path);
      changed = (
        (generation.head_fp != null && (headLine == null || headLine.length !== generation.fp_len || fingerprint(headLine) !== generation.head_fp)) ||
        (generation.cursor_tail_fp != null && fingerprint(await readLastLineBefore(handle, generation.cursor_bytes, path)) !== generation.cursor_tail_fp)
      );
    }

    let file: Buffer | null = null;
    if (!generation || changed) {
      file = await readExact(handle, stat.size, 0, path);
      const firstNewline = file.indexOf(0x0a);
      headLine = firstNewline >= 0 ? file.subarray(0, firstNewline + 1) : null;
      generation = {
        generation_uuid: randomUUID(), dev_inode: devInode,
        head_fp: headLine ? fingerprint(headLine) : null, fp_len: headLine?.length ?? null,
        cursor_bytes: 0, cursor_tail_fp: null,
      };
    } else if (generation.head_fp == null && headLine) {
      // Before the first complete line the contract pins the cursor at zero.
      generation.head_fp = fingerprint(headLine);
      generation.fp_len = headLine.length;
    }

    if (hadGeneration && !changed && stat.size === generation.cursor_bytes) {
      return { inserted: 0, generation: generation.generation_uuid };
    }

    const start = generation.cursor_bytes;
    const remaining = file?.subarray(start) ?? await readExact(handle, stat.size - start, start, path);
    const lastNewline = remaining.lastIndexOf(0x0a);
    const end = lastNewline < 0 ? start : start + lastNewline + 1;
    const events: JournalEvent[] = [];
    let offset = 0;
    if (end > start) {
      for (const line of remaining.subarray(0, end - start).toString("utf8").split("\n").slice(0, -1)) {
        const bytes = Buffer.byteLength(line) + 1;
        const event = translate(line, start + offset);
        if (event) events.push(event);
        offset += bytes;
      }
    }

    let inserted = 0;
    const commit = db.transaction(() => {
      if (changed) db.query("UPDATE source_generations SET retired=1 WHERE path=? AND retired=0").run(path);
      db.query(`INSERT INTO source_generations(path, generation_uuid, dev_inode, head_fp, fp_len, cursor_bytes, cursor_tail_fp, first_seen, retired)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(generation_uuid) DO UPDATE SET dev_inode=excluded.dev_inode, head_fp=excluded.head_fp,
          fp_len=excluded.fp_len, cursor_bytes=excluded.cursor_bytes, cursor_tail_fp=excluded.cursor_tail_fp`)
        .run(path, generation!.generation_uuid, devInode, generation!.head_fp, generation!.fp_len, end,
          end > start ? fingerprint(lastLineBefore(remaining, end - start)) : generation!.cursor_tail_fp, Date.now());
      const emitterId = `cmux-${generation!.generation_uuid}`;
      for (const event of events) {
        const stableId = `local:cmux:${event.session}`;
        const result = db.query(`INSERT OR IGNORE INTO journal(host, emitter_id, seq, at, stable_id, writer_id, kind, detail, spool_ref)
          VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)`).run(emitterId, event.byteStart, event.at, stableId,
            event.writerId, event.kind, JSON.stringify(event.detail), `${path}:${event.byteStart}`);
        if (Number(result.changes) === 0) continue;
        inserted++;
        if (event.kind === "session_started") {
          db.query(`INSERT INTO sessions(stable_id, host, runtime, session, origin, cwd, created_at, first_seen_at)
            VALUES (?, 'local', 'cmux', ?, 'unknown', ?, ?, ?)
            ON CONFLICT(stable_id) DO UPDATE SET cwd=COALESCE(excluded.cwd, sessions.cwd)`)
            .run(stableId, event.session, stringValue(event.detail.cwd), event.at, event.at);
          db.query(`INSERT INTO session_incarnations(stable_id, writer_id, liveness_domain, started_at, last_seen_at)
            VALUES (?, ?, 'lifecycle', ?, ?)
            ON CONFLICT(stable_id, writer_id) DO UPDATE SET last_seen_at=MAX(last_seen_at, excluded.last_seen_at)`)
            .run(stableId, event.writerId, event.at, event.at);
        } else {
          db.query("UPDATE session_incarnations SET last_seen_at=MAX(last_seen_at, ?) WHERE stable_id=? AND writer_id=?")
            .run(event.at, stableId, event.writerId);
        }
      }
    });
    commit.immediate();
    while (reduceJournal(db, reducerBatchSize) === reducerBatchSize) { /* drain */ }
    return { inserted, generation: generation.generation_uuid };
  } finally {
    await handle.close();
  }
}

function translate(line: string, byteStart: number): JournalEvent | null {
  let value: Record<string, unknown>;
  try { value = JSON.parse(line); } catch { return null; }
  const kind = stringValue(value.kind);
  const session = stringValue(value.workstreamId);
  if (!kind || !session) return null;
  const at = parseTime(value.updatedAt) ?? parseTime(value.createdAt) ?? Date.now();
  const writerId = `cmux-${session}`;
  const payload = objectValue(value.payload);
  const body = objectValue(payload[kind]);
  const status = Object.keys(objectValue(value.status))[0];

  if (ACTION_KINDS.has(kind)) {
    const requestId = stringValue(body.requestId) ?? `${session}#${byteStart}`;
    const detail: Record<string, unknown> = {
      request_id: requestId, request_kind: kind,
      tool_name: stringValue(body.toolName) ?? (kind === "question" ? "AskUserQuestion" : kind === "exitPlan" ? "ExitPlanMode" : undefined),
      summary: summaryFor(kind, body, value),
    };
    if (status === "pending") return { at, session, writerId, kind: "decision_requested", detail, byteStart };
    if (RESOLVED_STATUSES.has(status)) return { at, session, writerId, kind: "decision_resolved", detail: { ...detail, state: "resolved" }, byteStart };
    if (CANCELLED_STATUSES.has(status)) return { at, session, writerId, kind: "decision_resolved", detail: { ...detail, state: "cancelled" }, byteStart };
    return null;
  }
  if (kind === "sessionStart") return { at, session, writerId, kind: "session_started", detail: { cwd: stringValue(value.cwd) }, byteStart };
  if (kind === "sessionEnd") return { at, session, writerId, kind: "session_ended", detail: {}, byteStart };
  if (kind === "stop") return { at, session, writerId, kind: "settled", detail: {}, byteStart };
  return null;
}

function summaryFor(kind: string, body: Record<string, unknown>, row: Record<string, unknown>): string {
  let candidate = "";
  if (kind === "question") {
    const questions = Array.isArray(body.questions) ? body.questions : [];
    candidate = questions.map((question) => stringValue(objectValue(question).prompt)).filter(Boolean).join("; ");
  } else if (kind === "exitPlan") candidate = stringValue(body.plan) ?? "Exit plan approval";
  else candidate = stringValue(row.title) ?? stringValue(body.toolName) ?? "Permission request";
  return truncateUtf8(redact(candidate), 500);
}

function redact(value: string): string {
  return value
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function truncateUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return value;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function lastLineBefore(file: Buffer, cursor: number): Buffer {
  if (cursor <= 0 || cursor > file.length || file[cursor - 1] !== 0x0a) return Buffer.alloc(0);
  const previous = file.lastIndexOf(0x0a, cursor - 2);
  return file.subarray(previous + 1, cursor);
}

async function readExact(handle: Awaited<ReturnType<typeof open>>, length: number, position: number, path: string): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  if (length) {
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new Error(`short read from cmux workstream: ${path}`);
  }
  return buffer;
}

async function readHeadLine(handle: Awaited<ReturnType<typeof open>>, size: number, path: string): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let position = 0;
  while (position < size) {
    const chunk = await readExact(handle, Math.min(4096, size - position), position, path);
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(chunk.subarray(0, newline + 1));
      return Buffer.concat(chunks);
    }
    chunks.push(chunk);
    position += chunk.length;
  }
  return null;
}

async function readLastLineBefore(handle: Awaited<ReturnType<typeof open>>, cursor: number, path: string): Promise<Buffer> {
  if (cursor <= 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [Buffer.from("\n")];
  let end = cursor - 1;
  while (end > 0) {
    const start = Math.max(0, end - 4096);
    const chunk = await readExact(handle, end - start, start, path);
    const newline = chunk.lastIndexOf(0x0a);
    chunks.unshift(newline >= 0 ? chunk.subarray(newline + 1) : chunk);
    if (newline >= 0) break;
    end = start;
  }
  return Buffer.concat(chunks);
}

function fingerprint(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function parseTime(value: unknown): number | null { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; }
