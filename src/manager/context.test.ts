import { describe, expect, test } from "bun:test";
import { buildManagerContext, loadManagerReadModel } from "./context";
import { controlDb, item, ledgerDb, NOW, session, work } from "./test-fixtures";

const DAY_MS = 86_400_000;
const SEVEN_DAYS = 7 * DAY_MS;

describe("buildManagerContext", () => {
  test("empty databases produce an empty, stable snapshot", () => {
    const control = controlDb(), ledger = ledgerDb();
    const a = buildManagerContext(control, ledger, { now: NOW }), b = buildManagerContext(control, ledger, { now: NOW + 5 });
    expect(a.version).toBe("manager_turn_context_v1");
    expect(a.attention).toEqual({ now: [], inbox: [], follow_up: [] });
    expect(a.coverage).toMatchObject({ attention_included: 0, attention_omitted: 0, sessions_included: 0, sessions_omitted: 0, done_included: 0, done_omitted: 0, done_window_days: 7 });
    expect(a.snapshot_id).toBe(b.snapshot_id);
    expect(a.generated_at).not.toBe(b.generated_at);
    expect(a.coverage.sources.map((s) => s.source_id)).toEqual(["control", "ledger", "recon", "pull"]);
  });
  test("inbox-only fixture compacts items and extracts evidence timestamps", () => {
    const control = controlDb(); const w = work(control);
    item(control, w, "i1", { evidence: { observed_at: NOW - 5, nested: { effect_verified_at: NOW - 3 }, token: "x" } });
    const ctx = buildManagerContext(control, ledgerDb(), { now: NOW });
    expect(ctx.attention.now).toHaveLength(0);
    expect(ctx.attention.inbox.map((x) => x.item_id)).toEqual(["i1"]);
    expect(ctx.attention.inbox[0]!.evidence_timestamps).toEqual([{ field: "observed_at", at: NOW - 5 }, { field: "nested.effect_verified_at", at: NOW - 3 }]);
    expect(ctx.works[0]).toMatchObject({ work_id: w, objective: "ship", decision_owner: "owner", acceptance_count: 1 });
  });
  test("more than 48 items are capped with an exact omitted count; strings are redacted", () => {
    const control = controlDb(); const w = work(control);
    for (let i = 0; i < 50; i++) item(control, w, `n${String(i).padStart(2, "0")}`, { urgency: "now", at: NOW - 1000 + i });
    item(control, w, "secret", { conclusion: "use token=abc123456 now" });
    const ctx = buildManagerContext(control, ledgerDb(), { now: NOW });
    expect(ctx.attention.now).toHaveLength(48);
    expect(ctx.coverage.attention_included).toBe(49);
    expect(ctx.coverage.attention_omitted).toBe(2);
    expect(ctx.attention.inbox[0]!.conclusion).toBe("use token=[REDACTED] now");
  });
  test("done window caps at 30 and only counts the last 7 days", () => {
    const control = controlDb(); const w = work(control);
    for (let i = 0; i < 33; i++) item(control, w, `d${i}`, { state: "resolved", at: NOW - 1000 - i });
    item(control, w, "old", { state: "resolved", at: NOW - 8 * DAY_MS });
    const ctx = buildManagerContext(control, ledgerDb(), { now: NOW });
    expect(ctx.recent_done).toHaveLength(30);
    expect(ctx.coverage).toMatchObject({ done_included: 30, done_omitted: 3 });
  });
  test("done cutoff is inclusive: item exactly at the boundary counts", () => {
    const control = controlDb(); const w = work(control);
    const cutoff = NOW - SEVEN_DAYS;
    item(control, w, "at-cutoff", { state: "resolved", at: cutoff });
    item(control, w, "just-before", { state: "resolved", at: cutoff - 1 });
    item(control, w, "just-after", { state: "resolved", at: cutoff + 1 });
    const ctx = buildManagerContext(control, ledgerDb(), { now: NOW });
    expect(ctx.recent_done.map((d) => d.item_id).sort()).toEqual(["at-cutoff", "just-after"]);
    expect(ctx.coverage).toMatchObject({ done_included: 2, done_omitted: 0 });
  });
  test("full recent read retains more than one page while the snapshot is capped", () => {
    const control = controlDb(); const w = work(control);
    const cutoff = NOW - SEVEN_DAYS;
    for (let i = 0; i < 101; i++) item(control, w, `recent-${i}`, { state: "resolved", at: cutoff + 1 + i });
    item(control, w, "ancient", { state: "resolved", at: cutoff - 1 });
    const full = loadManagerReadModel(control, null, NOW);
    expect(full.done.map(i => i.item_id)).toEqual(Array.from({ length: 101 }, (_, i) => `recent-${100-i}`));
    const snapshot = buildManagerContext(control, null, { now: NOW });
    expect(snapshot.recent_done.map(i => i.item_id)).toEqual(full.done.slice(0, 30).map(i => i.item_id));
    expect(snapshot.coverage).toMatchObject({ done_included: 30, done_omitted: 71 });
    control.close();
  });
  test("ended, remote and non-pi sessions are excluded from targets; stuck sessions kept but unreachable", () => {
    const control = controlDb(), ledger = ledgerDb();
    session(ledger, "live"); session(ledger, "ended", { ended: true }); session(ledger, "remote", { host: "remote-a" });
    session(ledger, "claude", { runtime: "claude" }); session(ledger, "stuck", { runtime: "omp", q5: "turn_hung" });
    const ctx = buildManagerContext(control, ledger, { now: NOW });
    expect(ctx.sessions).toHaveLength(5);
    expect(ctx.targets.map((t) => [t.target_id, t.reachable, t.unreachable_reason]).sort()).toEqual([["live", true, null], ["stuck", false, "turn_hung"]]);
  });
  test("sessions beyond 48 are reported as omitted; missing ledger is an unavailable source", () => {
    const control = controlDb(), ledger = ledgerDb();
    for (let i = 0; i < 50; i++) session(ledger, `s${i}`, { at: NOW - 1000 - i });
    expect(buildManagerContext(control, ledger, { now: NOW }).coverage).toMatchObject({ sessions_included: 48, sessions_omitted: 2 });
    const none = buildManagerContext(control, null, { now: NOW });
    expect(none.coverage.sources.find((s) => s.kind === "ledger")).toMatchObject({ freshness: "unavailable", reason: "ledger_unavailable" });
  });
});
