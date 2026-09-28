import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ControlError, ensureControlSchema, createWork } from "./store";
import {
  createObject,
  getObjectVersion,
  type ObjectVersion,
} from "./context-pool";
import {
  pinContext,
  getPin,
  getPinnedVersion,
  unpin,
  listPinsByObject,
  listPinsByPurpose,
  readPinnedContent,
  shareObject,
  revokeShare,
  getSharesForObject,
  hasShare,
  purgeObjectContent,
} from "./context-pin";
import type { Contract } from "./types";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  return db;
}

function makeContract(owner: string): Contract {
  return {
    objective: "test objective",
    acceptance: [{ id: "a1", kind: "human", description: "done" }],
    non_goals: [],
    scope: { repo: "/tmp/repo" },
    budget: {},
    stop_conditions: [],
    decision_owner: owner,
  };
}

function makeObject(db: Database, workId: string, key: string, hash: string, sensitivity: "clean" | "confirmed_secret" = "clean") {
  return createObject(db, {
    work_id: workId,
    ctype: "fact",
    fact_subtype: "code_state",
    object_canonical_key: key,
    reference: `ref:${key}`,
    source_type: "orchestrator",
    content_hash: hash,
    sensitivity,
    shareable: sensitivity === "clean" ? 1 : 0,
  }, 1);
}

describe("T9 pinContext", () => {
  test("pin stores old version; object upgrade does not drift pin", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    const pin = pinContext(db, {
      object_id: obj.object_id,
      revision: 1,
      pinned_by: "alice",
      purpose: "decision_evidence",
    }, 2);
    expect(pin.revision).toBe(1);

    // 对象出新版
    db.query("UPDATE control_context_objects SET revision=2, updated_at=? WHERE object_id=?").run(3, obj.object_id);
    db.query("INSERT INTO control_context_object_versions(object_id,revision,reference,source_type,sensitivity,shareable,expires_at,staleness_ms,collected_at,derived_from,summary_short,summary_long,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(obj.object_id, 2, "ref:k2", "orchestrator", "clean", 1, null, null, null, null, null, null, "h2", 3);

    // pin 仍取旧版
    const pinned = getPinnedVersion(db, pin.pin_id);
    expect(pinned).toBeTruthy();
    expect(pinned!.version.revision).toBe(1);
    expect(pinned!.version.content_hash).toBe("h1");
    db.close();
  });

  test("unpin removes the pin", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    const pin = pinContext(db, { object_id: obj.object_id, revision: 1, pinned_by: "alice", purpose: "other" }, 2);
    expect(getPin(db, pin.pin_id)).toBeTruthy();
    unpin(db, pin.pin_id);
    expect(getPin(db, pin.pin_id)).toBeNull();
    db.close();
  });

  test("listPinsByObject and listPinsByPurpose", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    pinContext(db, { object_id: obj.object_id, revision: 1, pinned_by: "alice", purpose: "decision_evidence" }, 2);
    pinContext(db, { object_id: obj.object_id, revision: 1, pinned_by: "alice", purpose: "recovery_checkpoint" }, 3);
    expect(listPinsByObject(db, obj.object_id)).toHaveLength(2);
    expect(listPinsByPurpose(db, "decision_evidence")).toHaveLength(1);
    expect(listPinsByPurpose(db, "recovery_checkpoint")).toHaveLength(1);
    db.close();
  });
});

