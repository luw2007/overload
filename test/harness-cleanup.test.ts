import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { processLiveness, readBrokerMetadata, type ProcessIdentity } from '../src/adapters/pi-broker';
import { PiRuntime } from '../src/adapters/pi';

const harness = resolve(import.meta.dir, 'harness/browser-e2e.ts');
const phases = ['credentials', 'import', 'database', 'server', 'before-spawn', 'spawn', 'broker-early-exit', 'after-spawn', 'shutdown-uncertain'] as const;
const syntheticKey = 'cleanup-smoke-synthetic-key-not-a-real-credential';
type Final = { root: string; evidence: string; credentialsRemoved: boolean; error: string | null };
type Shutdown = { sessionId: string; childIdentity: ProcessIdentity | null; brokerIdentity: ProcessIdentity | null; childState: string; brokerState: string };

function jsonLines(text: string): Record<string, unknown>[] {
  return text.split('\n').flatMap(line => {
    try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value] : []; } catch { return []; }
  });
}
function identities(root: string): ProcessIdentity[] {
  const directory = join(root, 'runtime', 'metadata');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap(name => {
    const metadata = readBrokerMetadata(join(directory, name));
    return metadata ? [metadata.childIdentity, metadata.brokerIdentity].filter((id): id is ProcessIdentity => !!id) : [];
  });
}
function liveness(id: ProcessIdentity) { return processLiveness(id.pid, id.startIdentity, id.bootIdentity); }
// Real subprocess/OS identity transitions cannot use fake timers; these bounded
// polls wait for observed readiness and death, never a guessed settling delay.
async function until(predicate: () => boolean, timeout: number, description: string) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(50); }
  throw new Error(`Timed out waiting for ${description}`);
}

