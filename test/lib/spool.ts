/**
 * Synthetic spool generator — §2.1 spool layout:
 *   <root>/spool/<host_id>/<emitter_id>/active-<emitter_id>-<n>.ndjson
 *   <root>/spool/<host_id>/<emitter_id>/seg-<emitter_id>-<n>.ndjson
 *
 * Cursors are keyed by unique filename (path components never reused). Tests use
 * this to build realistic overlapping active+sealed segments that ingest must
 * de-duplicate by the journal UNIQUE(host, emitter_id, seq) key.
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope, HostId } from "../../src/shared/types";

export interface SpoolPaths {
  spoolRoot: string;
  host: HostId;
  emitterId: string;
}

export function spoolDir(p: SpoolPaths): string {
  return join(p.spoolRoot, "spool", p.host, p.emitterId);
}

export function activeName(emitterId: string, n: number): string {
  return `active-${emitterId}-${n}.ndjson`;
}
export function sealedName(emitterId: string, n: number): string {
  return `seg-${emitterId}-${n}.ndjson`;
}

export interface WriteSegOpts {
  /** If true, write WITHOUT trailing newline on the last line (partial trailing line). */
  partialTrailingLine?: boolean;
  /** If provided, only the first `nCompleteLines` lines get a trailing newline. */
  nCompleteLines?: number;
}

/**
 * Append the given envelopes (serialized as NDJSON) to an active segment file.
 * By default each line is newline-terminated. If `partialTrailingLine` is set,
 * the LAST envelope is written WITHOUT a trailing newline — this models the
 * "rsync snapshot truncated mid-line" case from §5.4 / residual risk 4: the
 * ingest line parser must NOT consume it, but it becomes consumable once the
 * newline arrives on the next pass.
 */
export function appendActive(
  p: SpoolPaths,
  n: number,
  envelopes: EventEnvelope[],
  opts: WriteSegOpts = {},
): string {
  const dir = spoolDir(p);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, activeName(p.emitterId, n));
  const lines = envelopes.map((e) => JSON.stringify(e));
  let payload: string;
  if (opts.partialTrailingLine && lines.length > 0) {
    const complete = opts.nCompleteLines ?? lines.length - 1;
    const head = lines.slice(0, Math.max(complete, 0)).map((l) => l + "\n").join("");
    const tail = lines.slice(Math.max(complete, 0)).join("\n"); // no trailing newline
    payload = head + tail;
  } else {
    payload = lines.map((l) => l + "\n").join("");
  }
  if (existsSync(file)) appendFileSync(file, payload);
  else writeFileSync(file, payload);
  return file;
}

/** Seal (rename) an active segment n → seg-n. Returns the sealed path. */
export function sealSegment(p: SpoolPaths, n: number): string {
  const dir = spoolDir(p);
  const from = join(dir, activeName(p.emitterId, n));
  const to = join(dir, sealedName(p.emitterId, n));
  renameSync(from, to);
  return to;
}

/** Write a fully sealed segment in one shot. */
export function writeSealed(p: SpoolPaths, n: number, envelopes: EventEnvelope[]): string {
  const dir = spoolDir(p);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, sealedName(p.emitterId, n));
  const payload = envelopes.map((e) => JSON.stringify(e) + "\n").join("");
  writeFileSync(file, payload);
  return file;
}

/**
 * Build the canonical overlapping layout used by idempotency tests:
 *  - seg-1 contains seqs [1..mid]
 *  - active-2 contains seqs [overlapStart..end]  (overlapping range, same emitter)
 * Transport reads BOTH (§2.1: rsync pulls seg-* AND active-*); UNIQUE dedups.
 * Returns the directory so tests can point ingest at it.
 */
export function buildOverlappingSpool(
  p: SpoolPaths,
  mid: number,
  overlapStart: number,
  end: number,
): { sealedFile: string; activeFile: string } {
  const sealed = writeSealed(
    p,
    1,
    range(1, mid).map((seq) => synthEnvelope(p, seq)),
  );
  const active = appendActive(
    p,
    2,
    range(overlapStart, end).map((seq) => synthEnvelope(p, seq)),
  );
  return { sealedFile: sealed, activeFile: active };
}

/** Lightweight envelope factory bound to a host+emitter (seq-driven). */
export function synthEnvelope(p: SpoolPaths, seq: number, kind: EventEnvelope["kind"] = "working"): EventEnvelope {
  return {
    v: 1,
    at: 1_700_000_000_000 + seq,
    host: p.host,
    runtime: "pi",
    session: "00000000-0000-4000-8000-000000000000",
    emitter_id: p.emitterId,
    writer_id: p.emitterId,
    seq,
    kind,
    dropped_total: 0,
    write_error_total: 0,
  };
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
