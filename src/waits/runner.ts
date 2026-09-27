import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { ControlError, expireConditionWait, listDueConditionWaits, observeConditionWait, openControl } from "../control/store";
import type { ConditionWait, WaitObservation, WaitSourceAdapter, WaitSourceAdapters } from "../control/types";
import { openMailbox } from "../decision-bot/mailbox";
import type { ResumeExecutor } from "../shared/resume";
import { DISPOSITION_FAILURE_BUDGET, listDispositionWork, recordDispositionFailure } from "./failure-budget";
import { listRecoveriesInFlight, processRecoveryEffect, processWaitDisposition, type RecoveryProbes } from "./recovery";

/**
 * Counters for one observer round (§9.1). `claimed` counts due waits taken this round; each claimed wait
 * ends as `observed` (committed and still watching, including a recorded retryable failure), `ready`,
 * `unavailable`, `expired`, `conflicted` (CAS lost or database busy; left for the next round), abandoned at
 * the run deadline, or an unexpected error that fails the round. `timed_out` counts adapters or dispositions
 * aborted by a deadline: an item deadline also records a transient failure, the run deadline records nothing.
 */
export type ObserveWaitsResult = {
  claimed: number; observed: number; ready: number;
  unavailable: number; expired: number; conflicted: number;
  timed_out: number; parked: number; duration_ms: number;
};

