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

/** Previous notified subject IDs persisted across runs; missing/corrupt file reads as empty set. */
function readPrevious(statePath: string): Set<string> {
  try {
    const content = readFileSync(statePath, "utf8").trim();
    if (!content) return new Set<string>();
    return new Set(content.split("\n").filter(Boolean));
  } catch {
    return new Set<string>();
  }
}


export async function nudgeOnce(deps: NudgeDeps): Promise<{ count: number; notified: boolean }> {
  const db = new Database(deps.ledgerPath, { readonly: true, create: false });
  let currentIds: Set<string>;
  try {
    const q1Ids = queryQ1(db).map(r => `q1:${r.request_uid}`);
    const hungIds = queryHung(db).map(r => `hung:${r.stable_id}`);
    currentIds = new Set([...q1Ids, ...hungIds]);
  } finally {
    db.close();
  }
  const previous = readPrevious(deps.statePath);
  let hasNew = false;
  for (const id of currentIds) {
    if (!previous.has(id)) { hasNew = true; break; }
  }
  if (hasNew) await deps.notify(`${currentIds.size} 项待处理 — 打开 http://127.0.0.1:4870/now`);
  writeFileSync(deps.statePath, [...currentIds].join("\n") + "\n", { mode: 0o600 });
  return { count: currentIds.size, notified: hasNew };
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
