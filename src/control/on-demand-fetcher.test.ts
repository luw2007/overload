import { describe, expect, test, beforeEach } from "bun:test";
import { unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ensureControlSchema } from "./store";
import { createObject, getObjectVersion } from "./context-pool";
import type { ContextObject, ObjectVersion } from "./context-pool";
import {
  fetchOnDemand,
  clearFetchCache,
  invalidateFetchCache,
  beginFetchSession,
} from "./on-demand-fetcher";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  return db;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function insertContract(db: Database, workId: string, rev: number, contractJson: string): void {
  db.query(
    "INSERT INTO control_contract_revisions(work_id,revision,contract,reason,created_at) VALUES (?,?,?,?,?)",
  ).run(workId, rev, contractJson, "test", Date.now());
}

function insertAttention(db: Database, itemId: string, workId: string, rev: number): void {
  db.query(`INSERT INTO control_attention
    (item_id,work_id,revision,state,effect_state,urgency,conclusion,trigger,impact,
     options,owner,contract_revision,decision_mode,evidence,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      itemId, workId, rev, "open", "not_started", "now",
      "test conclusion", "test trigger", "test impact",
      JSON.stringify(["continue"]), "owner", 1, "human_only",
      JSON.stringify({ foo: "bar" }), Date.now(), Date.now(),
    );
}

function makeObjectForReference(
  db: Database,
  opts: {
    work_id: string;
    ctype: "objective" | "constraints" | "fact" | "decision" | "artifact" | "scene";
    fact_subtype?: "code_state" | "test_result" | "external_state" | "observation_evidence";
    key: string;
    reference: string;
    sensitivity?: "clean" | "suspected" | "confirmed_secret";
    shareable?: number;
    content_hash?: string;
    summary_short?: string;
    summary_long?: string;
  },
): { object: ContextObject; version: ObjectVersion } {
  const obj = createObject(db, {
    work_id: opts.work_id,
    ctype: opts.ctype,
    fact_subtype: opts.fact_subtype,
    object_canonical_key: opts.key,
    reference: opts.reference,
    source_type: opts.ctype === "objective" || opts.ctype === "constraints" ? "contract" : "orchestrator",
    sensitivity: opts.sensitivity ?? "clean",
    shareable: opts.shareable ?? 0,
    content_hash: opts.content_hash ?? "testhash",
    summary_short: opts.summary_short ?? "short summary",
    summary_long: opts.summary_long ?? "long summary",
  });
  const version = getObjectVersion(db, obj.object_id, 1)!;
  return { object: obj, version };
}

function insertShare(db: Database, objectId: string, revision: number, sharedWithWork: string): void {
  db.query(
    "INSERT INTO control_context_shares(share_id,object_id,revision,shared_with_work,granted_by,granted_at) VALUES (?,?,?,?,?,?)",
  ).run(`share_${objectId}_${sharedWithWork}_${Date.now()}`, objectId, revision, sharedWithWork, "owner", Date.now());
}

beforeEach(() => {
  clearFetchCache();
});

describe("fetchOnDemand — permission rejection", () => {
  test("permission denied → blocked, does not fetch source", () => {
    const db = fixture();
    const contractJson = JSON.stringify({ objective: "do something" });
    insertContract(db, "w1", 1, contractJson);
    makeObjectForReference(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "contract:w1@1",
      sensitivity: "unknown", // unknown → unavailable
      content_hash: sha256(contractJson),
    });
    const result = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in result).toBe(true);
    if ("blocked" in result) {
      expect(result.code).toBe("unavailable");
    }
    db.close();
  });
});

describe("fetchOnDemand — contract source", () => {
  test("contract reference → queries DB and returns content", () => {
    const db = fixture();
    const contractJson = JSON.stringify({ objective: "refactor parseConfig", acceptance: [] });
    insertContract(db, "w1", 1, contractJson);
    makeObjectForReference(db, {
      work_id: "w1", ctype: "objective",
      key: "k1", reference: "contract:w1@1",
      sensitivity: "clean",
      content_hash: sha256(contractJson),
    });
    const result = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "orchestrator", work_id: "w1", purpose: "agent_task", db,
    });
    expect("blocked" in result).toBe(false);
    if (!("blocked" in result)) {
      expect(result.payload).toBe(contractJson);
      expect(result.content_hash).toBe(sha256(contractJson));
    }
    db.close();
  });
});

describe("fetchOnDemand — attention source", () => {
  test("attention reference → queries DB and returns content", () => {
    const db = fixture();
    const itemId = "item1";
    insertAttention(db, itemId, "w1", 1);
    // Fetch the row to compute its exact JSON for hash
    const row = db.query("SELECT * FROM control_attention WHERE item_id=? AND revision=?").get(itemId, 1) as Record<string, unknown>;
    const rowJson = JSON.stringify(row);
    makeObjectForReference(db, {
      work_id: "w1", ctype: "decision",
      key: "k1", reference: `attention:${itemId}@1`,
      sensitivity: "clean",
      content_hash: sha256(rowJson),
    });
    const result = fetchOnDemand({
      reference: `attention:${itemId}@1`, visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in result).toBe(false);
    if (!("blocked" in result)) {
      expect(result.payload).toBe(rowJson);
    }
    db.close();
  });
});

describe("fetchOnDemand — unimplemented sources", () => {
  test.each([
    "journal:1",
    "orchestrator:submit_result:abc",
    "git:myrepo@abc1234",
    "artifact:art1@v1",
  ])("%s → blocked, no fabricated values", (ref) => {
    const db = fixture();
    makeObjectForReference(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "observation_evidence",
      key: `key_${ref}`, reference: ref,
      sensitivity: "clean", content_hash: "somehash",
    });
    const result = fetchOnDemand({
      reference: ref, visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in result).toBe(true);
    if ("blocked" in result) {
      // artifact 命中"不属于本 work/不存在"时返回 forbidden；其余未实现源返回 unavailable。
      expect(["unavailable", "forbidden"]).toContain(result.code);
    }
    db.close();
  });
});

describe("fetchOnDemand — cache", () => {
  test("second identical request returns cached result", () => {
    const db = fixture();
    const contractJson = JSON.stringify({ objective: "cached" });
    insertContract(db, "w1", 1, contractJson);
    makeObjectForReference(db, {
      work_id: "w1", ctype: "objective",
      key: "k1", reference: "contract:w1@1",
      sensitivity: "clean", content_hash: sha256(contractJson),
    });
    const r1 = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in r1).toBe(false);

    // Change the DB row — should still return cached
    db.query("UPDATE control_contract_revisions SET contract=? WHERE work_id=? AND revision=?")
      .run(JSON.stringify({ objective: "changed" }), "w1", 1);

    const r2 = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in r2).toBe(false);
    if (!("blocked" in r2)) {
      expect(r2.payload).toBe(contractJson); // still old cached value
    }
    db.close();
  });

  test("cache isolation: different actor does not share cache", () => {
    const db = fixture();
    const contractJson = JSON.stringify({ objective: "isolated" });
    insertContract(db, "w1", 1, contractJson);
    makeObjectForReference(db, {
      work_id: "w1", ctype: "objective",
      key: "k1", reference: "contract:w1@1",
      sensitivity: "clean", content_hash: sha256(contractJson),
    });
    const r1 = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in r1).toBe(false);

    // Different actor — should NOT hit cache (different cache key)
    const r2 = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "orchestrator", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in r2).toBe(false);
    if (!("blocked" in r2)) {
      expect(r2.payload).toBe(contractJson); // still works, but independently fetched
    }
    db.close();
  });

  test("invalidateFetchCache clears cached entries", () => {
    const db = fixture();
    const contractJson = JSON.stringify({ objective: "invalidated" });
    insertContract(db, "w1", 1, contractJson);
    makeObjectForReference(db, {
      work_id: "w1", ctype: "objective",
      key: "k1", reference: "contract:w1@1",
      sensitivity: "clean", content_hash: sha256(contractJson),
    });
    fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });

    invalidateFetchCache("owner", "w1", "decision_view");

    // Change DB and refetch — should get new (but hash-mismatch) result
    const newJson = JSON.stringify({ objective: "new" });
    db.query("UPDATE control_contract_revisions SET contract=? WHERE work_id=? AND revision=?")
      .run(newJson, "w1", 1);

    const r2 = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in r2).toBe(true);
    if ("blocked" in r2) expect(r2.code).toBe("needs_context");
    db.close();
  });
});

describe("fetchOnDemand — content_hash", () => {
  test("content_hash mismatch → needs_context", () => {
    const db = fixture();
    insertContract(db, "w1", 1, JSON.stringify({ objective: "actual content" }));
    makeObjectForReference(db, {
      work_id: "w1", ctype: "objective",
      key: "k1", reference: "contract:w1@1",
      sensitivity: "clean",
      content_hash: sha256("wrong hash source"),
    });
    const result = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "orchestrator", work_id: "w1", purpose: "agent_task", db,
    });
    expect("blocked" in result).toBe(true);
    if ("blocked" in result) expect(result.code).toBe("needs_context");
    db.close();
  });
});

describe("fetchOnDemand — visibility projection", () => {
  test("visibility=short → returns summary_short, not full text", () => {
    const db = fixture();
    const contractJson = JSON.stringify({ objective: "full contract text here" });
    insertContract(db, "w1", 1, contractJson);
    makeObjectForReference(db, {
      work_id: "w1", ctype: "objective",
      key: "k1", reference: "contract:w1@1",
      sensitivity: "clean",
      content_hash: sha256(contractJson),
      summary_short: "one-line summary",
    });
    const result = fetchOnDemand({
      reference: "contract:w1@1", visibility: "short",
      actor: "orchestrator", work_id: "w1", purpose: "agent_task", db,
    });
    expect("blocked" in result).toBe(false);
    if (!("blocked" in result)) {
      expect(result.payload).toBe("one-line summary");
      expect(result.visibility).toBe("short");
    }
    db.close();
  });

  test("visibility=full → returns fetched source text", () => {
    const db = fixture();
    const contractJson = JSON.stringify({ objective: "full contract text" });
    insertContract(db, "w1", 1, contractJson);
    makeObjectForReference(db, {
      work_id: "w1", ctype: "objective",
      key: "k1", reference: "contract:w1@1",
      sensitivity: "clean",
      content_hash: sha256(contractJson),
    });
    const result = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "orchestrator", work_id: "w1", purpose: "agent_task", db,
    });
    expect("blocked" in result).toBe(false);
    if (!("blocked" in result)) {
      expect(result.payload).toBe(contractJson);
      expect(result.visibility).toBe("full");
    }
    db.close();
  });

  test("visibility=long → returns summary_long", () => {
    const db = fixture();
    const contractJson = JSON.stringify({ objective: "full" });
    insertContract(db, "w1", 1, contractJson);
    makeObjectForReference(db, {
      work_id: "w1", ctype: "scene",
      key: "k1", reference: "contract:w1@1",
      sensitivity: "clean",
      content_hash: sha256(contractJson),
      summary_long: "detailed long summary",
    });
    const result = fetchOnDemand({
      reference: "contract:w1@1", visibility: "long",
      actor: "orchestrator", work_id: "w1", purpose: "recovery", db,
    });
    expect("blocked" in result).toBe(false);
    if (!("blocked" in result)) {
      expect(result.payload).toBe("detailed long summary");
    }
    db.close();
  });
});

describe("fetchOnDemand — budget", () => {
  test("max_bytes exceeded → budget_limited flag", () => {
    const db = fixture();
    const longText = "a".repeat(1000);
    insertContract(db, "w1", 1, longText);
    makeObjectForReference(db, {
      work_id: "w1", ctype: "objective",
      key: "k1", reference: "contract:w1@1",
      sensitivity: "clean",
      content_hash: sha256(longText),
    });
    const result = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "orchestrator", work_id: "w1", purpose: "agent_task", db,
      budget: { max_bytes: 100 },
    });
    expect("blocked" in result).toBe(false);
    if (!("blocked" in result)) {
      expect(result.budget_limited).toBe(true);
      expect(Buffer.byteLength(result.payload, "utf8")).toBeLessThanOrEqual(100);
    }
    db.close();
  });
});

describe("fetchOnDemand — journal source (cross-db readonly)", () => {
  test("journal:<seq> → reads detail from ledger.db readonly", () => {
    const db = fixture();
    // Create temp ledger DB
    const ledgerPath = `/tmp/test-ledger-journal-${Date.now()}.db`; try { unlinkSync(ledgerPath); } catch {}
    const ledger = new Database(ledgerPath, { create: true });
    ledger.exec("CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT, detail TEXT)");
    const journalDetail = JSON.stringify({ kind: "effect_observed", note: "test effect" });
    ledger.run("INSERT INTO journal(detail) VALUES(?)", [journalDetail]);
    ledger.close();

    process.env.OVERLOAD_LEDGER_PATH = ledgerPath;
    makeObjectForReference(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "observation_evidence",
      key: "j1", reference: "journal:1",
      sensitivity: "clean", content_hash: sha256(journalDetail),
    });
    const result = fetchOnDemand({
      reference: "journal:1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in result).toBe(false);
    if (!("blocked" in result)) expect(result.payload).toBe(journalDetail);

    delete process.env.OVERLOAD_LEDGER_PATH;
    db.close();
    // cleanup
    try { unlinkSync(ledgerPath); } catch {}
  });
});

describe("fetchOnDemand — orchestrator task_event source (cross-db readonly)", () => {
  test("orchestrator:task_event:<id> → reads detail from orchestrator.db readonly (work bound)", () => {
    const db = fixture();
    const orchPath = `/tmp/test-orch-task-${Date.now()}.db`; try { unlinkSync(orchPath); } catch {}
    const orch = new Database(orchPath, { create: true });
    orch.exec(`CREATE TABLE tasks(task_id TEXT PRIMARY KEY, work_id TEXT, created_at INTEGER, updated_at INTEGER);
               CREATE TABLE task_events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, at INTEGER, event TEXT, detail TEXT)`);
    const eventDetail = JSON.stringify({ exit_code: 0, summary: "tests passed" });
    orch.run("INSERT INTO tasks(task_id,work_id,created_at,updated_at) VALUES(?,?,?,?)", ["task-1", "w1", 1000, 1000]);
    orch.run("INSERT INTO task_events(task_id,at,event,detail) VALUES(?,?,?,?)", ["task-1", 1000, "runner_exit", eventDetail]);
    orch.close();

    process.env.OVERLOAD_ORCHESTRATOR_PATH = orchPath;
    makeObjectForReference(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "te1", reference: "orchestrator:task_event:1",
      sensitivity: "clean", content_hash: sha256(eventDetail),
    });
    const result = fetchOnDemand({
      reference: "orchestrator:task_event:1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "agent_task", db,
    });
    expect("blocked" in result).toBe(false);
    if (!("blocked" in result)) expect(result.payload).toBe(eventDetail);

    delete process.env.OVERLOAD_ORCHESTRATOR_PATH;
    db.close();
    try { unlinkSync(orchPath); } catch {}
  });

  test("跨 work：task_event 属于 w2，用 w1 取 → blocked(forbidden)，不返回正文", () => {
    const db = fixture();
    const orchPath = `/tmp/test-orch-xwork-${Date.now()}.db`; try { unlinkSync(orchPath); } catch {}
    const orch = new Database(orchPath, { create: true });
    orch.exec(`CREATE TABLE tasks(task_id TEXT PRIMARY KEY, work_id TEXT, created_at INTEGER, updated_at INTEGER);
               CREATE TABLE task_events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, at INTEGER, event TEXT, detail TEXT)`);
    const secret = JSON.stringify({ secret: "w2-only body" });
    orch.run("INSERT INTO tasks(task_id,work_id,created_at,updated_at) VALUES(?,?,?,?)", ["task-9", "w2", 1, 1]);
    orch.run("INSERT INTO task_events(task_id,at,event,detail) VALUES(?,?,?,?)", ["task-9", 1, "runner_exit", secret]);
    orch.close();

    process.env.OVERLOAD_ORCHESTRATOR_PATH = orchPath;
    // 对象注册在 w1，但 reference 指向 w2 的 task_event。
    makeObjectForReference(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "te-x", reference: "orchestrator:task_event:1",
      sensitivity: "clean", shareable: 1, content_hash: sha256(secret),
    });
    const result = fetchOnDemand({
      reference: "orchestrator:task_event:1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "agent_task", db,
    });
    expect("blocked" in result).toBe(true);
    if ("blocked" in result) {
      expect(result.code).toBe("forbidden");
      expect(result.reason).toContain("cross-work");
    }

    delete process.env.OVERLOAD_ORCHESTRATOR_PATH;
    db.close();
    try { unlinkSync(orchPath); } catch {}
  });
});

describe("fetchOnDemand — artifact source (same DB mgmt tables)", () => {
  test("artifact:<id>@<ver> → queries mgmt_artifacts + mgmt_artifact_versions", () => {
    const db = fixture();
    // Insert control_works row first (FK constraint)
    db.run("INSERT INTO control_works(work_id,title,source,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ["w1", "test work", "test", "active", 1, Date.now(), Date.now()]);
    // Insert mgmt data
    db.run("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES(?,?,?,?,?,?,?)",
      ["w1", "contract_governed", "mgmt", "tracking", "owner", "test work", Date.now()]);
    db.run("INSERT INTO mgmt_artifacts(artifact_id,work_id,kind,canonical_key,created_at) VALUES(?,?,?,?,?)",
      ["art1", "w1", "file", "src/main.ts", Date.now()]);
    const artifactRow = { artifact_id: "art1", kind: "file", canonical_key: "src/main.ts", version_id: "v1", content_kind: "content", content_sha256: "abc", snapshot_path: "/tmp/snap", snapshot_state: "stored", sensitivity: "clean" };
    db.run("INSERT INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_path,snapshot_state,sensitivity,producer,history_available,stale_capture,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ["v1", "art1", "content", "abc", "/tmp/snap", "stored", "clean", "test", 1, 0, Date.now()]);
    const expectedPayload = JSON.stringify(artifactRow);

    makeObjectForReference(db, {
      work_id: "w1", ctype: "artifact",
      key: "art-key", reference: "artifact:art1@v1",
      sensitivity: "clean", content_hash: sha256(expectedPayload),
    });
    const result = fetchOnDemand({
      reference: "artifact:art1@v1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in result).toBe(false);
    if (!("blocked" in result)) expect(result.payload).toBe(expectedPayload);
    db.close();
  });
});

describe("fetchOnDemand — illegal path rejection", () => {
  test("arbitrary file path → unavailable, not read", () => {
    const db = fixture();
    makeObjectForReference(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "code_state",
      key: "bad1", reference: "../../etc/passwd",
      sensitivity: "clean", content_hash: "somehash",
    });
    const result = fetchOnDemand({
      reference: "../../etc/passwd", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in result).toBe(true);
    if ("blocked" in result) expect(result.code).toBe("unavailable");
    db.close();
  });

  test("http URL → unavailable (not implemented)", () => {
    const db = fixture();
    makeObjectForReference(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "external_state",
      key: "http1", reference: "https://example.com/data",
      sensitivity: "clean", content_hash: "somehash",
    });
    const result = fetchOnDemand({
      reference: "https://example.com/data", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in result).toBe(true);
    if ("blocked" in result) expect(result.code).toBe("unavailable");
    db.close();
  });
});

describe("fetchOnDemand — assembly_enabled switch", () => {
  test("OVERLOAD_CONTEXT_ASSEMBLY_ENABLED=false → blocked unavailable", () => {
    const db = fixture();
    makeObjectForReference(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "code_state",
      key: "sw1", reference: "contract:w1@1",
      sensitivity: "clean", content_hash: "somehash",
    });
    process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED = "false";
    const result = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in result).toBe(true);
    if ("blocked" in result) {
      expect(result.code).toBe("unavailable");
      expect(result.reason).toContain("disabled");
    }
    delete process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED;
    db.close();
  });
});

describe("fetchOnDemand — artifact cross-work binding", () => {
  test("artifact 属于 w2，用 w1 取 → blocked(forbidden)，不返回正文", () => {
    const db = fixture();
    db.run("INSERT INTO control_works(work_id,title,source,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ["w2", "w2 work", "test", "active", 1, Date.now(), Date.now()]);
    db.run("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES(?,?,?,?,?,?,?)",
      ["w2", "contract_governed", "mgmt", "tracking", "owner", "w2 work", Date.now()]);
    db.run("INSERT INTO mgmt_artifacts(artifact_id,work_id,kind,canonical_key,created_at) VALUES(?,?,?,?,?)",
      ["art-secret", "w2", "file", "secret.ts", Date.now()]);
    db.run("INSERT INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_path,snapshot_state,sensitivity,producer,history_available,stale_capture,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ["v1", "art-secret", "content", "h", "/tmp/s", "stored", "clean", "t", 1, 0, Date.now()]);
    makeObjectForReference(db, {
      work_id: "w2", ctype: "artifact",
      key: "art-x", reference: "artifact:art-secret@v1",
      sensitivity: "clean", content_hash: "x".repeat(64),
    });
    const result = fetchOnDemand({
      reference: "artifact:art-secret@v1", visibility: "full",
      actor: "owner", work_id: "w1", purpose: "decision_view", db,
    });
    expect("blocked" in result).toBe(true);
    if ("blocked" in result) {
      expect(result.code).toBe("forbidden");
      expect(result.reason).toContain("cross-work");
    }
    db.close();
  });
});

describe("fetchOnDemand — bounded cache (LRU + TTL)", () => {
  test("超 LRU 上限后最旧条目被淘汰（不再无限常驻）", () => {
    const db = fixture();
    // 造 101 个独立 contract 对象引用，全部 full 取源写缓存。
    const N = 101;
    for (let i = 0; i < N; i++) {
      const rev = i + 1;
      const content = `content-${i}`;
      insertContract(db, "w1", rev, content);
      makeObjectForReference(db, {
        work_id: "w1", ctype: "objective",
        key: `k${i}`, reference: `contract:w1@${rev}`,
        sensitivity: "clean", content_hash: sha256(content),
      });
      const r = fetchOnDemand({
        reference: `contract:w1@${rev}`, visibility: "full",
        actor: "orchestrator", work_id: "w1", purpose: "agent_task", db,
      });
      expect("blocked" in r).toBe(false);
    }

    // 篡改最旧对象（i=0）的 DB 原文，但不改注册的 content_hash。
    // 若已被 LRU 淘汰 → 重新取源读到篡改值 → hash 不匹配 → needs_context。
    // 若仍在缓存 → 返回旧原文 content-0，不报错。
    db.query("UPDATE control_contract_revisions SET contract=? WHERE work_id=? AND revision=?")
      .run("tampered", "w1", 1);
    const oldest = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "orchestrator", work_id: "w1", purpose: "agent_task", db,
    });
    expect("blocked" in oldest).toBe(true);
    if ("blocked" in oldest) expect(oldest.code).toBe("needs_context");

    // 对照：最新对象（i=100）仍在缓存内，返回旧原文而非重取。
    const newest = fetchOnDemand({
      reference: "contract:w1@101", visibility: "full",
      actor: "orchestrator", work_id: "w1", purpose: "agent_task", db,
    });
    expect("blocked" in newest).toBe(false);
    if (!("blocked" in newest)) expect(newest.payload).toBe("content-100");
    db.close();
  });
});

describe("fetchOnDemand — 预算按装配会话隔离", () => {
  test("两次装配会话各自独立计数 max_fetch_count，不跨请求污染", () => {
    const db = fixture();
    // 两个独立引用 A、B。
    const contentA = "contract-A";
    const contentB = "contract-B";
    insertContract(db, "w1", 1, contentA);
    insertContract(db, "w1", 2, contentB);
    makeObjectForReference(db, {
      work_id: "w1", ctype: "objective", key: "kA", reference: "contract:w1@1",
      sensitivity: "clean", content_hash: sha256(contentA),
    });
    makeObjectForReference(db, {
      work_id: "w1", ctype: "objective", key: "kB", reference: "contract:w1@2",
      sensitivity: "clean", content_hash: sha256(contentB),
    });

    // 会话 1：预算 max_fetch_count=1。取 A 消耗 1 次；再取 B 应立即 budget_exceeded。
    beginFetchSession();
    const a1 = fetchOnDemand({
      reference: "contract:w1@1", visibility: "full",
      actor: "orchestrator", work_id: "w1", purpose: "agent_task", db,
      budget: { max_fetch_count: 1 },
    });
    expect("blocked" in a1).toBe(false);
    const b1 = fetchOnDemand({
      reference: "contract:w1@2", visibility: "full",
      actor: "orchestrator", work_id: "w1", purpose: "agent_task", db,
      budget: { max_fetch_count: 1 },
    });
    expect("blocked" in b1).toBe(true);
    if ("blocked" in b1) expect(b1.code).toBe("budget_exceeded");

    // 会话 2：新装配重置计数。B 从未成功取源（未缓存），不应再因上一会话的计数立即触发预算。
    beginFetchSession();
    const b2 = fetchOnDemand({
      reference: "contract:w1@2", visibility: "full",
      actor: "orchestrator", work_id: "w1", purpose: "agent_task", db,
      budget: { max_fetch_count: 1 },
    });
    expect("blocked" in b2).toBe(false);
    if (!("blocked" in b2)) expect(b2.payload).toBe(contentB);
    db.close();
  });
});
