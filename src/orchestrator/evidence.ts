import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandExecutor } from "./worktree";

export type StructuredCheckItem = {
  check_id: string;
  status: "pass" | "fail" | "unknown" | "not_run";
  fingerprint: string | null;
  check_def_version: string;
};

export type StructuredCheckResult = {
  items: StructuredCheckItem[];
  raw: string;
};

export type Evidence = { diff:string; commits:string; status:string; checksExitCode:number|null; checksOutput:string; runnerLogTail:string; structured_checks?: StructuredCheckItem[] | null };

const CHECK_STATUS_WHITELIST = new Set(["pass", "fail", "unknown", "not_run"] as const);

function normalizeItem(raw: unknown): StructuredCheckItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return null;
  const rawStatus = typeof obj.status === "string" ? obj.status : "";
  const status = (CHECK_STATUS_WHITELIST as ReadonlySet<string>).has(rawStatus)
    ? (rawStatus as StructuredCheckItem["status"])
    : "unknown";
  const fingerprint = typeof obj.fingerprint === "string" ? obj.fingerprint : null;
  const check_def_version = typeof obj.check_def_version === "string" && obj.check_def_version.length > 0
    ? obj.check_def_version
    : "unknown";
  return { check_id: obj.id, status, fingerprint, check_def_version };
}

// 解析 orchestrator.check 的机器可读输出。
// 约定格式：输出中包含一行或多行 JSON，每行一个检查项对象，字段为 id/status/fingerprint/check_def_version。
// 也支持整个输出是一个 JSON 数组 [{id,status,fingerprint,check_def_version}, ...]。
// 解析成功返回 items 数组；输出中没有可识别的结构化 JSON 时返回 null。
// status 不在白名单内的项标记为 "unknown"。
// 缺少 check_def_version 时用 "unknown"。
// fingerprint 缺失或非字符串时为 null。
export function parseStructuredCheckOutput(output: string): StructuredCheckItem[] | null {
  const trimmed = output.trim();
  if (trimmed.length === 0) return null;

  // 1. 尝试整个输出是一个 JSON 数组
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const items = parsed.map(normalizeItem).filter((x): x is StructuredCheckItem => x !== null);
      if (items.length > 0) return items;
    }
  } catch {
    // fall through to line-based parsing
  }

  // 2. 逐行尝试 JSON.parse，收集所有含 id 字段的对象
  const items: StructuredCheckItem[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const item = normalizeItem(parsed);
    if (item !== null) items.push(item);
  }
  return items.length > 0 ? items : null;
}

export async function collectEvidence(worktreeDir:string,taskId:string,baseRef:string,executor:CommandExecutor,artifactsRoot=join(homedir(),".overload","artifacts")):Promise<Evidence>{
  const [diff,commits,status]=await Promise.all([
    executor("git",["diff",`${baseRef}...HEAD`],{cwd:worktreeDir}),
    executor("git",["log","--oneline",`${baseRef}..HEAD`],{cwd:worktreeDir}),
    executor("git",["status","--porcelain"],{cwd:worktreeDir}),
  ]);
  const check=join(worktreeDir,"orchestrator.check");
  // Only a missing path means no check. A present but non-executable/broken check is
  // still attempted so the executor's spawn error is preserved as failed evidence.
  const checked=existsSync(check)?await executor(check,[],{cwd:worktreeDir}):null;
  const dir=join(artifactsRoot,taskId);mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
  const attemptLogs=readdirSync(dir,{withFileTypes:true}).filter(entry=>entry.isFile()&&/^runner-[^.]+\.log$/.test(entry.name)).map(entry=>join(dir,entry.name)).sort();
  const runnerPath=attemptLogs.at(-1)??join(dir,"runner.log");
  const prior=existsSync(runnerPath)?readFileSync(runnerPath,"utf8"):"";
  const runnerLogTail=prior.slice(-64*1024);
  const checksOutput=checked===null?"":`${checked.stdout}${checked.stderr}`;
  const structured_checks=checked===null?null:parseStructuredCheckOutput(checksOutput);
  const evidence:Evidence={diff:diff.stdout,commits:commits.stdout,status:status.stdout,checksExitCode:checked===null?null:(checked.ok?0:1),checksOutput,runnerLogTail,structured_checks};
  for(const [name,value] of [["diff.patch",evidence.diff],["commits.txt",evidence.commits],["status.txt",evidence.status],["checks.txt",evidence.checksOutput],["runner.log",evidence.runnerLogTail]] as const)writeFileSync(join(dir,name),value,{mode:0o600});
  return evidence;
}

export function evidenceReady(e:Evidence):{ready:boolean;reason?:string}{
  if(!e.diff.trim()||!e.commits.trim())return {ready:false,reason:"no_changes"};
  if(e.status.trim())return {ready:false,reason:"dirty_worktree"};
  if(e.checksExitCode===null)return {ready:false,reason:"no_check"};
  if(e.checksExitCode!==0)return {ready:false,reason:"checks_failed"};
  return {ready:true};
}
