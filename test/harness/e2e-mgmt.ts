import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import {
 mkdtempSync,
 mkdirSync,
 readFileSync,
 writeFileSync,
 chmodSync,
 symlinkSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createHandoff } from "../../src/manage/handoff";
import { launchHandoff, reconcileLaunches } from "../../src/manage/launch";
import {
 computeManifest,
 insertManifest,
 listManifests,
 recordAcceptance,
 requestAcceptance,
} from "../../src/manage/manifest";
import { localSourceFs, sshSourceFs } from "../../src/manage/source";
import { submitAcceptance } from "../../src/manage/submit";
import { parseClaudeSession } from "../../src/manage/readers/types";
import { scanOnce, type ManageConfig } from "../../src/manage/manage";
import type { CommandExecutor } from "../../src/orchestrator/worktree";

const scenario = process.argv[process.argv.indexOf("--scenario") + 1];
const accountHome = () => {
 const byOs = userInfo().homedir;
 if (byOs !== process.env.HOME) return byOs;
 const uid = process.getuid?.();
 const row = readFileSync("/etc/passwd", "utf8")
  .split("\n")
  .find((line) => Number(line.split(":")[2]) === uid);
 return row?.split(":")[5] ?? byOs;
};
const run = async (
 argv: string[],
 env: Record<string, string>,
 cwd?: string,
) => {
 const p = Bun.spawn(argv, {
  cwd,
  env: { ...process.env, ...env },
  stdout: "pipe",
  stderr: "pipe",
 });
 const [out, err, code] = await Promise.all([
  new Response(p.stdout).text(),
  new Response(p.stderr).text(),
  p.exited,
 ]);
 if (code) throw new Error(`${argv.join(" ")} exited ${code}: ${err.trim()}`);
 return out.trim();
};
const pass = (step: number, text: string) =>
 console.log(`PASS step ${step}: ${text}`);

const expectBound = (n: number) =>
 assert.ok(n >= 1, `expected reconcile to bind, got ${n}`);
