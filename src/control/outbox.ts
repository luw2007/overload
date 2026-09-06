import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const LEASE_MS = 30_000;
const BATCH_SIZE = 100;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

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
  CREATE INDEX IF NOT EXISTS control_outbox_delivery ON control_outbox(delivered_at, lease_until, created_at);`);
  db.query("INSERT OR IGNORE INTO control_identity(id, producer_id) VALUES (1, ?)").run(randomUUID());
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
  const identity = `${producer.producer_id}\0${input.entity_id}\0${input.entity_version}\0${input.kind}`;
  const eventId = createHash("sha256").update(identity).digest("hex");
  const payload = canonical(input.payload);
  const payloadHash = hash(input.payload);
  const existing = db.query("SELECT payload_hash FROM control_outbox WHERE event_id=?").get(eventId) as { payload_hash: string } | null;
  if (existing && existing.payload_hash !== payloadHash) throw new Error(`control event identity collision: ${eventId}`);
  db.query(`INSERT OR IGNORE INTO control_outbox(event_id,producer_id,entity_id,entity_version,kind,work_id,item_id,payload,payload_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(eventId, producer.producer_id, input.entity_id, input.entity_version, input.kind,
      input.work_id ?? null, input.item_id ?? null, payload, payloadHash, now);
  return eventId;
}

export function publishControlEvents(db: Database, ledgerPath: string, emit: (detail: Record<string, unknown>) => unknown, now = Date.now()): { published: number; delivered: number } {
  ensureOutbox(db);
  let ledger: Database | null = null;
  try {
    ledger = new Database(ledgerPath, { readonly: true });
  } catch { /* unavailable confirmation must retain events */ }

  let delivered = 0;
  if (ledger) {
    try {
      const pending = db.query("SELECT event_id,payload_hash FROM control_outbox WHERE delivered_at IS NULL").all() as Array<{event_id:string;payload_hash:string}>;
      const applied = ledger.query("SELECT payload_hash FROM applied_control_events WHERE event_id=?");
      for (const row of pending) {
        const confirmation = applied.get(row.event_id) as { payload_hash: string } | null;
        if (!confirmation) continue;
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
    const detail = {
      event_id: row.event_id, producer_id: row.producer_id, entity_id: row.entity_id,
      entity_version: row.entity_version, event_kind: row.kind, work_id: row.work_id,
      item_id: row.item_id, payload: JSON.parse(row.payload as string), payload_hash: row.payload_hash,
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
  return { published, delivered };
}
