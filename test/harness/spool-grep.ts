/**
 * test/harness/spool-grep.ts — count/inspect parsed envelope lines under a
 * spool ROOT (the directory containing <host>/<emitter>/*.ndjson). JSON-parse
 * based, so it is robust to any whitespace layout the emitter chose.
 *
 * Usage:
 *   bun test/harness/spool-grep.ts --spool <root> --kind telemetry_gap
 *                                 [--detail native_id=herdr-gap1]
 *                                 [--runtime overload] [--print-first]
 *
 * Prints one JSON line: {"count":N,"first":{…}|null}. Exit 0 unless args bad.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

interface Args {
  spool: string | null;
  kind: string | null;
  runtime: string | null;
  emitterPrefix: string | null;
  details: Array<[string, string]>;
  printFirst: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { spool: null, kind: null, runtime: null, emitterPrefix: null, details: [], printFirst: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const v = argv[i + 1];
    if (t === "--spool") { a.spool = v; i++; }
    else if (t === "--kind") { a.kind = v; i++; }
    else if (t === "--runtime") { a.runtime = v; i++; }
    else if (t === "--emitter-prefix") { a.emitterPrefix = v; i++; }
    else if (t === "--detail") {
      if (!v || !v.includes("=")) { console.error("error: --detail expects key=value"); process.exit(2); }
      const eq = v.indexOf("=");
      a.details.push([v.slice(0, eq), v.slice(eq + 1)]);
      i++;
    }
    else if (t === "--print-first") a.printFirst = true;
    else if (t === "--help" || t === "-h") {
      console.log("Usage: bun test/harness/spool-grep.ts --spool <root> [--kind k] [--detail k=v]\n" +
                  "                 [--runtime r] [--emitter-prefix p] [--print-first]");
      process.exit(0);
    }
  }
  return a;
}

function walk(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(d); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (e.endsWith(".ndjson")) out.push(p);
    }
  }
  return out;
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  if (!a.spool) { console.error("error: --spool required"); process.exit(2); }
  let count = 0;
  let first: unknown = null;
  for (const file of walk(a.spool)) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let env: any;
      try { env = JSON.parse(line); } catch { continue; }
      if (!env || typeof env !== "object") continue;
      if (a.kind !== null && env.kind !== a.kind) continue;
      if (a.runtime !== null && env.runtime !== a.runtime) continue;
      if (a.emitterPrefix !== null && typeof env.emitter_id === "string" && !env.emitter_id.startsWith(a.emitterPrefix)) continue;
      let match = true;
      for (const [k, val] of a.details) {
        const dv = env.detail?.[k];
        if (String(dv) !== val) { match = false; break; }
      }
      if (!match) continue;
      count++;
      if (first === null) first = { file, envelope: env };
    }
  }
  console.log(JSON.stringify({ count, first: a.printFirst ? first : first === null ? null : true }));
}

main();
