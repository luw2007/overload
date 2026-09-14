/**
 * Coordinator mock-harness tests.
 *
 * What IS tested (in-process, all fake/offline):
 *   - Coordinator contract logic: bind, dispatch, scope, review, deliver, accept/reject
 *   - AdapterService routing: message event → conversation, decision event → coordinatorDecision path
 *   - Same-repo serial ship+scout (by design: child scope ⊆ contract scope)
 *   - Attention card lifecycle: open → resolved, evidence fields
 *
 * What is NOT tested (smoke gaps for live integration):
 *   - GAP-SDK: Real Feishu SDK inbound (createLarkChannel, websocket, webhook verify)
 *   - GAP-PI-WORKER: Two real pi runtime sessions (CoordinatorWorkers.start with live AgentRuntime)
 *   - GAP-USER-CALLBACK: Real user card-button click → Feishu cardAction webhook → ChannelEvent
 *   - GAP-CARD-UPDATE: Original card message_id update via FeishuChannel.send/updateCard
 *   - GAP-DELIVERY-DEDUP: channel_deliveries flush loop idempotency under concurrent ticks
 *
 * Fake components:
 *   - FakeChannel: in-memory ChannelAdapter, send() → local array, no network
 *   - FakeRuntime: in-memory AgentRuntime, no process spawn
 *   - Worker completion: store.transition() direct call, not runtime event stream
 *   - Human decision: ChannelEvent{kind:'decision'} injected to AdapterService.accept()
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openMailbox } from '../decision-bot/mailbox';
import { openStore, transition, getTask } from '../orchestrator/store';
import { createWork, getWork, getAttention } from '../control/store';
import { ensureAdapterSchema } from './store';
import { CoordinatorBridge } from './coordinator';
import { AdapterService } from './service';
import type {
  AgentRuntime, SessionHandle, ChannelAdapter, ChannelEvent,
  ChannelMessage, SessionReference, RuntimeEvent,
} from './types';
import type { Database } from 'bun:sqlite';
import type { Contract, Work } from '../control/types';

// --- Fakes (no network, no process, no SDK) ---

function createFakeRuntime() {
  const sessions = new Map<string, { ref: SessionReference; turnId: string | null; prompt: string | null }>();
  const runtime: AgentRuntime = {
    kind: 'fake', capabilities: { restore: false, answer: false, steer: false },
    async start(req) {
      const s = { ref: { ...req, runtimeKind: 'fake' }, turnId: null as string | null, prompt: null as string | null };
      sessions.set(req.sessionId, s);
      const handle: SessionHandle = {
        reference: s.ref,
        events: { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } },
        async submit(t) { s.turnId = t.turnId; s.prompt = t.text; return { state: 'accepted', commandId: t.turnId }; },
        async cancel() { return { state: 'rejected', commandId: 'x' }; },
        async close() {},
      };
      return handle;
    },
    async connect(ref) { throw new Error('fake_no_reconnect'); },
  };
  return { runtime, sessions };
}

function createFakeChannel() {
  const sent: ChannelMessage[] = [];
  let acceptFn: ((e: ChannelEvent) => Promise<void>) | null = null;
  const channel: ChannelAdapter = {
    kind: 'fake', instanceId: 'fake-ch', capabilities: { update: true, actions: true },
    async start(accept) { acceptFn = accept; },
    async stop() { acceptFn = null; },
    async send(m) { sent.push(m); return { state: 'sent', messageId: m.replaceMessageId ?? 'fmsg-' + sent.length }; },
  };
  const inject = (e: ChannelEvent) => { if (!acceptFn) throw new Error('channel not started'); return acceptFn(e); };
  return { channel, sent, inject };
}

// --- Helpers ---

function sha256(s: string) { return createHash('sha256').update(s).digest('hex'); }
function evidence(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name); writeFileSync(p, body);
  return { path: p, sha256: sha256(body) };
}
function contract(dir: string): Contract {
  return {
    objective: 'test', acceptance: [{ id: 'a', kind: 'artifact', description: 'x' }],
    non_goals: [], scope: { repo: dir, cwd: dir, allowed_effects: ['read', 'write'], human_only_effects: ['push'] },
    budget: { retry_limit: 2 }, stop_conditions: [], decision_owner: 'owner@test',
  };
}
const msgEvent = (id: string, text: string): ChannelEvent => ({
  kind: 'message', eventId: id,
  identity: { instanceId: 'fake-ch', tenantId: 't', userId: 'owner' },
  address: { instanceId: 'fake-ch', tenantId: 't', chatId: 'c1' },
  messageId: id, text, receivedAt: Date.now(),
});
const decEvent = (itemId: string, rev: number, answer: string,messageId:string): ChannelEvent => ({
  kind: 'decision', eventId: randomUUID(),
  identity: { instanceId: 'fake-ch', tenantId: 't', userId: 'owner' },
  address: { instanceId: 'fake-ch', tenantId: 't', chatId: 'c1' },
  messageId, itemId, revision: rev, answer,receivedAt:Date.now(),
});

// --- Coordinator lifecycle through AdapterService ---

describe('coordinator harness (offline, fake channel+runtime)', () => {
  let dir: string, db: Database, orch: Database, bridge: CoordinatorBridge;
  let rt: ReturnType<typeof createFakeRuntime>, ch: ReturnType<typeof createFakeChannel>;
  let svc: AdapterService, work: Work;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'coord-harness-'));
    db = openMailbox(join(dir, 'c.db')); orch = openStore(join(dir, 'o.db'));
    ensureAdapterSchema(db);
    work = createWork(db, { title: 'T', source: 'op', contract: contract(dir) });
    bridge = new CoordinatorBridge(db, orch); bridge.start(0);
    rt = createFakeRuntime(); ch = createFakeChannel();
    svc = new AdapterService(db, {
      runtime: rt.runtime, channels: [ch.channel], cwd: dir,
      authorize: i => i.userId === 'owner' ? {ownerId:'owner@test',workId:work.work_id} : null,
      coordinator: (conv, ref) => bridge.bind(conv, ref, work.work_id),
      silentTurn: id => bridge.isWakeup(id),
      coordinatorDecision: (item, ans, actor) => bridge.decide(item, ans, actor),
    });
    await svc.start();
  });
  afterEach(async () => {
    await svc.stop(); bridge.stop(); db.close(); orch.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Bind via coordinator HTTP (as root agent would). */
  async function coord(method: string, extra: Record<string, unknown>) {
    const tok = (db.query('SELECT token FROM channel_coordinators WHERE work_id=?').get(work.work_id) as any)?.token;
    const r = await bridge.handle(new Request('http://127.0.0.1/' + method, {
      method: 'POST', headers: { authorization: 'Bearer ' + tok },
      body: JSON.stringify({ work_id: work.work_id, ...extra }),
    }));
    return { status: r.status, body: await r.json() as any };
  }

  /** Advance task queued→starting→running→awaiting_human via store (FAKE — not live runtime). */
  function finish(taskId: string) {
    orch.run('UPDATE tasks SET attempt_id=? WHERE task_id=?',[randomUUID(),taskId]);
    transition(orch, taskId, 'claim', {});
    transition(orch, taskId, 'spawn_ok', { worktree: dir, branch: 'b' });
    return transition(orch, taskId, 'runner_exit', { evidence_complete: true });
  }

  test('ingress → ship+scout (same repo) → review → deliver → decision event → done', async () => {
    // 1. SDK inbound message → conversation + session
    await ch.inject(msgEvent('m1', 'go'));
    await svc.tick();
    const conv = db.query("SELECT id,work_id FROM conversations WHERE owner_id='owner@test'").get() as any;
    expect(conv.work_id).toBe(work.work_id);
    expect(rt.sessions.size).toBe(1);

    // 2. Dispatch ship + scout (same repo, serial — by design)
    const ship = await coord('coordinator_dispatch', {
      request_id: 'ship', title: 'Ship', repo: dir, kind: 'ship',
      scope: { repo: dir, allowed_effects: ['read', 'write'] },
      acceptance: ['a'], disposition: 'local',
    });
    const scout = await coord('coordinator_dispatch', {
      request_id: 'scout', title: 'Scout', repo: dir, kind: 'scout',
      scope: { repo: dir, allowed_effects: ['read'] },
      acceptance: ['a'], disposition: 'local',
    });
    expect(ship.status).toBe(200);
    expect(scout.status).toBe(200);
    expect(ship.body.task_id).not.toBe(scout.body.task_id);

    // 3. FAKE worker completion (store.transition, NOT live pi runtime)
    const sT = finish(ship.body.task_id);
    expect(sT.state).toBe('awaiting_human');

    // 4. Evidence + review
    const sEv = evidence(dir, 'impl.txt', 'done');
    const scEv = evidence(dir, 'report-x.txt', 'clean');
    const shipReview=await coord('coordinator_review', {
      task_id: sT.task_id, attempt_id: sT.attempt_id,
      state: 'awaiting_human', verdict: 'accept', reason: 'ok', evidence: [sEv],
    });expect(shipReview).toMatchObject({status:200});

    const scT=finish(scout.body.task_id);expect(scT.state).toBe('awaiting_human');
    expect((await coord('coordinator_review', {
      task_id: scT.task_id, attempt_id: scT.attempt_id,
      state: 'awaiting_human', verdict: 'accept', reason: 'ok', evidence: [scEv],
    })).status).toBe(200);

    // 5. Deliver → attention card
    const del = await coord('coordinator_deliver', { summary: 'ready' });
    expect(del.body.status).toBe('awaiting_human');
    const card = getAttention(db, del.body.item_id)!;
    expect(card.state).toBe('open');
    expect(card.decision_mode).toBe('human_only');
    expect((card.evidence as any).children).toHaveLength(2);

    // 6. FAKE human decision: inject ChannelEvent{kind:'decision'} → AdapterService.accept → coordinatorDecision
    //    (NOT bridge.decide direct call — goes through service.ts L32 routing)
    bridge.tick();await svc.tick();await svc.flush();
    const cardMessageId=(db.query('SELECT message_id FROM channel_card_bindings WHERE item_id=?').get(del.body.item_id) as {message_id:string}).message_id;
    expect(ch.sent.some(message=>message.decision?.itemId===del.body.item_id)).toBe(true);
    await ch.inject(decEvent(del.body.item_id, del.body.revision, 'accept',cardMessageId));

    // 7. Verify
    expect(getWork(db, work.work_id)!.state).toBe('completed');
    const resolved = getAttention(db, del.body.item_id)!;
    expect(resolved.state).toBe('resolved');
    expect(resolved.effect_state).toBe('succeeded');
    expect((resolved.evidence as any).accepted_by).toBe('owner@test');
  });

  test('decision event reject → work stays active', async () => {
    await ch.inject(msgEvent('m2', 'go'));
    await svc.tick();
    const ship = await coord('coordinator_dispatch', {
      request_id: 's2', title: 'S', repo: dir, kind: 'ship',
      scope: { repo: dir, allowed_effects: ['read', 'write'] }, acceptance: ['a'], disposition: 'local',
    });
    const scout = await coord('coordinator_dispatch', {
      request_id: 'sc2', title: 'Sc', repo: dir, kind: 'scout',
      scope: { repo: dir, allowed_effects: ['read'] }, acceptance: ['a'], disposition: 'local',
    });
    const sT = finish(ship.body.task_id);
    const sEv = evidence(dir, 'r-impl.txt', 'x'), scEv = evidence(dir, 'report-r.txt', 'y');
    await coord('coordinator_review', { task_id: sT.task_id, attempt_id: sT.attempt_id, state: 'awaiting_human', verdict: 'accept', reason: 'ok', evidence: [sEv] });

    const scT=finish(scout.body.task_id);
    await coord('coordinator_review', { task_id: scT.task_id, attempt_id: scT.attempt_id, state: 'awaiting_human', verdict: 'accept', reason: 'ok', evidence: [scEv] });
    const del = await coord('coordinator_deliver', { summary: 'x' });

    bridge.tick();await svc.tick();await svc.flush();
    const cardMessageId=(db.query('SELECT message_id FROM channel_card_bindings WHERE item_id=?').get(del.body.item_id) as {message_id:string}).message_id;
    expect(ch.sent.some(message=>message.decision?.itemId===del.body.item_id)).toBe(true);
    await ch.inject(decEvent(del.body.item_id, del.body.revision, 'reject',cardMessageId));
    expect(getWork(db, work.work_id)!.state).toBe('active');
    expect((getAttention(db, del.body.item_id)!.evidence as any).rejected_by).toBe('owner@test');
  });
});