describe("T9 readPinnedContent", () => {
  test("available when permission is intact", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    const pin = pinContext(db, { object_id: obj.object_id, revision: 1, pinned_by: "alice", purpose: "decision_evidence" }, 2);
    const result = readPinnedContent(db, pin.pin_id, "alice", 3);
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.content_hash).toBe("h1");
    }
    db.close();
  });

  test("revoked when actor is no longer decision_owner (pin does not shield security)", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    const pin = pinContext(db, { object_id: obj.object_id, revision: 1, pinned_by: "alice", purpose: "decision_evidence" }, 2);

    // 变更 decision_owner 为 bob（模拟权限撤销）
    const contract = makeContract("bob");
    db.query("UPDATE control_works SET contract=? WHERE work_id=?").run(JSON.stringify(contract), work.work_id);

    const result = readPinnedContent(db, pin.pin_id, "alice", 3);
    expect(result.status).toBe("revoked");
    if (result.status === "revoked") {
      expect(result.content_hash).toBe("h1"); // 只返回 hash
    }
    db.close();
  });

  test("purged returns tombstone_reason and hash", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    const pin = pinContext(db, { object_id: obj.object_id, revision: 1, pinned_by: "alice", purpose: "decision_evidence" }, 2);
    purgeObjectContent(db, obj.object_id, "expired", 3);

    const result = readPinnedContent(db, pin.pin_id, "alice", 4);
    expect(result.status).toBe("purged");
    if (result.status === "purged") {
      expect(result.content_hash).toBe("h1");
      expect(result.tombstone_reason).toBe("expired");
    }
    db.close();
  });

  test("expired when pin expires_at is in the past", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    const pin = pinContext(db, {
      object_id: obj.object_id,
      revision: 1,
      pinned_by: "alice",
      purpose: "decision_evidence",
      expires_at: 1000, // 已过期
    }, 2);
    const result = readPinnedContent(db, pin.pin_id, "alice", 5000);
    expect(result.status).toBe("expired");
    if (result.status === "expired") {
      expect(result.content_hash).toBe("h1");
    }
    db.close();
  });

  test("pin does not shield security: pin exists but revoked → status=revoked", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    const pin = pinContext(db, { object_id: obj.object_id, revision: 1, pinned_by: "alice", purpose: "decision_evidence" }, 2);

    // alice still has permission → available
    expect(readPinnedContent(db, pin.pin_id, "alice", 3).status).toBe("available");

    // 撤销权限：改 decision_owner
    db.query("UPDATE control_works SET contract=? WHERE work_id=?").run(JSON.stringify(makeContract("bob")), work.work_id);
    expect(readPinnedContent(db, pin.pin_id, "alice", 3).status).toBe("revoked");
    db.close();
  });
});

describe("T9 shareObject", () => {
  test("confirmed_secret object cannot be shared", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1", "confirmed_secret");
    expect(() =>
      shareObject(db, { object_id: obj.object_id, revision: 1, shared_with_work: "w2", granted_by: "alice" }, 2),
    ).toThrow(ControlError);
    try {
      shareObject(db, { object_id: obj.object_id, revision: 1, shared_with_work: "w2", granted_by: "alice" }, 2);
    } catch (e) {
      expect((e as ControlError).code).toBe("invalid");
    }
    db.close();
  });

  test("clean object shares successfully and hasShare returns true", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1", "clean");
    const share = shareObject(db, { object_id: obj.object_id, revision: 1, shared_with_work: "w2", granted_by: "alice" }, 2);
    expect(share.shared_with_work).toBe("w2");
    expect(hasShare(db, obj.object_id, 1, "w2")).toBe(true);
    expect(hasShare(db, obj.object_id, 1, "w3")).toBe(false);
    db.close();
  });

  test("revokeShare removes the share", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1", "clean");
    const share = shareObject(db, { object_id: obj.object_id, revision: 1, shared_with_work: "w2", granted_by: "alice" }, 2);
    expect(hasShare(db, obj.object_id, 1, "w2")).toBe(true);
    revokeShare(db, share.share_id);
    expect(hasShare(db, obj.object_id, 1, "w2")).toBe(false);
    db.close();
  });

  test("getSharesForObject filters by revision", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1", "clean");
    shareObject(db, { object_id: obj.object_id, revision: 1, shared_with_work: "w2", granted_by: "alice" }, 2);
    expect(getSharesForObject(db, obj.object_id)).toHaveLength(1);
    expect(getSharesForObject(db, obj.object_id, 1)).toHaveLength(1);
    expect(getSharesForObject(db, obj.object_id, 2)).toHaveLength(0);
    db.close();
  });
});

describe("T9 purgeObjectContent", () => {
  test("sets purged_at and tombstone_reason; versions still queryable by hash", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    purgeObjectContent(db, obj.object_id, "retention_policy", 2);

    const row = db.query("SELECT purged_at, tombstone_reason FROM control_context_objects WHERE object_id=?").get(obj.object_id) as { purged_at: string; tombstone_reason: string };
    expect(row.purged_at).toBeTruthy();
    expect(row.tombstone_reason).toBe("retention_policy");

    // versions 行保留，仍可查 hash
    const v = getObjectVersion(db, obj.object_id, 1);
    expect(v).toBeTruthy();
    expect(v!.content_hash).toBe("h1");
    db.close();
  });

  test("purge is idempotent", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    purgeObjectContent(db, obj.object_id, "manual", 2);
    expect(() => purgeObjectContent(db, obj.object_id, "expired", 3)).not.toThrow();
    db.close();
  });
});
