import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Puller, type PullConfig } from "./pull";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(failing = false) {
  const root = await mkdtemp(join(tmpdir(), "overload-pull-"));
  roots.push(root);
  const remoteSpool = join(root, "remote-spool");
  const dest = join(root, "dest");
  const adminSpool = join(root, "admin-spool");
  const heartbeat = join(root, "pull.heartbeat");
  const state = join(root, "pull-state.json");
  const lock = join(root, "pull.lock");
  const ledger = join(root, "ledger.db");
  await Promise.all([mkdir(remoteSpool), mkdir(dest), mkdir(adminSpool)]);
  const ssh = join(root, "ssh.sh");
  await writeFile(ssh, `#!/bin/sh\nexit ${failing ? 9 : 0}\n`, { mode: 0o700 });
  const db = new Database(ledger);
  db.exec("CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, kind TEXT, detail TEXT)");
  db.close();
  const config: PullConfig = {
    remote: "local", remote_spool: remoteSpool, dest, ssh_cmd: ssh, rsync_cmd: "rsync",
    fail_threshold: 4, timeout_ms: 5_000, ledger, admin_spool: adminSpool,
    heartbeat, state, lock,
  };
  return { root, remoteSpool, dest, adminSpool, heartbeat, state, ledger, ssh, config };
}

async function adminEvents(directory: string): Promise<any[]> {
  const paths = await Array.fromAsync(new Bun.Glob("*/active-*.ndjson").scan({ cwd: directory, absolute: true }));
  const text = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function addJournalFinding(ledger: string, kind: string): void {
  const db = new Database(ledger);
  db.query("INSERT INTO journal(kind, detail) VALUES (?, ?)").run(kind, JSON.stringify({ source: "devbox" }));
  db.close();
}

describe("Puller", () => {
  test("limits rsync transfers to 8 MiB files", async () => {
    const f = await fixture();
    const argsPath = join(f.root, "rsync-args.txt");
    const rsync = join(f.root, "rsync.sh");
    await writeFile(rsync, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsPath)}\n`, { mode: 0o700 });

    await new Puller({ ...f.config, rsync_cmd: rsync }).runOnce();

    expect((await readFile(argsPath, "utf8")).split("\n")).toContain("--max-size=8m");
  });

  test("emits one outage at the consecutive failure threshold and journal-deduplicates later attempts", async () => {
    const f = await fixture(true);
    const puller = new Puller(f.config);
    for (let attempt = 0; attempt < 6; attempt++) await puller.runOnce();
    expect((await adminEvents(f.adminSpool)).filter((event) => event.kind === "source_outage")).toHaveLength(1);

    addJournalFinding(f.ledger, "source_outage");
    await new Puller({ ...f.config, state: join(f.root, "fresh-state.json") }).runOnce();
    expect((await adminEvents(f.adminSpool)).filter((event) => event.kind === "source_outage")).toHaveLength(1);
  });

  test("emits recovered after a successful pull when the journal has an open outage", async () => {
    const f = await fixture();
    addJournalFinding(f.ledger, "source_outage");
    const summary = await new Puller(f.config).runOnce();
    expect(summary.failures).toBe(0);
    expect((await adminEvents(f.adminSpool)).map((event) => event.kind)).toEqual(["source_recovered"]);
  });

  test("pulls seg and active files with local rsync, preserves unrelated files, and touches heartbeat", async () => {
    const f = await fixture();
    const emitterDir = join(f.remoteSpool, "pi-1-deadbeef");
    await mkdir(emitterDir);
    await writeFile(join(emitterDir, "seg-pi-1-deadbeef-0.ndjson"), "one\n");
    await writeFile(join(emitterDir, "active-pi-1-deadbeef-1.ndjson"), "two\n");
    await writeFile(join(emitterDir, "ignored.txt"), "no\n");
    await writeFile(join(f.dest, "keep.txt"), "keep\n");

    const summary = await new Puller(f.config).runOnce();
    expect(await readFile(join(f.dest, "pi-1-deadbeef", "seg-pi-1-deadbeef-0.ndjson"), "utf8")).toBe("one\n");
    expect(await readFile(join(f.dest, "pi-1-deadbeef", "active-pi-1-deadbeef-1.ndjson"), "utf8")).toBe("two\n");
    expect(await readFile(join(f.dest, "keep.txt"), "utf8")).toBe("keep\n");
    expect(await readdir(join(f.dest, "pi-1-deadbeef"))).not.toContain("ignored.txt");
    expect(summary.files).toBe(2);
    expect(summary.bytes).toBe(8);
    expect((await stat(f.heartbeat)).isFile()).toBe(true);
  });
});
