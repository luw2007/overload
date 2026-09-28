import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControl, createWork, upsertAttention } from "../control/store";
import { createObject, createProblem, linkProblemObject, updateObject } from "../control/context-pool";
import { ensureContextReducerSchema } from "../control/context-reducer";
import { clearFetchCache } from "../control/on-demand-fetcher";
import { startWebServer } from "./server";
import { renderDecisionCard } from "../cli/overload";
import type { Contract } from "../control/types";

const roots: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void; port: number }> = [];
const SCHEMA_SQL = readFileSync(join(import.meta.dir, "../ingest/schema.sql"), "utf8");

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => clearFetchCache());

function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }

function seedLedger(root: string): string {
  const path = join(root, "ledger.db");
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["local:pi:a", "local", "pi", "sess", "agent", "/repo", "main", 1_700_000_000_000, 1_700_000_000_000]);
  db.close();
  return path;
}

interface Seeded {
  controlPath: string;
  workId: string;
  factObjectId: string;
  contractObjectId: string;
  secretObjectId: string;
  journalObjectId: string;
  unknownObjectId: string;
  contractJson: string;
}

function seedControl(root: string): Seeded {
  const controlPath = join(root, "control.db");
  const db = openControl(controlPath);
  ensureContextReducerSchema(db);
  const contract: Contract = {
    objective: "refactor parseConfig to a pure function",
    acceptance: [{ id: "a1", kind: "human", description: "done" }],
    non_goals: ["do not change public API"],
    scope: { repo: "/tmp/repo" },
    budget: { retry_limit: 3 },
    stop_conditions: [],
    decision_owner: "alice",
  };
  const work = createWork(db, { title: "w", source: "test", contract }, 1);
  const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
  upsertAttention(db, {
    item_id: "item-1", work_id: work.work_id, state: "open", effect_state: "not_started",
    urgency: "now", conclusion: "accept the public API change?", trigger: "exported signature changed",
    impact: "existing callers will break", recommendation: "accept", options: ["accept", "revert"],
    owner: "alice", expires_at: null, source_link: "session://jump/1", approval_id: null,
    consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
  }, 3);
  // trigger evidence fact: short + long 两级摘要
  const fact = createObject(db, {
    work_id: work.work_id, ctype: "fact", fact_subtype: "test_result",
    object_canonical_key: "fact-1", reference: "orchestrator:submit_result:run-1",
    source_type: "orchestrator", sensitivity: "clean", content_hash: "h-fact",
    summary_short: "tests exit 1", summary_long: "3 failures in parseConfig.test.ts",
  });
  linkProblemObject(db, { problem_id: problem.problem_id, object_id: fact.object_id, revision: 1, role: "fact" }, 4);
  // contract object for full fetch
  const contractJson = JSON.stringify(contract);
  const contractObj = createObject(db, {
    work_id: work.work_id, ctype: "objective", object_canonical_key: "contract-1",
    reference: `contract:${work.work_id}@1`, source_type: "contract", sensitivity: "clean",
    content_hash: sha256(contractJson),
  });
  // secret object (no grant) → forbidden
  const secret = createObject(db, {
    work_id: work.work_id, ctype: "fact", fact_subtype: "observation_evidence",
    object_canonical_key: "secret-1", reference: "orchestrator:submit_result:secret",
    source_type: "orchestrator", sensitivity: "confirmed_secret", content_hash: "h-secret",
  });
  // journal object → source unavailable
  const journal = createObject(db, {
    work_id: work.work_id, ctype: "fact", fact_subtype: "observation_evidence",
    object_canonical_key: "journal-1", reference: "journal:1",
    source_type: "ledger_event", sensitivity: "clean", content_hash: "h-journal",
  });
  // unknown-sensitivity fact → must NOT appear in trigger_evidence (no summary)
  const unknown = createObject(db, {
    work_id: work.work_id, ctype: "fact", fact_subtype: "observation_evidence",
    object_canonical_key: "unknown-1", reference: "orchestrator:submit_result:unknown",
    source_type: "orchestrator", sensitivity: "unknown", content_hash: "h-unknown",
    summary_short: "this summary must not leak", summary_long: "long of unknown must not leak",
  });
  linkProblemObject(db, { problem_id: problem.problem_id, object_id: unknown.object_id, revision: 1, role: "fact" }, 5);
  db.close();
  return {
    controlPath, workId: work.work_id,
    factObjectId: fact.object_id, contractObjectId: contractObj.object_id,
    secretObjectId: secret.object_id, journalObjectId: journal.object_id,
    unknownObjectId: unknown.object_id, contractJson,
  };
}

