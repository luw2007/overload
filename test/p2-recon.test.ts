/**
 * test/p2-recon.test.ts — reconciliation finding rules against the FROZEN P2
 * contract (p2-freeze.md protocols 3/6, tech-solution §3), driven with FAKE
 * platform CLIs (tiny scripts echoing captured JSON shapes from
 * docs/research/overload-20260813-probe-findings.md — never real
 * herdr/orca/cmux).
 *
 * Two layers:
 *  - CONTRACT (always runs): the N8 reference decision core
 *    (test/lib/p2/recon.ts) over frozen-schema ledgers with injected liveness
 *    probes. Must pass BEFORE N5/N6/N7 merge.
 *  - REAL (explicit SKIP until the entry exists): spawns N6's
 *    `src/recon/recon.ts --once --herdr-cmd … --orca-cmd … --cmux-sessions-file
 *    … --ledger … --spool …` against the same fixtures and asserts identical
 *    observable behavior (admin spool / journal). Activates once node/n6 lands.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openLedgerP2 } from "./lib/p2/schema";
import {
  allSpoolFilesDrained,
  freshReconState,
  runReconPass,
  scanSpoolFindings,
  type ReconState,
} from "./lib/p2/recon";
import {
  herdrAgent,
  herdrAgentsJson,
  makeCmuxSessionsFile,
  makeFakeCli,
  makeFailingCli,
  makeGarbageCli,
  orcaWorktree,
  orcaWorktreesJson,
} from "./lib/p2/fakes";
import { makeTempDir, cleanupTempDir, nextCounter } from "./lib/util";
import { DRAIN_GRACE_MS, STALL_PROFILE_MS } from "../src/shared/types";

const REPO = process.cwd();
const N6_RECON = join(REPO, "src/recon/recon.ts");
const N5_INGEST = join(REPO, "src/ingest/ingest.ts");
const HAS_N6 = existsSync(N6_RECON);

const NOW = 1_800_000_000_000;

// ─── CONTRACT LAYER ─────────────────────────────────────────────────────────

let root: string;
let ledger: string;
let spoolRoot: string;
let fakes: string;
let cmuxFile: string;
let state: ReconState;

beforeEach(() => {
  root = makeTempDir(`n8-rcn-${nextCounter()}`);
  ledger = join(root, "ledger.db");
  spoolRoot = join(root, "spool");
  fakes = join(root, "fakes");
  cmuxFile = makeCmuxSessionsFile(join(root, "cmux-sessions.json"));
  state = freshReconState();
});
afterEach(() => cleanupTempDir(root));

interface Fixture {
  stableId: string;
  cwd: string;
  runtime?: string;
  pid?: number | null;
  lastSeenAt?: number | null;
  liveness?: "process" | "lifecycle";
  writerId?: string;
}

function seedSession(fx: Fixture): void {
  const db = openLedgerP2(ledger);
  db.query(
    `INSERT INTO sessions(stable_id, host, runtime, session, origin, cwd, created_at, first_seen_at)
     VALUES(?, 'local', ?, ?, 'unknown', ?, ?, ?)`,
  ).run(fx.stableId, fx.runtime ?? "pi", fx.stableId.split(":").pop(), fx.cwd, NOW - 100_000, NOW - 100_000);
  db.query(
    `INSERT INTO session_incarnations(stable_id, writer_id, liveness_domain, pid, proc_boot_id, started_at, last_seen_at)
     VALUES(?, ?, ?, ?, 'boot0001', ?, ?)`,
  ).run(
    fx.stableId,
    fx.writerId ?? `pi-1-${fx.stableId.slice(-8)}`,
    fx.liveness ?? "process",
    fx.pid ?? null,
    NOW - 100_000,
    fx.lastSeenAt ?? NOW - 60_000,
  );
  db.close();
}

// Optional per-emitter writerId is part of Fixture above.

function seedSpoolFile(emitterId: string, bytes = 100, host = "local"): { file: string; size: number } {
  const dir = join(spoolRoot, host, emitterId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `active-${emitterId}-1.ndjson`);
  writeFileSync(file, "x".repeat(bytes));
  return { file, size: bytes };
}

function seedCursor(key: string, bytes: number): void {
  const db = openLedgerP2(ledger);
  db.query("INSERT OR REPLACE INTO cursors(file_name, bytes) VALUES(?, ?)").run(key, bytes);
  db.close();
}

function deps(over: Partial<Parameters<typeof runReconPass>[0]> = {}) {
  const d: Parameters<typeof runReconPass>[0] = {
    ledger,
    spoolRoot,
    cmuxSessionsFile: cmuxFile,
    now: NOW,
    ...over,
  } as Parameters<typeof runReconPass>[0];
  // Defaults are created ONLY when not overridden: makeFakeCli writes files by
  // name, so an unconditional default would clobber a custom same-name script.
  if (!d.herdrCmd) d.herdrCmd = makeFakeCli(fakes, "herdr", herdrAgentsJson([]));
  if (!d.orcaCmd) d.orcaCmd = makeFakeCli(fakes, "orca", orcaWorktreesJson([]));
  return d;
}

const kinds = (findings: ReturnType<typeof runReconPass>) => findings.map((f) => f.kind);

describe("contract: source_outage — one event per outage + recovery (protocol 6)", () => {
  test("down → single event; still down → silence; up → recovered; down again → NEW outage", () => {
    const bad = makeFailingCli(fakes, "herdr-down");
    const good = makeFakeCli(fakes, "herdr-ok", herdrAgentsJson([]));
    let d = deps({ herdrCmd: bad });

    expect(kinds(runReconPass(d, state))).toEqual(["source_outage"]);
    expect(runReconPass(d, state).map((f) => f.detail.source)).toEqual([]); // no storm
    expect(runReconPass(d, state)).toEqual([]);

    d = deps({ herdrCmd: good });
    const recovered = runReconPass(d, state);
    expect(kinds(recovered)).toEqual(["source_recovered"]);
    expect(recovered[0]!.detail).toEqual({ source: "herdr" });
    expect(runReconPass(d, state)).toEqual([]);

    d = deps({ herdrCmd: bad });
    expect(kinds(runReconPass(d, state))).toEqual(["source_outage"]); // new outage, new event
  });

  test("unparseable CLI output (rc 0, garbage) is an OUTAGE, not an empty snapshot", () => {
    const garbage = makeGarbageCli(fakes, "herdr-garbage");
    const out = runReconPass(deps({ herdrCmd: garbage }), state);
    expect(kinds(out)).toEqual(["source_outage"]);
    expect(out[0]!.detail).toEqual({ source: "herdr" });
  });

  test("while herdr is out, ZERO herdr-derived per-session findings are emitted", () => {
    seedSession({ stableId: "local:pi:s-gap", cwd: join(root, "proj"), runtime: "claude", liveness: "lifecycle", lastSeenAt: NOW - 40 * 60_000 });
    const bad = deps({ herdrCmd: makeFailingCli(fakes, "herdr-down") });
    runReconPass(bad, state); // outage starts
    // Snapshot recovers but the agent list itself now parses fine — findings
    // resume only after recovery. During the outage passes nothing derived:
    for (let i = 0; i < 3; i++) {
      expect(runReconPass(bad, state).filter((f) => f.kind !== "source_outage")).toEqual([]);
    }
  });

  test("cmux: missing file = unused (silence); malformed file = outage", () => {
    expect(runReconPass(deps({ cmuxSessionsFile: join(root, "nope.json") }), state)).toEqual([]);
    const badCmux = join(root, "bad-cmux.json");
    writeFileSync(badCmux, "{not json\n");
    const out = runReconPass(deps({ cmuxSessionsFile: badCmux }), state);
    expect(kinds(out)).toEqual(["source_outage"]);
    expect(out[0]!.detail).toEqual({ source: "cmux" });
  });
});

describe("contract: telemetry_gap — live platform agent with no spool writer (rate-limited)", () => {
  test("gap fires once per native_id per hour — no storm on repeated passes", () => {
    const cwd = join(root, "proj");
    seedSession({
      stableId: "local:claude:s-gap",
      cwd,
      runtime: "claude",
      liveness: "lifecycle",
      lastSeenAt: NOW - 40 * 60_000, // silent beyond the stall profile
    });
    const herdr = makeFakeCli(fakes, "herdr", herdrAgentsJson([herdrAgent("herdr-t1", cwd, "working")]));
    const d = deps({ herdrCmd: herdr });

    const first = runReconPass(d, state).filter((f) => f.kind === "telemetry_gap");
    expect(first).toHaveLength(1);
    expect(first[0]!.detail).toEqual({ platform: "herdr", native_id: "herdr-t1", cwd });

    // Immediate re-passes within the rate-limit window: silence.
    d.now = NOW + 60_000;
    expect(runReconPass(d, state).filter((f) => f.kind === "telemetry_gap")).toEqual([]);
    d.now = NOW + 30 * 60_000;
    expect(runReconPass(d, state).filter((f) => f.kind === "telemetry_gap")).toEqual([]);
    // Past the window (1h): allowed again.
    d.now = NOW + 61 * 60_000;
    expect(runReconPass(d, state).filter((f) => f.kind === "telemetry_gap")).toHaveLength(1);
  });

  test("a session WITH a live (recent) spool writer is not a gap", () => {
    const cwd = join(root, "proj2");
    seedSession({ stableId: "local:pi:s-live", cwd, lastSeenAt: NOW - 60_000 });
    const herdr = makeFakeCli(fakes, "herdr", herdrAgentsJson([herdrAgent("herdr-t2", cwd)]));
    const out = runReconPass(deps({ herdrCmd: herdr }), state);
    expect(out.filter((f) => f.kind === "telemetry_gap")).toEqual([]);
  });

  test("a cwd with no ledger session joins nothing (no fabricated subjects)", () => {
    const herdr = makeFakeCli(fakes, "herdr", herdrAgentsJson([herdrAgent("herdr-t3", join(root, "unknown-dir"))]));
    expect(runReconPass(deps({ herdrCmd: herdr }), state)).toEqual([]);
  });
});

describe("contract: emitter_dead / emitter_drained — the cursor==size gate (protocol 3)", () => {
  const EM = "pi-77-dead0001";
  function deadFixture(lastSeenAt: number): void {
    seedSession({ stableId: "local:pi:s-dead", cwd: join(root, "projA"), pid: 4242, lastSeenAt, writerId: EM });
  }

  test("dead by kill-0, cursor behind EOF → emitter_dead but NOT drained", () => {
    deadFixture(NOW - DRAIN_GRACE_MS - 60_000); // silence beyond grace
    seedSpoolFile(EM, 100);
    seedCursor(`local/${EM}/active-${EM}-1.ndjson`, 90); // 10 bytes unconsumed
    const out = runReconPass(deps({ probeAlive: () => "dead" }), state);
    expect(out.map((f) => f.kind)).toEqual(["emitter_dead"]);
    expect(out[0]!.detail).toMatchObject({ emitter_id: EM, pid: 4242, verified: "kill0" });
  });

  test("cursor reaches EOF → emitter_drained follows; emitted exactly once", () => {
    deadFixture(NOW - DRAIN_GRACE_MS - 60_000);
    seedSpoolFile(EM, 100);
    seedCursor(`local/${EM}/active-${EM}-1.ndjson`, 100);
    const d = deps({ probeAlive: () => "dead" });
    const out = runReconPass(d, state);
    expect(out.map((f) => f.kind)).toEqual(["emitter_dead", "emitter_drained"]);
    expect(out[1]!.detail).toEqual({ emitter_id: EM, stable_id: "local:pi:s-dead" });
    // Repeated passes never re-emit drained (once per emitter).
    d.now = NOW + 10 * 60_000;
    expect(runReconPass(d, state).filter((f) => f.kind === "emitter_drained")).toEqual([]);
  });

  test("grace not elapsed (fresh death) → dead but NOT drained despite cursor at EOF", () => {
    deadFixture(NOW - 10_000); // died just now
    seedSpoolFile(EM, 100);
    seedCursor(`local/${EM}/active-${EM}-1.ndjson`, 100);
    const out = runReconPass(deps({ probeAlive: () => "dead" }), state);
    expect(out.map((f) => f.kind)).toEqual(["emitter_dead"]);
  });

  test("comm mismatch also proves death (verified=comm_mismatch)", () => {
    deadFixture(NOW - DRAIN_GRACE_MS - 60_000);
    seedSpoolFile(EM, 100);
    seedCursor(`local/${EM}/active-${EM}-1.ndjson`, 100);
    const out = runReconPass(deps({ probeAlive: () => "comm_mismatch" }), state);
    expect(out.map((f) => f.kind)).toEqual(["emitter_dead", "emitter_drained"]);
    expect(out[0]!.detail).toMatchObject({ verified: "comm_mismatch" });
  });

  test("alive emitter with heartbeat silence beyond the profile → emitter_stalled, never dead", () => {
    deadFixture(NOW - STALL_PROFILE_MS.narrow - 60_000);
    const out = runReconPass(deps({ probeAlive: () => "alive" }), state);
    expect(out.map((f) => f.kind)).toEqual(["emitter_stalled"]);
    expect(out[0]!.detail).toMatchObject({ emitter_id: EM, silent_ms: STALL_PROFILE_MS.narrow + 60_000 });
  });

  test("lifecycle-domain writers (claude) are never kill-0 probed", () => {
    seedSession({
      stableId: "local:claude:s-hook",
      cwd: join(root, "projB"),
      runtime: "claude",
      liveness: "lifecycle",
      pid: 4242,
      lastSeenAt: NOW - 3 * DRAIN_GRACE_MS,
    });
    const probes: string[] = [];
    const out = runReconPass(
      deps({
        probeAlive: (pid) => {
          probes.push(String(pid));
          return "dead";
        },
      }),
      state,
    );
    expect(probes).toEqual([]); // no process probe for lifecycle writers
    expect(out).toEqual([]);
  });

  test("allSpoolFilesDrained: any file without a cursor at size blocks the drain", () => {
    seedSession({ stableId: "local:pi:s-dead2", cwd: join(root, "projC"), pid: 1, lastSeenAt: NOW - DRAIN_GRACE_MS, writerId: EM });
    const dir = join(spoolRoot, "local", EM);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `active-${EM}-1.ndjson`), "x".repeat(50));
    writeFileSync(join(dir, `seg-${EM}-2.ndjson`), "y".repeat(50));
    seedCursor(`local/${EM}/active-${EM}-1.ndjson`, 50);
    let db = openLedgerP2(ledger);
    expect(allSpoolFilesDrained(db, spoolRoot, EM)).toBe(false); // seg file has no cursor
    db.close();
    seedCursor(`local/${EM}/seg-${EM}-2.ndjson`, 50);
    db = openLedgerP2(ledger);
    expect(allSpoolFilesDrained(db, spoolRoot, EM)).toBe(true);
    db.close();
  });
});

describe("contract: session_vanished — ONLY on a complete snapshot", () => {
  const SID = "local:pi:s-van";
  function seedAttached(): void {
    seedSession({ stableId: SID, cwd: join(root, "projV"), runtime: "claude", liveness: "lifecycle" });
    const db = openLedgerP2(ledger);
    db.query(
      "INSERT INTO attachments(stable_id, platform, binding, observed_at, valid) VALUES(?, 'herdr', 'T-VAN', ?, 1)",
    ).run(SID, NOW - 60_000);
    db.close();
  }

  test("complete snapshot lacking the bound session → session_vanished", () => {
    seedAttached();
    const herdr = makeFakeCli(fakes, "herdr", herdrAgentsJson([herdrAgent("other-t", join(root, "elsewhere"))]));
    const out = runReconPass(deps({ herdrCmd: herdr }), state);
    expect(out.map((f) => f.kind)).toEqual(["session_vanished"]);
    expect(out[0]!.detail).toEqual({ stable_id: SID, platform: "herdr" });
  });

  test("failed snapshot (rc!=0) proves NOTHING — no vanished", () => {
    seedAttached();
    const out = runReconPass(deps({ herdrCmd: makeFailingCli(fakes, "herdr-down") }), state);
    expect(out.map((f) => f.kind)).toEqual(["source_outage"]);
  });

  test("garbage snapshot (parse failure) proves NOTHING — no vanished", () => {
    seedAttached();
    const out = runReconPass(deps({ herdrCmd: makeGarbageCli(fakes, "herdr-garbage") }), state);
    expect(out.map((f) => f.kind)).toEqual(["source_outage"]);
  });

  test("session still present in the complete snapshot → no vanished", () => {
    seedAttached();
    const herdr = makeFakeCli(
      fakes,
      "herdr",
      herdrAgentsJson([herdrAgent("T-VAN", join(root, "projV"), "idle")]),
    );
    expect(runReconPass(deps({ herdrCmd: herdr }), state)).toEqual([]);
  });

  test("orca worktrees follow the same rule (binding = worktreeInstanceId)", () => {
    seedSession({ stableId: SID, cwd: join(root, "projO"), runtime: "claude", liveness: "lifecycle" });
    const db = openLedgerP2(ledger);
    db.query(
      "INSERT INTO attachments(stable_id, platform, binding, observed_at, valid) VALUES(?, 'orca', 'wt-orc1', ?, 1)",
    ).run(SID, NOW - 60_000);
    db.close();
    const empty = makeFakeCli(fakes, "orca", orcaWorktreesJson([]));
    expect(runReconPass(deps({ orcaCmd: empty }), state).map((f) => f.kind)).toEqual(["session_vanished"]);
    const present = makeFakeCli(
      fakes,
      "orca",
      orcaWorktreesJson([orcaWorktree("wt-orc1", join(root, "projO"))]),
    );
    expect(runReconPass(deps({ orcaCmd: present }), state)).toEqual([]);
  });
});

describe("contract: findings land in the admin spool as overload envelopes", () => {
  test("writeFindingsToSpool produces newline-terminated monotonic-seq envelopes, never touching the ledger", () => {
    seedSession({ stableId: "local:pi:s-x", cwd: join(root, "projX"), pid: 1, lastSeenAt: NOW - DRAIN_GRACE_MS });
    const { writeFindingsToSpool } = require("./lib/p2/recon") as typeof import("./lib/p2/recon");
    const d = deps({ herdrCmd: makeFailingCli(fakes, "herdr-down") });
    const findings = runReconPass(d, state);
    const file = writeFindingsToSpool(d, state, findings, { adminEmitter: "overload-99-test0001" });
    expect(file).not.toBeNull();
    const scanned = scanSpoolFindings(spoolRoot);
    expect(scanned.length).toBeGreaterThan(0);
    for (const env of scanned) {
      expect(env.runtime).toBe("overload");
      expect(env.emitter_id.startsWith("overload-")).toBe(true);
    }
    const seqs = scanned.map((s) => s.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // The ledger was never written by recon (read-only contract): the only
    // tables with recon-relevant rows are the ones the fixture seeded.
    const db = new Database(ledger, { readonly: true });
    const incidents = (db.query("SELECT COUNT(*) AS n FROM incidents").get() as { n: number }).n;
    db.close();
    expect(incidents).toBe(0);
  });
});

// ─── REAL LAYER (explicit SKIP until node/n6 lands) ─────────────────────────

test("entry inventory: recon entry exists on this tree", () => {
  console.log(`[n8] real-layer entry: src/recon/recon.ts=${existsSync(N6_RECON)} ` +
    `(real-layer tests ${HAS_N6 ? "ACTIVE" : "SKIPPED until N6 merges"})`);
  expect(true).toBe(true);
});

describe.skipIf(!HAS_N6)("real: N6 recon --once against fake CLIs", () => {
  let home: string;
  let rLedger: string;
  let rSpool: string;
  let rFakes: string;

  beforeEach(() => {
    home = makeTempDir(`n8-rcn-real-${nextCounter()}`);
    rLedger = join(home, ".overload", "ledger.db");
    rSpool = join(home, ".overload", "spool");
    rFakes = join(home, "fakes");
  });
  afterEach(() => cleanupTempDir(home));

  function herdrPath(name: string, agents: Array<Record<string, unknown>>): string {
    return makeFakeCli(rFakes, name, herdrAgentsJson(agents));
  }

  async function runRecon(herdr: string, orca?: string): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(
      [
        "bun", N6_RECON, "--once",
        "--herdr-cmd", herdr,
        "--orca-cmd", orca ?? makeFakeCli(rFakes, "orca", orcaWorktreesJson([])),
        "--cmux-sessions-file", makeCmuxSessionsFile(join(home, "cmux.json")),
        "--ledger", rLedger,
        "--spool", rSpool,
      ],
      { cwd: REPO, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    return { code: proc.exitCode, out };
  }

  async function runIngest(): Promise<number> {
    const proc = Bun.spawn(["bun", N5_INGEST, "--once"], {
      cwd: REPO,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    return proc.exitCode;
  }

  function journalCount(kind: string, detailLike = "%"): number {
    const db = new Database(rLedger);
    try {
      return (db.query(
        "SELECT COUNT(*) AS n FROM journal WHERE kind=? AND detail LIKE ?",
      ).get(kind, detailLike) as { n: number }).n;
    } finally {
      db.close();
    }
  }

  test("outage: single event per outage, recovery backfills, re-outage emits again", async () => {
    const down = makeFailingCli(rFakes, "herdr-down");
    const up = herdrPath("herdr-up", []);
    mkdirSync(join(home, ".overload"), { recursive: true });
    openLedgerP2(rLedger).close();

    expect((await runRecon(down)).code).toBe(0);
    expect(await runIngest()).toBe(0);
    expect(journalCount("source_outage", '%herdr%')).toBe(1);

    await runRecon(down);
    await runIngest();
    expect(journalCount("source_outage", '%herdr%')).toBe(1); // no storm

    await runRecon(up);
    await runIngest();
    expect(journalCount("source_recovered", '%herdr%')).toBe(1);

    await runRecon(down);
    await runIngest();
    expect(journalCount("source_outage", '%herdr%')).toBe(2); // new outage
  });

  test("telemetry_gap: rate limit across passes (journal count stays 1)", async () => {
    const cwd = join(home, "proj");
    const db = openLedgerP2(rLedger);
    db.query(
      `INSERT INTO sessions(stable_id, host, runtime, session, origin, cwd, created_at, first_seen_at)
       VALUES('local:claude:s1', 'local', 'claude', 's1', 'unknown', ?, ?, ?)`,
    ).run(cwd, Date.now() - 3_600_000, Date.now() - 3_600_000);
    db.query(
      `INSERT INTO session_incarnations(stable_id, writer_id, liveness_domain, pid, proc_boot_id, started_at, last_seen_at)
       VALUES('local:claude:s1', 'claude-s1', 'lifecycle', NULL, NULL, ?, ?)`,
    ).run(Date.now() - 3_600_000, Date.now() - 40 * 60_000);
    db.close();

    const herdr = herdrPath("herdr-gap", [herdrAgent("herdr-rg1", cwd, "working")]);
    await runRecon(herdr);
    await runIngest();
    expect(journalCount("telemetry_gap", '%herdr-rg1%')).toBe(1);
    await runRecon(herdr);
    await runIngest();
    expect(journalCount("telemetry_gap", '%herdr-rg1%')).toBe(1); // no storm
  });

  test("drained gate: cursor behind EOF blocks; EOF + grace releases; emitted once", async () => {
    const EM = "pi-55-realdead1";
    const sleeper = Bun.spawn(["sleep", "60"]);
    const pid = sleeper.pid!;
    sleeper.kill(9);
    await sleeper.exited;
    const file = join(rSpool, "local", EM, `active-${EM}-1.ndjson`);
    mkdirSync(join(file, ".."), { recursive: true });
    const line = JSON.stringify({ v: 1, at: Date.now() - 10 * 60_000, host: "local", runtime: "pi", session: "55555555-0000-4000-8000-000000000055", emitter_id: EM, writer_id: EM, seq: 1, kind: "heartbeat", dropped_total: 0, write_error_total: 0 }) + "\n";
    writeFileSync(file, line);
    const size = line.length;

    const db = openLedgerP2(rLedger);
    db.query(
      `INSERT INTO sessions(stable_id, host, runtime, session, origin, cwd, created_at, first_seen_at)
       VALUES('local:pi:s55', 'local', 'pi', '55555555-0000-4000-8000-000000000055', 'unknown', ?, ?, ?)`,
    ).run(join(home, "proj55"), Date.now() - 10 * 60_000, Date.now() - 10 * 60_000);
    db.query(
      `INSERT INTO session_incarnations(stable_id, writer_id, liveness_domain, pid, proc_boot_id, started_at, last_seen_at)
       VALUES('local:pi:s55', ?, 'process', ?, 'realdead1', ?, ?)`,
    ).run(EM, pid, Date.now() - 10 * 60_000, Date.now() - 10 * 60_000);
    db.query("INSERT INTO cursors(file_name, bytes) VALUES(?, ?)").run(`local/${EM}/active-${EM}-1.ndjson`, size - 5);
    db.close();

    await runRecon(makeFailingCli(rFakes, "herdr-empty", herdrAgentsJson([])));
    const findings1 = scanSpoolFindings(rSpool).filter((f) => f.emitter_id.startsWith("overload-"));
    expect(findings1.some((f) => f.kind === "emitter_dead")).toBe(true);
    expect(findings1.some((f) => f.kind === "emitter_drained")).toBe(false); // gate closed

    const db2 = new Database(rLedger);
    db2.query("UPDATE cursors SET bytes=? WHERE file_name=?").run(size, `local/${EM}/active-${EM}-1.ndjson`);
    db2.close();
    await runRecon(makeFakeCli(rFakes, "herdr-empty2", herdrAgentsJson([])));
    expect(scanSpoolFindings(rSpool).filter((f) => f.kind === "emitter_drained").length).toBe(1);

    // Consumed + re-run: drained must never repeat.
    await runIngest();
    await runRecon(makeFakeCli(rFakes, "herdr-empty3", herdrAgentsJson([])));
    await runIngest();
    expect(journalCount("emitter_drained")).toBe(1);
  });

  test("vanished only on complete snapshots", async () => {
    const cwd = join(home, "projV");
    const db = openLedgerP2(rLedger);
    db.query(
      `INSERT INTO sessions(stable_id, host, runtime, session, origin, cwd, created_at, first_seen_at)
       VALUES('local:claude:sv', 'local', 'claude', 'sv', 'unknown', ?, ?, ?)`,
    ).run(cwd, Date.now() - 3_600_000, Date.now() - 3_600_000);
    db.query(
      `INSERT INTO attachments(stable_id, platform, binding, observed_at, valid)
       VALUES('local:claude:sv', 'herdr', 'T-REALVAN', ?, 1)`,
    ).run(Date.now() - 60_000);
    db.close();

    // Complete snapshot WITHOUT the bound agent → vanished.
    await runRecon(herdrPath("herdr-lacking", [herdrAgent("someone-else", join(home, "other"))]));
    await runIngest();
    expect(journalCount("session_vanished", '%herdr%')).toBe(1);

    // Failed snapshot → no new vanished.
    await runRecon(makeFailingCli(rFakes, "herdr-down"));
    await runIngest();
    expect(journalCount("session_vanished", '%herdr%')).toBe(1);
  });
});
