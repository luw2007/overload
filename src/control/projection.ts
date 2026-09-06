import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AttentionItem } from "./types";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function validAttention(value: unknown): value is AttentionItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.item_id === "string" && typeof item.work_id === "string" && Number.isSafeInteger(item.revision)
    && ["open","applying","resolved","superseded"].includes(item.state as string)
    && ["not_started","applying","succeeded","failed","unknown"].includes(item.effect_state as string);
}

export function applyControlEvent(db: Database, detail: Record<string, unknown>, at: number): void {
  const eventId = detail.event_id;
  const suppliedHash = detail.payload_hash;
  const payload = detail.payload;
  if (typeof eventId !== "string" || !eventId || typeof suppliedHash !== "string" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid control event");
  }
  const actualHash = digest(payload);
  if (actualHash !== suppliedHash) throw new Error(`control event payload hash mismatch: ${eventId}`);
  const existing = db.query("SELECT payload_hash FROM applied_control_events WHERE event_id=?").get(eventId) as { payload_hash: string } | null;
  if (existing) {
    if (existing.payload_hash !== suppliedHash) throw new Error(`control event identity mismatch: ${eventId}`);
    return;
  }
  const payloadRow = payload as Record<string, unknown>;
  if (detail.event_kind === "attention.feedback") {
    if (typeof payloadRow.item_id !== "string" || !Number.isSafeInteger(payloadRow.revision) || typeof payloadRow.useful !== "boolean") throw new Error(`invalid attention feedback: ${eventId}`);
    db.query("INSERT INTO control_attention_feedback(event_id,item_id,revision,useful,reason,created_at) VALUES (?,?,?,?,?,?)").run(eventId,payloadRow.item_id,payloadRow.revision,payloadRow.useful?1:0,typeof payloadRow.reason==="string"?payloadRow.reason:null,at);
  }
  const item = payloadRow.attention;
  if (item !== undefined) {
    if (!validAttention(item)) throw new Error(`invalid attention snapshot: ${eventId}`);
    const current = db.query("SELECT revision,event_id FROM control_attention WHERE item_id=?").get(item.item_id) as { revision:number;event_id:string }|null;
    if (current && item.revision < current.revision) {
      // Valid late delivery: mark business event applied without rolling projection back.
    } else if (!current || item.revision > current.revision) {
      db.query(`INSERT INTO control_attention(item_id,work_id,revision,state,effect_state,urgency,owner,conclusion,trigger,impact,recommendation,options,expires_at,defer_until,acknowledged_at,source_link,approval_id,consumer_owner,contract_revision,decision_mode,evidence,event_id,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(item_id) DO UPDATE SET work_id=excluded.work_id,revision=excluded.revision,state=excluded.state,effect_state=excluded.effect_state,urgency=excluded.urgency,owner=excluded.owner,conclusion=excluded.conclusion,trigger=excluded.trigger,impact=excluded.impact,recommendation=excluded.recommendation,options=excluded.options,expires_at=excluded.expires_at,defer_until=excluded.defer_until,acknowledged_at=excluded.acknowledged_at,source_link=excluded.source_link,approval_id=excluded.approval_id,consumer_owner=excluded.consumer_owner,contract_revision=excluded.contract_revision,decision_mode=excluded.decision_mode,evidence=excluded.evidence,event_id=excluded.event_id,updated_at=excluded.updated_at`)
        .run(item.item_id,item.work_id,item.revision,item.state,item.effect_state,item.urgency,item.owner,item.conclusion,item.trigger,item.impact,item.recommendation,JSON.stringify(item.options),item.expires_at,item.defer_until,item.acknowledged_at,item.source_link,item.approval_id,item.consumer_owner,item.contract_revision,item.decision_mode,JSON.stringify(item.evidence),eventId,item.updated_at);
    } else if (current && item.revision === current.revision && current.event_id !== eventId) {
      const projected = db.query("SELECT work_id,state,effect_state,urgency,owner,conclusion,trigger,impact,recommendation,options,expires_at,defer_until,acknowledged_at,source_link,approval_id,consumer_owner,contract_revision,decision_mode,evidence,updated_at FROM control_attention WHERE item_id=?").get(item.item_id) as Record<string,unknown>;
      const comparable = {...item, created_at: undefined, item_id: undefined, revision: undefined};
      const existingComparable = {...projected,options:JSON.parse(projected.options as string),evidence:JSON.parse(projected.evidence as string)};
      delete comparable.created_at; delete comparable.item_id; delete comparable.revision;
      if (canonical(comparable) !== canonical(existingComparable)) throw new Error(`attention revision payload mismatch: ${item.item_id}@${item.revision}`);
    }
  }
  db.query("INSERT INTO applied_control_events(event_id,payload_hash,applied_at) VALUES (?,?,?)").run(eventId,suppliedHash,at);
}
