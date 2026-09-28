import type { Database } from "bun:sqlite";
import { enqueueControlEvent } from "./outbox";

export type ContextEventKind = "context.updated" | "context.invalidated" | "context.stale" | "context.conflict";

// 复用 control outbox：稳定 event_id = sha256(producer_id + entity_id + entity_version + kind)，
// 同键异 payload 由 enqueueControlEvent 抛错。
export function emitContextEvent(
  db: Database,
  kind: ContextEventKind,
  entity_id: string,
  entity_version: number,
  payload: Record<string, unknown>,
  work_id?: string,
): string {
  return enqueueControlEvent(db, {
    entity_id,
    entity_version,
    kind,
    ...(work_id ? { work_id } : {}),
    payload,
  });
}
