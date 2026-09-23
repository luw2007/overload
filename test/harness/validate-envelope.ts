/**
 * test/harness/validate-envelope.ts — validate that every ndjson line under a
 * spool root conforms to the frozen EventEnvelope contract. Used by the matrix
 * runner to assert "spool file appears with a valid envelope".
 *
 * Usage: bun test/harness/validate-envelope.ts --spool <dir>
 * Exit 0 if all lines valid (and at least one line exists); 1 otherwise.
 * Prints a one-line JSON summary: {files, lines, valid, invalid, errors[]}.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateEnvelope } from "../lib/envelope";

function parseArgs(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--spool") return argv[i + 1] ?? null;
    if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`Usage: bun test/harness/validate-envelope.ts --spool <dir>

Walks <dir>/spool/**/*.ndjson, parses each newline-terminated line, and
validates it against the frozen EventEnvelope contract (src/shared/types.ts).

Exit 0 iff at least one valid envelope found and zero invalid lines.
Exit 1 otherwise.`);
      process.exit(0);
    }
  }
  return null;
}

function walk(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
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

function main() {
  const spool = parseArgs(process.argv.slice(2));
  if (!spool) { console.error("error: --spool required"); process.exit(2); }
  const base = join(spool, "spool");
  const files = walk(base);
  let lines = 0, valid = 0, invalid = 0;
  const errors: string[] = [];
  for (const f of files) {
    const txt = readFileSync(f, "utf8");
    for (const line of txt.split("\n")) {
      if (line.trim() === "") continue;
      lines++;
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { invalid++; errors.push(`${f}: malformed json`); continue; }
      const errs = validateEnvelope(obj);
      if (errs.length === 0) valid++;
      else { invalid++; errors.push(`${f}: ${errs.map((e) => e.field + ":" + e.reason).join(",")}`); }
    }
  }
  console.log(JSON.stringify({ files: files.length, lines, valid, invalid, errors: errors.slice(0, 5) }));
  if (valid > 0 && invalid === 0) process.exit(0);
  process.exit(1);
}
main();
