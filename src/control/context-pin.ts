import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { ControlError, ensureControlSchema, getWork } from "./store";
import {
  getObject,
  getObjectVersion,
  type ObjectVersion,
  type Pin,
  type PinPurpose,
  type Share,
} from "./context-pool";

// ========== row 映射 ==========

function pinFrom(row: Record<string, unknown>): Pin {
  return {
    pin_id: row.pin_id as string,
    object_id: row.object_id as string,
    revision: row.revision as number,
    pinned_by: row.pinned_by as string,
    purpose: row.purpose as PinPurpose,
    expires_at: row.expires_at as number | null,
    created_at: row.created_at as number,
  };
}

function shareFrom(row: Record<string, unknown>): Share {
  return {
    share_id: row.share_id as string,
    object_id: row.object_id as string,
    revision: row.revision as number,
    shared_with_work: row.shared_with_work as string,
    granted_by: row.granted_by as string,
    granted_at: row.granted_at as number,
  };
}

function versionFrom(row: Record<string, unknown>): ObjectVersion {
  return {
    object_id: row.object_id as string,
    revision: row.revision as number,
    reference: row.reference as string,
    source_type: row.source_type as ObjectVersion["source_type"],
    sensitivity: row.sensitivity as ObjectVersion["sensitivity"],
    shareable: row.shareable as number,
    expires_at: row.expires_at as number | null,
    staleness_ms: row.staleness_ms as number | null,
    collected_at: row.collected_at as number | null,
    derived_from: row.derived_from as string | null,
    summary_short: row.summary_short as string | null,
    summary_long: row.summary_long as string | null,
    content_hash: row.content_hash as string,
    created_at: row.created_at as number,
  };
}

// ========== Pin API ==========

