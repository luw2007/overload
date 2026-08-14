/**
 * test/harness/ingest-once.ts — single-pass ingest adapter for the
 * crash-injection harness.
 *
 * Invocation contract (fixed after owner verification on the merged tree):
 *   - The REAL ingest (src/ingest/ingest.ts) accepts ONLY `--once` and resolves
 *     everything from HOME: spool at ~/.overload/spool, ledger at
 *     ~/.overload/ledger.db. It is therefore driven with HOME=<fake home> and
 *     no other flags.
 *   - The N3 reference implementation (test/lib/ingest.ts) is called in-process
 *     against the SAME paths under the fake home, so assertions are uniform.
 *
 * Usage:
 *   bun test/harness/ingest-once.ts --home <dir> [--entry <path>]
 *
 * Options:
 *   --home <dir>    Fake HOME. Spool is read from <dir>/.overload/spool and the
 *                   ledger is <dir>/.overload/ledger.db. Required.
 *   --entry <path>  External ingest entry to drive (default: src/ingest/ingest.ts
 *                   if it exists, else the bundled N3 reference in-process).
 *                   An external entry is invoked as: HOME=<dir> bun <path> --once
 *
 * Exit 0 on success; the reference path prints a one-line JSON summary.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

interface Args {
  home: string | null;
  entry: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { home: null, entry: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const v = argv[i + 1];
    if (t === "--home") { a.home = v; i++; }
    else if (t === "--entry") { a.entry = v; i++; }
    else if (t === "--help" || t === "-h") {
      console.log(`Usage: bun test/harness/ingest-once.ts --home <dir> [--entry <path>]

Runs ONE ingest scan pass over <dir>/.overload/spool/**/{active,seg}-* files,
writing <dir>/.overload/ledger.db — i.e. it treats <dir> as HOME, exactly like
the real ingest resolves ~/.overload.

Options:
  --home <dir>    Fake HOME (required). Spool: <dir>/.overload/spool;
                  ledger: <dir>/.overload/ledger.db.
  --entry <path>  External ingest entry (default: src/ingest/ingest.ts if it
                  exists, else the bundled N3 reference run in-process).
                  External entries are invoked as: HOME=<dir> bun <path> --once
                  (the real entry accepts only --once).
  --help, -h      Show this help.

Exit codes: 0 = ok, 2 = bad args, 1 = runtime error.`);
      process.exit(0);
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.home) {
    console.error("error: --home is required (see --help)");
    process.exit(2);
  }
  const home = resolve(args.home);
  if (!existsSync(home)) {
    console.error(`error: fake home not found: ${home}`);
    process.exit(1);
  }
  const stateDir = join(home, ".overload");

  // Prefer the real ingest when present; otherwise use the N3 reference.
  const n2Entry = resolve(process.cwd(), "src/ingest/ingest.ts");
  let entry = args.entry;
  if (!entry) {
    entry = existsSync(n2Entry) ? n2Entry : null; // null => bundled reference
  }
  if (entry && !existsSync(entry)) {
    console.error(`error: ingest entry not found: ${entry}`);
    process.exit(1);
  }

  // Reference path: in-process, same on-disk layout as the real ingest.
  const refPath = resolve(process.cwd(), "test/lib/ingest.ts");
  if (!entry || resolve(entry) === refPath) {
    mkdirSync(stateDir, { recursive: true });
    const { openLedger, ingestOnce } = await import(refPath);
    const db = openLedger(join(stateDir, "ledger.db"));
    const res = ingestOnce(db, stateDir); // scans <stateDir>/spool/**
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    console.log(JSON.stringify({ entry: entry ?? refPath, home, ...res }));
    return;
  }

  // Real/external ingest: it accepts ONLY --once and resolves ~/.overload from
  // HOME, so we pass exactly that — never --spool/--ledger.
  const proc = Bun.spawn(["bun", entry, "--once"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  process.exit(code);
}

main();
