import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { pollSubmissions } from "../src/manage/submit";
import type { CommandExecutor } from "../src/orchestrator/worktree";

function newDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE mgmt_submissions(
    submission_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    steps TEXT NOT NULL,
    external_ref TEXT
  )`);
  return db;
}

function seed(db: Database): void {
  db.query("INSERT INTO mgmt_submissions(submission_id,state,steps,external_ref) VALUES (?,?,?,?)")
    .run("s1", "pr_created", "[]", "https://example.test/pr/merged");
  db.query("INSERT INTO mgmt_submissions(submission_id,state,steps,external_ref) VALUES (?,?,?,?)")
    .run("s2", "pr_created", "[]", "https://example.test/pr/observation-failed");
}

function fakeExecutor(outcomes: Record<string, { ok: boolean; stdout: string }>): CommandExecutor {
  return async (_cmd, args) => {
    const url = args[2] as string; // gh pr view <url> ...
    const hit = outcomes[url] ?? { ok: false, stdout: "", stderr: "not found" };
    return { ok: hit.ok, stdout: hit.stdout, stderr: "" };
  };
}

test("MAN-54: pollSubmissions counts merged vs failed_observations and updates state/steps", async () => {
  const db = newDb();
  seed(db);

  const outcomes: Record<string, { ok: boolean; stdout: string }> = {
    "https://example.test/pr/merged": { ok: true, stdout: JSON.stringify({ state: "MERGED" }) },
    "https://example.test/pr/observation-failed": { ok: false, stdout: "", stderr: "gh unavailable" },
  };

  const result = await pollSubmissions(db, { executor: fakeExecutor(outcomes), now: 123 });

  expect(result).toEqual({ checked: 2, merged: 1, failed_observations: 1 });

  const s1 = db.query("SELECT state FROM mgmt_submissions WHERE submission_id='s1'").get() as { state: string };
  expect(s1.state).toBe("merged");

  const s2 = db.query("SELECT steps FROM mgmt_submissions WHERE submission_id='s2'").get() as { steps: string };
  const steps = JSON.parse(s2.steps);
  expect(steps).toEqual([{ kind: "pr_observation_failure", count: 1, at: 123 }]);

  // Second poll: s1 no longer pr_created; s2's failure step is incremented in place.
  const again = await pollSubmissions(db, { executor: fakeExecutor(outcomes), now: 456 });
  expect(again).toEqual({ checked: 1, merged: 0, failed_observations: 1 });
  const s2b = db.query("SELECT steps FROM mgmt_submissions WHERE submission_id='s2'").get() as { steps: string };
  expect(JSON.parse(s2b.steps)).toEqual([{ kind: "pr_observation_failure", count: 2, at: 123 }]);

  db.close();
});
