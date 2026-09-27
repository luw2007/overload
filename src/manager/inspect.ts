import type { Database } from "bun:sqlite";
import { compactAttention, compactFollowUp, compactSession, compactWait, compactWork, handoffTargets, loadManagerReadModel, redactDeep } from "./context";

export const MANAGER_VIEWS = ["attention", "follow_up", "works", "waits", "sessions", "done", "targets"] as const;
export type ManagerView = typeof MANAGER_VIEWS[number];
export const READ_PAGE_SIZE = 12;
export type ManagerReadPage = { view: ManagerView; rows: unknown[]; next_cursor: string | null; total: number };

export class ManagerReadError extends Error {}

// Cursor is a plain offset over a deterministic ordering (the read models sort by updated_at/stable id).
// Limit: rows inserted between pages can shift later pages; upgrade to keyset cursors if reads span live churn.
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) throw new ManagerReadError("invalid cursor");
  return Number(cursor);
}

export function readManagerView(control: Database, ledger: Database | null, input: { view: string; cursor?: string; now?: number }): ManagerReadPage {
  if (!(MANAGER_VIEWS as readonly string[]).includes(input.view)) throw new ManagerReadError(`invalid view: ${input.view}`);
  const view = input.view as ManagerView;
  const offset = parseCursor(input.cursor);
  const model = loadManagerReadModel(control, ledger, input.now ?? Date.now());
  const all: unknown[] =
    view === "attention" ? [...model.now, ...model.inbox].map((item) => ({ zone: model.now.includes(item) ? "now" : "inbox", ...compactAttention(item) }))
    : view === "follow_up" ? model.followUps.map(compactFollowUp)
    : view === "works" ? model.works.map(compactWork)
    : view === "waits" ? model.waits.map(compactWait)
    : view === "sessions" ? model.sessions.map(compactSession)
    : view === "done" ? model.done.map(compactAttention)
    : handoffTargets(model.sessions);
  const rows = redactDeep(all.slice(offset, offset + READ_PAGE_SIZE));
  const next = offset + READ_PAGE_SIZE;
  return { view, rows, next_cursor: next < all.length ? String(next) : null, total: all.length };
}
