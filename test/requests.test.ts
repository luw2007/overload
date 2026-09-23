/**
 * test/requests.test.ts — §2.2 requests state machine (P1 scope: requests
 * lifecycle only, per N2-TASK.md).
 *
 * P1 acceptance (N3-TASK #3):
 *  - pending → resolved (normal)
 *  - duplicate resolve is idempotent
 *  - terminal-before-pending: a decision_resolved arriving BEFORE its
 *    decision_requested creates a terminal (resolved) row directly
 *  - orphaned → resolved override ALLOWED (source terminal overrides inferred)
 *  - resolved → cancelled REJECTED (source terminals mutually exclusive)
 *
 * Driven through test/lib/requests.ts (applyRequestTransition) over the frozen
 * requests DDL (test/lib/schema.ts). N2's reducer.ts must satisfy the same rules.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { openLedger } from "./lib/ingest";
import {
  applyRequestTransition,
  getRequest,
  requestUid,
  SOURCE_TERMINALS,
  INFERRED_TERMINALS,
} from "./lib/requests";
import { makeTempDir, cleanupTempDir, nextCounter } from "./lib/util";
import type { Database } from "bun:sqlite";

let db: Database;
let root: string;

beforeEach(() => {
  root = makeTempDir(`n3-req-${nextCounter()}`);
  db = openLedger(join(root, "ledger.db"));
});
afterEach(() => {
  try { db.close(); } catch { /* */ }
  cleanupTempDir(root);
});

function baseReq(suffix: string) {
  const rid = `req-${suffix}`;
  const stable = `local:pi:00000000-0000-4000-8000-00000000000${suffix}`;
  const writer = `pi-${suffix}-abcdef01`;
  return {
    request_uid: requestUid(stable, writer, rid),
    stable_id: stable,
    writer_id: writer,
    origin_emitter_id: writer,
    request_id: rid,
    kind: "decision_requested",
  };
}

describe("requests state machine: pending → resolved (normal path)", () => {
  test("decision_requested creates pending; decision_resolved advances", () => {
    const r = baseReq("a");
    const o1 = applyRequestTransition(db, r, "pending", { now: 1000 });
    expect(o1).toEqual({ ok: true, kind: "inserted" });
    let row = getRequest(db, r.request_uid)!;
    expect(row.state).toBe("pending");
    expect(row.resolved_at).toBeNull();

    const o2 = applyRequestTransition(db, r, "resolved", { now: 2000 });
    expect(o2).toEqual({ ok: true, kind: "advanced" });
    row = getRequest(db, r.request_uid)!;
    expect(row.state).toBe("resolved");
    expect(row.resolved_at).toBe(2000);
  });

  test("pending → cancelled and pending → timed_out also allowed", () => {
    for (const term of ["cancelled", "timed_out"] as const) {
      const r = baseReq("term-" + term);
      applyRequestTransition(db, r, "pending", { now: 1 });
      const o = applyRequestTransition(db, r, term, { now: 2 });
      expect(o.ok).toBe(true);
      expect(getRequest(db, r.request_uid)!.state).toBe(term);
    }
  });
});

describe("requests state machine: duplicate resolve idempotent", () => {
  test("applying resolved twice is a no-op (kind=noop_same_state, resolved_at sticky)", () => {
    const r = baseReq("dup");
    applyRequestTransition(db, r, "pending", { now: 100 });
    applyRequestTransition(db, r, "resolved", { now: 500 });
    const o = applyRequestTransition(db, r, "resolved", { now: 999 });
    expect(o).toEqual({ ok: true, kind: "noop_same_state" });
    const row = getRequest(db, r.request_uid)!;
    expect(row.state).toBe("resolved");
    expect(row.resolved_at).toBe(500); // sticky, not overwritten by 999
  });

  test("replay-safe: re-applying pending after terminal is no-op, keeps terminal", () => {
    // reducer replay may see the journal seqs again; the terminal stays.
    const r = baseReq("replay");
    applyRequestTransition(db, r, "pending", { now: 1 });
    applyRequestTransition(db, r, "resolved", { now: 2 });
    const o = applyRequestTransition(db, r, "pending", { now: 3 });
    // pending is not a source terminal; from=resolved is. pending cannot override.
    // §2.2: terminal sticky, late events don't revive.
    expect(o.ok).toBe(true);
    expect(getRequest(db, r.request_uid)!.state).toBe("resolved");
  });
});