interface Booted { base: string; seed: Seeded }

async function boot(actor?: string): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), "overload-context-ui-"));
  roots.push(root);
  writeFileSync(join(root, "host"), "local\n");
  const seed = seedControl(root);
  const ledgerPath = seedLedger(root);
  const server = startWebServer({
    ledgerPath, controlPath: seed.controlPath,
    orchestratorPath: join(root, "orch.db"), spoolRoot: root,
    publishIntervalMs: 60_000, port: 0, ...(actor === undefined ? {} : { actor }),
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, seed };
}

describe("context routes: server-side actor injection", () => {
  // a + b: no actor configured → 501 regardless of headers
  test("a/b. 未配置 actor → 501 not_implemented，不传头也一样", async () => {
    const { base, seed } = await boot(undefined);
    const noHeader = await fetch(`${base}/api/context/decision-package?item_id=item-1&work_id=${encodeURIComponent(seed.workId)}`);
    expect(noHeader.status).toBe(501);
    const noBody = await noHeader.json() as Record<string, any>;
    expect(noBody.error).toBe("not_implemented");
    // 即使客户端伪造 actor 头，也必须被忽略
    const spoofed = await fetch(`${base}/api/context/decision-package?item_id=item-1&work_id=${encodeURIComponent(seed.workId)}`, { headers: { "x-overload-actor": "mallory" } });
    expect(spoofed.status).toBe(501);
    const spoofBody = await spoofed.json() as Record<string, any>;
    expect(spoofBody.error).toBe("not_implemented");
    // fetch-full 同样 501
    const ff = await fetch(`${base}/api/context/fetch-full?object_id=${encodeURIComponent(seed.factObjectId)}&revision=1&work_id=${encodeURIComponent(seed.workId)}`);
    expect(ff.status).toBe(501);
  });

  // c: actor=alice (decision_owner) → 200, trigger_evidence non-empty
  test("c. 配置 actor=alice（owner）→ 200，trigger_evidence 非空", async () => {
    const { base, seed } = await boot("alice");
    const res = await fetch(`${base}/api/context/decision-package?item_id=item-1&work_id=${encodeURIComponent(seed.workId)}`);
    expect(res.status).toBe(200);
    const pkg = await res.json() as Record<string, any>;
    expect(pkg.package_type).toBe("decision_view");
    expect(pkg.conclusion).toBeTruthy();
    expect(pkg.trigger_evidence.length).toBe(1);
    const ev = pkg.trigger_evidence[0];
    expect(ev.object_id).toBe(seed.factObjectId);
    expect(ev.summary).toBe("tests exit 1");
    expect(ev.reference).toBe("orchestrator:submit_result:run-1");
    // short only: long summary not leaked
    expect(JSON.stringify(pkg)).not.toContain("3 failures in parseConfig.test.ts");
  });

  // d: actor=bob (not owner, no share) → 403, no summary/body
  test("d. 配置 actor=bob（非 owner 无 share）→ 403 forbidden，不给摘要", async () => {
    const { base, seed } = await boot("bob");
    const res = await fetch(`${base}/api/context/decision-package?item_id=item-1&work_id=${encodeURIComponent(seed.workId)}`);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain("accept the public API change?");
    expect(body).not.toContain("tests exit 1");
    const parsed = JSON.parse(body) as Record<string, any>;
    expect(parsed.blocked).toBe(true);
    expect(parsed.code).toBe("forbidden");
  });

  // e: unknown-sensitivity fact must not appear in trigger_evidence
  test("e. sensitivity=unknown 的 fact 不出现在 trigger_evidence（不给摘要）", async () => {
    const { base, seed } = await boot("alice");
    const res = await fetch(`${base}/api/context/decision-package?item_id=item-1&work_id=${encodeURIComponent(seed.workId)}`);
    expect(res.status).toBe(200);
    const pkg = await res.json() as Record<string, any>;
    const ids = (pkg.trigger_evidence as Array<{ object_id: string }>).map((e) => e.object_id);
    expect(ids).not.toContain(seed.unknownObjectId);
    expect(JSON.stringify(pkg)).not.toContain("this summary must not leak");
  });

  // f: fetch-full on confirmed_secret without grant → 403
  test("f. fetch-full：confirmed_secret 无 grant → 403，无 payload", async () => {
    const { base, seed } = await boot("alice");
    const res = await fetch(`${base}/api/context/fetch-full?object_id=${encodeURIComponent(seed.secretObjectId)}&revision=1&work_id=${encodeURIComponent(seed.workId)}&visibility=short`);
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, any>;
    expect(body.error).toBe("forbidden");
    expect(body.payload).toBeUndefined();
  });

  // g: fetch-full on journal reference → 404 unavailable (source not implemented)
  test("g. fetch-full：journal 源未实现 → 404 unavailable，不造值", async () => {
    const { base, seed } = await boot("alice");
    const res = await fetch(`${base}/api/context/fetch-full?object_id=${encodeURIComponent(seed.journalObjectId)}&revision=1&work_id=${encodeURIComponent(seed.workId)}&visibility=full`);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, any>;
    expect(body.error).toBe("unavailable");
  });

  // h: x-overload-actor header is ignored; server actor wins
  test("h. x-overload-actor 头被忽略：服务器配 alice，请求带 mallory 头仍按 alice 授权", async () => {
    const { base, seed } = await boot("alice");
    const res = await fetch(`${base}/api/context/decision-package?item_id=item-1&work_id=${encodeURIComponent(seed.workId)}`, { headers: { "x-overload-actor": "mallory" } });
    // mallory 无权限；若头被采信会是 403。返回 200 证明实际用的是服务器注入的 alice。
    expect(res.status).toBe(200);
    const pkg = await res.json() as Record<string, any>;
    expect(pkg.trigger_evidence.length).toBe(1);
  });
});

