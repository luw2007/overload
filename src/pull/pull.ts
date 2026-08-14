#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ENVELOPE_VERSION, type EventEnvelope } from "../shared/types";

const DEFAULT_TIMEOUT_MS = 55_000;
const TRANSFERRED_FILE = /(?:^|\/)(?:seg|active)-[^/]+-\d+(?:-recovered)?\.ndjson$/;

export type PullConfig = {
  remote: string;
  remote_spool: string;
  dest: string;
  ssh_cmd: string;
  rsync_cmd: string;
  fail_threshold: number;
  timeout_ms: number;
  ledger: string;
  admin_spool: string;
  heartbeat: string;
  state: string;
  lock: string;
};

export type PullSummary = { files: number; bytes: number; failures: number; success: boolean };
type PullState = { failures: number; outage_reported: boolean };

export class Puller {
  private readonly emitterId = `overload-pull-${process.pid}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  private seq = 0;

  constructor(private readonly config: PullConfig) {}

  async runOnce(): Promise<PullSummary> {
    const state = await this.loadState();
    try {
      const deadline = Date.now() + this.config.timeout_ms;
      await secureDirectory(this.config.dest);
      await runCommand(commandWords(this.config.ssh_cmd), [
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", this.config.remote, "true",
      ], remainingTimeout(deadline));
      const source = this.config.remote === "local"
        ? `${this.config.remote_spool.replace(/\/$/, "")}/`
        : `${this.config.remote}:${this.config.remote_spool.replace(/\/$/, "")}/`;
      const output = await runCommand(commandWords(this.config.rsync_cmd), [
        "-a", "--out-format=%n|%l", "--include=*/", "--include=seg-*.ndjson",
        // Review P3 M1: "--" terminates option parsing so leading-dash
        // remote/dest config values cannot inject rsync options.
        "--include=active-*.ndjson", "--exclude=*", "--", source, `${this.config.dest.replace(/\/$/, "")}/`,
      ], remainingTimeout(deadline));
      const transferred = parseTransferOutput(output);
      const openOutage = state.outage_reported || this.sourceOutageOpen();
      state.failures = 0;
      state.outage_reported = false;
      if (openOutage) await this.emit("source_recovered");
      await touchSecure(this.config.heartbeat);
      await this.saveState(state);
      return { ...transferred, failures: 0, success: true };
    } catch {
      state.failures++;
      if (state.failures >= this.config.fail_threshold && !state.outage_reported && !this.sourceOutageOpen()) {
        await this.emit("source_outage");
        state.outage_reported = true;
      }
      await this.saveState(state);
      return { files: 0, bytes: 0, failures: state.failures, success: false };
    }
  }

  private sourceOutageOpen(): boolean {
    let db: Database | undefined;
    try {
      db = new Database(this.config.ledger, { readonly: true, create: false });
      const row = db.query(`SELECT kind FROM journal
        WHERE kind IN ('source_outage','source_recovered')
          AND json_extract(detail, '$.source')='devbox'
        ORDER BY ingest_seq DESC LIMIT 1`).get() as { kind: string } | null;
      return row?.kind === "source_outage";
    } catch { return false; }
    finally { db?.close(); }
  }

  private async emit(kind: "source_outage" | "source_recovered"): Promise<void> {
    const envelope: EventEnvelope = {
      v: ENVELOPE_VERSION, at: Date.now(), host: "local", runtime: "overload", session: "admin",
      emitter_id: this.emitterId, writer_id: this.emitterId, seq: ++this.seq, kind,
      dropped_total: 0, write_error_total: 0, detail: { source: "devbox" },
    };
    const directory = join(this.config.admin_spool, this.emitterId);
    await secureDirectory(this.config.admin_spool);
    await secureDirectory(directory);
    const path = join(directory, `active-${this.emitterId}-0.ndjson`);
    const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_APPEND |
      fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.write(`${JSON.stringify(envelope)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await chmod(path, 0o600);
  }

  private async loadState(): Promise<PullState> {
    try {
      const value = JSON.parse(await readFile(this.config.state, "utf8"));
      return {
        failures: Number.isSafeInteger(value.failures) && value.failures >= 0 ? value.failures : 0,
        outage_reported: value.outage_reported === true,
      };
    } catch { return { failures: 0, outage_reported: false }; }
  }