export function pinContext(db: Database, input: {
  object_id: string;
  revision: number;
  pinned_by: string;
  purpose: PinPurpose;
  expires_at?: number;
}, nowTs = Date.now()): Pin {
  ensureControlSchema(db);
  if (!input.object_id) throw new ControlError("invalid", "object_id is required");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new ControlError("invalid", "revision must be a positive integer");
  if (!input.pinned_by) throw new ControlError("invalid", "pinned_by is required");

  const tx = db.transaction(() => {
    // 验证版本存在（复合 FK 已保证，但显式检查给出更好的错误）
    const version = getObjectVersion(db, input.object_id, input.revision);
    if (!version) throw new ControlError("not_found", "object version not found");

    const pinId = randomUUID();
    db.query(
      "INSERT INTO control_context_pins(pin_id,object_id,revision,pinned_by,purpose,expires_at,created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(pinId, input.object_id, input.revision, input.pinned_by, input.purpose, input.expires_at ?? null, nowTs);

    return getPin(db, pinId)!;
  });
  return tx.immediate() as Pin;
}

export function getPin(db: Database, pinId: string): Pin | null {
  ensureControlSchema(db);
  const row = db.query("SELECT * FROM control_context_pins WHERE pin_id=?").get(pinId) as Record<string, unknown> | null;
  return row ? pinFrom(row) : null;
}

/**
 * 关键：JOIN control_context_object_versions 取该版的 reference/权限/时效，
 * 不回对象表取 latest。对象出新版后 pin 仍取旧版。
 */
export function getPinnedVersion(db: Database, pinId: string): { pin: Pin; version: ObjectVersion } | null {
  ensureControlSchema(db);
  const row = db.query(`
    SELECT p.pin_id, p.object_id, p.revision, p.pinned_by, p.purpose, p.expires_at, p.created_at,
           v.reference, v.source_type, v.sensitivity, v.shareable, v.expires_at AS v_expires_at,
           v.staleness_ms, v.collected_at, v.derived_from, v.summary_short, v.summary_long,
           v.content_hash, v.created_at AS v_created_at
    FROM control_context_pins p
    JOIN control_context_object_versions v ON v.object_id = p.object_id AND v.revision = p.revision
    WHERE p.pin_id = ?
  `).get(pinId) as Record<string, unknown> | null;
  if (!row) return null;
  const pin = pinFrom(row);
  const version = versionFrom({
    ...row,
    expires_at: row.v_expires_at,
    created_at: row.v_created_at,
  });
  return { pin, version };
}

export function unpin(db: Database, pinId: string): void {
  ensureControlSchema(db);
  db.query("DELETE FROM control_context_pins WHERE pin_id=?").run(pinId);
}

export function listPinsByObject(db: Database, objectId: string): Pin[] {
  ensureControlSchema(db);
  const rows = db.query("SELECT * FROM control_context_pins WHERE object_id=? ORDER BY created_at").all(objectId) as Record<string, unknown>[];
  return rows.map(pinFrom);
}

export function listPinsByPurpose(db: Database, purpose: PinPurpose): Pin[] {
  ensureControlSchema(db);
  const rows = db.query("SELECT * FROM control_context_pins WHERE purpose=? ORDER BY created_at").all(purpose) as Record<string, unknown>[];
  return rows.map(pinFrom);
}

// ========== Pin 读取时的权限检查 ==========

export type ReadPinnedResult =
  | { status: "available"; version: ObjectVersion; content_hash: string }
  | { status: "revoked"; content_hash: string; reason: string }
  | { status: "purged"; content_hash: string; tombstone_reason: string }
  | { status: "expired"; content_hash: string };

/**
 * pin 保留旧证据的内容哈希和元数据作审计证据，但不屏蔽安全约束。
 * 权限被撤销后 pin 持有者只看到 "revoked" + hash，正文不可取。
 */
export function readPinnedContent(db: Database, pinId: string, actor: string, nowTs = Date.now()): ReadPinnedResult {
  ensureControlSchema(db);
  const pinned = getPinnedVersion(db, pinId);
  if (!pinned) throw new ControlError("not_found", "pin not found");
  const { pin, version } = pinned;
  const obj = getObject(db, pin.object_id);
  if (!obj) throw new ControlError("not_found", "object not found");

  // 1. 对象是否已被 purge（正文清除）
  if (obj.purged_at !== null) {
    return {
      status: "purged",
      content_hash: version.content_hash,
      tombstone_reason: obj.tombstone_reason ?? "unknown",
    };
  }

  // 2. pin 是否过期
  if (pin.expires_at !== null && pin.expires_at < nowTs) {
    return { status: "expired", content_hash: version.content_hash };
  }

  // 3. 当前 actor 是否仍有权限。
  // shares 表无 actor 列，shared_with_work 语义是 work id，无法把人 actor 绑定到 share；
  // share 是对象级跨 work 引用授权，不构成 pin 正文的人级读取授权。故 fail-closed：仅 decision_owner。
  const work = getWork(db, obj.work_id);
  const hasPermission = !!work?.contract?.decision_owner && actor === work.contract.decision_owner;

  if (!hasPermission) {
    return {
      status: "revoked",
      content_hash: version.content_hash,
      reason: "actor permission revoked",
    };
  }

  return { status: "available", version, content_hash: version.content_hash };
}

// ========== Shares API ==========

export function shareObject(db: Database, input: {
  object_id: string;
  revision: number;
  shared_with_work: string;
  granted_by: string;
}, nowTs = Date.now()): Share {
  ensureControlSchema(db);
  if (!input.object_id) throw new ControlError("invalid", "object_id is required");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new ControlError("invalid", "revision must be a positive integer");
  if (!input.shared_with_work) throw new ControlError("invalid", "shared_with_work is required");
  if (!input.granted_by) throw new ControlError("invalid", "granted_by is required");

  const tx = db.transaction(() => {
    // 检查版本是否存在
    const version = getObjectVersion(db, input.object_id, input.revision);
    if (!version) throw new ControlError("not_found", "object version not found");

    // confirmed_secret 对象默认不可跨工作共享
    if (version.sensitivity === "confirmed_secret") {
      throw new ControlError("invalid", "confirmed_secret cannot be shared");
    }

    // 检查是否已存在 share（UNIQUE 约束）
    const existing = db.query(
      "SELECT share_id FROM control_context_shares WHERE object_id=? AND revision=? AND shared_with_work=?",
    ).get(input.object_id, input.revision, input.shared_with_work) as { share_id: string } | null;
    if (existing) {
      return getSharesForObject(db, input.object_id, input.revision).find(
        (s) => s.shared_with_work === input.shared_with_work,
      )!;
    }

    const shareId = randomUUID();
    db.query(
      "INSERT INTO control_context_shares(share_id,object_id,revision,shared_with_work,granted_by,granted_at) VALUES (?,?,?,?,?,?)",
    ).run(shareId, input.object_id, input.revision, input.shared_with_work, input.granted_by, nowTs);

    return db.query("SELECT * FROM control_context_shares WHERE share_id=?").get(shareId) as Record<string, unknown>;
  });
  const row = tx.immediate() as Record<string, unknown>;
  return shareFrom(row);
}

export function revokeShare(db: Database, shareId: string): void {
  ensureControlSchema(db);
  db.query("DELETE FROM control_context_shares WHERE share_id=?").run(shareId);
}

export function getSharesForObject(db: Database, objectId: string, revision?: number): Share[] {
  ensureControlSchema(db);
  let rows: Record<string, unknown>[];
  if (revision !== undefined) {
    rows = db.query(
      "SELECT * FROM control_context_shares WHERE object_id=? AND revision=? ORDER BY granted_at",
    ).all(objectId, revision) as Record<string, unknown>[];
  } else {
    rows = db.query(
      "SELECT * FROM control_context_shares WHERE object_id=? ORDER BY granted_at",
    ).all(objectId) as Record<string, unknown>[];
  }
  return rows.map(shareFrom);
}

export function hasShare(db: Database, objectId: string, revision: number, workId: string): boolean {
  ensureControlSchema(db);
  const row = db.query(
    "SELECT 1 FROM control_context_shares WHERE object_id=? AND revision=? AND shared_with_work=?",
  ).get(objectId, revision, workId) as { 1?: number } | null;
  return !!row;
}

// ========== 正文清除（purge） ==========

/**
 * 设置 objects.purged_at + tombstone_reason。
 * versions 行保留但 reference 指向的正文标记不可取。
 * 不删用户原源文件，只清本系统受管副本。
 */
export function purgeObjectContent(db: Database, objectId: string, reason: "expired" | "revoked" | "retention_policy" | "manual", nowTs = Date.now()): void {
  ensureControlSchema(db);
  const obj = getObject(db, objectId);
  if (!obj) throw new ControlError("not_found", "object not found");
  if (obj.purged_at !== null) return; // 已清除，幂等

  const purgedAt = new Date(nowTs).toISOString();
  db.query(
    "UPDATE control_context_objects SET purged_at=?, tombstone_reason=? WHERE object_id=?",
  ).run(purgedAt, reason, objectId);
}
