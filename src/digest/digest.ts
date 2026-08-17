#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configRefocusCostMin, DEFAULT_REFOCUS_COST_MIN, formatAttention, queryAttention } from "../shared/queries";

export type DigestOptions = {
  outputDir?: string;
  now?: Date;
  llm?: "pi";
  model?: string;
  refocusCostMin?: number;
  /** Test-only crash seam immediately after the complete tmp file is written. */
  beforeRename?: () => void;
};

type Item = {
  stable_id: string;
  queue: "q5" | "q2" | "q4";
  q5_reason: string | null;
  last_event_at: number;
  host: string | null;
  summary: string;
  binding: string | null;
  commits: Array<{ sha: string; repo: string }>;
};

function parsed(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try { const result = JSON.parse(value); return result && typeof result === "object" && !Array.isArray(result) ? result : {}; }
  catch { return {}; }
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function oneLine(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function stamp(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}`;
}
function escapeMarkdown(value: string): string { return value.replace(/([\\`*_{}\[\]<>])/g, "\\$1"); }

async function compressWithPi(raw: string, model: string): Promise<string> {
  try {
    const process = Bun.spawn(["pi", "-p", "--no-session", "--no-tools", "--model", model,
      `Compress this ledger-derived session summary to one factual line. Do not add facts:\n${raw}`],
      // Review P4 M1: a hung provider must not block digest generation —
      // bounded per-item timeout keeps the fail-open-to-raw promise real.
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
    const output = oneLine(await new Response(process.stdout).text());
    return await process.exited === 0 && output ? output : raw;
  } catch { return raw; }
}

function readItems(db: Database): Item[] {
  const rows = db.query(`SELECT c.stable_id, c.queue, c.q5_reason, c.last_event_at, s.host,
    (SELECT detail FROM journal j WHERE j.stable_id=c.stable_id AND j.kind='settled' ORDER BY j.ingest_seq DESC LIMIT 1) settled_detail,
    (SELECT binding FROM attachments a WHERE a.stable_id=c.stable_id AND a.valid=1 ORDER BY a.observed_at DESC LIMIT 1) binding
    FROM current c LEFT JOIN sessions s ON s.stable_id=c.stable_id
    WHERE c.queue IN ('q5','q2','q4')
    ORDER BY CASE c.queue WHEN 'q5' THEN 0 WHEN 'q2' THEN 1 ELSE 2 END,
      c.last_event_at DESC, c.stable_id LIMIT 50`).all() as Array<Omit<Item, "summary" | "commits"> & { settled_detail: string | null }>;
  return rows.map((row) => {
    const detail = parsed(row.settled_detail);
    const summary = oneLine(text(detail.text) ?? text(detail.summary) ?? "No settled summary recorded.");
    const commits = (db.query("SELECT detail FROM journal WHERE stable_id=? AND kind='commit_observed' ORDER BY ingest_seq")
      .all(row.stable_id) as Array<{ detail: string | null }>).flatMap(({ detail: raw }) => {
        const value = parsed(raw), sha = text(value.sha), repo = text(value.repo);
        return sha && repo ? [{ sha, repo }] : [];
      });
    return { ...row, summary, commits };
  });
}

function healthLine(db: Database): string {
  const failed = (db.query("SELECT count(*) n FROM notifications WHERE state='failed_permanent'").get() as { n: number }).n;
  const incidents = (db.query("SELECT count(*) n FROM incidents WHERE closed_at IS NULL").get() as { n: number }).n;
  const gaps = (db.query("SELECT count(*) n FROM coverage_gaps").get() as { n: number }).n;
  return `failed deliveries=${failed} · open incidents=${incidents} · coverage gaps=${gaps}`;
}

function jump(item: Item): string {
  if (item.binding) return item.binding;
  if (item.host && item.host !== "local") return `ssh ${item.host}`;
  return "-";
}

export async function generateDigest(db: Database, options: DigestOptions = {}): Promise<string> {
  const now = options.now ?? new Date();
  const directory = options.outputDir ?? join(homedir(), "ai", "overload", "digests");
  const destination = join(directory, `${stamp(now)}.md`);
  const temporary = `${destination}.${process.pid}.tmp`;
  mkdirSync(directory, { recursive: true });
  const items = readItems(db);
  if (options.llm === "pi") {
    const model = options.model ?? "glm_anthropic/glm-5.2";
    for (const item of items) item.summary = await compressWithPi(item.summary, model);
  }
  const attention = formatAttention(queryAttention(db, now.getTime(), options.refocusCostMin ?? DEFAULT_REFOCUS_COST_MIN));
  const lines = ["# Overload digest", "", `Generated: ${now.toISOString()}`, `Health: ${healthLine(db)}`, `Attention: ${attention}`, ""];
  for (const item of items) {
    lines.push(`## ${item.queue.toUpperCase()} · ${escapeMarkdown(item.stable_id)}`);
    lines.push(`- Summary: ${escapeMarkdown(item.summary)}`);
    lines.push(`- Jump: ${escapeMarkdown(jump(item))}`);
    if (item.q5_reason) lines.push(`- Reason: ${escapeMarkdown(item.q5_reason)}`);
    lines.push(`- Commits: ${item.commits.length ? item.commits.map((commit) => `${escapeMarkdown(commit.repo)}@${escapeMarkdown(commit.sha)}`).join(", ") : "-"}`, "");
  }
  try {
    writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
    options.beforeRename?.();
    renameSync(temporary, destination);
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
    throw error;
  }
  return destination;
}

function configModel(): string {
  try {
    const config = parsed(readFileSync(join(homedir(), ".overload", "config.json"), "utf8"));
    return text(config.digest_model) ?? "glm_anthropic/glm-5.2";
  } catch { return "glm_anthropic/glm-5.2"; }
}

export async function runDigestOnce(db: Database, llm?: "pi"): Promise<string> {
  return generateDigest(db, { llm, model: configModel(), refocusCostMin: configRefocusCostMin() });
}
