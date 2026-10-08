#!/usr/bin/env bun
/** Browser I/O only: runtime, approvals, effects and files are production paths. */
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, writeFileSync, existsSync, realpathSync, unlinkSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ChannelAdapter, ChannelEvent, ChannelMessage, ChannelAddress, SessionReference } from '../../src/adapters/types';
import type { Conversation, StoredTurn } from '../../src/adapters/store';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
function object(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function configObject(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!object(value)) throw new Error('Provider configuration must be an object');
  return value;
}

const args = process.argv.slice(2);
function option(name: string): string | undefined { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
const provider = option('--provider'), model = option('--model');
const port = Number(option('--port') ?? 0);
if (!provider || !model || !Number.isInteger(port) || port < 0 || port > 65535 || args.some((a, i) => i % 2 === 0 && !['--provider', '--model', '--port'].includes(a)) || args.length % 2) {
  throw new Error('Usage: bun test/harness/browser-e2e.ts --provider PROVIDER --model MODEL [--port PORT]');
}
const originalAgent = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
const originalEnv = { ...process.env };
const piCommand = Bun.which('pi');
if (!piCommand) throw new Error('Pi executable is required on PATH');
const secrets = new Set<string>();
const providers = configObject(join(originalAgent, 'models.json')).providers;
const selectedValue = object(providers) ? providers[provider] : undefined;
if (selectedValue !== undefined && !object(selectedValue)) throw new Error('Selected provider must be an object');
const selected = selectedValue;
const auth = configObject(join(originalAgent, 'auth.json'))[provider];
if (auth !== undefined && !object(auth)) throw new Error('Selected auth must be an object');
if (Array.isArray(selected?.models) && selected.models.length && !selected.models.some(m => object(m) && m.id === model) && !(object(selected.modelOverrides) && selected.modelOverrides[model])) throw new Error('Selected model is absent from selected custom provider');
// Resolve only selected credential references before changing HOME. Never copy unrelated providers.
async function credential(value: string): Promise<string> {
  if (value.startsWith('!')) {
    const proc = Bun.spawn(['/bin/sh', '-c', value.slice(1)], { env: originalEnv, stdout: 'pipe', stderr: 'ignore' });
    const result = (await new Response(proc.stdout).text()).trim();
    if (await proc.exited !== 0 || !result) throw new Error('Selected provider credential command failed');
    secrets.add(result); return result;
  }
  const result = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const found = originalEnv[a || b]; if (!found) throw new Error('Selected provider credential environment variable is missing'); return found;
  });
  if (result) secrets.add(result); return result;
}
async function selectedConfig() {
  if (!selected) return null;
  const copy = structuredClone(selected);
  if (Array.isArray(copy.models)) copy.models = copy.models.filter(m => object(m) && m.id === model);
  if (object(copy.modelOverrides)) copy.modelOverrides = copy.modelOverrides[model] ? { [model]: copy.modelOverrides[model] } : {};
  const entries = [copy, ...(Array.isArray(copy.models) ? copy.models : []), ...(object(copy.modelOverrides) ? Object.values(copy.modelOverrides) : [])];
  for (const entry of entries) {
    if (!object(entry)) throw new Error('Selected model configuration must be an object');
    if (typeof entry.apiKey === 'string') entry.apiKey = await credential(entry.apiKey);
    if (object(entry.headers)) for (const key of Object.keys(entry.headers)) {
      const value = entry.headers[key];
      if (typeof value !== 'string') throw new Error('Selected provider header must be a string');
      entry.headers[key] = await credential(value);
    }
  }
  return copy;
}
const copiedProvider = await selectedConfig();
function collectSecrets(value: unknown) { if (typeof value === 'string' && value.length > 3) secrets.add(value); else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (k !== 'type') collectSecrets(v); }
if (auth) collectSecrets(auth);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'overload-browser-e2e-')));
chmodSync(root, 0o700);
const home = join(root, 'home'), agent = join(home, '.pi', 'agent'), overload = join(home, '.overload');
const repo = join(root, 'repo'), runtimeRoot = join(root, 'runtime');
for (const dir of [home, agent, overload, repo, runtimeRoot, join(overload, 'spool')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const privateJson = (path: string, value: unknown) => { writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 }); chmodSync(path, 0o600); };
if (copiedProvider) privateJson(join(agent, 'models.json'), { providers: { [provider]: copiedProvider } });
if (auth) privateJson(join(agent, 'auth.json'), { [provider]: auth });
privateJson(join(agent, 'settings.json'), { defaultProvider: provider, defaultModel: model, defaultThinkingLevel: 'off', enableSkills: false });
writeFileSync(join(overload, 'host'), 'browser-e2e\n', { mode: 0o600 });
// A narrow inherited environment prevents accidental access to other credentials or production roots.
for (const key of Object.keys(process.env)) if (!['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'].includes(key)) delete process.env[key];
Object.assign(process.env, { HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1' });
// Built-in providers can use selected auth, or their exact selected API-key variable.
if (!copiedProvider && !auth) {
  const variables: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY', deepseek: 'DEEPSEEK_API_KEY', xai: 'XAI_API_KEY', groq: 'GROQ_API_KEY', mistral: 'MISTRAL_API_KEY' };
  const key = variables[provider];
  if (!key || !originalEnv[key]) throw new Error(`Selected provider needs auth.json, custom models.json credentials, or a supported selected API-key variable (root retained: ${root})`);
  process.env[key] = originalEnv[key]; secrets.add(originalEnv[key]!);
}
const ledgerPath = join(overload, 'ledger.db'), controlPath = join(overload, 'orchestrator-answers.db'), orchestratorPath = join(overload, 'orchestrator.db');
Object.assign(process.env, { OVERLOAD_LEDGER_PATH: ledgerPath, OVERLOAD_ANSWERS_PATH: controlPath, OVERLOAD_ORCHESTRATOR_PATH: orchestratorPath, OVERLOAD_SPOOL_ROOT: overload });
const [{ PiRuntime }, { AdapterService }, { startWebServer }, { initializeLedger, scanOnce }, { openMailbox, expireActiveTargets, reconcileEffectEvents }, broker] = await Promise.all([
  import('../../src/adapters/pi'), import('../../src/adapters/service'), import('../../src/web/server'), import('../../src/ingest/ingest'), import('../../src/decision-bot/mailbox'), import('../../src/adapters/pi-broker'),
]);
const db = openMailbox(controlPath), ledger = new Database(ledgerPath);
initializeLedger(ledger);
const scope = randomUUID(), instanceId = `browser-${scope}`, tenantId = 'local-browser', actor = 'local-e2e-operator';
const identity = { instanceId, tenantId, userId: actor };
function sanitized<T>(value: T): T {
  let text = JSON.stringify(value);
  for (const secret of secrets) if (secret.length > 3) text = text.replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]');
  return JSON.parse(text);
}
type Projection = { messageId: string; version: number; message: ChannelMessage; history: { at: number; message: ChannelMessage }[] };
const channelOperations = new Set<Promise<void>>();
class BrowserChannel implements ChannelAdapter {
  readonly kind = 'browser-e2e'; readonly instanceId = instanceId; readonly capabilities = { update: true, actions: true };
  messages: Projection[] = []; private accept: ((event: ChannelEvent) => Promise<void>) | null = null;
  async start(accept: (event: ChannelEvent) => Promise<void>) { this.accept = accept; }
  async stop() { this.accept = null; }
  async inject(event: ChannelEvent) {
    if (!this.accept) throw new Error('browser_channel_stopped');
    const operation = this.accept(event);
    channelOperations.add(operation);
    try { await operation; } finally { channelOperations.delete(operation); }
  }
  async send(message: ChannelMessage) {
    const previous = message.replaceMessageId ? this.messages.find(m => m.messageId === message.replaceMessageId) : undefined;
    if (message.replaceMessageId && !previous) return { state: 'failed' as const, reason: 'browser_message_not_found' };
    const copy = structuredClone(message), at = Date.now();
    if (previous) { previous.version++; previous.message = copy; previous.history.push({ at, message: copy }); return { state: 'sent' as const, messageId: previous.messageId }; }
    const messageId = `browser-message-${randomUUID()}`;
    this.messages.push({ messageId, version: 1, message: copy, history: [{ at, message: copy }] });
    return { state: 'sent' as const, messageId };
  }
}
const channel = new BrowserChannel(), runtime = new PiRuntime({
  runtimeRoot,
  command: piCommand,
  async spawnBroker(config) {
    // Bun can inherit its original native environment when env is omitted,
    // even after process.env changes. Pin every broker to the private HOME.
    const configDir = join(runtimeRoot, 'config');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configPath = join(configDir, `${config.sessionId}-${randomUUID()}.json`);
    privateJson(configPath, config);
    const child = Bun.spawn([process.execPath, 'run', join(import.meta.dir, '../../src/adapters/pi-broker.ts'), '--pi-broker-file', configPath], {
      cwd: config.cwd, env: { ...process.env }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true,
    });
    child.unref();
  },
});
const dashboard = startWebServer({ ledgerPath, controlPath, orchestratorPath, spoolRoot: overload, port: 0, actor });
const dashboardUrl = `http://127.0.0.1:${dashboard.port}`;
type Kind = 'approve' | 'deny' | 'expire';
type Scenario = { id: string; kind: Kind; prompt: string; markerPath: string; expectedContent: string; address: ChannelAddress; configPath: string };
type Action = { eventId: string; messageId: string; itemId: string; revision: Json | undefined; answer: string; status: number; error: string | null; at: number };
const scenarios: Scenario[] = [], actions: Action[] = [];
let error: string | null = null, stopping = false, pending: Promise<void> = Promise.resolve();
const service = new AdapterService(db, {
  runtime, channels: [channel], cwd: repo, provider, model,
  authorize: (i, a) => i.instanceId === instanceId && i.tenantId === tenantId && i.userId === actor && a.instanceId === instanceId && a.tenantId === tenantId && scenarios.some(s => s.address.chatId === a.chatId && s.address.rootMessageId === a.rootMessageId) ? actor : null,
  runtimeConfig: c => { const a = JSON.parse(c.address); const s = scenarios.find(s => s.address.chatId === a.chatId && s.address.rootMessageId === a.rootMessageId); if (!s) throw new Error('scenario_runtime_policy_missing'); return { configPath: s.configPath, requiredApprovalGate: true, approvalRoot: repo }; },
});
await service.start();
const references = new Map<string, SessionReference>();
function conversation(s: Scenario): Conversation | null {
  // Schema-owned rows from ensureAdapterSchema; Bun SQLite cannot infer result types.
  return db.query('SELECT * FROM conversations WHERE binding_key=?').get(JSON.stringify([instanceId, tenantId, s.address.chatId, s.address.rootMessageId])) as Conversation | null;
}
function snapshot() {
  return { ...sanitized({ scope, root, dashboardUrl, error, scenarios: scenarios.map(s => {
    const c = conversation(s), ref: SessionReference | null = c?.session_reference ? JSON.parse(c.session_reference) : null;
    if (ref) references.set(ref.sessionId, ref);
    // SQLite's query API cannot infer a selected row shape; these columns are production schema-owned.
    const t = c ? db.query('SELECT * FROM conversation_turns WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1').get(c.id) as StoredTurn | null : null;
    const meta = ref ? broker.readBrokerMetadata(broker.brokerMetadataPath(runtimeRoot, ref.sessionId)) : null;
    const items = (ref ? db.query("SELECT a.item_id,a.revision,a.state,a.effect_state,p.expires_at FROM control_attention a JOIN approval_targets p ON p.consumer_owner=a.consumer_owner AND p.approval_id=a.approval_id WHERE json_extract(p.evidence,'$.session_id')=?").all(ref.sessionId) : []) as { item_id: string; revision: number; state: string; effect_state: string; expires_at: number | null }[];
    const receipts = (ref ? db.query("SELECT r.receipt_id,r.answer,r.actor,r.outcome,r.consumed_at,r.applied_at FROM decision_receipts r JOIN approval_targets p ON p.consumer_owner=r.consumer_owner AND p.approval_id=r.approval_id WHERE json_extract(p.evidence,'$.session_id')=?").all(ref.sessionId) : []) as { receipt_id: string; answer: string; actor: string; outcome: string | null; consumed_at: number; applied_at: number | null }[];
    const exists = existsSync(s.markerPath), content = exists ? readFileSync(s.markerPath, 'utf8') : null;
    return { id: s.id, kind: s.kind, prompt: s.prompt, markerPath: s.markerPath, expectedContent: s.expectedContent, conversationId: c?.id ?? null, turnId: t?.id ?? null, turnState: t?.state ?? null, turnOutput: t?.output ?? t?.reason ?? null, marker: { exists, content, sha256: content === null ? null : createHash('sha256').update(content).digest('hex') }, attention: items.map(a => ({ itemId: a.item_id, revision: a.revision, state: a.state, effectState: a.effect_state, expiresAt: a.expires_at })), receipts: receipts.map(r => ({ receiptId: r.receipt_id, answer: r.answer, actor: r.actor, outcome: r.outcome, consumedAt: r.consumed_at, appliedAt: r.applied_at })), runtime: meta ? { sessionId: meta.sessionId, state: meta.state, requiredApprovalGate: meta.requiredApprovalGate === true, configPath: meta.configPath ?? null, approvalRoot: meta.approvalRoot ?? null, brokerPid: meta.brokerIdentity?.pid ?? meta.pid, childPid: meta.childIdentity?.pid ?? null } : null };
  }), messages: channel.messages, actions }), provider, model };
}
async function tick() {
  await scanOnce(ledger, join(overload, 'spool'));
  expireActiveTargets(db, Date.now()); // Production target expiration; do not forge attention/card terminal states.
  reconcileEffectEvents(db, ledgerPath);
  await service.tick();
  snapshot();
}
let ticking = false;
const interval = setInterval(() => {
  if (stopping || ticking) return;
  ticking = true;
  pending = tick().catch(e => { error = String(e instanceof Error ? e.message : e); }).finally(() => { ticking = false; });
}, 500);
function forbidden(request: Request, actualPort: number): boolean {
  if (request.headers.get('host') !== `127.0.0.1:${actualPort}`) return true;
  if (request.method === 'GET') return false;
  const origin = request.headers.get('origin');
  return origin ? origin !== `http://127.0.0.1:${actualPort}` : request.headers.get('sec-fetch-site') !== 'same-origin';
}
const ui = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request, server) {
  if (forbidden(request, server.port!)) return Response.json({ error: 'forbidden_origin' }, { status: 403 });
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/') return new Response(Bun.file(join(import.meta.dir, 'browser-e2e.html')), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (request.method === 'GET' && url.pathname === '/api/e2e/state') return Response.json(snapshot(), { headers: { 'Cache-Control': 'no-store' } });
  if (stopping) return Response.json({ error: 'shutting_down' }, { status: 503 });
  let body: JsonObject;
  try { const parsed: unknown = await request.json(); if (!object(parsed)) throw new Error('invalid_json'); body = parsed; } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
  if (request.method === 'POST' && url.pathname === '/api/e2e/scenarios') {
    if (typeof body.kind !== 'string' || !['approve', 'deny', 'expire'].includes(body.kind)) return Response.json({ error: 'invalid_kind' }, { status: 400 });
    const id = randomUUID(), markerPath = join(repo, `${body.kind}-${id}.txt`), expectedContent = `OVERLOAD_BROWSER_E2E_${body.kind.toUpperCase()}_${id}\n`;
    const configPath = join(root, `gate-${id}.json`);
    privateJson(configPath, { web_port: dashboard.port, approval_gate: { enabled: true, block_bash_patterns: ['.*'], require_approval_bash_patterns: [], block_write_paths: [], require_approval_write_paths: [repo], allowed_write_roots: [repo], timeout_ms: body.kind === 'expire' ? 20000 : 180000 } });
    const prompt = `Browser-channel real runtime acceptance case ${id}. Invoke the write tool exactly once to create ${markerPath} with exactly this string (JSON encoding): ${JSON.stringify(expectedContent)}. The write requires human approval. Wait for its actual result. If denied, expired, or blocked, stop without retrying, editing, bash, alternate paths, or any workaround. Then report the actual tool outcome honestly. Do not ask an additional question or claim success before the tool result.`;
    const s: Scenario = { id, kind: body.kind as Kind, prompt, markerPath, expectedContent, configPath, address: { instanceId, tenantId, chatId: `case-${id}`, rootMessageId: `browser-root-${id}` } };
    scenarios.push(s);
    try { await channel.inject({ eventId: randomUUID(), identity, address: s.address, messageId: s.address.rootMessageId!, receivedAt: Date.now(), kind: 'message', text: prompt }); return Response.json({ id }); }
    catch (e) { error = String(e instanceof Error ? e.message : e); return Response.json({ id, error: sanitized(error) }, { status: 409 }); }
  }
  if (request.method === 'POST' && url.pathname === '/api/e2e/decision') {
    const eventId = randomUUID(), at = Date.now();
    const message = channel.messages.find(m => m.messageId === body?.messageId);
    const action = { eventId, messageId: String(body?.messageId ?? ''), itemId: String(body?.itemId ?? ''), revision: body?.revision, answer: String(body?.answer ?? ''), status: 409, error: null as string | null, at };
    actions.push(action);
    try {
      if (!message || typeof body.messageId !== 'string' || typeof body.itemId !== 'string' || typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || typeof body.answer !== 'string') throw new Error('invalid_decision_packet');
      await channel.inject({ eventId, identity, address: message.message.address, messageId: body.messageId, receivedAt: at, kind: 'decision', itemId: body.itemId, revision: body.revision, answer: body.answer });
      action.status = 200; return Response.json({ ok: true, eventId });
    } catch (e) { action.error = String(e instanceof Error ? e.message : e); return Response.json(sanitized({ ok: false, eventId, error: action.error }), { status: 409 }); }
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
} });
console.log(JSON.stringify({ root, browserUrl: `http://127.0.0.1:${ui.port}`, dashboardUrl, provider, model }));
let shutdownPromise: Promise<void> | undefined;
async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    stopping = true; clearInterval(interval); await pending;
    await Promise.allSettled([...channelOperations]);
    snapshot();
    // Failed startup can persist an owned child before AdapterService binds a conversation.
    const metadataDir = join(runtimeRoot, 'metadata');
    if (existsSync(metadataDir)) for (const name of readdirSync(metadataDir)) {
      if (!name.endsWith('.json')) continue;
      const metadata = broker.readBrokerMetadata(join(metadataDir, name));
      if (metadata) references.set(metadata.sessionId, { runtimeKind: 'pi', sessionId: metadata.sessionId, ownerId: metadata.ownerId, cwd: metadata.cwd });
    }
    const identities = [...references.values()].map(ref => ({ ref, metadata: broker.readBrokerMetadata(broker.brokerMetadataPath(runtimeRoot, ref.sessionId)) }));
    const shutdowns = [];
    for (const { ref, metadata } of identities) {
      let result: unknown; try { result = await runtime.shutdown(ref); } catch (e) { result = { error: String(e instanceof Error ? e.message : e) }; }
      const child = metadata?.childIdentity, parent = metadata?.brokerIdentity;
      const liveness = (identity: typeof child) => identity ? broker.processLiveness(identity.pid, identity.startIdentity, identity.bootIdentity) : 'unknown';
      let childState = liveness(child), brokerState = liveness(parent);
      for (let i = 0; i < 50 && (childState === 'alive' || brokerState === 'alive'); i++) { await Bun.sleep(100); childState = liveness(child); brokerState = liveness(parent); }
      shutdowns.push({ sessionId: ref.sessionId, result, childIdentity: child ?? null, brokerIdentity: parent ?? null, childState, brokerState });
    }
    await service.stop(); await scanOnce(ledger, join(overload, 'spool')); reconcileEffectEvents(db, ledgerPath);
    const safe = shutdowns.every(s => s.childState === 'dead' && s.brokerState === 'dead');
    if (!safe) error = 'Shutdown identity not proven dead; copied credentials retained privately.';
    if (safe) for (const name of ['auth.json', 'models.json']) { const path = join(agent, name); if (existsSync(path)) unlinkSync(path); }
    privateJson(join(root, 'evidence.json'), sanitized({ ...snapshot(), shutdown: shutdowns, credentialsRemoved: safe, savedAt: Date.now() }));
    await ui.stop(true); await dashboard.stop(true); ledger.close(); db.close();
    console.log(JSON.stringify({ root, evidence: join(root, 'evidence.json'), credentialsRemoved: safe, error }));
    if (!safe) process.exitCode = 1;
  })();
  return shutdownPromise;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown().catch(e => { console.error('Shutdown failed; private credentials retained:', sanitized(String(e))); process.exitCode = 1; }); });