// --- Contract logic (pure coordinator, no AdapterService) ---

describe('coordinator contract (pure logic)', () => {
  let dir: string, db: Database, orch: Database, bridge: CoordinatorBridge;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coord-ctr-'));
    db = openMailbox(join(dir, 'c.db')); orch = openStore(join(dir, 'o.db'));
    ensureAdapterSchema(db); bridge = new CoordinatorBridge(db, orch); bridge.start(0);
  });
  afterEach(() => { bridge.stop(); db.close(); orch.close(); rmSync(dir, { recursive: true, force: true }); });

  function bind() {
    const w = createWork(db, { title: 'T', source: 'op', contract: contract(dir) });
    const c = db.query("INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES(?,'[\"fake-ch\",\"t\",\"z\",null]','{}','owner@test',?) RETURNING *").get(randomUUID(), Date.now()) as any;
    const b = bridge.bind(c, { runtimeKind: 'x', sessionId: randomUUID(), ownerId: c.id, cwd: dir }, w.work_id);
    const call = async (m: string, x: Record<string, unknown>) => {
      const r = await bridge.handle(new Request('http://127.0.0.1/' + m, {
        method: 'POST', headers: { authorization: 'Bearer ' + b.token },
        body: JSON.stringify({ work_id: w.work_id, ...x }),
      }));
      return { status: r.status, body: await r.json() as any };
    };
    return { w, call };
  }

  test('ship needs write, scout needs read-only', async () => {
    const { call } = bind();
    expect((await call('coordinator_dispatch', {
      request_id: 'a', title: 'X', repo: dir, kind: 'ship',
      scope: { repo: dir, allowed_effects: ['read'] }, acceptance: ['x'],
    })).body.error).toBe('ship_write_authority_required');
    expect((await call('coordinator_dispatch', {
      request_id: 'b', title: 'X', repo: dir, kind: 'scout',
      scope: { repo: dir, allowed_effects: ['read', 'write'] }, acceptance: ['x'],
    })).body.error).toBe('scout_read_only_required');
  });

  test('no token → 403', async () => {
    bind();
    expect((await bridge.handle(new Request('http://127.0.0.1/coordinator_status', {
      method: 'POST', body: JSON.stringify({ work_id: 'x' }),
    }))).status).toBe(403);
  });

  test('idempotent dispatch', async () => {
    const { call } = bind();
    const args = { request_id: 'i', title: 'X', repo: dir, kind: 'ship' as const, scope: { repo: dir, allowed_effects: ['read', 'write'] }, acceptance: ['x'], disposition: 'local' };
    expect((await call('coordinator_dispatch', args)).body.task_id).toBe((await call('coordinator_dispatch', args)).body.task_id);
  });

  test('deliver before review → error', async () => {
    const { call } = bind();
    await call('coordinator_dispatch', { request_id: 'p', title: 'X', repo: dir, kind: 'ship', scope: { repo: dir, allowed_effects: ['read', 'write'] }, acceptance: ['x'], disposition: 'local' });
    expect((await call('coordinator_deliver', { summary: 'x' })).body.error).toContain('final_not_ready');
  });

  test('superseded contract → 409', async () => {
    const { w, call } = bind();
    db.run('UPDATE control_works SET revision=revision+1 WHERE work_id=?', [w.work_id]);
    expect((await call('coordinator_status', {})).status).toBe(409);
  });
});
