import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureControlSchema } from "./store";
import { createObject, getObjectVersion } from "./context-pool";
import type { ContextObject, ObjectVersion, Sensitivity } from "./context-pool";
import {
  checkVisibility,
  defaultVisibility,
  hasValidGrant,
  isAuthoritativeReference,
} from "./visibility-policy";
import type { Purpose, VisibilityLevel } from "./visibility-policy";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  return db;
}

function makeVersionedObject(
  db: Database,
  opts: {
    work_id: string;
    ctype: "objective" | "constraints" | "fact" | "decision" | "artifact" | "scene";
    fact_subtype?: "code_state" | "test_result" | "external_state" | "observation_evidence";
    key: string;
    reference: string;
    sensitivity?: Sensitivity;
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
    source_type: opts.ctype === "contract" ? "contract" : "orchestrator",
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
  ).run(`share_${objectId}_${sharedWithWork}`, objectId, revision, sharedWithWork, "owner", Date.now());
}

describe("isAuthoritativeReference", () => {
  test("accepts registered handle formats", () => {
    expect(isAuthoritativeReference("journal:1")).toBe(true);
    expect(isAuthoritativeReference("journal:42")).toBe(true);
    expect(isAuthoritativeReference("orchestrator:submit_result:abc-123")).toBe(true);
    expect(isAuthoritativeReference("git:myrepo@abc1234")).toBe(true);
    expect(isAuthoritativeReference("artifact:art1@v2")).toBe(true);
    expect(isAuthoritativeReference("contract:work1@3")).toBe(true);
    expect(isAuthoritativeReference("attention:item1@1")).toBe(true);
  });

  test("rejects bare file paths and unknown formats", () => {
    expect(isAuthoritativeReference("/tmp/file.txt")).toBe(false);
    expect(isAuthoritativeReference("./relative/path")).toBe(false);
    expect(isAuthoritativeReference("")).toBe(false);
    expect(isAuthoritativeReference("random string")).toBe(false);
  });

  test("rejects http/https by default (empty whitelist)", () => {
    expect(isAuthoritativeReference("https://example.com/data")).toBe(false);
    expect(isAuthoritativeReference("http://internal/api")).toBe(false);
  });
});

describe("defaultVisibility", () => {
  test("objective/constraints/scene → long", () => {
    expect(defaultVisibility("objective", "agent_task")).toBe("long");
    expect(defaultVisibility("constraints", "recovery")).toBe("long");
    expect(defaultVisibility("scene", "decision_view")).toBe("long");
  });

  test("fact/decision/artifact → short", () => {
    expect(defaultVisibility("fact", "decision_view")).toBe("short");
    expect(defaultVisibility("decision", "agent_task")).toBe("short");
    expect(defaultVisibility("artifact", "recovery")).toBe("short");
  });
});

describe("checkVisibility — reference and actor", () => {
  test("invalid reference → unavailable", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "/tmp/badpath", sensitivity: "clean",
    });
    const result = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("unavailable");
      expect(result.reason).toContain("invalid reference");
    }
    db.close();
  });

  test("empty actor → unauthorized", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "clean",
    });
    const result = checkVisibility({
      db, actor: "", work_id: "w1", object, version, purpose: "decision_view",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("unauthorized");
    db.close();
  });
});

describe("checkVisibility — sensitivity gating", () => {
  test("confirmed_secret without grant → forbidden, no summary", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "external_state",
      key: "k1", reference: "journal:1", sensitivity: "confirmed_secret", shareable: 0,
    });
    const result = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("forbidden");
      expect(result.reason).toContain("confirmed_secret requires grant");
    }
    db.close();
  });

  test("confirmed_secret with share record → allowed", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "external_state",
      key: "k1", reference: "journal:1", sensitivity: "confirmed_secret", shareable: 0,
    });
    insertShare(db, object.object_id, 1, "w1");
    const result = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view",
    });
    expect(result.allowed).toBe(true);
    db.close();
  });

  test("sensitivity=unknown → unavailable, rejects body and summary", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "unknown",
    });
    const result = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("unavailable");
      expect(result.reason).toContain("sensitivity unknown");
    }
    db.close();
  });

  test("suspected → defaults to short; requesting full downgrades to short", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "suspected",
    });
    // default
    const r1 = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view",
    });
    expect(r1.allowed).toBe(true);
    if (r1.allowed) expect(r1.visibility).toBe("short");

    // request full → downgraded
    const r2 = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view", requested_level: "full",
    });
    expect(r2.allowed).toBe(true);
    if (r2.allowed) {
      expect(r2.visibility).toBe("short");
      expect(r2.reason).toContain("suspected requires human confirmation");
    }
    db.close();
  });

  test("clean → passes through at default level", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "clean",
    });
    const result = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view",
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.visibility).toBe("short");
    db.close();
  });
});

describe("checkVisibility — target_model whitelist", () => {
  test("target_model not whitelisted → forbidden", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "clean",
    });
    const result = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "agent_task",
      target_model: "unknown_runtime",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("forbidden");
    db.close();
  });

  test("target_model whitelisted → allowed", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "clean",
    });
    const result = checkVisibility({
      db, actor: "orchestrator", work_id: "w1", object, version, purpose: "agent_task",
      target_model: "pi",
    });
    expect(result.allowed).toBe(true);
    db.close();
  });
});

describe("checkVisibility — cross-work", () => {
  test("cross-work without share → forbidden", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w2", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "clean", shareable: 1,
    });
    const result = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("forbidden");
    db.close();
  });

  test("cross-work with share + shareable=1 → allowed", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w2", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "clean", shareable: 1,
    });
    insertShare(db, object.object_id, 1, "w1");
    const result = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view",
    });
    expect(result.allowed).toBe(true);
    db.close();
  });

  test("cross-work with share but shareable=0 → forbidden", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w2", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "clean", shareable: 0,
    });
    insertShare(db, object.object_id, 1, "w1");
    const result = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("forbidden");
    db.close();
  });
});

describe("checkVisibility — default visibility levels", () => {
  test("objective → long for agent_task", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "objective",
      key: "k1", reference: "contract:w1@1", sensitivity: "clean",
    });
    const result = checkVisibility({
      db, actor: "orchestrator", work_id: "w1", object, version, purpose: "agent_task",
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.visibility).toBe("long");
    db.close();
  });

  test("fact → short for decision_view", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "clean",
    });
    const result = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view",
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.visibility).toBe("short");
    db.close();
  });

  test("requested_level within sensitivity cap is honored", () => {
    const db = fixture();
    const { object, version } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "clean",
    });
    const result = checkVisibility({
      db, actor: "owner", work_id: "w1", object, version, purpose: "decision_view",
      requested_level: "full",
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.visibility).toBe("full");
    db.close();
  });
});

describe("hasValidGrant", () => {
  test("returns true when share exists", () => {
    const db = fixture();
    const { object } = makeVersionedObject(db, {
      work_id: "w1", ctype: "fact", fact_subtype: "test_result",
      key: "k1", reference: "journal:1", sensitivity: "clean",
    });
    expect(hasValidGrant(db, object.object_id, 1, "w1")).toBe(false);
    insertShare(db, object.object_id, 1, "w1");
    expect(hasValidGrant(db, object.object_id, 1, "w1")).toBe(true);
    db.close();
  });
});
