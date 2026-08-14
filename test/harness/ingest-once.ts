/**
 * test/harness/ingest-once.ts — single-pass ingest entry for the crash-injection
 * harness. This is the N3 adapter that lets test/harness/crash-injection.sh run
 * TODAY (against the frozen contract) while defaulting to N2's real ingest when
 * it lands.
 *
 * Usage:
 *   bun test/harness/ingest-once.ts --spool <dir> --ledger <path>
 *
 * Selectable ingest entry:
 *   --entry <path>   Force a specific ingest entry (default: prefer
 *                    src/ingest/ingest.ts if it exists, else this reference).
 *
 * Contract (must hold for whichever entry runs):
 *   - reads <dir>/spool/<host>/<emitter>/active-* and seg-*
 *   - parses only newline-terminated lines
 *   - ONE transaction: journal inserts + cursor advance; UNIQUE dedup
 *
 * Exit 0 on success with a one-line JSON summary on stdout.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface Args {
  spool: string | null;
  ledger: string | null;
  entry: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { spool: null, ledger: null, entry: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const v = argv[i + 1];
    if (t === "--spool") { a.spool = v; i++; }
    else if (t === "--ledger") { a.ledger = v; i++; }
    else if (t === "--entry") { a.entry = v; i++; }
    else if (t === "--help" || t === "-h") {
      console.log(`Usage: bun test/harness/ingest-once.ts --spool <dir> --ledger <path> [--entry <path>]

Runs ONE ingest scan pass over <dir>/spool/**/{active,seg}-* files.

Options:
  --spool <dir>    Spool root (contains a spool/ subdir). Required.
  --ledger <path>  SQLite ledger path. Required.
  --entry <path>   External ingest entry to drive (default: src/ingest/ingest.ts
                   if it exists, else the bundled N3 reference run in-process).
  --help, -h       Show this help.

Exit codes: 0 = ok, 2 = bad args, 1 = runtime error.`);
      process.exit(0);
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.spool || !args.ledger) {
    console.error("error: --spool and --ledger are required (see --help)");
    process.exit(2);
  }

  // Prefer N2's real ingest when present; otherwise fall back to the N3
  // reference implementation (contract-identical).
  const n2Entry = resolve(process.cwd(), "src/ingest/ingest.ts");
  let entry = args.entry;
  if (!entry) {
    entry = existsSync(n2Entry) ? n2Entry : null; // null => use bundled ref in-process
  }
  if (entry && !existsSync(entry)) {
    console.error(`error: ingest entry not found: ${entry}`);
    process.exit(1);
  }

  // If no external entry is given (or the chosen entry is the N3 reference),
  // run the reference ingest in-process for speed and determinism.
  const refPath = resolve(process.cwd(), "test/lib/ingest.ts");
  if (!entry || resolve(entry) === refPath) {
    const { openLedger, ingestOnce } = await import(refPath);
    const db = openLedger(args.ledger);
    const res = ingestOnce(db, args.spool);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    console.log(JSON.stringify({ entry: entry ?? refPath, ...res }));
    return;
  }

  // External N2 entry: forward the flags. N2's ingest.ts must accept --spool /
  // --ledger / --once (its own task spec defines --once).
  const proc = Bun.spawn(
    ["bun", entry, "--once", "--spool", args.spool, "--ledger", args.ledger],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  process.exit(code);
}

main();
