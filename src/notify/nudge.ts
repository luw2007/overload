// P5 recall nudge: when the Now zone (pending decisions + hung turns)
// transitions from empty to non-empty, emit ONE aggregated macOS
// notification. Never per-event, never while Now stays non-empty.
// Runs from scripts/maintenance.sh on the 60s launchd interval.
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { queryHung, queryQ1 } from "../shared/queries";

export type NudgeDeps = {
  ledgerPath: string;
  statePath: string;
  notify: (message: string) => Promise<void>;
};

/** Previous Now count persisted across runs; missing/corrupt file reads as 0. */
function readPrevious(statePath: string): number {
  try {
    const parsed = Number.parseInt(readFileSync(statePath, "utf8").trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}


export async function nudgeOnce(deps: NudgeDeps): Promise<{ count: number; notified: boolean }> {
  const db = new Database(deps.ledgerPath, { readonly: true, create: false });
  let count: number;
  try {
    count = queryQ1(db).length + queryHung(db).length;
  } finally {
    db.close();
  }
  const previous = readPrevious(deps.statePath);
  const notified = previous === 0 && count > 0;
  if (notified) await deps.notify(`${count} 项待处理 — 打开 http://127.0.0.1:4870/now`);
  if (count !== previous) writeFileSync(deps.statePath, `${count}\n`, { mode: 0o600 });
  return { count, notified };
}

/** Message is derived from a count only; still passed as argv, never interpolated into script source. */
export async function macNotify(message: string): Promise<void> {
  const script = `display notification "${message.replaceAll('"', "")}" with title "Overload"`;
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

if (import.meta.main) {
  const home = join(homedir(), ".overload");
  const result = await nudgeOnce({
    ledgerPath: process.env.OVERLOAD_LEDGER_PATH ?? join(home, "ledger.db"),
    statePath: join(home, "nudge.state"),
    notify: macNotify,
  });
  if (result.notified) console.error(`nudge: notified (now=${result.count})`);
}
