import type { Database } from "bun:sqlite";
import { compactAttention, compactFollowUp, compactSession, compactWait, compactWork, DONE_WINDOW_DAYS, handoffTargets, loadManagerReadModel, redactDeep } from "./context";
import { ControlError, listAttentionPage } from "../control/store";

export const MANAGER_VIEWS = ["attention", "follow_up", "works", "waits", "sessions", "done", "targets"] as const;
export type ManagerView = typeof MANAGER_VIEWS[number];
export const READ_PAGE_SIZE = 12;
export type ManagerReadPage = { view: ManagerView; rows: unknown[]; next_cursor: string | null; total: number };

export class ManagerReadError extends Error {}

// Non-Done views use offsets over deterministic ordering; Done uses the store's keyset cursor.
// Rows inserted between offset pages can shift later pages.
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) throw new ManagerReadError("invalid cursor");
  return Number(cursor);
}

const DAY_MS = 86_400_000;

export function readManagerView(control: Database, ledger: Database | null, input: { view: string; cursor?: string; now?: number }): ManagerReadPage {
  if (!(MANAGER_VIEWS as readonly string[]).includes(input.view)) throw new ManagerReadError(`invalid view: ${input.view}`);
  const view = input.view as ManagerView;
  const now = input.now ?? Date.now();
  if (view === "done") {
    const cutoff = Math.max(0, now - DONE_WINDOW_DAYS * DAY_MS);
    try {
      const page = listAttentionPage(control, "done", { cursor: input.cursor, updated_since: cutoff, limit: READ_PAGE_SIZE }, now);
      return { view, rows: redactDeep(page.items.map(compactAttention)), next_cursor: page.next_cursor, total: page.total };
    } catch (err) {
      if (err instanceof ControlError) throw new ManagerReadError(err.message);
      throw err;
    }
  }
  const offset = parseCursor(input.cursor);
  const model = loadManagerReadModel(control, ledger, now);
  const all: unknown[] =
    view === "attention" ? [...model.now, ...model.inbox].map((item) => ({ zone: model.now.includes(item) ? "now" : "inbox", ...compactAttention(item) }))
    : view === "follow_up" ? model.followUps.map(compactFollowUp)
    : view === "works" ? model.works.map(compactWork)
    : view === "waits" ? model.waits.map(compactWait)
    : view === "sessions" ? model.sessions.map(compactSession)
    : handoffTargets(model.sessions);
  const rows = redactDeep(all.slice(offset, offset + READ_PAGE_SIZE));
  const next = offset + READ_PAGE_SIZE;
  return { view, rows, next_cursor: next < all.length ? String(next) : null, total: all.length };
}