describe("T11 decision card evidence UI (regression)", () => {
  test("1. GET decision-package → DecisionViewPackage, short only", async () => {
    const { base, seed } = await boot("alice");
    const res = await fetch(`${base}/api/context/decision-package?item_id=item-1&work_id=${encodeURIComponent(seed.workId)}`);
    expect(res.status).toBe(200);
    const pkg = await res.json() as Record<string, any>;
    expect(pkg.package_type).toBe("decision_view");
    expect(pkg.trigger_evidence.length).toBe(1);
    const ev = pkg.trigger_evidence[0];
    expect(ev.object_id).toBe(seed.factObjectId);
    expect(ev.summary).toBe("tests exit 1");
    expect(ev.reference).toBe("orchestrator:submit_result:run-1");
    expect(JSON.stringify(pkg)).not.toContain("3 failures in parseConfig.test.ts");
  });

  test("2. GET decision-package：item 不存在 → blocked(needs_context)", async () => {
    const { base, seed } = await boot("alice");
    const res = await fetch(`${base}/api/context/decision-package?item_id=nope&work_id=${encodeURIComponent(seed.workId)}`);
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, any>;
    expect(body.blocked).toBe(true);
    expect(body.code).toBe("needs_context");
  });

  test("3. GET fetch-full：contract reference + 有权限 → 原文 payload", async () => {
    const { base, seed } = await boot("alice");
    const res = await fetch(`${base}/api/context/fetch-full?object_id=${encodeURIComponent(seed.contractObjectId)}&revision=1&work_id=${encodeURIComponent(seed.workId)}&visibility=full`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.payload).toBe(seed.contractJson);
    expect(body.visibility).toBe("full");
    expect(body.content_hash).toBe(sha256(seed.contractJson));
  });

  test("6. evidence 默认 short；long 需显式 visibility=long", async () => {
    const { base, seed } = await boot("alice");
    const pkgRes = await fetch(`${base}/api/context/decision-package?item_id=item-1&work_id=${encodeURIComponent(seed.workId)}`);
    const pkg = await pkgRes.json() as Record<string, any>;
    expect(pkg.trigger_evidence[0].summary).toBe("tests exit 1");
    expect(pkg.trigger_evidence[0].summary).not.toContain("3 failures");
    const longRes = await fetch(`${base}/api/context/fetch-full?object_id=${encodeURIComponent(seed.factObjectId)}&revision=1&work_id=${encodeURIComponent(seed.workId)}&visibility=long`);
    expect(longRes.status).toBe(200);
    const longBody = await longRes.json() as Record<string, any>;
    expect(longBody.payload).toBe("3 failures in parseConfig.test.ts");
    expect(longBody.visibility).toBe("long");
  });

  test("7. stale 标记：对象出新版后 evidence 项 stale=true", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-context-stale-"));
    roots.push(root);
    writeFileSync(join(root, "host"), "local\n");
    const seed = seedControl(root);
    const ledgerPath = seedLedger(root);
    const server = startWebServer({ ledgerPath, controlPath: seed.controlPath, orchestratorPath: join(root, "orch.db"), spoolRoot: root, publishIntervalMs: 60_000, port: 0, actor: "alice" });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    const before = await (await fetch(`${base}/api/context/decision-package?item_id=item-1&work_id=${encodeURIComponent(seed.workId)}`)).json() as Record<string, any>;
    expect(before.trigger_evidence[0].stale).toBeUndefined();

    const db = openControl(seed.controlPath);
    updateObject(db, { object_id: seed.factObjectId, expectedRevision: 1, patch: { content_hash: "hash-v2", summary_short: "updated short" } }, 5);
    db.close();

    const after = await (await fetch(`${base}/api/context/decision-package?item_id=item-1&work_id=${encodeURIComponent(seed.workId)}`)).json() as Record<string, any>;
    expect(after.trigger_evidence[0].stale).toBe(true);
    expect(after.stale_objects[0].current_revision).toBe(2);
    expect(after.stale_objects[0].linked_revision).toBe(1);
  });

  test("8. CLI：默认 short 不展开 long；--verbose 输出 long 级别摘要", () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-card-"));
    roots.push(root);
    const seed = seedControl(root);
    const db = openControl(seed.controlPath);
    const short = renderDecisionCard(db, "item-1");
    expect(short).toContain("tests exit 1");
    expect(short).toContain("orchestrator:submit_result:run-1");
    expect(short).not.toContain("3 failures in parseConfig.test.ts");
    const verbose = renderDecisionCard(db, "item-1", { verbose: true });
    expect(verbose).toContain("3 failures in parseConfig.test.ts");
    db.close();
  });

  test("9. blocked(forbidden)：mallory 非 owner → 决策卡显示警示，不造值", () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-blocked-"));
    roots.push(root);
    const seed = seedControl(root);
    const db = openControl(seed.controlPath);
    const out = renderDecisionCard(db, "item-1", { actor: "mallory" });
    expect(out).toContain("上下文不足");
    expect(out).toContain("原因：");
    expect(out).not.toContain("accept the public API change?");
    db.close();
  });
});