async function smoke(phase?: typeof phases[number]) {
  if (!Bun.which('pi')) throw new Error('Harness cleanup smoke requires actual pi on PATH');
  const fixture = mkdtempSync(join(tmpdir(), 'overload-cleanup-fixture-'));
  const agent = join(fixture, 'agent'); mkdirSync(agent);
  writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'cleanup-smoke': {
    baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', apiKey: syntheticKey,
    models: [{ id: 'cleanup-smoke', name: 'Cleanup smoke', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
  } } }), { mode: 0o600 });
  writeFileSync(join(agent, 'auth.json'), JSON.stringify({ 'cleanup-smoke': { type: 'api_key', key: syntheticKey } }), { mode: 0o600 });
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent };
  delete env.OVERLOAD_BROWSER_E2E_FAIL_AT;
  delete env.OVERLOAD_BROWSER_E2E_SMOKE_START;
  if (phase) env.OVERLOAD_BROWSER_E2E_FAIL_AT = phase;
  else env.OVERLOAD_BROWSER_E2E_SMOKE_START = '1';
  const proc = Bun.spawn([process.execPath, harness, '--provider', 'cleanup-smoke', '--model', 'cleanup-smoke'], {
    env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  let stdout = '', stderr = '';
  const drain = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) append(decoder.decode(bytes, { stream: true }));
    append(decoder.decode());
  };
  const output = Promise.all([drain(proc.stdout, text => { stdout += text; }), drain(proc.stderr, text => { stderr += text; })]);
  let root: string | undefined;
  const discoverRoot = () => {
    root ??= jsonLines(stdout).find(row => typeof row.root === 'string')?.root as string | undefined;
    return root;
  };
  try {
    if (!phase) {
      await until(() => {
        discoverRoot();
        return !!root && jsonLines(stdout).some(row => typeof row.browserUrl === 'string') && identities(root).length === 2;
      }, 30_000, 'interactive server and real child');
      for (const id of identities(root!)) expect(liveness(id)).toBe('alive');
      proc.kill('SIGTERM');
    }
    let code: number | undefined;
    void proc.exited.then(value => { code = value; });
    await until(() => code !== undefined, 40_000, `harness exit (${phase ?? 'SIGTERM'})`);
    await output;
    const final = jsonLines(stdout).findLast(row => typeof row.evidence === 'string') as Final | undefined;
    expect(final, `stdout=${stdout}\nstderr=${stderr}`).toBeDefined();
    root = final!.root;
    expect(code, stderr).toBe(phase ? 1 : 0);
    const uncertain = phase === 'shutdown-uncertain';
    expect(final!.credentialsRemoved).toBe(!uncertain);
    if (uncertain) expect(final!.error).toContain('retained');
    else if (phase) expect(final!.error).toContain(`Injected startup failure: ${phase}`);
    else expect(final!.error).toBeNull();
    expect(final!.evidence).toBe(join(root, 'evidence.json'));
    const evidence = JSON.parse(readFileSync(final!.evidence, 'utf8'));
    expect(evidence.credentialsRemoved).toBe(!uncertain);
    if (uncertain) expect(JSON.stringify(evidence)).toContain('Injected shutdown uncertainty');
    expect(existsSync(join(root, 'home', '.pi', 'agent', 'models.json'))).toBe(uncertain);
    expect(existsSync(join(root, 'home', '.pi', 'agent', 'auth.json'))).toBe(uncertain);
    const configDir = join(root, 'runtime', 'config');
    if (existsSync(configDir)) expect(readdirSync(configDir).filter(name => name.endsWith('.json'))).toHaveLength(0);
    const metadataDir = join(root, 'runtime', 'metadata');
    if (!uncertain && existsSync(metadataDir)) expect(readdirSync(metadataDir).filter(name => name.endsWith('.json') || name.endsWith('.lock'))).toHaveLength(0);
    expect(stdout + stderr + JSON.stringify(evidence)).not.toContain(syntheticKey);
    const shutdown: Shutdown[] = evidence.shutdown;
    expect(Array.isArray(shutdown)).toBe(true);
    if (phase === 'after-spawn' || uncertain || !phase) {
      const session = shutdown.find(row => row.sessionId === 'cleanup-smoke');
      expect(session).toBeDefined();
      expect(session!.childIdentity).not.toBeNull();
      expect(session!.brokerIdentity).not.toBeNull();
      expect(session!.childState).toBe(uncertain ? 'alive' : 'dead');
      expect(session!.brokerState).toBe(uncertain ? 'alive' : 'dead');
      for (const id of [session!.childIdentity!, session!.brokerIdentity!]) expect(liveness(id)).toBe(uncertain ? 'alive' : 'dead');
      console.log(JSON.stringify({ cleanupSmoke: phase ?? 'SIGTERM', root, evidence: final!.evidence, shutdown }));
    } else if (phase === 'broker-early-exit') {
      expect(shutdown).toHaveLength(1);
      expect(shutdown[0].childIdentity).toBeNull();
      expect(shutdown[0].brokerIdentity).toBeNull();
      expect(shutdown[0].childState).toBe('dead');
      expect(shutdown[0].brokerState).toBe('dead');
    } else expect(shutdown).toHaveLength(0);
  } finally {
    // Signal only the subprocess handle we own. Runtime processes are stopped
    // through their authenticated broker protocol, never a numeric PID signal.
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await Promise.race([proc.exited, Bun.sleep(10_000)]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    await proc.exited;
    await output;
    discoverRoot();
    const failures: string[] = [];
    if (root) {
      const runtimeRoot = join(root, 'runtime');
      const metadataDir = join(runtimeRoot, 'metadata');
      const runtime = new PiRuntime({ runtimeRoot, commandTimeoutMs: 5_000 });
      const metadataSessions = new Set<string>();
      if (existsSync(metadataDir)) for (const name of readdirSync(metadataDir).filter(name => name.endsWith('.json'))) {
        const metadata = readBrokerMetadata(join(metadataDir, name));
        if (metadata) metadataSessions.add(metadata.sessionId);
        if (!metadata || !metadata.childIdentity || !metadata.brokerIdentity) {
          failures.push(`Unconfirmed runtime metadata: ${name}`);
          continue;
        }
        try {
          const receipt = await runtime.shutdown({ runtimeKind: 'pi', sessionId: metadata.sessionId, ownerId: metadata.ownerId, cwd: metadata.cwd });
          if (receipt.state !== 'accepted') failures.push(`Shutdown unconfirmed: ${metadata.sessionId}`);
          await until(() => [metadata.childIdentity!, metadata.brokerIdentity!].every(id => liveness(id) === 'dead'), 5_000, `runtime death (${metadata.sessionId})`);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (identities(root).some(id => liveness(id) !== 'dead')) failures.push('Owned runtime identity is alive or unknown');
      if (existsSync(metadataDir)) for (const name of readdirSync(metadataDir).filter(name => name.endsWith('.lock'))) {
        try {
          const lock = JSON.parse(readFileSync(join(metadataDir, name), 'utf8')) as ProcessIdentity;
          if (liveness(lock) !== 'dead') failures.push(`Runtime lock identity is alive or unknown: ${name}`);
        } catch { failures.push(`Unconfirmed runtime lock: ${name}`); }
      }
      const finalizerIdentities = identities(root);
      const configDir = join(runtimeRoot, 'config');
      if (existsSync(configDir)) for (const name of readdirSync(configDir).filter(name => name.endsWith('.json'))) {
        try {
          const config = JSON.parse(readFileSync(join(configDir, name), 'utf8')) as { sessionId?: string };
          if (!config.sessionId || !metadataSessions.has(config.sessionId)) failures.push(`Orphan broker handoff has no proven process identity: ${name}`);
        } catch { failures.push(`Unconfirmed broker handoff: ${name}`); }
      }
      if (!failures.length) {
        // Preserve non-secret evidence; metadata and handoffs contain tokens.
        // Remove those only after every owned process and lock holder is dead.
        for (const name of ['models.json', 'auth.json']) rmSync(join(root, 'home', '.pi', 'agent', name), { force: true });
        if (existsSync(configDir)) for (const name of readdirSync(configDir)) {
          if (name.endsWith('.json')) rmSync(join(configDir, name), { force: true });
        }
        if (existsSync(metadataDir)) for (const name of readdirSync(metadataDir)) {
          if (name.endsWith('.json') || name.endsWith('.lock')) rmSync(join(metadataDir, name), { force: true });
        }
      }
      console.log(JSON.stringify({ cleanupSmoke: phase ?? 'SIGTERM', root, finalizerIdentities, finalizerState: failures.length ? 'unconfirmed' : 'dead', failures }));
    }
    if (failures.length) throw new Error(`Cleanup unconfirmed; private credentials and evidence retained at ${root}: ${failures.join('; ')}`);
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe('browser harness private startup cleanup', () => {
  for (const phase of phases) test(`cleans injected ${phase} failure`, () => smoke(phase), 90_000);
  test('SIGTERM stops interactive harness and real no-prompt child', () => smoke(), 90_000);
});
