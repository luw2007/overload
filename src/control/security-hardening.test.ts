import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { ControlError, ensureControlSchema, createWork, upsertAttention, getWork, resolveAttentionDecision } from "./store";
import { openControl } from "./store";
import { openStore } from "../orchestrator/store";
import { openMailbox } from "../decision-bot/mailbox";
import { createObject, createProblem, linkProblemObject } from "./context-pool";
import { fetchOnDemand } from "./on-demand-fetcher";
import { collectFacts, collectAndSpool } from "../orchestrator/context-collector";
import { ingestContextSpool } from "./context-ingest";
import { openStore as openOrchStore } from "../orchestrator/store";
import { mkdtempSync as mktmp } from "node:fs";
import type { Contract } from "./types";

const repoRoot = join(import.meta.dir, "..", "..");

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
function openContextItem(db: Database, workId: string, opts: { owner: string; withEvidence?: boolean }) {
  return upsertAttention(db, {
    item_id: `item-${Math.random().toString(36).slice(2)}`,
    work_id: workId,
    state: "open",
    effect_state: "not_started",
    urgency: "now",
    conclusion: "decision",
    trigger: "trigger",
    impact: "impact",
    recommendation: null,
    options: ["continue", "stop"],
    owner: opts.owner,
    expires_at: null,
    source_link: null,
    approval_id: null,
    consumer_owner: null,
    contract_revision: 1,
    decision_mode: "human_only",
    evidence: opts.withEvidence ? { object_id: "obj-evidence", revision: 1 } : {},
  });
}

afterEach(() => {
  // 任何路径解析错误都不得在仓库根目录留下 Bun 的 "undefined" 文件。
  expect(existsSync(join(repoRoot, "undefined"))).toBe(false);
  expect(existsSync(join(repoRoot, "undefined-shm"))).toBe(false);
  expect(existsSync(join(repoRoot, "undefined-wal"))).toBe(false);
});