describe("requests state machine: terminal-before-pending (out-of-order)", () => {
  test("decision_resolved arriving before decision_requested creates a resolved row", () => {
    const r = baseReq("ooo");
    const o = applyRequestTransition(db, r, "resolved", { now: 777 });
    expect(o).toEqual({ ok: true, kind: "inserted" });
    const row = getRequest(db, r.request_uid)!;
    expect(row.state).toBe("resolved");
    expect(row.resolved_at).toBe(777);

    // The late decision_requested now arrives: pending cannot demote a terminal.
    const o2 = applyRequestTransition(db, r, "pending", { now: 888 });
    expect(o2.ok).toBe(true);
    expect(getRequest(db, r.request_uid)!.state).toBe("resolved"); // still resolved
  });
});

describe("requests state machine: orphaned override + source mutual exclusion", () => {
  test("orphaned is the ONLY inferred terminal", () => {
    expect(INFERRED_TERMINALS).toEqual(["orphaned"]);
    expect(SOURCE_TERMINALS.sort()).toEqual(["cancelled", "resolved", "timed_out"]);
  });

  test("orphaned → resolved override ALLOWED (source overrides inferred, idempotent)", () => {
    const r = baseReq("orph");
    applyRequestTransition(db, r, "pending", { now: 1 });
    applyRequestTransition(db, r, "orphaned", { now: 10 }); // inferred (emitter judged dead)
    expect(getRequest(db, r.request_uid)!.state).toBe("orphaned");

    // Late resolution backed by a source event overrides the inferred orphan.
    const o = applyRequestTransition(db, r, "resolved", { now: 20 });
    expect(o).toEqual({ ok: true, kind: "advanced" });
    expect(getRequest(db, r.request_uid)!.state).toBe("resolved");

    // Idempotent: re-applying resolved is a no-op.
    const o2 = applyRequestTransition(db, r, "resolved", { now: 30 });
    expect(o2.kind).toBe("noop_same_state");
  });

  test("orphaned → cancelled and orphaned → timed_out also allowed", () => {
    for (const term of ["cancelled", "timed_out"] as const) {
      const r = baseReq("orph-" + term);
      applyRequestTransition(db, r, "pending", { now: 1 });
      applyRequestTransition(db, r, "orphaned", { now: 2 });
      const o = applyRequestTransition(db, r, term, { now: 3 });
      expect(o.ok).toBe(true);
      expect(getRequest(db, r.request_uid)!.state).toBe(term);
    }
  });

  test("resolved → cancelled REJECTED (source terminals mutually exclusive)", () => {
    const r = baseReq("conflict");
    applyRequestTransition(db, r, "pending", { now: 1 });
    applyRequestTransition(db, r, "resolved", { now: 2 });
    const o = applyRequestTransition(db, r, "cancelled", { now: 3 });
    expect(o.ok).toBe(false);
    if (!o.ok) {
      expect(o.kind).toBe("rejected_source_conflict");
      expect(o.from).toBe("resolved");
      expect(o.to).toBe("cancelled");
    }
    expect(getRequest(db, r.request_uid)!.state).toBe("resolved"); // unchanged
  });

  test("every source-vs-source pair is rejected", () => {
    const pairs: Array<[any, any]> = [
      ["resolved", "cancelled"],
      ["resolved", "timed_out"],
      ["cancelled", "resolved"],
      ["cancelled", "timed_out"],
      ["timed_out", "resolved"],
      ["timed_out", "cancelled"],
    ];
    for (const [a, b] of pairs) {
      const r = baseReq(`s${a}${b}`);
      applyRequestTransition(db, r, "pending", { now: 1 });
      applyRequestTransition(db, r, a, { now: 2 });
      const o = applyRequestTransition(db, r, b, { now: 3 });
      expect(o.ok).toBe(false);
      expect(getRequest(db, r.request_uid)!.state).toBe(a);
    }
  });

  test("source terminal is NOT demoted to orphaned (inferred cannot override source)", () => {
    // §2.2: only the inferred terminal may be overridden. A source terminal
    // already recorded makes a later orphan stale → source wins (no-op).
    const r = baseReq("src-sticky");
    applyRequestTransition(db, r, "pending", { now: 1 });
    applyRequestTransition(db, r, "resolved", { now: 2 });
    const o = applyRequestTransition(db, r, "orphaned", { now: 3 });
    expect(o.ok).toBe(true);
    expect(getRequest(db, r.request_uid)!.state).toBe("resolved");
  });
});
