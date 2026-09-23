import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { openStore, addTask } from "../src/orchestrator/store";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitFor(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("ORC-50: main SIGTERM seals spool, closes DB, exits 0", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "overload-orc50-"));
  dirs.push(home);
  const stateDir = join(home, ".overload");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "host"), "local\n");

  const orchestratorDb = join(stateDir, "orchestrator.db");
  // Seed one queued task so the first tick claims it and emits a spool event.
  const seed = openStore(orchestratorDb);
  addTask(seed, "seeded task", join(home, "nope-repo"), "main");
  seed.close();

  const spoolDir = join(stateDir, "spool", "local", "orchestrator");
  const activeFile = join(spoolDir, "active-orchestrator-0.ndjson");

  const child = Bun.spawn(["bun", "src/orchestrator/orchestrator.ts", "--once"], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOME: home,
      OVERLOAD_ORCHESTRATOR_PATH: orchestratorDb,
      OVERLOAD_LEDGER_PATH: join(stateDir, "ledger.db"),
      OVERLOAD_ANSWERS_PATH: join(stateDir, "answers.db"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    // First tick must have run: the claim emits session_started to the active segment.
    await waitFor(activeFile);

    child.kill("SIGTERM");
    const code = await child.exited;

    expect(code).toBe(0);

    // stop() -> spool.close() renames active-orchestrator-*.ndjson -> seg-orchestrator-*.ndjson.
    const segFiles = readdirSync(spoolDir).filter((f) => f.startsWith("seg-"));
    expect(segFiles.length).toBeGreaterThan(0);

    // The active segment is sealed away; no active file should linger.
    expect(existsSync(activeFile)).toBe(false);

    // Orchestrator store DB exists and is non-empty (schema + seeded task + spool_seq writes).
    expect(existsSync(orchestratorDb)).toBe(true);
    expect(statSync(orchestratorDb).size).toBeGreaterThan(0);

    // The sealed segment carries at least one event envelope (session_started).
    const segContent = await readFile(join(spoolDir, segFiles[0]!), "utf8");
    expect(segContent.length).toBeGreaterThan(0);
    expect(JSON.parse(segContent.trim().split("\n")[0]!).kind).toBe("session_started");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited.catch(() => {});
  }
});
