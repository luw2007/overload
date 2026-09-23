import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureControlSchema, createWork } from "../control/store";
import { ensureContextReducerSchema } from "../control/context-reducer";
import type { Contract } from "../control/types";
import { createObject, createProblem, linkProblemObject, type ContextObject } from "../control/context-pool";
import { buildAgentTaskContext, type AgentTaskContextResult } from "./agent-task-context";

const orchSchema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");

function controlFixture(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  ensureContextReducerSchema(db);
  return db;
}

function orchFixture(): Database {
  const db = new Database(":memory:");
  db.exec(orchSchema);
  return db;
}

function makeContract(owner = "alice"): Contract {
  return {
    objective: "refactor parseConfig to pure function and add tests",
    acceptance: [{ id: "a1", kind: "human", description: "done" }],
    non_goals: ["do not change public API signature"],
    scope: { repo: "/tmp/repo", cwd: "/tmp/repo" },
    budget: { retry_limit: 3 },
    stop_conditions: [{ id: "s1", kind: "hard", description: "tests fail" }],
    decision_owner: owner,
  };
}

function makeFact(
  db: Database,
  workId: string,
  key: string,
  over: Partial<Parameters<typeof createObject>[1]> = {},
): ContextObject {
  return createObject(db, {
    work_id: workId,
    ctype: "fact",
    fact_subtype: "test_result",
    object_canonical_key: key,
    reference: `orchestrator:submit_result:${key}`,
    source_type: "orchestrator",
    content_hash: `hash-${key}`,
    sensitivity: "clean",
    summary_short: `test ${key} passed`,
    ...over,
  });
}

function expectOk(result: AgentTaskContextResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.reason}`);
  return result;
}

describe("T6 agent-task-context", () => {
  test("1. buildAgentTaskContext: returns ok with structured constraints in injection", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);

    const result = buildAgentTaskContext({
      db: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: "task-1",
      actor: "alice",
    });

    const ok = expectOk(result);
    expect(ok.package.package_type).toBe("agent_task");
    expect(ok.package.objective.summary).toContain("refactor parseConfig");
    expect(ok.package.constraints.non_goals).toContain("do not change public API signature");
    expect(ok.package.constraints.stop_conditions.length).toBeGreaterThan(0);
    expect(ok.system_prompt_injection).toContain("=== OVERLOAD CONTEXT ===");
    expect(ok.system_prompt_injection).toContain("Objective: refactor parseConfig");
    expect(ok.system_prompt_injection).toContain("Non-goals: do not change public API signature");
    expect(ok.system_prompt_injection).toContain("=== END OVERLOAD CONTEXT ===");
    cdb.close(); odb.close();
  });

  test("2. scope filter: only matching facts retained", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(cdb, { work_id: work.work_id, title: "root" }, 2);

    // Fact matching scope: references /tmp/repo
    const factMatch = makeFact(cdb, work.work_id, "fact-match", {
      summary_short: "test result in /tmp/repo passed",
      reference: "orchestrator:submit_result:fact-match",
    });
    linkProblemObject(cdb, { problem_id: problem.problem_id, object_id: factMatch.object_id, revision: 1, role: "fact" }, 3);

    // Fact NOT matching scope: references different path
    const factNoMatch = makeFact(cdb, work.work_id, "fact-nomatch", {
      summary_short: "test result in /other/dir passed",
      reference: "orchestrator:submit_result:fact-nomatch",
    });
    linkProblemObject(cdb, { problem_id: problem.problem_id, object_id: factNoMatch.object_id, revision: 1, role: "fact" }, 4);

    const result = buildAgentTaskContext({
      db: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: "task-2",
      problem_id: problem.problem_id,
      actor: "alice",
      scope_filter: { repo: "/tmp/repo" },
    });

    const ok = expectOk(result);
    // Only the fact matching /tmp/repo should be retained
    const refs = ok.package.relevant_facts.map((f) => f.reference);
    expect(refs).toContain("orchestrator:submit_result:fact-match");
    expect(refs).not.toContain("orchestrator:submit_result:fact-nomatch");
    cdb.close(); odb.close();
  });

  test("3. no objective (contract without objective) → blocked(needs_context)", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    // Create work with contract (for access), then strip objective from contract
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    // Strip objective from contract to simulate missing objective
    cdb.run("UPDATE control_works SET contract=? WHERE work_id=?", [
      JSON.stringify({ decision_owner: "alice", acceptance: [], non_goals: [], scope: {}, budget: {}, stop_conditions: [] }),
      work.work_id,
    ]);

    const result = buildAgentTaskContext({
      db: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: "task-3",
      actor: "alice",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("needs_context");
    }
    cdb.close(); odb.close();
  });

  test("4. actor without permission → blocked(forbidden)", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);

    const result = buildAgentTaskContext({
      db: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: "task-4",
      actor: "bob", // not decision owner, no share
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("forbidden");
    }
    cdb.close(); odb.close();
  });

  test("5. system prompt injection format correct", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);

    const result = buildAgentTaskContext({
      db: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: "task-5",
      actor: "alice",
    });

    const ok = expectOk(result);
    expect(ok.system_prompt_injection).toContain("=== OVERLOAD CONTEXT ===");
    expect(ok.system_prompt_injection).toContain("Objective:");
    expect(ok.system_prompt_injection).toContain("Contract revision:");
    expect(ok.system_prompt_injection).toContain("Non-goals:");
    expect(ok.system_prompt_injection).toContain("Scope:");
    expect(ok.system_prompt_injection).toContain("Budget:");
    expect(ok.system_prompt_injection).toContain("Stop conditions:");
    expect(ok.system_prompt_injection).toContain("Human-only effects:");
    expect(ok.system_prompt_injection).toContain("Relevant facts:");
    expect(ok.system_prompt_injection).toContain("Prior decisions:");
    expect(ok.system_prompt_injection).toContain("Artifacts:");
    expect(ok.system_prompt_injection).toContain("Checkpoint:");
    expect(ok.system_prompt_injection).toContain("=== END OVERLOAD CONTEXT ===");
    cdb.close(); odb.close();
  });

  test("6. OVERLOAD_CONTEXT_ASSEMBLY_ENABLED=false → disabled 状态", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);

    const oldEnv = process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED;
    process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED = "false";
    try {
      const result = buildAgentTaskContext({
        db: cdb,
        orchestratorDb: odb,
        work_id: work.work_id,
        task_id: "task-6",
        actor: "alice",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("disabled");
        expect(result.blocked).toBe(false);
      }
    } finally {
      if (oldEnv === undefined) delete process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED;
      else process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED = oldEnv;
    }
    cdb.close(); odb.close();
  });
});
