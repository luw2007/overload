import type { Database } from 'bun:sqlite';
import { openControl } from '../control/store';
import { ensureAdapterSchema, type Conversation, type StoredTurn } from '../adapters/store';
import type { ChannelAddress, SessionReference } from '../adapters/types';

export interface ConversationRouteOptions { controlPath?: string }
export type ConversationSummary = Omit<Conversation, 'address' | 'session_reference'> & {
  address: ChannelAddress;
  session_reference: SessionReference | null;
  last_sequence: number | null;
};
type ConversationRow = Conversation & { last_sequence: number | null };
const SUMMARY_SQL = `SELECT c.*, (SELECT MAX(sequence) FROM conversation_turns WHERE conversation_id=c.id) AS last_sequence FROM conversations c`;
function summary(row: ConversationRow): ConversationSummary {
  return { ...row, address: JSON.parse(row.address), session_reference: row.session_reference ? JSON.parse(row.session_reference) : null };
}
function integer(raw: string | null, min: number, max: number, fallback?: number): number {
  if (raw === null && fallback !== undefined) return fallback;
  if (raw === null || !raw.trim()) throw new Error('integer required');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('integer out of range');
  return value;
}
function cursor(raw: string): { t: number; i: string } {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(raw)) throw new Error('invalid cursor');
  const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('t' in value) || !('i' in value)
    || typeof value.t !== 'number' || !Number.isSafeInteger(value.t) || value.t < 0 || typeof value.i !== 'string' || !value.i.trim()) {
    throw new Error('invalid cursor');
  }
  return { t: value.t, i: value.i };
}

export async function conversationRoute(request: Request, url: URL, options: ConversationRouteOptions): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const isList = url.pathname === '/api/conversations';
  const match = url.pathname.match(/^\/api\/conversations\/([^/]+)\/turns$/);
  if (!isList && !match) return null;
  let limit: number, position: { t: number; i: string } | null = null, id: string | null = null;
  let before: number | null = null, after: number | null = null;
  try {
    limit = integer(url.searchParams.get('limit'), 1, 100, 50);
    if (isList) {
      const raw = url.searchParams.get('cursor');
      if (raw !== null) position = cursor(raw);
    } else {
      id = decodeURIComponent(match![1]);
      const beforeRaw = url.searchParams.get('before'), afterRaw = url.searchParams.get('after');
      if (beforeRaw !== null && afterRaw !== null) throw new Error('before and after are mutually exclusive');
      if (beforeRaw !== null) before = integer(beforeRaw, 1, Number.MAX_SAFE_INTEGER);
      if (afterRaw !== null) after = integer(afterRaw, 0, Number.MAX_SAFE_INTEGER);
    }
  } catch (error) {
    return Response.json({ error: 'invalid', message: error instanceof Error ? error.message : 'invalid page' }, { status: 400 });
  }
  const db = openControl(options.controlPath);
  try {
    ensureAdapterSchema(db);
    return isList ? listPage(db, limit, position) : turnsPage(db, id!, limit, before, after);
  } finally { db.close(); }
}
function listPage(db: Database, limit: number, position: { t: number; i: string } | null): Response {
  const where = position ? ' WHERE c.created_at<? OR (c.created_at=? AND c.id>?)' : '';
  const params = position ? [position.t, position.t, position.i, limit + 1] : [limit + 1];
  const rows = db.query(`${SUMMARY_SQL}${where} ORDER BY c.created_at DESC,c.id ASC LIMIT ?`).all(...params) as ConversationRow[];
  const hasMore = rows.length > limit;
  if (hasMore) rows.length = limit;
  const last = rows.at(-1);
  const next_cursor = hasMore && last ? Buffer.from(JSON.stringify({ t: last.created_at, i: last.id })).toString('base64url') : null;
  return Response.json({ items: rows.map(summary), next_cursor });
}
function turnsPage(db: Database, id: string, limit: number, before: number | null, after: number | null): Response {
  const row = db.query(`${SUMMARY_SQL} WHERE c.id=?`).get(id) as ConversationRow | null;
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
  const ascending = after !== null;
  const bound = ascending ? after : before;
  const where = bound !== null ? ` AND sequence${ascending ? '>' : '<'}?` : '';
  const params = bound !== null ? [id, bound, limit + 1] : [id, limit + 1];
  const turns = db.query(`SELECT * FROM conversation_turns WHERE conversation_id=?${where} ORDER BY sequence ${ascending ? 'ASC' : 'DESC'} LIMIT ?`).all(...params) as StoredTurn[];
  const hasMore = turns.length > limit;
  if (hasMore) turns.length = limit;
  const next = hasMore ? turns.at(-1)!.sequence : null;
  if (!ascending) turns.reverse();
  return Response.json({ conversation: summary(row), turns, next_before: ascending ? null : next, next_after: ascending ? next : null });
}