async function main() {
 if (scenario === "ssh-discovery") {
  const remote = process.env.OVERLOAD_E2E_SSH_HOST;
  if (!remote) {
   console.log("SKIP ssh-discovery: OVERLOAD_E2E_SSH_HOST unset");
   return;
  }
  const db = new Database(":memory:"),
   snapshot = await Bun.$`mktemp -d`.text(),
   cfg: ManageConfig = {
    enabled: true,
    agents: ["claude"],
    hosts: [{ host: remote, kind: "ssh", remote }],
    lookback_ms: 30 * 86_400_000,
    follow_new: true,
    snapshot: {
     file_max_bytes: 2 * 1024 * 1024,
     work_max_bytes: 64 * 1024 * 1024,
     retain_ms: 30 * 86_400_000,
    },
    archive_grace_ms: 30 * 60_000,
    snapshot_root: snapshot.trim(),
   };
  const first = await scanOnce(db, null, cfg),
   counts = () => ({
    works: (db.query("SELECT count(*) n FROM control_works").get() as any).n,
    executions: (
     db
      .query(
       "SELECT count(*) n FROM mgmt_executions WHERE source_coverage='file_only'",
      )
      .get() as any
    ).n,
   });
  assert.equal(first.hosts[0]?.state, "ok");
  const before = counts();
  assert(before.works && before.executions);
  console.log("scan first", first, before);
  const second = await scanOnce(db, null, cfg),
   after = counts();
  assert.deepEqual(after, before);
  console.log("scan second", second, after);
  const empty = new Database(":memory:"),
   unavailable = await scanOnce(empty, null, {
    ...cfg,
    hosts: [{ host: "no-such-host", kind: "ssh", remote: "no-such-host" }],
   });
  assert.equal(unavailable.hosts[0]?.state, "unavailable");
  assert.equal(
   (empty.query("SELECT count(*) n FROM control_works").get() as any).n,
   0,
  );
  assert.equal(
   (empty.query("SELECT count(*) n FROM mgmt_executions").get() as any).n,
   0,
  );
  console.log("scan unavailable", unavailable, { works: 0, executions: 0 });
  return;
 }
 if (scenario === "ssh-source") {
  const remote = process.env.OVERLOAD_E2E_SSH_REMOTE ?? "koda-dev",
   source = sshSourceFs({ host: remote, kind: "ssh", remote });
  const home = (
   await source.exec("/", ["sh", "-c", "echo $HOME"], 10_000)
  ).stdout.trim();
  assert(home);
  pass(1, `connected to ${remote}`);
  const files = await source.listFiles(`${home}/.claude/projects`, {
   sinceMs: Date.now() - 30 * 86_400_000,
   suffix: ".jsonl",
  });
  assert(files.length);
  pass(2, `listed ${files.length} recent Claude sessions`);
  const range = await source.readRange(files[0]!.path, 0, 64 * 1024);
  assert(range?.generation);
  const parsed = parseClaudeSession(
   new TextDecoder().decode(range.bytes).split(/\r?\n/),
  );
  assert(parsed.userMessages.length + parsed.toolEvents.length);
  pass(3, "read and parsed a ranged session");
  const file = await source.readFile(files[0]!.path, 4096);
  assert(file?.sha256 && file.bytes.length <= 4096);
  assert.equal(await source.readFile("/nonexistent/overload", 10), null);
  assert.deepEqual(
   await source.listFiles("/nonexistent/overload", {
    sinceMs: 0,
    suffix: ".jsonl",
   }),
   [],
  );
  pass(4, "readFile and missing-path semantics passed");
  assert.match(
   (await source.exec(home, ["git", "--version"], 10_000)).stdout,
   /git version/,
  );
  const bad = sshSourceFs({
   host: "unreachable",
   kind: "ssh",
   remote: "no-such-host-xyz",
  });
  assert.deepEqual(
   await bad.listFiles("/tmp", { sinceMs: 0, suffix: ".jsonl" }),
   [],
  );
  pass(5, "exec and unreachable-host semantics passed");
  return;
 }
 if (!["takeover-and-handoff", "accept-and-submit"].includes(scenario))
  throw new Error(
   "usage: bun test/harness/e2e-mgmt.ts --scenario <takeover-and-handoff|accept-and-submit|ssh-source>",
  );
 const root = mkdtempSync(join(tmpdir(), "overload-e2e-mgmt-")),
  home = join(root, "home"),
  repo = join(root, "repo"),
  bin = join(root, "bin"),
  realHome = process.env.OVERLOAD_E2E_REAL_HOME ?? accountHome();
 mkdirSync(join(home, ".config"), { recursive: true });
 symlinkSync(
  join(realHome, ".config/agent-credentials.json"),
  join(home, ".config/agent-credentials.json"),
 );
 mkdirSync(repo);
 mkdirSync(bin);
 await run(["git", "init", "-q"], {}, repo);
 await run(["git", "config", "user.email", "e2e@example.test"], {}, repo);
 await run(["git", "config", "user.name", "E2E"], {}, repo);
 if (scenario === "accept-and-submit") {
  const origin = join(root, "origin.git");
  await run(["git", "init", "--bare", "-q", origin], {});
  writeFileSync(join(repo, "README.md"), "e2e\n");
  await run(["git", "add", "README.md"], {}, repo);
  await run(["git", "commit", "-qm", "initial"], {}, repo);
  await run(["git", "checkout", "-qb", "feature/e2e"], {}, repo);
  await run(["git", "remote", "add", "origin", origin], {}, repo);
 }
 const env = {
  HOME: home,
  OVERLOAD_HOME: join(home, ".overload"),
  OVERLOAD_LEDGER_PATH: join(home, ".overload/ledger.db"),
  OVERLOAD_ANSWERS_PATH: join(home, ".overload/orchestrator-answers.db"),
  PI_CODING_AGENT_DIR: "/home/luwei.will/.overload/pi-agent",
 };
 await run(
  [
   join(realHome, ".npm-global/bin/pi"),
   "--no-extensions",
   "-e",
   join(import.meta.dir, "../../src/extension/overload.ts"),
   "--session-dir",
   join(home, ".pi/agent/sessions"),
   "-p",
   scenario === "accept-and-submit"
    ? "Create exactly two files a.txt and b.txt, each containing its own filename. Commit both files to git, then stop."
    : "Create exactly two files a.txt and b.txt, each containing its own filename, then stop.",
  ],
  env,
  repo,
 );
 if (scenario !== "accept-and-submit")
  pass(1, "real pi exited; session and extension spool emitted");
 await run(
  ["bun", join(import.meta.dir, "../../src/ingest/ingest.ts"), "--once"],
  env,
 );
 const scan = JSON.parse(
  await run(
   [
    "bun",
    join(import.meta.dir, "../../src/cli/overload.ts"),
    "mgmt",
    "scan",
    "--once",
   ],
   env,
  ),
 );
 const db = new Database(env.OVERLOAD_ANSWERS_PATH);
 const counts = () =>
  Object.fromEntries(
   [
    "control_works",
    "mgmt_executions",
    "mgmt_artifacts",
    "mgmt_artifact_versions",
    "mgmt_links",
   ].map((t) => [t, (db.query(`SELECT count(*) n FROM ${t}`).get() as any).n]),
  );
 const first = counts();
 assert.equal(first.control_works, 1);
 assert.equal(first.mgmt_executions, 1);
 assert.equal(first.mgmt_artifacts, 2);
 assert.equal(first.mgmt_artifact_versions, 2);
 assert.equal(
  (
   db
    .query("SELECT count(*) n FROM mgmt_links WHERE relation='modified'")
    .get() as any
  ).n,
  2,
 );
 assert.ok(
  (db.query("SELECT input_head FROM mgmt_work_profile").get() as any)
   .input_head,
 );
 await run(
  [
   "bun",
   join(import.meta.dir, "../../src/cli/overload.ts"),
   "mgmt",
   "scan",
   "--once",
  ],
  env,
 );
 assert.deepEqual(counts(), first);
 pass(
  scenario === "accept-and-submit" ? 1 : 2,
  `scan idempotent ${JSON.stringify(first)} report=${JSON.stringify(scan)}`,
 );
 if (scenario === "accept-and-submit") {
  const fs = localSourceFs(),
   workId = (db.query("SELECT work_id FROM control_works").get() as any)
    .work_id,
   recompute = (
    database: Database,
    source: ReturnType<typeof localSourceFs>,
    id: string,
   ) => computeManifest(database, source, id, { verification: [] }),
   input = await recompute(db, fs, workId),
   manifest = insertManifest(db, input, "e2e", Date.now());
  requestAcceptance(db, manifest.manifest_id, Date.now());
  assert.equal(input.entries.length, 2);
  assert.equal(
   input.git_head,
   await run(["git", "rev-parse", "HEAD"], {}, repo),
  );
  assert.equal(
   (
    db
     .query(
      "SELECT count(*) n FROM control_attention WHERE item_id LIKE 'mgmt:accept:%' AND state='open'",
     )
     .get() as any
   ).n,
   1,
  );
  pass(
   2,
   "manifest has two entries at current git HEAD and one open acceptance card",
  );
  const acceptance = recordAcceptance(
   db,
   manifest.manifest_id,
   "accepted",
   "e2e",
   {},
   Date.now(),
  );
  assert.ok(
   db
    .query("SELECT 1 FROM mgmt_acceptances WHERE acceptance_id=?")
    .get(acceptance.acceptance_id),
  );
  assert.equal(
   (
    db
     .query(
      "SELECT state FROM control_attention WHERE item_id LIKE 'mgmt:accept:%'",
     )
     .get() as any
   ).state,
   "resolved",
  );
  pass(3, "acceptance recorded and card resolved");
  let calls = 0;
  const executor: CommandExecutor = async (command, args, opts) => {
   calls++;
   if (command === "which" && args[0] === "gh")
    return { ok: false, stdout: "", stderr: "tool_missing: gh" };
   const proc = Bun.spawn([command, ...args], {
     cwd: opts?.cwd,
     stdout: "pipe",
     stderr: "pipe",
    }),
    [stdout, stderr, code] = await Promise.all([
     new Response(proc.stdout).text(),
     new Response(proc.stderr).text(),
     proc.exited,
    ]);
   return { ok: code === 0, stdout, stderr };
  };
  const submitted = await submitAcceptance(
   db,
   fs,
   acceptance.acceptance_id,
   { target_kind: "github_pr", target: "main" },
   { executor, recompute },
  );
  assert.equal(submitted.state, "pushed");
  assert.notEqual(submitted.state, "pr_created");
  assert.notEqual(submitted.state, "merged");
  assert.equal(submitted.external_ref, null);
  assert.match(JSON.stringify(submitted.steps), /tool_missing/);
  const remoteHead = (
    await run(
     ["git", "ls-remote", "--heads", "origin", "feature/e2e"],
     {},
     repo,
    )
   ).split(/\s+/)[0],
   localHead = await run(["git", "rev-parse", "HEAD"], {}, repo);
  assert.equal(remoteHead, localHead);
  assert.equal(
   (
    db
     .query("SELECT state FROM mgmt_external_effects WHERE kind='git_push'")
     .get() as any
   ).state,
   "confirmed",
  );
  assert.equal(
   (
    db
     .query("SELECT state FROM mgmt_external_effects WHERE kind='gh_pr'")
     .get() as any
   ).state,
   "unknown",
  );
  assert.equal(listManifests(db, workId)[0]?.submission?.state, "pushed");
  pass(
   4,
   "push confirmed, missing gh left pushed submission without external ref",
  );
  const before = calls,
   duplicate = await submitAcceptance(
    db,
    fs,
    acceptance.acceptance_id,
    { target_kind: "github_pr", target: "main" },
    { executor, recompute },
   );
  assert.equal(duplicate.submission_id, submitted.submission_id);
  assert.equal(calls, before);
  pass(5, "duplicate submission reused id without executor calls");
  await run(
   [
    join(realHome, ".npm-global/bin/pi"),
    "--no-extensions",
    "-e",
    join(import.meta.dir, "../../src/extension/overload.ts"),
    "--session-dir",
    join(home, ".pi/agent/sessions"),
    "--continue",
    "-p",
    "Change only a.txt to contain changed-a, commit it to git, then stop.",
   ],
   env,
   repo,
  );
  await run(
   ["bun", join(import.meta.dir, "../../src/ingest/ingest.ts"), "--once"],
   env,
  );
  await run(
   [
    "bun",
    join(import.meta.dir, "../../src/cli/overload.ts"),
    "mgmt",
    "scan",
    "--once",
   ],
   env,
  );
  const invalidated = db
   .query("SELECT invalidated_at FROM mgmt_acceptances WHERE acceptance_id=?")
   .get(acceptance.acceptance_id) as any;
  assert.ok(invalidated.invalidated_at);
  assert.equal(
   (
    db
     .query(
      "SELECT count(*) n FROM control_attention WHERE item_id LIKE 'mgmt:accept:%' AND state='open'",
     )
     .get() as any
   ).n,
   0,
  );
  let drift: any;
  try {
   await submitAcceptance(
    db,
    fs,
    acceptance.acceptance_id,
    { target_kind: "github_pr", target: "main" },
    { executor, recompute },
   );
  } catch (error) {
   drift = error;
  }
  assert.equal(drift?.message, "manifest_drift");
  assert.match(JSON.stringify(drift?.data), /a\.txt/);
  assert.equal(
   (
    await run(
     ["git", "ls-remote", "--heads", "origin", "feature/e2e"],
     {},
     repo,
    )
   ).split(/\s+/)[0],
   remoteHead,
  );
  pass(6, "rescan invalidated acceptance; drift named a.txt and made no push");
  return;
 }
 const work = (db.query("SELECT work_id FROM mgmt_work_profile").get() as any)
   .work_id,
  execution = (
   db.query("SELECT execution_id FROM mgmt_executions").get() as any
  ).execution_id,
  ledger = new Database(env.OVERLOAD_LEDGER_PATH);
 const handoff = createHandoff(db, {
  workId: work,
  sourceExecutionId: execution,
  targetAgent: "omp",
  targetHost: "local",
  ledger,
 });
 const record = join(root, "omp-launch.json");
 writeFileSync(
  join(bin, "omp"),
  `#!/bin/sh\nprintf '%s\\n' "$OVERLOAD_PARENT|$*" > '${record}'\n`,
 );
 chmodSync(join(bin, "omp"), 0o755);
 let sawRequested = false;
 const launched = await launchHandoff(db, handoff.handoff_id, {
  confirmed: true,
  executor: async (req) => {
   sawRequested =
    (
     db
      .query(
       "SELECT state FROM mgmt_handoff_launch_attempts WHERE handoff_id=?",
      )
      .get(handoff.handoff_id) as any
    ).state === "requested";
   const p = Bun.spawn(req.argv, {
    cwd: req.cwd,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...req.env },
   });
   await p.exited;
   return { pid: p.pid, receipt: `pid:${p.pid}` };
  },
 });
 assert.equal(sawRequested, true);
 assert.equal(launched.state, "launching");
 assert.ok(
  readFileSync(record, "utf8").includes(`mgmt:handoff:${handoff.handoff_id}`),
 );
 pass(
  3,
  "launch attempt requested before started; OVERLOAD_PARENT propagated to omp stub",
 );
 const successorEnv = {
  ...env,
  OVERLOAD_PARENT: `mgmt:handoff:${handoff.handoff_id}`,
 };
 await run(
  [
   join(realHome, ".bun/bin/omp"),
   "--no-extensions",
   "-e",
   join(import.meta.dir, "../../src/extension/overload.ts"),
   "--session-dir",
   join(home, ".omp/agent/sessions"),
   "--no-tools",
   "-p",
   "Reply only: done",
  ],
  successorEnv,
  repo,
 );
 await run(
  ["bun", join(import.meta.dir, "../../src/ingest/ingest.ts"), "--once"],
  env,
 );
 expectBound(reconcileLaunches(db, ledger).bound);
 const bound = db
  .query("SELECT state,new_stable_id FROM mgmt_handoffs WHERE handoff_id=?")
  .get(handoff.handoff_id) as any;
 assert.equal(bound.state, "bound");
 assert.equal(
  (
   db
    .query("SELECT work_id FROM mgmt_executions WHERE parent_handoff_id=?")
    .get(handoff.handoff_id) as any
  ).work_id,
  work,
 );
 pass(4, `real omp successor bound as ${bound.new_stable_id}`);
 mkdirSync(join(home, ".overload"), { recursive: true });
 writeFileSync(
  join(home, ".overload/config.json"),
  JSON.stringify({
   manage: { enabled: true, agents: ["pi", "omp"], archive_grace_ms: 0 },
  }),
 );
 await run(
  [
   "bun",
   join(import.meta.dir, "../../src/cli/overload.ts"),
   "mgmt",
   "scan",
   "--once",
  ],
  env,
 );
 const result = db
  .query(
   "SELECT p.track_state,w.state FROM mgmt_work_profile p JOIN control_works w ON w.work_id=p.work_id WHERE p.work_id=?",
  )
  .get(work) as any;
 assert.deepEqual(result, { track_state: "archived", state: "candidate" });
 assert.equal(
  (
   db
    .query("SELECT count(*) n FROM control_attention WHERE state='open'")
    .get() as any
  ).n,
  0,
 );
 pass(
  5,
  "successor closeout archived management profile; control Work remains candidate; zero open attention",
 );
 db.close();
 ledger.close();
}
main().catch((error) => {
 console.error(
  `FAIL: ${error instanceof Error ? error.message : String(error)}`,
 );
 process.exitCode = 1;
});
