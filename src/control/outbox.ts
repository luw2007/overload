import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const LEASE_MS = 30_000;
const BATCH_SIZE = 100;

/**
 * Canonical (sorted-key) JSON with exactly JSON.stringify's value semantics, so the stored text, the hash input
 * and what a JSON.parse round trip yields are one value: `toJSON` is honoured, undefined/function/symbol object
 * members are dropped, such array slots and non-finite numbers become null. A value JSON cannot represent at all
 * (top-level undefined/function/symbol, bigint, cycles) throws ControlEventVerificationError.
 */
export function canonicalJson(value: unknown): string {
  const text = canonicalValue(value, "", []);
  if (text === undefined) throw new ControlEventVerificationError(`control payload value is not JSON-serializable (${typeof value})`);
  return text;
}
function canonicalValue(value: unknown, key: string, stack: object[]): string | undefined {
  if (typeof value === "object" && value !== null && "toJSON" in value && typeof value.toJSON === "function") value = value.toJSON(key);
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") throw new ControlEventVerificationError("control payload contains a bigint");
  if (value === null || typeof value !== "object") return JSON.stringify(value); // NaN/±Infinity → "null", like JSON.stringify
  if (stack.includes(value)) throw new ControlEventVerificationError("control payload contains a cycle");
  stack.push(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry, index) => canonicalValue(entry, String(index), stack) ?? "null").join(",")}]`;
    const row = value as Record<string, unknown>;
    const members: string[] = [];
    for (const member of Object.keys(row).sort()) {
      const text = canonicalValue(row[member], member, stack);
      if (text !== undefined) members.push(`${JSON.stringify(member)}:${text}`);
    }
    return `{${members.join(",")}}`;
  } finally { stack.pop(); }
}
/** SHA-256 over canonical JSON; the single control payload hash algorithm. */
export function controlPayloadHash(payload: Record<string, unknown>): string { return createHash("sha256").update(canonicalJson(payload)).digest("hex"); }
/** Byte-level control event identity used by `enqueueControlEvent`. */
export function controlEventId(producerId: string, entityId: string, entityVersion: number, kind: string): string {
  return createHash("sha256").update(`${producerId}\0${entityId}\0${String(entityVersion)}\0${kind}`).digest("hex");
}

export type VerifiedControlOutboxEvent = {
  event_id: string; producer_id: string; entity_id: string; entity_version: number;
  kind: string; work_id: string | null; item_id: string | null;
  payload: Record<string, unknown>; payload_hash: string;
};

/** Typed verification failure: callers must treat it as `invalid_response`, never as "not yet". */
export class ControlEventVerificationError extends Error {
  readonly code = "invalid_response" as const;
  constructor(message: string) { super(message); this.name = "ControlEventVerificationError"; }
}

const HEX64 = /^[0-9a-f]{64}$/;
function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function verifyFields(fields: {
  event_id: unknown; producer_id: unknown; entity_id: unknown; entity_version: unknown; kind: unknown;
  work_id: unknown; item_id: unknown; payload: unknown; payload_hash: unknown;
}, expectedProducerId: string | null): VerifiedControlOutboxEvent {
  const fail = (reason: string): never => { throw new ControlEventVerificationError(`control event ${reason}`); };
  const { event_id, producer_id, entity_id, entity_version, kind, work_id, item_id, payload, payload_hash } = fields;
  if (typeof event_id !== "string" || !HEX64.test(event_id)) fail("event_id is not a control identity hash");
  if (typeof producer_id !== "string" || !producer_id) fail("producer_id is invalid");
  if (typeof entity_id !== "string" || !entity_id) fail("entity_id is invalid");
  if (typeof entity_version !== "number" || !Number.isSafeInteger(entity_version) || entity_version < 1) fail("entity_version is invalid");
  if (typeof kind !== "string" || !kind) fail("kind is invalid");
  if (work_id !== null && (typeof work_id !== "string" || !work_id)) fail("work_id is invalid");
  if (item_id !== null && (typeof item_id !== "string" || !item_id)) fail("item_id is invalid");
  if (!plainObject(payload)) fail("payload is not an object");
  if (typeof payload_hash !== "string" || !HEX64.test(payload_hash)) fail("payload_hash is invalid");
  const verified = { event_id, producer_id, entity_id, entity_version, kind, work_id, item_id, payload, payload_hash } as VerifiedControlOutboxEvent;
  if (expectedProducerId !== null && verified.producer_id !== expectedProducerId) fail("producer does not match this control database");
  if (controlPayloadHash(verified.payload) !== verified.payload_hash) fail("payload hash mismatch");
  if (controlEventId(verified.producer_id, verified.entity_id, verified.entity_version, verified.kind) !== verified.event_id) fail("event_id does not match its identity");
  return verified;
}

/**
 * Verifies a raw `control_outbox` row against this control DB's producer: strict envelope types,
 * canonical stored payload, SHA-256(canonicalJson(payload)) and the enqueue identity algorithm.
 */
export function verifyControlOutboxEvent(db: Database, row: Record<string, unknown>): VerifiedControlOutboxEvent {
  if (!plainObject(row)) throw new ControlEventVerificationError("control event row is not an object");
  const identity = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='control_identity'").get()
    ? db.query("SELECT producer_id FROM control_identity WHERE id=1").get() as { producer_id: unknown } | null
    : null;
  if (!identity || typeof identity.producer_id !== "string" || !identity.producer_id) throw new ControlEventVerificationError("control producer identity is missing");
  if (typeof row.payload !== "string") throw new ControlEventVerificationError("control event payload is not stored JSON text");
  let payload: unknown;
  try { payload = JSON.parse(row.payload); } catch { throw new ControlEventVerificationError("control event payload is malformed JSON"); }
  if (!plainObject(payload) || canonicalJson(payload) !== row.payload) throw new ControlEventVerificationError("control event payload is not canonical object JSON");
  const verified = verifyFields({ ...row, payload } as Parameters<typeof verifyFields>[0], identity.producer_id);
  // event_id does not cover the payload: the stored row for this identity must be exactly this event (no second payload).
  const stored = db.query("SELECT payload,payload_hash,work_id,item_id FROM control_outbox WHERE event_id=?").get(verified.event_id) as Record<string, unknown> | null;
  if (!stored) throw new ControlEventVerificationError("control event is not recorded in this control outbox");
  if (stored.payload !== row.payload || stored.payload_hash !== verified.payload_hash || stored.work_id !== verified.work_id || stored.item_id !== verified.item_id) {
    throw new ControlEventVerificationError("control event differs from the recorded event with the same identity");
  }
  return verified;
}

/**
 * Verifies a published control envelope (`publishControlEvents` detail) where no producer registry is
 * available (ledger side): strict types, payload hash and identity algorithm. Because event_id does not
 * cover the payload, a second payload for an applied identity is caught by the projection's event-id dedup.
 */
export function verifyControlEventEnvelope(detail: Record<string, unknown>): VerifiedControlOutboxEvent {
  if (!plainObject(detail)) throw new ControlEventVerificationError("control envelope is not an object");
  return verifyFields({ ...detail, kind: detail.event_kind } as Parameters<typeof verifyFields>[0], null);
}

export function ensureOutbox(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_identity(
    id INTEGER PRIMARY KEY CHECK(id=1), producer_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS control_outbox(
    event_id TEXT PRIMARY KEY, producer_id TEXT NOT NULL, entity_id TEXT NOT NULL,
    entity_version INTEGER NOT NULL, kind TEXT NOT NULL, work_id TEXT, item_id TEXT,
    payload TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
    published_at INTEGER, delivered_at INTEGER, lease_owner TEXT, lease_until INTEGER,
    UNIQUE(producer_id, entity_id, entity_version, kind)
  );
  CREATE INDEX IF NOT EXISTS control_outbox_delivery ON control_outbox(delivered_at, lease_until, created_at);
  -- Terminal rejection record. A rejected row also gets delivered_at (the terminal timestamp) so no pass re-leases,
  -- re-emits or retains it; source says whether local verification (producer) or the ledger reducer refused it.
  CREATE TABLE IF NOT EXISTS control_outbox_rejections(
    event_id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('producer','ledger')),
    reason TEXT NOT NULL, rejected_at INTEGER NOT NULL
  );`);
  db.query("INSERT OR IGNORE INTO control_identity(id, producer_id) VALUES (1, ?)").run(randomUUID());
}

