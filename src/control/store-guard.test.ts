// Gap-fill: redirectWork activate/pause branches + listAttention done zone.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createWork, ensureControlSchema, listAttention, redirectWork, upsertAttention } from "./store";
import type { Contract } from "./types";

const contract: Contract = {
  objective: "ship",
  acceptance: [{ id: "human", kind: "human", description: "owner accepts" }],
  non_goals: [],
  scope: { allowed_effects: ["write"] },
  budget: { retry_limit: 1 },
  stop_conditions: [{ id: "risk", kind: "hard", description: "d" }],
  decision_owner: "owner",
};
function db() {
  const d = new Database(":memory:");
  ensureControlSchema(d);
  return d;
}

test("CTRL-10 redirectWork activate reopens a stopped work", () => {
  const d = db();
  const w = createWork(d, { title: "w", source: "t", contract }, 1);
  redirectWork(d, w.work_id, 1, { reason: "paused", affected_work_ids: [], action: "stop" }, 2);
  const activated = redirectWork(d, w.work_id, 2, { reason: "resumed", affected_work_ids: [], action: "activate" }, 3);
  expect(activated.state).toBe("active");
  d.close();
});

test("CTRL-13 listAttention done zone returns resolved/superseded only", () => {
  const d = db();
  const w = createWork(d, { title: "w", source: "t", contract }, 1);
  upsertAttention(d, {
    item_id: "done-1", work_id: w.work_id, state: "resolved", effect_state: "succeeded",
    urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: null,
    options: [], owner: "owner", expires_at: null, source_link: null, approval_id: null,
    consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
  }, 2);
  upsertAttention(d, {
    item_id: "open-1", work_id: w.work_id, state: "open", effect_state: "not_started",
    urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: null,
    options: [], owner: "owner", expires_at: null, source_link: null, approval_id: null,
    consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
  }, 3);
  expect(listAttention(d, "done", 4).map((x) => x.item_id)).toEqual(["done-1"]);
  expect(listAttention(d, "now", 4).map((x) => x.item_id)).toEqual(["open-1"]);
  d.close();
});

import { Database as _Db } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_SCHEMA_VERSION, ControlError, ensureControlSchema } from "./store";
import { ensureContextReducerSchema } from "./context-reducer";

describe("T20 schema 升级/重入（真实临时 SQLite 文件）", () => {
  test("模拟 v3 库 → ensureControlSchema 升级到 v6，reducer 表/列存在", () => {
    const dir = mkdtempSync(join(tmpdir(), "overload-schema-up-"));
    try {
      const path = join(dir, "c.db");
      const db = new _Db(path);
      db.exec("PRAGMA foreign_keys=ON");
      ensureControlSchema(db); // 现在是当前版本
      // 回退到 v3：丢掉 v4 才建的 reducer 表，版本拨回 3
      db.exec("DROP TABLE IF EXISTS control_context_fact_quarantine");
      db.exec("DROP TABLE IF EXISTS control_context_fact_dedup");
      db.query("UPDATE control_schema_meta SET version=3 WHERE id=1").run();
      expect((db.query("SELECT version FROM control_schema_meta WHERE id=1").get() as { version: number }).version).toBe(3);
      // 升级
      expect(() => ensureControlSchema(db)).not.toThrow();
      expect((db.query("SELECT version FROM control_schema_meta WHERE id=1").get() as { version: number }).version).toBe(CONTROL_SCHEMA_VERSION);
      ensureContextReducerSchema(db); // 幂等
      for (const t of ["control_context_fact_dedup", "control_context_fact_quarantine"]) {
        expect(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)).toBeTruthy();
      }
      const cols = (db.query("PRAGMA table_info(control_context_fact_dedup)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("observation_revision");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("再次 ensureControlSchema（重入）不报错，版本仍为当前版本", () => {
    const dir = mkdtempSync(join(tmpdir(), "overload-schema-reentry-"));
    try {
      const db = new _Db(join(dir, "c.db"));
      db.exec("PRAGMA foreign_keys=ON");
      ensureControlSchema(db);
      expect(() => ensureControlSchema(db)).not.toThrow();
      expect(() => ensureControlSchema(db)).not.toThrow();
      expect((db.query("SELECT version FROM control_schema_meta WHERE id=1").get() as { version: number }).version).toBe(CONTROL_SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("全新空文件 → ensureControlSchema 直接到当前版本，所有核心表存在", () => {
    const dir = mkdtempSync(join(tmpdir(), "overload-schema-fresh-"));
    try {
      const db = new _Db(join(dir, "c.db"));
      db.exec("PRAGMA foreign_keys=ON");
      ensureControlSchema(db);
      expect((db.query("SELECT version FROM control_schema_meta WHERE id=1").get() as { version: number }).version).toBe(CONTROL_SCHEMA_VERSION);
      for (const t of ["control_works", "control_attention", "control_context_problems", "control_context_objects", "control_context_object_versions", "control_context_problem_objects", "control_context_fact_dedup", "control_context_fact_quarantine"]) {
        expect(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)).toBeTruthy();
      }
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("版本号高于当前支持版本的库 → 拒启动（抛 ControlError('blocked')）", () => {
    const dir = mkdtempSync(join(tmpdir(), "overload-schema-newer-"));
    try {
      const db = new _Db(join(dir, "c.db"));
      db.exec("PRAGMA foreign_keys=ON");
      ensureControlSchema(db);
      db.query("UPDATE control_schema_meta SET version=99 WHERE id=1").run();
      expect(() => ensureControlSchema(db)).toThrow(ControlError);
      try { ensureControlSchema(db); } catch (e) { expect((e as ControlError).code).toBe("blocked"); }
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