  private async saveState(state: PullState): Promise<void> {
    await secureDirectory(dirname(this.config.state));
    const temporary = `${this.config.state}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.config.state);
  }
}

function commandWords(command: string): string[] {
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("empty command");
  return words;
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new Error("pull timed out");
  return remaining;
}

async function runCommand(command: string[], args: string[], timeoutMs: number): Promise<string> {
  const proc = Bun.spawn([...command, ...args], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
  try {
    const [stdout, stderr, rc] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (timedOut) throw new Error(`command timed out after ${timeoutMs}ms`);
    if (rc !== 0) throw new Error(`${basename(command[0]!)} failed (${rc}): ${stderr.trim()}`);
    return stdout;
  } finally { clearTimeout(timer); }
}

function parseTransferOutput(output: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const line of output.split("\n")) {
    const separator = line.lastIndexOf("|");
    if (separator < 0 || !TRANSFERRED_FILE.test(line.slice(0, separator))) continue;
    const size = Number(line.slice(separator + 1));
    if (!Number.isFinite(size) || size < 0) continue;
    files++;
    bytes += size;
  }
  return { files, bytes };
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe directory: ${path}`);
  await chmod(path, 0o700);
}

async function touchSecure(path: string): Promise<void> {
  await secureDirectory(dirname(path));
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  await handle.close();
  const now = new Date();
  await utimes(path, now, now);
  await chmod(path, 0o600);
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`expected positive integer, got: ${raw}`);
  return value;
}
function rejectLeadingDash(value: string, flag: string): string {
  if (value.startsWith("-")) { console.error(`pull: --${flag} must not start with '-': ${value}`); process.exit(2); }
  return value;
}


export async function loadConfig(args: string[]): Promise<{ config: PullConfig; once: boolean; locked: boolean }> {
  const values = new Map<string, string>();
  let once = false;
  let locked = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--once") { once = true; continue; }
    if (arg === "--locked") { locked = true; continue; }
    if (!arg.startsWith("--") || !args[index + 1]) throw new Error(`invalid argument: ${arg}`);
    values.set(arg.slice(2), args[++index]!);
  }
  const overload = join(homedir(), ".overload");
  return { once, locked, config: {
    remote: rejectLeadingDash(values.get("remote") ?? "devbox", "remote"),
    remote_spool: rejectLeadingDash(values.get("remote-spool") ?? "~/.overload/spool/devbox", "remote-spool"),
    dest: rejectLeadingDash(values.get("dest") ?? join(overload, "spool", "devbox"), "dest"),
    ssh_cmd: values.get("ssh-cmd") ?? "ssh",
    rsync_cmd: values.get("rsync-cmd") ?? "rsync",
    fail_threshold: positiveInteger(values.get("fail-threshold"), 4),
    timeout_ms: positiveInteger(values.get("timeout-ms"), DEFAULT_TIMEOUT_MS),
    ledger: values.get("ledger") ?? join(overload, "ledger.db"),
    admin_spool: values.get("admin-spool") ?? join(overload, "spool", "local"),
    heartbeat: values.get("heartbeat") ?? join(overload, "pull.heartbeat"),
    state: values.get("state") ?? join(overload, "pull-state.json"),
    lock: values.get("lock") ?? join(overload, "pull.lock"),
  } };
}

async function underSingleFlight(config: PullConfig, originalArgs: string[]): Promise<number> {
  await secureDirectory(dirname(config.lock));
  const flock = Bun.which("flock");
  if (flock) {
    const proc = Bun.spawn([flock, "-n", config.lock, Bun.argv[0]!, Bun.argv[1]!, ...originalArgs, "--locked"], {
      stdout: "inherit", stderr: "inherit",
    });
    return proc.exited;
  }
  const fallback = `${config.lock}.d`;
  try { await mkdir(fallback); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return 0; throw error; }
  try { return await execute(config); }
  finally { await import("node:fs/promises").then(({ rmdir }) => rmdir(fallback).catch(() => {})); }
}

async function execute(config: PullConfig): Promise<number> {
  const summary = await new Puller(config).runOnce();
  console.log(`pull files=${summary.files} bytes=${summary.bytes} failures=${summary.failures}`);
  return summary.success ? 0 : 1;
}

async function main(): Promise<void> {
  process.umask(0o077);
  try {
    const loaded = await loadConfig(Bun.argv.slice(2));
    const rc = loaded.locked ? await execute(loaded.config) : await underSingleFlight(loaded.config, Bun.argv.slice(2));
    process.exitCode = rc;
  } catch (error) {
    console.error(`overload pull: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}

if (import.meta.main) await main();