function rejectOutboxEvent(db: Database, eventId: string, source: "producer" | "ledger", reason: string, now: number): boolean {
  return db.transaction(() => {
    const terminal = db.query("UPDATE control_outbox SET delivered_at=?,lease_owner=NULL,lease_until=NULL WHERE event_id=? AND delivered_at IS NULL").run(now, eventId);
    if (!terminal.changes) return false;
    db.query("INSERT OR REPLACE INTO control_outbox_rejections(event_id,source,reason,rejected_at) VALUES (?,?,?,?)").run(eventId, source, reason, now);
    return true;
  })();
}

export function enqueueControlEvent(db: Database, input: {
  entity_id: string; entity_version: number; kind: string; work_id?: string;
  item_id?: string; payload: Record<string, unknown>;
}, now = Date.now()): string {
  ensureOutbox(db);
  if (!input.entity_id || !input.kind || !Number.isSafeInteger(input.entity_version) || input.entity_version < 1) {
    throw new Error("invalid control event identity");
  }
  const producer = db.query("SELECT producer_id FROM control_identity WHERE id=1").get() as { producer_id: string };
  const eventId = controlEventId(producer.producer_id, input.entity_id, input.entity_version, input.kind);
  // Fail the producer's transaction on a payload JSON cannot carry, instead of storing text that poisons the outbox.
  if (!plainObject(input.payload)) throw new ControlEventVerificationError("control payload is not an object");
  const payload = canonicalJson(input.payload);
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const existing = db.query("SELECT payload_hash FROM control_outbox WHERE event_id=?").get(eventId) as { payload_hash: string } | null;
  if (existing && existing.payload_hash !== payloadHash) throw new Error(`control event identity collision: ${eventId}`);
  db.query(`INSERT OR IGNORE INTO control_outbox(event_id,producer_id,entity_id,entity_version,kind,work_id,item_id,payload,payload_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(eventId, producer.producer_id, input.entity_id, input.entity_version, input.kind,
      input.work_id ?? null, input.item_id ?? null, payload, payloadHash, now);
  return eventId;
}

export function publishControlEvents(db: Database, ledgerPath: string, emit: (detail: Record<string, unknown>) => unknown, now = Date.now()): { published: number; delivered: number; rejected: number } {
  ensureOutbox(db);
  let ledger: Database | null = null;
  try {
    ledger = new Database(ledgerPath, { readonly: true });
  } catch { /* unavailable confirmation must retain events */ }

  let delivered = 0, rejected = 0;
  if (ledger) {
    try {
      const pending = db.query("SELECT event_id,payload_hash FROM control_outbox WHERE delivered_at IS NULL").all() as Array<{event_id:string;payload_hash:string}>;
      const applied = ledger.query("SELECT payload_hash FROM applied_control_events WHERE event_id=?");
      // The reducer's terminal verdict: a rejected event is never retried, so it must not be re-leased either.
      const refused = ledger.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rejected_control_events'").get()
        ? ledger.query("SELECT payload_hash,reason FROM rejected_control_events WHERE event_id=?") : null;
      for (const row of pending) {
        const confirmation = applied.get(row.event_id) as { payload_hash: string } | null;
        if (!confirmation) {
          const rejection = refused?.get(row.event_id) as { payload_hash: string | null; reason: string } | null | undefined;
          if (rejection && (rejection.payload_hash === null || rejection.payload_hash === row.payload_hash)
            && rejectOutboxEvent(db, row.event_id, "ledger", rejection.reason, now)) rejected++;
          continue;
        }
        if (confirmation.payload_hash !== row.payload_hash) throw new Error(`ledger payload mismatch for ${row.event_id}`);
        db.query("UPDATE control_outbox SET delivered_at=?,lease_owner=NULL,lease_until=NULL WHERE event_id=? AND delivered_at IS NULL").run(now, row.event_id);
        delivered++;
      }
    } finally { ledger.close(); }
  }

  const retained = db.query("SELECT COALESCE(SUM(length(payload)),0) AS bytes FROM control_outbox WHERE delivered_at IS NULL").get() as { bytes: number };
  if (retained.bytes > MAX_RETAINED_BYTES) throw new Error(`control outbox retained-byte limit exceeded: ${retained.bytes}`);

  const owner = randomUUID();
  const claim = db.transaction(() => {
    const rows = db.query(`SELECT event_id FROM control_outbox WHERE delivered_at IS NULL
      AND (lease_until IS NULL OR lease_until<?) ORDER BY created_at,event_id LIMIT ?`).all(now, BATCH_SIZE) as Array<{event_id:string}>;
    const update = db.query("UPDATE control_outbox SET lease_owner=?,lease_until=? WHERE event_id=? AND delivered_at IS NULL AND (lease_until IS NULL OR lease_until<?)");
    return rows.filter((row) => Number(update.run(owner, now + LEASE_MS, row.event_id, now).changes) === 1).map((row) => row.event_id);
  });
  const ids = claim.immediate() as string[];
  let published = 0;
  const get = db.query("SELECT * FROM control_outbox WHERE event_id=? AND lease_owner=?");
  for (const id of ids) {
    const row = get.get(id, owner) as Record<string, unknown> | null;
    if (!row) continue;
    let event: VerifiedControlOutboxEvent;
    try {
      event = verifyControlOutboxEvent(db, row);
    } catch (error) {
      // A row that fails local verification (e.g. legacy non-JSON payload text) can never succeed: make it terminal
      // so it never blocks the rows behind it. Anything else (storage) releases the lease and aborts the pass.
      if (!(error instanceof ControlEventVerificationError)) {
        db.query("UPDATE control_outbox SET lease_owner=NULL,lease_until=NULL WHERE event_id=? AND lease_owner=?").run(id, owner);
        throw error;
      }
      if (rejectOutboxEvent(db, id, "producer", error.message, now)) rejected++;
      continue;
    }
    const detail = {
      event_id: event.event_id, producer_id: event.producer_id, entity_id: event.entity_id,
      entity_version: event.entity_version, event_kind: event.kind, work_id: event.work_id,
      item_id: event.item_id, payload: event.payload, payload_hash: event.payload_hash,
    };
    try {
      emit(detail);
      db.query("UPDATE control_outbox SET published_at=? WHERE event_id=? AND lease_owner=?").run(now, id, owner);
      published++;
    } catch (error) {
      db.query("UPDATE control_outbox SET lease_owner=NULL,lease_until=NULL WHERE event_id=? AND lease_owner=?").run(id, owner);
      throw error;
    }
  }
  return { published, delivered, rejected };
}
