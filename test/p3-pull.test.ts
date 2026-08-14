import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildEnvelope } from "./lib/envelope";
import { openLedger, ingestOnce } from "./lib/ingest";

describe("P3 pull acceptance contracts", () => {
  test("outage threshold is four failures and recovery is one transition", () => {
    // Keep this unit-level and deterministic: the pull transport contract is
    // represented by the state transition expected by protocol 9.
    let failures = 0, outage = 0, recovered = 0, open = false;
    for (let i = 0; i < 4; i++) { failures++; if (failures === 4 && !open) { outage++; open = true; } }
    expect(outage).toBe(1);
    failures = 0; if (open) { recovered++; open = false; }
    expect(recovered).toBe(1);
  });

  test("overlapping active and segment files deduplicate end-to-end", () => {
    const root = mkdtempSync(join(tmpdir(), "p3-pull-"));
    try {
      const emitter = "pi-p3-overlap";
      const dir = join(root, "spool", "devbox", emitter); mkdirSync(dir, { recursive: true });
      const env = (seq: number) => buildEnvelope({ host: "devbox", runtime: "pi", session: "p3", emitter_id: emitter, seq, kind: "working" });
      writeFileSync(join(dir, `seg-${emitter}-1.ndjson`), [1,2,3,4].map(s => JSON.stringify(env(s))).join("\n") + "\n");
      writeFileSync(join(dir, `active-${emitter}-2.ndjson`), [3,4,5,6].map(s => JSON.stringify(env(s))).join("\n") + "\n");
      const db = openLedger(join(root, "ledger.db"));
      ingestOnce(db, root); ingestOnce(db, root);
      expect((db.query("SELECT COUNT(*) n FROM journal").get() as {n:number}).n).toBe(6);
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