describe("修复1: open* 路径 fail-fast", () => {
  test("openControl 拒绝空/字面量 'undefined' 路径且不建文件", () => {
    const root = mkdtempSync(join(tmpdir(), "ovl-path-"));
    try {
      expect(() => openControl(join(root, "x.db"))).not.toThrow(); // 正常路径可用
      expect(() => openControl("")).toThrow(/path is required/);
      expect(() => openControl(null)).toThrow(/path is required/);
      expect(() => openControl("undefined")).toThrow(/path is required/);
      expect(existsSync(join(root, "undefined"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("openStore 拒绝空/字面量 'undefined' 路径", () => {
    const root = mkdtempSync(join(tmpdir(), "ovl-store-"));
    try {
      expect(() => openStore(join(root, "y.db"))).not.toThrow();
      expect(() => openStore("")).toThrow(/path is required/);
      expect(() => openStore(null)).toThrow(/path is required/);
      expect(() => openStore("undefined")).toThrow(/path is required/);
      expect(existsSync(join(root, "undefined"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("openMailbox 拒绝空/字面量 'undefined' 路径", () => {
    const root = mkdtempSync(join(tmpdir(), "ovl-mail-"));
    try {
      expect(() => openMailbox(join(root, "m.db"))).not.toThrow();
      expect(() => openMailbox("")).toThrow(/path is required/);
      expect(() => openMailbox(null)).toThrow(/path is required/);
      expect(() => openMailbox("undefined")).toThrow(/path is required/);
      expect(existsSync(join(root, "undefined"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("修复3: resolveAttentionDecision 复验 fail-closed", () => {
  test("actor 为空 + context 证据 → 拒绝（不再 fail-open）", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const item = openContextItem(db, work.work_id, { owner: "alice", withEvidence: true });
    expect(() =>
      resolveAttentionDecision(db, item.item_id, item.revision, { selected_option: "stop", expected_contract_revision: 1 }),
    ).toThrowError(/actor identity required/);
    expect(getWork(db, work.work_id)?.state).toBe("active");
    db.close();
  });

  test("actor 为空 + 纯 legacy 无 context → 兼容放行", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const item = openContextItem(db, work.work_id, { owner: "alice", withEvidence: false });
    expect(() =>
      resolveAttentionDecision(db, item.item_id, item.revision, { selected_option: "stop" }),
    ).not.toThrow();
    db.close();
  });

  test("错误 owner → 拒绝", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const item = openContextItem(db, work.work_id, { owner: "alice", withEvidence: true });
    expect(() =>
      resolveAttentionDecision(db, item.item_id, item.revision, { selected_option: "stop", expected_contract_revision: 1 }, Date.now(), "mallory"),
    ).toThrowError(/not authorized/);
    db.close();
  });

  test("work A 的 share 不放行 work B（跨 work 不串权）", () => {
    const db = fixture();
    // work A：owner alice，登记 context problem+object，并 share 给 "some-other-work"。
    const workA = createWork(db, { title: "A", source: "test", contract: makeContract("alice") }, 1);
    const prob = createProblem(db, { work_id: workA.work_id, title: "p" }, 2);
    const obj = createObject(db, {
      work_id: workA.work_id, ctype: "fact", fact_subtype: "code_state",
      object_canonical_key: "k", reference: "ref:k", source_type: "orchestrator",
      content_hash: "h", sensitivity: "clean", shareable: 1,
    }, 3);
    linkProblemObject(db, { problem_id: prob.problem_id, object_id: obj.object_id, revision: 1, role: "fact" }, 4);
    // share 记录：授予某个不相关 work "victim-work"。
    db.run("INSERT INTO control_context_shares(share_id,object_id,revision,shared_with_work,granted_by,granted_at) VALUES(?,?,?,?,?,?)",
      ["share-1", obj.object_id, 1, "victim-work", "alice", Date.now()]);

    // work B：owner bob，带 context evidence。actor mallory 不是 bob 也不是 work B 的被 share 方。
    const workB = createWork(db, { title: "B", source: "test", contract: makeContract("bob") }, 1);
    const itemB = openContextItem(db, workB.work_id, { owner: "bob", withEvidence: true });
    // work B 自己有 context problem 才会触发 share 查询域；给它也建一个 problem。
    const probB = createProblem(db, { work_id: workB.work_id, title: "pb" }, 5);
    void probB;
    expect(() =>
      resolveAttentionDecision(db, itemB.item_id, itemB.revision, { selected_option: "stop", expected_contract_revision: 1 }, Date.now(), "mallory"),
    ).toThrowError(/not authorized/);
    db.close();
  });
});

describe("修复4: contract revision fail-closed", () => {
  test("不传 expected_contract_revision，但 contract 已漂移 → 仍被 staleness 绑定拒绝", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const item = openContextItem(db, work.work_id, { owner: "alice", withEvidence: true });
    // attention 记录 contract_revision=1，把 work.revision 漂到 2 → 无条件 staleness 兜底拒绝。
    db.run("UPDATE control_works SET revision=? WHERE work_id=?", [2, work.work_id]);
    expect(() =>
      resolveAttentionDecision(db, item.item_id, item.revision, { selected_option: "stop" }, Date.now(), "alice"),
    ).toThrowError(/stale/);
    db.close();
  });

  test("context 决策传不匹配的 expected_contract_revision → 拒绝", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const item = openContextItem(db, work.work_id, { owner: "alice", withEvidence: true });
    db.run("UPDATE control_works SET revision=? WHERE work_id=?", [9, work.work_id]);
    expect(() =>
      resolveAttentionDecision(db, item.item_id, item.revision, { selected_option: "stop", expected_contract_revision: 1 }, Date.now(), "alice"),
    ).toThrowError(/revision mismatch|stale/);
    db.close();
  });

  test("context 决策传当前版本 + owner → 通过", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const item = openContextItem(db, work.work_id, { owner: "alice", withEvidence: true });
    expect(() =>
      resolveAttentionDecision(db, item.item_id, item.revision, { selected_option: "stop", expected_contract_revision: 1 }, Date.now(), "alice"),
    ).not.toThrow();
    db.close();
  });
});

describe("修复6: fetchFromSource 路径安全", () => {
  test("reference 含 ../ → blocked", () => {
    const db = fixture();
    const r = fetchOnDemand({ reference: "contract:../etc/passwd@1", visibility: "full", actor: "a", work_id: "w", purpose: "decision_view", db });
    expect("blocked" in r).toBe(true);
  });
  test("绝对路径 /etc/passwd → blocked", () => {
    const db = fixture();
    const r = fetchOnDemand({ reference: "/etc/passwd", visibility: "full", actor: "a", work_id: "w", purpose: "decision_view", db });
    expect("blocked" in r).toBe(true);
  });
  test("未注册 handle file:///etc/passwd → blocked", () => {
    const db = fixture();
    const r = fetchOnDemand({ reference: "file:///etc/passwd", visibility: "full", actor: "a", work_id: "w", purpose: "decision_view", db });
    expect("blocked" in r).toBe(true);
  });
});


describe("修复5: OVERLOAD_CONTEXT_ASSEMBLY_ENABLED=false 全链路停用", () => {
  test("collector 返回空、ingest 返回全 0、不写表", () => {
    process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED = "false";
    try {
      const root = mktmp(join(tmpdir(), "ovl-switch-"));
      const controlDb = new Database(":memory:");
      controlDb.exec("PRAGMA foreign_keys=ON");
      ensureControlSchema(controlDb);
      const orchDb = openOrchStore(join(root, "orch.db"));
      try {
        const facts = collectFacts({ db: orchDb, work_id: "w1", actor: "a" } as any);
        expect(Array.isArray(facts)).toBe(true);
        expect(facts.length).toBe(0);
        const spooled = collectAndSpool({ db: orchDb, work_id: "w1", actor: "a" } as any, join(root, "spool"));
        expect(spooled).toEqual({ events: 0, spooled: 0 });
        const stats = ingestContextSpool(controlDb, join(root, "spool"));
        expect(stats.read).toBe(0);
        expect(stats.created).toBe(0);
        expect(stats.idempotent).toBe(0);
        expect(stats.quarantined).toBe(0);
        expect(stats.failed).toBe(0);
      } finally { orchDb.close(); controlDb.close(); }
    } finally {
      delete process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED;
    }
  });
});
