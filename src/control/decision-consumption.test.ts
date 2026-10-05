import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { actOnAttention, createWork, getAttention, getWork, resolveAttentionDecision, upsertAttention, ControlError } from './store';
import type { Contract } from './types';

const contract: Contract = { objective: 'review local change', acceptance: [{ id: 'review', kind: 'human', description: 'owner decides' }],
  non_goals: [], scope: { cwd: '/tmp' }, budget: {}, stop_conditions: [], decision_owner: 'owner' };
function seed(db: Database, expiresAt: number | null = null) {
  const work = createWork(db, { title: 'local decision', source: 'test', contract }, 1000);
  const item = upsertAttention(db, { item_id: 'decision', work_id: work.work_id, state: 'open', effect_state: 'not_started', urgency: 'inbox',
    conclusion: 'choose a path', trigger: 'new evidence', impact: 'held until chosen', recommendation: null, options: ['continue'], owner: 'owner',
    expires_at: expiresAt, source_link: null, approval_id: null, consumer_owner: null, contract_revision: work.revision,
    decision_mode: 'human_only', evidence: {} }, 1000);
  return { work, item };
}

test('resolve without a selected option cannot archive or change the work', () => {
  const db = new Database(':memory:');
  try {
    const { work, item } = seed(db);
    expect(() => actOnAttention(db, item.item_id, item.revision, 'resolve', {}, 'owner', 2000)).toThrow(ControlError);
    expect(getAttention(db, item.item_id)).toMatchObject({ state: 'open', effect_state: 'not_started', revision: item.revision });
    expect(getWork(db, work.work_id)).toMatchObject({ state: 'active', revision: work.revision });
  } finally { db.close(); }
});

test.each([undefined, '', 'intruder'])('decision owner cannot be bypassed by actor %s without context objects', actor => {
  const db = new Database(':memory:');
  try {
    const { work, item } = seed(db);
    expect(() => resolveAttentionDecision(db, item.item_id, item.revision, { selected_option: 'continue' }, 2000, actor)).toThrow(ControlError);
    expect(getAttention(db, item.item_id)).toMatchObject({ state: 'open', revision: item.revision });
    expect(getWork(db, work.work_id)?.revision).toBe(work.revision);
  } finally { db.close(); }
});

test.each([4999, 5000, 5001])('decision expiry is enforced at consumption time %i', now => {
  const db = new Database(':memory:');
  try {
    const { work, item } = seed(db, 5000);
    if (now < 5000) {
      const resolved = resolveAttentionDecision(db, item.item_id, item.revision, { selected_option: 'continue' }, now, 'owner');
      expect(resolved).toMatchObject({ state: 'resolved', effect_state: 'succeeded', evidence: expect.objectContaining({ selected_option: 'continue' }) });
      expect(getWork(db, work.work_id)?.revision).toBe(work.revision + 1);
    } else {
      expect(() => resolveAttentionDecision(db, item.item_id, item.revision, { selected_option: 'continue' }, now, 'owner')).toThrow(ControlError);
      expect(getAttention(db, item.item_id)).toMatchObject({ state: 'open', revision: item.revision });
      expect(getWork(db, work.work_id)?.revision).toBe(work.revision);
    }
  } finally { db.close(); }
});
