import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureControlSchema, openControl, createWork } from "../src/control/store";
import { ensureMgmtSchema } from "../src/manage/schema";
import { setTracking } from "../src/manage/manage";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function isolatedHome() {
  const home = mkdtempSync(join(tmpdir(), "overload-mgmt-track-"));
  roots.push(home);
  const controlPath = join(home, "orchestrator-answers.db");
  const db = new Database(controlPath);
  ensureControlSchema(db);
  ensureMgmtSchema(db);
  db.close();
  return { home, controlPath };
}

/** Creates a work and its mgmt_work_profile row so setTracking can find it. */
function seedWork(controlPath: string, title: string) {
  const db = openControl(controlPath);
  const work = createWork(db, { title, source: "test" });
  db.run("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES(?,?,?,?,?,?,?)",
    [work.work_id, "discovered", "mgmt", "tracking", "op", title, Date.now()]);
  db.close();
  return work.work_id;
}

/** Spawn `bun -e <wrapper> <args...>` with OVERLOAD_HOME pointed at the isolated dir. */
async function runMgmt(home: string, args: string[]) {
  const wrapper = `import { runMgmtCli } from ${JSON.stringify(join(import.meta.dir, "..", "src", "cli", "mgmt"))}; await runMgmtCli(${JSON.stringify(args)});`;
  const proc = Bun.spawn(["bun", "-e", wrapper], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OVERLOAD_HOME: home, OVERLOAD_ANSWERS_PATH: join(home, "orchestrator-answers.db"), OVERLOAD_HOME_ROOT: home },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("MGMT-03 track", () => {
  test("track on an existing work exits 0 and sets tracking", async () => {
    const { home, controlPath } = isolatedHome();
    const workId = seedWork(controlPath, "track-me");

    const { exitCode, stdout } = await runMgmt(home, ["track", workId, "on"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");

    const inspect = openControl(controlPath);
    const row = inspect.query("SELECT track_state FROM mgmt_work_profile WHERE work_id=?").get(workId) as { track_state: string } | null;
    inspect.close();
    expect(row?.track_state).toBe("tracking");
  });

  test("track off an existing work exits 0 and sets paused", async () => {
    const { home, controlPath } = isolatedHome();
    const workId = seedWork(controlPath, "track-off");

    const { exitCode } = await runMgmt(home, ["track", workId, "off"]);
    expect(exitCode).toBe(0);

    const inspect = openControl(controlPath);
    const row = inspect.query("SELECT track_state FROM mgmt_work_profile WHERE work_id=?").get(workId) as { track_state: string } | null;
    inspect.close();
    expect(row?.track_state).toBe("paused");
  });

  test("track a nonexistent work exits non-zero", async () => {
    const { home } = isolatedHome();
    const { exitCode, stderr } = await runMgmt(home, ["track", "no-such-work", "on"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("work not found");
  });

  test("track without on|off exits non-zero with usage error", async () => {
    const { home } = isolatedHome();
    const { exitCode, stderr } = await runMgmt(home, ["track", "some-work"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("usage");
  });
});

describe("MGMT-04 scan", () => {
  test("scan prints a JSON report and exits 0", async () => {
    const { home } = isolatedHome();
    const { exitCode, stdout } = await runMgmt(home, ["scan"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveProperty("hosts");
    expect(parsed).toHaveProperty("discovered");
    expect(parsed).toHaveProperty("executions");
    expect(Array.isArray(parsed.hosts)).toBe(true);
  });
});
