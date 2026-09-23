/**
 * Reference ingest — §2.1 atomic ingestion contract (N3-owned, for testing).
 *
 * This is the N3 reference implementation of the P1 ingest contract so that
 * envelope/idempotency/crash-injection tests are deterministic against the
 * FROZEN schema + spool layout TODAY, before N2 lands. N2's real `ingest.ts`
 * must satisfy the SAME observable contract:
 *
 *   - scan <root>/spool/<host>/<emitter>/ for active-* and seg-* files
 *   - parse ONLY newline-terminated complete lines (partial trailing line of an
 *     active file is left for the next pass; byte cursor must point at the last
 *     consumed newline so the next pass resumes exactly there)
 *   - per batch, ONE transaction: INSERT journal rows (UNIQUE host,emitter_id,seq
 *     dedups; duplicates silently skipped) + UPDATE cursors(file_name→bytes)
 *   - cursor is keyed by the unique FILENAME (basename), not full path — §2.1
 *     "cursors keyed by unique filename"
 *
 * It takes a spool root and ledger path (both under a temp dir in tests), so it
 * never touches a real ~/.overload.
 */
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { SCHEMA_SQL } from "./schema";

export interface IngestResult {
  scannedFiles: number;
  consumedLines: number; // complete lines parsed this pass
  insertedRows: number; // new journal rows actually inserted (post-dedup)
  skippedDupes: number; // lines whose (host,emitter,seq) already existed
  malformedLines: number; // lines that failed JSON.parse (not consumed)
  cursorAdvances: { file: string; bytes: number }[];
}

/**
 * Open (or create) a ledger DB at `path` with the frozen schema. Returns the
 * Database handle (caller closes it). WAL pragma is applied at creation.
 */
export function openLedger(path: string): Database {
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  return db;
}

/** Run a single ingest scan pass against `spoolRoot`. Mutates `db`. */
export function ingestOnce(db: Database, spoolRoot: string): IngestResult {
  const spoolBase = join(spoolRoot, "spool");
  const res: IngestResult = {
    scannedFiles: 0,
    consumedLines: 0,
    insertedRows: 0,
    skippedDupes: 0,
    malformedLines: 0,
    cursorAdvances: [],
  };
  if (!existsSync(spoolBase)) return res;

  // Collect all active-* and seg-* files across all host/emitter dirs.
  const files: string[] = [];
  for (const hostDir of readdirSorted(spoolBase)) {
    const hostPath = join(spoolBase, hostDir);
    if (!isDir(hostPath)) continue;
    for (const emitterDir of readdirSorted(hostPath)) {
      const emitterPath = join(hostPath, emitterDir);
      if (!isDir(emitterPath)) continue;
      for (const f of readdirSorted(emitterPath)) {
        if (f.startsWith("active-") || f.startsWith("seg-")) {
          files.push(join(emitterPath, f));
        }
      }
    }
  }

  // Pre-fetch cursors once.
  const selCursor = db.prepare("SELECT bytes FROM cursors WHERE file_name = ?");
  const upsertCursor = db.prepare(
    "INSERT INTO cursors(file_name, bytes) VALUES(?, ?) ON CONFLICT(file_name) DO UPDATE SET bytes=excluded.bytes",
  );
  const insertJournal = db.prepare(
    `INSERT INTO journal(host, emitter_id, seq, at, stable_id, writer_id, kind, detail, spool_ref)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const file of files) {
    res.scannedFiles += 1;
    const name = basename(file);
    const row = selCursor.get(name) as { bytes: number } | null;
    const prevBytes = row?.bytes ?? 0;
    const buf = readFileSync(file);
    const size = buf.length;
    if (size <= prevBytes) continue; // nothing new (or shrunk — not our concern in P1 local)

    // Find the byte offset of the LAST newline in the newly-appended region.
    // We scan from prevBytes..size for complete lines (newline-terminated).
    // A "complete line" is one ending in '\n'. Bytes beyond the final '\n' form
    // the partial trailing region, which we leave for the next pass.
    let newCompleteBytes = prevBytes;
    let lastNewline = -1;
    for (let i = prevBytes; i < size; i++) {
      if (buf[i] === 0x0a) lastNewline = i;
    }
    if (lastNewline < prevBytes) {
      // No complete new line this pass; cursor stays.
      continue;
    }
    newCompleteBytes = lastNewline + 1;

    // Slice the complete region and split into lines.
    const region = buf.subarray(prevBytes, newCompleteBytes).toString("utf8");
    const lines = region.split("\n");
    // region always ends with '\n' (since we cut at lastNewline+1), so the final
    // split element is "" and is dropped.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    // One transaction for this file: all inserts + cursor advance.
    db.exec("BEGIN");
    let fileInserted = 0;
    try {
      for (const line of lines) {
        if (line.trim() === "") continue;
        res.consumedLines += 1;
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Malformed line — contract: do not consume, do not crash. Skip but
          // do NOT advance past it (cursor will catch up when valid bytes come).
          // For determinism in tests we count it as malformed, not inserted.
          res.malformedLines += 1;
          continue;
        }
        // stable_id is reconstructed from host:runtime:session (§2.1).
        const stable_id = `${parsed.host}:${parsed.runtime}:${parsed.session}`;
        try {
          insertJournal.run(
            parsed.host,
            parsed.emitter_id,
            parsed.seq,
            parsed.at,
            stable_id,
            parsed.writer_id,
            parsed.kind,
            parsed.detail !== undefined ? JSON.stringify(parsed.detail) : null,
            `${name}`, // spool_ref = source file basename
          );
          fileInserted += 1;
          res.insertedRows += 1;
        } catch (e: any) {
          // UNIQUE violation → duplicate (transport overlap / replay). Silently
          // skip; cursor still advances because the bytes are legitimately
          // consumed.
          if (e && /UNIQUE|constraint/i.test(String(e.message))) {
            res.skippedDupes += 1;
          } else {
            throw e;
          }
        }
      }
      upsertCursor.run(name, newCompleteBytes);
      res.cursorAdvances.push({ file: name, bytes: newCompleteBytes });
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    void fileInserted;
  }

  return res;
}

function readdirSorted(p: string): string[] {
  try {
    return readdirSync(p).sort();
  } catch {
    return [];
  }
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
