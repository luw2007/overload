/**
 * test/harness/gen-p2-spool.ts — synthetic P2 spool generator for the
 * six-injection harness (and manual smoke). Unlike the P1 gen-spool (fixed
 * `working` kind), this one crafts arbitrary event sequences with full detail
 * control and timestamp aging, e.g.:
 *
 *   bun test/harness/gen-p2-spool.ts --spool $STATE --runtime pi \
 *     --emitter pi-501-cafe0001 --session 11111111-… \
 *     --events 'session_started:pid=501,proc_boot_id=cafe0001,cwd=/x,branch=main; \
 *               working; decision_requested:request_id=ask-1'
 *     --age-ms 360000
 *
 * Event spec grammar (one emitter, one file, seq = 1..N):
 *   events      := token (';' token)*
 *   token       := kind | kind ':' field (',' field)*
 *   field       := key '=' value   (value: string, or number when key = pid)
 *   kind        := any EventKind from src/shared/types.ts
 * `at` = (now − age-ms) + (seq−1)·1000 — aged events satisfy grace/backoff
 * windows WITHOUT real waiting (the harness's deterministic time control).
 *
 * Writes <root>/spool/<host>/<emitter>/active-<emitter>-1.ndjson with
 * newline-terminated contract envelopes (counters zeroed, monotonic seq).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NUMERIC_DETAIL_KEYS = new Set(["pid"]);

interface Args {
  spool: string | null;
  host: string;
  runtime: string;
  emitter: string | null;
  writer: string | null;
  session: string;
  events: string | null;
  ageMs: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    spool: null, host: "local", runtime: "pi", emitter: null, writer: null,
    session: "00000000-0000-4000-8000-000000000000", events: null, ageMs: 60_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const v = argv[i + 1];
    if (t === "--spool") { a.spool = v; i++; }
    else if (t === "--host") { a.host = v; i++; }
    else if (t === "--runtime") { a.runtime = v; i++; }
    else if (t === "--emitter") { a.emitter = v; i++; }
    else if (t === "--writer") { a.writer = v; i++; }
    else if (t === "--session") { a.session = v; i++; }
    else if (t === "--events") { a.events = v; i++; }
    else if (t === "--age-ms") { a.ageMs = parseInt(v, 10); i++; }
    else if (t === "--help" || t === "-h") {
      console.log(`Usage: bun test/harness/gen-p2-spool.ts --spool <root> --emitter <id> --events <spec>
                      [--runtime pi|claude|…] [--writer <id>] [--session <uuid>]
                      [--host local] [--age-ms <n>]

Event spec: 'kind; kind:k=v,k=v; …' — e.g.
  session_started:pid=42,proc_boot_id=cafe0001,cwd=/tmp/p,branch=main,parent=agent@ws1
  working; heartbeat; settled; session_ended
  decision_requested:request_id=ask-1,request_kind=decision
  decision_resolved:request_id=ask-1,state=resolved

--age-ms shifts all 'at' timestamps into the past (default 60000).`);
      process.exit(0);
    }
  }
  return a;
}

function parseEvents(spec: string): Array<{ kind: string; detail: Record<string, unknown> }> {
  return spec
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((token) => {
      const [kind, fields] = token.split(":", 2);
      const detail: Record<string, unknown> = {};
      if (fields) {
        for (const field of fields.split(",")) {
          const eq = field.indexOf("=");
          if (eq < 0) continue;
          const k = field.slice(0, eq).trim();
          const v = field.slice(eq + 1);
          if (k.length === 0) continue;
          detail[k] = NUMERIC_DETAIL_KEYS.has(k) && /^\d+$/.test(v) ? parseInt(v, 10) : v;
        }
      }
      return { kind: kind!.trim(), detail };
    });
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  if (!a.spool || !a.emitter || !a.events) {
    console.error("error: --spool, --emitter and --events are required (see --help)");
    process.exit(2);
  }
  const events = parseEvents(a.events);
  if (events.length === 0) {
    console.error("error: empty --events spec");
    process.exit(2);
  }
  const dir = join(a.spool, "spool", a.host, a.emitter);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `active-${a.emitter}-1.ndjson`);
  const base = Date.now() - a.ageMs;
  let buf = "";
  events.forEach((e, idx) => {
    const env = {
      v: 1,
      at: base + idx * 1000,
      host: a.host,
      runtime: a.runtime,
      session: a.session,
      emitter_id: a.emitter,
      writer_id: a.writer ?? a.emitter,
      seq: idx + 1,
      kind: e.kind,
      dropped_total: 0,
      write_error_total: 0,
      ...(Object.keys(e.detail).length > 0 ? { detail: e.detail } : {}),
    };
    buf += JSON.stringify(env) + "\n";
  });
  writeFileSync(file, buf);
  console.log(JSON.stringify({ file, count: events.length, age_ms: a.ageMs }));
}

main();