/** Spawns a command bound to an AbortSignal; the adapter-facing shape of `ChildProcessRegistry.executor`. */
export type ChildProcessExecutor = (cmd: string, args: string[], opts?: { cwd?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** Tracks every spawned child so the runner can wait for TERM/KILL reaping before a slot is reused or the round returns. */
export type ChildProcessRegistry = {
  executor: ChildProcessExecutor;
  /** Resolves once every child spawned with `signal` (or every child, when omitted) has exited and been read. */
  settled(signal?: AbortSignal): Promise<void>;
};

/** Fixed service identity for maintenance-driven dispositions; it never stands in for a decision owner (§8.1 rule 4). */
export const WAIT_SERVICE_ACTOR = "maintenance";

// §7.2: successful same/changed observations are re-checked five minutes later; the store owns error backoff.
const POLL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 50;
const DEFAULT_RUN_BUDGET_MS = 4000;
const DEFAULT_ITEM_TIMEOUT_MS = 2000;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
// openControl waits up to 5s on a lock; a round must not block its hard deadline on one busy CAS.
const CAS_BUSY_TIMEOUT_MS = 250;
const CHILD_KILL_GRACE_MS = 250;

/** Raised after the round when setup failed or any wait hit an unexpected error; `result` keeps the partial counts. */
export class ObserveWaitsFailure extends Error {
  constructor(readonly result: ObserveWaitsResult, readonly failures: unknown[]) {
    super(`wait observer round failed: ${failures.map(describe).join("; ")}`);
    this.name = "ObserveWaitsFailure";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`invalid ${name}: ${value}`);
  return Math.min(value, max);
}

function isContention(error: unknown): boolean {
  if (error instanceof ControlError) return error.code === "conflict";
  return String((error as { code?: unknown } | null)?.code ?? "").startsWith("SQLITE_BUSY");
}

const WAIT_KINDS = ["github_pr_merged", "check_new_result", "work_completed"] as const;

/**
 * One bounded observer round (§7.2, §9.1). A run-level AbortController fires at the hard `runBudgetMs`
 * deadline; every claim first proves remaining budget on the monotonic clock, and each adapter call gets
 * `min(itemTimeoutMs, remaining)` linked to the run signal. External observation never runs inside a SQLite
 * transaction: row/version → adapter → short CAS. After the hard deadline nothing is claimed or committed;
 * in-flight adapters and their children are aborted and awaited before returning. Pending dispositions and in-flight
 * authorized recoveries left by earlier rounds are handled first so slow sources can never starve a condition that is
 * already settled or a launched resume whose effect window is running.
 */
export async function observeDueWaits(
  deps: {
    controlPath: string;
    orchestratorPath: string;
    ledgerPath: string;
    mailboxPath: string;
    adapters: WaitSourceAdapters;
    now?: () => number;
    /** Registry behind the adapters' command executor; awaited so no child outlives its slot or the round. */
    children?: Pick<ChildProcessRegistry, "settled">;
    /** Runtime seams for an authorized resume; production uses cmux, the process table and the runtime session roots. */
    recovery?: { executor?: ResumeExecutor } & RecoveryProbes;
  },
  options: {
    batchSize?: number; // default 20, max 50
    runBudgetMs?: number; // default 4000; hard run deadline, outer cleanup grace
    itemTimeoutMs?: number; // default 2000
    concurrency?: number; // default 2, max 4
  } = {},
): Promise<ObserveWaitsResult> {
  const startedMono = performance.now();
  const batchSize = bounded(options.batchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, "batchSize");
  const runBudgetMs = bounded(options.runBudgetMs, DEFAULT_RUN_BUDGET_MS, DEFAULT_RUN_BUDGET_MS, "runBudgetMs");
  const itemTimeoutMs = bounded(options.itemTimeoutMs, DEFAULT_ITEM_TIMEOUT_MS, Number.MAX_SAFE_INTEGER, "itemTimeoutMs");
  const concurrency = bounded(options.concurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, "concurrency");
  const deadlineMono = startedMono + runBudgetMs;
  // Disposition work (redecisions, dispatches, effects) starts and runs only within the first half of the round, so
  // observation of due waits always keeps the rest.
  const dispositionDeadlineMono = startedMono + runBudgetMs / 2;
  const run = new AbortController();
  // One place ends the round: the timer, the monotonic check, or an item deadline capped by the remaining budget.
  const endRun = () => { if (!run.signal.aborted) run.abort(new DOMException("wait observer run deadline reached", "TimeoutError")); };
  const runTimer = setTimeout(endRun, runBudgetMs);
  const clock = deps.now ?? Date.now;
  const result: ObserveWaitsResult = { claimed: 0, observed: 0, ready: 0, unavailable: 0, expired: 0, conflicted: 0, timed_out: 0, parked: 0, duration_ms: 0 };
  const failures: unknown[] = [];

  /** Monotonic hard-deadline check; the timer may lag a busy loop, the clock is authoritative. */
  const pastDeadline = (): boolean => {
    if (performance.now() >= deadlineMono) endRun();
    return run.signal.aborted;
  };

  let control: Database | null = null;
  let mailbox: Database | null = null;
  let ledger: Database | null = null;
  let ledgerOpened = false;

  /**
   * Runs `task` under an item deadline linked to the run signal; returns whether a deadline aborted it. The item
   * deadline is `itemTimeoutMs`, cut short at `capMono`; one that reaches the run deadline is the run deadline, so it
   * ends the round rather than recording a transient failure for a source that still had its own time left.
   */
  const withItemDeadline = async <T>(task: (signal: AbortSignal) => Promise<T>, capMono = deadlineMono): Promise<{ value?: T; error?: unknown; aborted: boolean }> => {
    const item = new AbortController();
    const nowMono = performance.now();
    const runRemaining = Math.max(0, deadlineMono - nowMono);
    const itemLimit = Math.min(itemTimeoutMs, Math.max(0, capMono - nowMono));
    const timer = runRemaining <= itemLimit
      ? setTimeout(endRun, runRemaining)
      : setTimeout(() => item.abort(new DOMException(`wait item deadline of ${itemLimit}ms reached`, "TimeoutError")), itemLimit);
    const onRunAbort = () => item.abort(run.signal.reason);
    if (run.signal.aborted) onRunAbort();
    else run.signal.addEventListener("abort", onRunAbort, { once: true });
    let aborted = false;
    try {
      const value = await task(item.signal);
      aborted = item.signal.aborted;
      return { value, aborted };
    } catch (error) {
      aborted = item.signal.aborted;
      return { error, aborted };
    } finally {
      clearTimeout(timer);
      run.signal.removeEventListener("abort", onRunAbort);
      // The item scope ends here: any child it spawned is terminated and reaped before the slot is reused.
      if (!aborted) item.abort(new DOMException("wait item finished", "AbortError"));
      await deps.children?.settled(item.signal);
    }
  };

  const openStores = () => {
    if (!mailbox) {
      mailbox = openMailbox(deps.mailboxPath);
      mailbox.exec(`PRAGMA busy_timeout=${CAS_BUSY_TIMEOUT_MS}`);
    }
    if (!ledgerOpened) {
      ledgerOpened = true;
      // Liveness and effect evidence are read-only; a missing ledger means "unknown", on which recovery fails closed.
      try { ledger = new Database(deps.ledgerPath, { readonly: true }); } catch { ledger = null; }
    }
    return { control: control!, mailbox, ledger, ...deps.recovery, actor: WAIT_SERVICE_ACTOR, now: clock };
  };

  /** Counts a failed disposition of `wait` against its budget; the one failure that spends it is surfaced. */
  const budgetFailure = (wait: ConditionWait, error: unknown): void => {
    try {
      const { failures: count, parked } = recordDispositionFailure(control!, wait, describe(error), clock());
      if (!parked) return;
      result.parked++;
      failures.push(new Error(`wait ${wait.wait_id}@${wait.version} disposition parked after ${count}/${DISPOSITION_FAILURE_BUDGET} failures: ${describe(error)}`));
    } catch (budgetError) {
      failures.push(budgetError);
    }
  };

  /**
   * Processes one disposition (pending redecision/dispatch, or an in-flight recovery effect). CAS contention and the
   * run deadline leave the row for the next round; any other failure, including overrunning its own item deadline,
   * is reported and backs the row off (src/waits/failure-budget.ts) so it cannot hold the head of the queue.
   */
  const dispose = async (wait: ConditionWait, recovery = false, capMono = deadlineMono): Promise<void> => {
    if (pastDeadline()) return;
    const stores = openStores();
    const outcome = await withItemDeadline<{ kind: string; reason?: string }>((signal) =>
      recovery ? processRecoveryEffect({ ...stores, signal }, wait) : processWaitDisposition({ ...stores, signal }, wait), capMono);
    const itemOverran = outcome.aborted && !run.signal.aborted;
    if (outcome.error !== undefined) {
      if (isContention(outcome.error)) result.conflicted++;
      else if (outcome.aborted) result.timed_out++;
      else failures.push(outcome.error);
      if (!isContention(outcome.error) && (!outcome.aborted || itemOverran)) budgetFailure(wait, outcome.error);
    } else if (outcome.aborted || (outcome.value?.kind === "skipped" && outcome.value.reason === "aborted")) {
      result.timed_out++;
      if (itemOverran) budgetFailure(wait, new Error("disposition exceeded its item deadline"));
    }
  };

  /**
   * Short CAS, synchronous from the caller's last deadline check. A lost race or busy lock leaves the row for
   * the next round (never retried against a stale version); a settled outcome is disposed immediately.
   * Returns the store's `invalid` rejection so the caller can fail the observation closed.
   */
  const commit = async (write: () => { wait: ConditionWait; became_ready: boolean }): Promise<ControlError | null> => {
    let landed: { wait: ConditionWait; became_ready: boolean };
    try {
      landed = write();
    } catch (error) {
      if (error instanceof ControlError && error.code === "invalid") return error;
      if (isContention(error)) result.conflicted++;
      else failures.push(error);
      return null;
    }
    if (landed.became_ready) result.ready++;
    else if (landed.wait.state === "watching") result.observed++;
    else if (landed.wait.state === "unavailable") result.unavailable++;
    else if (landed.wait.state === "expired") result.expired++;
    if (landed.wait.disposition_state === "pending") await dispose(landed.wait);
    return null;
  };

  const observeOne = async (wait: ConditionWait): Promise<void> => {
    // Wall time never regresses below the row's last mutation, so a clock step cannot break chronology.
    const observeAt = Math.max(clock(), wait.updated_at);
    if (observeAt >= wait.deadline_at) {
      await commit(() => ({ wait: expireConditionWait(control!, wait.wait_id, wait.version, "deadline", observeAt), became_ready: false }));
      return;
    }
    // Keyed by condition kind (validated at round start); TS cannot correlate the union with the mapped adapter.
    const adapter = deps.adapters[wait.condition.kind] as unknown as WaitSourceAdapter;
    const outcome = await withItemDeadline((signal) => adapter.observe(wait, { now: observeAt, signal }));
    if (pastDeadline()) { result.timed_out++; return; }
    let observation: WaitObservation;
    if (outcome.aborted) {
      result.timed_out++;
      observation = { kind: "error", error_kind: "transient", detail: "source observation exceeded its item deadline", observed_at: observeAt };
    } else if (outcome.error !== undefined) {
      observation = { kind: "error", error_kind: "unknown", detail: `source adapter failed: ${describe(outcome.error)}`, observed_at: observeAt };
    } else {
      observation = outcome.value as WaitObservation;
    }
    const at = Math.max(clock(), observeAt);
    if (at >= wait.deadline_at) {
      await commit(() => ({ wait: expireConditionWait(control!, wait.wait_id, wait.version, "deadline", at), became_ready: false }));
      return;
    }
    const schedule = { next_check_at: at + POLL_INTERVAL_MS };
    const rejected = await commit(() => observeConditionWait(control!, wait.wait_id, wait.version, observation, schedule, at));
    if (!rejected) return;
    // The store refused the adapter's claim (regressed generation, non-advancing ready, malformed shape): the
    // source contradicts the persisted wait, which fails closed to a human instead of becoming same or ready.
    const contradiction: WaitObservation = { kind: "error", error_kind: "invalid_response", detail: `source observation rejected: ${rejected.message}`, observed_at: observeAt };
    const unrecordable = await commit(() => observeConditionWait(control!, wait.wait_id, wait.version, contradiction, schedule, at));
    if (unrecordable) failures.push(unrecordable);
  };

  try {
    for (const kind of WAIT_KINDS) {
      if (deps.adapters?.[kind]?.kind !== kind) throw new TypeError(`missing source adapter for ${kind}`);
    }
    control = openControl(deps.controlPath);
    control.exec(`PRAGMA busy_timeout=${CAS_BUSY_TIMEOUT_MS}`);
    const pastDispositionDeadline = () => pastDeadline() || performance.now() >= dispositionDeadlineMono;
    for (const wait of listDispositionWork(control, ["pending"], clock(), batchSize)) {
      if (pastDispositionDeadline()) break;
      await dispose(wait, false, dispositionDeadlineMono);
    }
    for (const wait of listRecoveriesInFlight(control, batchSize, clock())) {
      if (pastDispositionDeadline()) break;
      await dispose(wait, true, dispositionDeadlineMono);
    }
    if (!pastDeadline()) {
      const due = listDueConditionWaits(control, clock(), batchSize);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < due.length && !pastDeadline()) {
          const wait = due[next++]!;
          result.claimed++;
          await observeOne(wait);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
    }
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(runTimer);
    run.abort(new DOMException("wait observer round finished", "AbortError"));
    try { await deps.children?.settled(); } catch (error) { failures.push(error); }
    for (const db of [ledger as Database | null, mailbox as Database | null, control as Database | null]) {
      try { db?.close(); } catch (error) { failures.push(error); }
    }
    result.duration_ms = Math.round(performance.now() - startedMono);
  }
  if (failures.length > 0) throw new ObserveWaitsFailure(result, failures);
  return result;
}

/**
 * Abort-aware command executor: a child gets TERM when its signal aborts and KILL after a short grace, and
 * stays tracked until it has exited. After an abort the result never waits on pipes a surviving grandchild
 * may still hold; the maintenance process-group deadline reaps such descendants. Nothing spawns after an abort.
 */
export function createChildProcessRegistry(killGraceMs = CHILD_KILL_GRACE_MS): ChildProcessRegistry {
  const running = new Set<{ signal: AbortSignal | undefined; done: Promise<unknown> }>();
  const executor: ChildProcessExecutor = (cmd, args, opts = {}) => {
    const signal = opts.signal;
    if (signal?.aborted) return Promise.resolve({ ok: false, stdout: "", stderr: "aborted before spawn" });
    let proc: Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([cmd, ...args], { cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      return Promise.resolve({ ok: false, stdout: "", stderr: describe(error) });
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const aborted = Promise.withResolvers<null>();
    const onAbort = () => {
      try { proc.kill("SIGTERM"); } catch { /* already exited */ }
      killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already exited */ } }, killGraceMs);
      aborted.resolve(null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (async () => {
      const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).catch((error: unknown) => ["", describe(error)]);
      try {
        const code = await proc.exited;
        const read = await Promise.race([output, aborted.promise]);
        if (read === null || signal?.aborted) return { ok: false, stdout: "", stderr: `aborted: ${describe(signal?.reason)}` };
        return { ok: code === 0, stdout: read[0], stderr: read[1] };
      } finally {
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
      }
    })();
    const entry = { signal, done };
    running.add(entry);
    void done.finally(() => running.delete(entry));
    return done;
  };
  return {
    executor,
    async settled(signal) {
      await Promise.all([...running].filter((entry) => signal === undefined || entry.signal === signal).map((entry) => entry.done));
    },
  };
}
