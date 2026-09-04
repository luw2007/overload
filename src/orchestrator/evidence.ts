import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandExecutor } from "./worktree";

export type Evidence = { diff:string; commits:string; status:string; checksExitCode:number|null; checksOutput:string; runnerLogTail:string };

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
  const runnerPath=join(dir,"runner.log");const prior=existsSync(runnerPath)?readFileSync(runnerPath,"utf8"):"";
  const runnerLogTail=prior.slice(-64*1024);
  const evidence:Evidence={diff:diff.stdout,commits:commits.stdout,status:status.stdout,checksExitCode:checked===null?null:(checked.ok?0:1),checksOutput:checked===null?"":`${checked.stdout}${checked.stderr}`,runnerLogTail};
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
