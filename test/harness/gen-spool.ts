/**
 * test/harness/gen-spool.ts — generate a synthetic spool for the crash-injection
 * harness. Writes N complete events (and optionally one partial trailing line)
 * into an active segment under a temp spool root.
 *
 * Usage:
 *   bun test/harness/gen-spool.ts --spool <dir> --emitter <id> --count <n>
 *                                 [--host local] [--partial]
 *
 * The envelopes conform exactly to src/shared/types.ts (v1, counters present,
 * monotonic seq). Used by test/harness/crash-injection.sh.
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface Args {
  spool: string | null;
  emitter: string | null;
  count: number;
  host: string;
  partial: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { spool: null, emitter: null, count: 100, host: "local", partial: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const v = argv[i + 1];
    if (t === "--spool") { a.spool = v; i++; }
    else if (t === "--emitter") { a.emitter = v; i++; }
    else if (t === "--count") { a.count = parseInt(v, 10); i++; }
    else if (t === "--host") { a.host = v; i++; }
    else if (t === "--partial") { a.partial = true; }
    else if (t === "--help" || t === "-h") {
      console.log(`Usage: bun test/harness/gen-spool.ts --spool <dir> --emitter <id> --count <n>
                      [--host local] [--partial]

Writes <count> complete ndjson envelopes to
  <dir>/spool/<host>/<emitter>/active-<emitter>-1.ndjson

With --partial, appends one final line WITHOUT a trailing newline (models a
truncated active-file snapshot). All envelopes match the frozen EventEnvelope
contract (v1, monotonic seq, counters on every event).

Options:
  --spool <dir>    Spool root (a spool/ subdir is created inside). Required.
  --emitter <id>   Emitter id (also used as writer_id). Required.
  --count <n>      Number of complete events (default 100).
  --host <id>      host_id (default local).
  --partial        Also write a partial trailing line (no newline).
  --help, -h       Show this help.`);
      process.exit(0);
    }
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.spool || !a.emitter) {
    console.error("error: --spool and --emitter are required (see --help)");
    process.exit(2);
  }
  const dir = join(a.spool, "spool", a.host, a.emitter);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `active-${a.emitter}-1.ndjson`);
  const session = "00000000-0000-4000-8000-000000000000";
  let buf = "";
  for (let seq = 1; seq <= a.count; seq++) {
    const env = {
      v: 1,
      at: 1_700_000_000_000 + seq,
      host: a.host,
      runtime: "pi",
      session,
      emitter_id: a.emitter,
      writer_id: a.emitter,
      seq,
      kind: "working",
      dropped_total: 0,
      write_error_total: 0,
    };
    buf += JSON.stringify(env) + "\n";
  }
  writeFileSync(file, buf);

  if (a.partial) {
    // A partial trailing line: a well-formed envelope object but NO newline.
    const partial = {
      v: 1,
      at: 1_700_000_000_000 + a.count + 1,
      host: a.host,
      runtime: "pi",
      session,
      emitter_id: a.emitter,
      writer_id: a.emitter,
      seq: a.count + 1,
      kind: "working",
      dropped_total: 0,
      write_error_total: 0,
    };
    appendFileSync(file, JSON.stringify(partial));
  }
  console.log(JSON.stringify({ file, complete: a.count, partial: a.partial }));
}

main();
