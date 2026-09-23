import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ControlError, ensureControlSchema } from "./store";
import { createProblem, getObject, getObjectVersion, listObjectsByProblem } from "./context-pool";
import {
  factIdempotencyKey,
  getQuarantinedEvents,
  ingestFactObserved,
  ingestFactObservedOrThrow,
  type FactObservedPayload,
} from "./context-reducer";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  return db;
}

function makeWork(db: Database, workId = "w1", decisionOwner = "alice"): void {
  db.query(
    `INSERT INTO control_works(work_id,title,source,source_id,state,revision,contract,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(workId, "t", "test", null, "active", 1, JSON.stringify({ decision_owner: decisionOwner }), 1, 1);
}

function basePayload(over: Partial<FactObservedPayload> = {}): FactObservedPayload {
  return {
    work_id: "w1",
    problem_id: null,
    object_canonical_key: "test-parseConfig",
    reference: "orchestrator:submit_result:attempt-1",
    source_type: "orchestrator",
    source_id: "runner-42",
    source_identity: "alice",
    source_event_id: "evt-001",
    observation_revision: 1,
    attempt: "attempt-1",
    fact_subtype: "test_result",
    content_hash: "hash-aaa",
    sensitivity: "clean",
    collected_at: "2026-09-22T10:00:00.000Z",
    expires_at: null,
    derived_from: null,
    ...over,
  };
}

describe("T10 context.fact_observed reducer", () => {
  test("1. 完整合法 fact_observed → created，pool 中出现 fact 对象", () => {
    const db = fixture();
    makeWork(db);
    const result = ingestFactObserved(db, basePayload());
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result.revision).toBe(1);
    const obj = getObject(db, result.object_id)!;
    expect(obj.ctype).toBe("fact");
    expect(obj.fact_subtype).toBe("test_result");
    expect(obj.work_id).toBe("w1");
    const v = getObjectVersion(db, result.object_id, 1)!;
    expect(v.content_hash).toBe("hash-aaa");
    expect(v.shareable).toBe(0);
    expect(v.sensitivity).toBe("clean");
    expect(v.summary_short).toBe("fact:test_result from orchestrator:runner-42");
    db.close();
  });

  test("2. 同 idempotency_key + 同 content_hash → idempotent，不重复创建", () => {
    const db = fixture();
    makeWork(db);
    const r1 = ingestFactObserved(db, basePayload());
    expect(r1.status).toBe("created");
    const r2 = ingestFactObserved(db, basePayload());
    expect(r2.status).toBe("idempotent");
    if (r2.status !== "idempotent") throw new Error("expected idempotent");
    expect(r2.object_id).toBe((r1 as { object_id: string }).object_id);
    expect(r2.revision).toBe(1);
    // objects 表仍只有 1 行 version
    const versions = db.query(
      "SELECT COUNT(*) AS n FROM control_context_object_versions WHERE object_id=?",
    ).get(r2.object_id) as { n: number };
    expect(versions.n).toBe(1);
    db.close();
  });

  test("3. 同 idempotency_key + 异 content_hash → quarantined，不覆盖已有对象", () => {
    const db = fixture();
    makeWork(db);
    const r1 = ingestFactObserved(db, basePayload());
    expect(r1.status).toBe("created");
    const r2 = ingestFactObserved(db, basePayload({ content_hash: "hash-bbb" }));
    expect(r2.status).toBe("quarantined");
    if (r2.status !== "quarantined") throw new Error("expected quarantined");
    expect(r2.reason).toContain("integrity_error");
    // 已有对象未被覆盖
    const obj = getObject(db, (r1 as { object_id: string }).object_id)!;
    expect(obj.revision).toBe(1);
    const v = getObjectVersion(db, (r1 as { object_id: string }).object_id, 1)!;
    expect(v.content_hash).toBe("hash-aaa");
    // 隔离事件可查询
    const q = getQuarantinedEvents(db);
    expect(q).toHaveLength(1);
    expect(q[0].content_hash).toBe("hash-bbb");
    db.close();
  });

  test("4. 缺必填字段（source_event_id）→ invalid", () => {
    const db = fixture();
    makeWork(db);
    expect(() => ingestFactObserved(db, basePayload({ source_event_id: "" }))).toThrow(ControlError);
    try {
      ingestFactObserved(db, basePayload({ source_event_id: "" }));
    } catch (e) {
      expect((e as ControlError).code).toBe("invalid");
      expect((e as Error).message).toContain("source_event_id");
    }
    db.close();
  });

  test("5. observation_revision=0 或负数 → invalid", () => {
    const db = fixture();
    makeWork(db);
    for (const rev of [0, -1]) {
      expect(() => ingestFactObserved(db, basePayload({ observation_revision: rev }))).toThrow(ControlError);
      try {
        ingestFactObserved(db, basePayload({ observation_revision: rev }));
      } catch (e) {
        expect((e as ControlError).code).toBe("invalid");
      }
    }
    db.close();
  });

  test("6. fact_subtype 不在枚举 → invalid", () => {
    const db = fixture();
    makeWork(db);
    expect(() => ingestFactObserved(db, basePayload({ fact_subtype: "not_a_subtype" }))).toThrow(ControlError);
    try {
      ingestFactObserved(db, basePayload({ fact_subtype: "not_a_subtype" }));
    } catch (e) {
      expect((e as ControlError).code).toBe("invalid");
    }
    db.close();
  });

  test("7. sensitivity 不在枚举 → invalid", () => {
    const db = fixture();
    makeWork(db);
    expect(() => ingestFactObserved(db, basePayload({ sensitivity: "top_secret" }))).toThrow(ControlError);
    try {
      ingestFactObserved(db, basePayload({ sensitivity: "top_secret" }));
    } catch (e) {
      expect((e as ControlError).code).toBe("invalid");
    }
    db.close();
  });

  test("8. 跨 work problem 引用 → conflict", () => {
    const db = fixture();
    makeWork(db, "w1", "alice");
    makeWork(db, "w2", "bob");
    const p = createProblem(db, { work_id: "w2", title: "p in w2" }, 1);
    expect(() =>
      ingestFactObserved(db, basePayload({ work_id: "w1", problem_id: p.problem_id })),
    ).toThrow(ControlError);
    try {
      ingestFactObserved(db, basePayload({ work_id: "w1", problem_id: p.problem_id }));
    } catch (e) {
      expect((e as ControlError).code).toBe("conflict");
    }
    db.close();
  });

  test("9. confirmed_secret + 无授权 → blocked", () => {
    const db = fixture();
    makeWork(db, "w1", "alice");
    expect(() =>
      ingestFactObserved(db, basePayload({ sensitivity: "confirmed_secret" })),
    ).toThrow(ControlError);
    try {
      ingestFactObserved(db, basePayload({ sensitivity: "confirmed_secret" }));
    } catch (e) {
      expect((e as ControlError).code).toBe("blocked");
    }
    // 错误 actor 也 blocked
    expect(() =>
      ingestFactObserved(db, basePayload({ sensitivity: "confirmed_secret" }), { actor: "mallory" }),
    ).toThrow(ControlError);
    db.close();
  });

  test("10. confirmed_secret + 有授权（decision_owner）→ created", () => {
    const db = fixture();
    makeWork(db, "w1", "alice");
    const result = ingestFactObserved(
      db,
      basePayload({ sensitivity: "confirmed_secret" }),
      { actor: "alice" },
    );
    expect(result.status).toBe("created");
    const v = getObjectVersion(db, result.object_id, 1)!;
    expect(v.sensitivity).toBe("confirmed_secret");
    expect(v.shareable).toBe(0);
    db.close();
  });

  test("11. 同一 source_event_id 不同 observation_revision → 创建新版本", () => {
    const db = fixture();
    makeWork(db);
    const r1 = ingestFactObserved(db, basePayload({ observation_revision: 1, content_hash: "h1" }));
    expect(r1.status).toBe("created");
    const r2 = ingestFactObserved(db, basePayload({ observation_revision: 2, content_hash: "h2" }));
    expect(r2.status).toBe("created");
    if (r2.status !== "created") throw new Error("expected created");
    expect(r2.revision).toBe(2);
    expect(r2.object_id).toBe((r1 as { object_id: string }).object_id);
    // 旧版仍在
    expect(getObjectVersion(db, r2.object_id, 1)!.content_hash).toBe("h1");
    expect(getObjectVersion(db, r2.object_id, 2)!.content_hash).toBe("h2");
    db.close();
  });

  test("12. problem_id 提供时自动 linkProblemObject", () => {
    const db = fixture();
    makeWork(db);
    const p = createProblem(db, { work_id: "w1", title: "root" }, 1);
    const result = ingestFactObserved(db, basePayload({ problem_id: p.problem_id }));
    expect(result.status).toBe("created");
    const linked = listObjectsByProblem(db, p.problem_id);
    expect(linked).toHaveLength(1);
    expect(linked[0].role).toBe("fact");
    expect(linked[0].object.object_id).toBe(result.object_id);
    db.close();
  });

  test("13. 事务性：投影失败时 dedup 记录不写入（回滚）", () => {
    const db = fixture();
    makeWork(db, "w1", "alice");
    // problem_id 指向不存在的 problem → 事务内抛 invalid
    expect(() =>
      ingestFactObserved(db, basePayload({ problem_id: "nonexistent-problem" })),
    ).toThrow(ControlError);
    // dedup 表无记录
    const dedupCount = db.query("SELECT COUNT(*) AS n FROM control_context_fact_dedup").get() as { n: number };
    expect(dedupCount.n).toBe(0);
    // objects 表也无记录
    const objCount = db.query("SELECT COUNT(*) AS n FROM control_context_objects").get() as { n: number };
    expect(objCount.n).toBe(0);
    db.close();
  });

  test("14. ingest 后发出 context.updated 事件（查 control_outbox）", () => {
    const db = fixture();
    makeWork(db);
    const result = ingestFactObserved(db, basePayload());
    expect(result.status).toBe("created");
    const events = db.query(
      "SELECT kind, entity_id, entity_version FROM control_outbox WHERE kind='context.updated'",
    ).all() as Array<{ kind: string; entity_id: string; entity_version: number }>;
    expect(events).toHaveLength(1);
    expect(events[0].entity_id).toBe(result.object_id);
    expect(events[0].entity_version).toBe(1);
    db.close();
  });

  test("辅助函数 factIdempotencyKey 稳定且不含 fact_subtype/content_hash", () => {
    expect(factIdempotencyKey("orchestrator", "runner-1", "evt-1", 1))
      .toBe(factIdempotencyKey("orchestrator", "runner-1", "evt-1", 1));
    expect(factIdempotencyKey("orchestrator", "runner-1", "evt-1", 1))
      .not.toBe(factIdempotencyKey("orchestrator", "runner-1", "evt-1", 2));
  });
});

describe("ingestFactObservedOrThrow", () => {
  test("同 key 同 hash → idempotent 不抛", () => {
    const db = fixture();
    makeWork(db);
    const r1 = ingestFactObservedOrThrow(db, basePayload());
    expect(r1.status).toBe("created");
    const r2 = ingestFactObservedOrThrow(db, basePayload());
    expect(r2.status).toBe("idempotent");
    db.close();
  });

  test("同 key 异 hash → 抛 ControlError('conflict')", () => {
    const db = fixture();
    makeWork(db);
    ingestFactObservedOrThrow(db, basePayload());
    try {
      ingestFactObservedOrThrow(db, basePayload({ content_hash: "hash-bbb" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ControlError).code).toBe("conflict");
      expect((e as Error).message).toContain("integrity_error");
    }
    db.close();
  });

  test("冲突后既有对象不被覆盖", () => {
    const db = fixture();
    makeWork(db);
    const r1 = ingestFactObservedOrThrow(db, basePayload());
    expect(r1.status).toBe("created");
    expect(() => ingestFactObservedOrThrow(db, basePayload({ content_hash: "hash-bbb" }))).toThrow(ControlError);
    const obj = getObject(db, r1.object_id)!;
    expect(obj.revision).toBe(1);
    const v = getObjectVersion(db, r1.object_id, 1)!;
    expect(v.content_hash).toBe("hash-aaa");
    db.close();
  });
});

describe("Fix3 reducer 乱序防护", () => {
  test("rev2 先到 → created；rev1 后到 → quarantined，对象内容不被覆盖", () => {
    const db = fixture();
    makeWork(db);
    // rev2 先到
    const r2 = ingestFactObserved(db, basePayload({ observation_revision: 2, content_hash: "hash-rev2" }));
    expect(r2.status).toBe("created");
    if (r2.status !== "created") throw new Error("expected created for rev2");
    expect(r2.revision).toBe(1);
    // rev1 后到（旧于已摄入最大 revision=2）→ quarantine
    const r1 = ingestFactObserved(db, basePayload({ observation_revision: 1, content_hash: "hash-rev1" }));
    expect(r1.status).toBe("quarantined");
    if (r1.status !== "quarantined") throw new Error("expected quarantined for rev1");
    expect(r1.reason).toContain("out_of_order");
    // 对象内容仍为 rev2，未被 rev1 覆盖
    const obj = getObject(db, r2.object_id)!;
    expect(obj.revision).toBe(1);
    expect(getObjectVersion(db, r2.object_id, 1)!.content_hash).toBe("hash-rev2");
    // rev1 未产生新 version
    const vcount = db.query("SELECT COUNT(*) AS n FROM control_context_object_versions WHERE object_id=?").get(r2.object_id) as { n: number };
    expect(vcount.n).toBe(1);
    db.close();
  });

  test("OrThrow 版本：旧 revision 迟到 → 抛 ControlError('conflict')", () => {
    const db = fixture();
    makeWork(db);
    ingestFactObservedOrThrow(db, basePayload({ observation_revision: 2, content_hash: "h2" }));
    try {
      ingestFactObservedOrThrow(db, basePayload({ observation_revision: 1, content_hash: "h1" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ControlError).code).toBe("conflict");
      expect((e as Error).message).toContain("out_of_order");
    }
    db.close();
  });

  test("正向：rev1→rev2→rev3 顺序到达，正常递增版本", () => {
    const db = fixture();
    makeWork(db);
    const a = ingestFactObserved(db, basePayload({ observation_revision: 1, content_hash: "h1" }));
    const b = ingestFactObserved(db, basePayload({ observation_revision: 2, content_hash: "h2" }));
    const c = ingestFactObserved(db, basePayload({ observation_revision: 3, content_hash: "h3" }));
    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
    expect(c.status).toBe("created");
    if (c.status !== "created") throw new Error("expected created");
    expect(c.revision).toBe(3);
    expect(getObjectVersion(db, c.object_id, 3)!.content_hash).toBe("h3");
    db.close();
  });
});
