#!/usr/bin/env bun
import { resolve } from "node:path";
import { addTask, getTask, listTasks, openStore, transition, type TaskState, STATES } from "./store";
import { defaultCommandExecutor, gcCandidates } from "./worktree";
import { openAnswersDb } from "./approval";
import { parseSince } from "../cli/audit";
function usage():never{throw new Error('usage: overload orch add "<title>" --repo <path> [--base-ref <ref>] | ls [--state <s>] | show <task_id> | answer <approval_id> <option> | advance <task_id> <event> | abandon <task_id> | reopen <task_id> | gc [--older-than <duration>] [--apply]');}
function option(argv:string[],name:string):string|undefined{const i=argv.indexOf(name);return i<0?undefined:argv[i+1];}
export async function runCli(argv=Bun.argv.slice(2),out=(s:string)=>console.log(s)):Promise<void>{if(argv[0]==="orch")argv=argv.slice(1);const [command,...rest]=argv;if(command==="answer"){if(rest.length!==2)usage();const answers=openAnswersDb(process.env.OVERLOAD_ANSWERS_PATH);try{answers.run("INSERT INTO answers(approval_id,answer,actor,at) VALUES(?,?,?,?)",[rest[0]!,rest[1]!,"cli",Date.now()]);out(JSON.stringify({approval_id:rest[0],answer:rest[1],actor:"cli"}));}finally{answers.close();}return;}const db=openStore();try{
 if(command==="add"){const title=rest[0],repoArg=option(rest,"--repo");if(!title||!repoArg)usage();const repo=resolve(repoArg);const ref=option(rest,"--base-ref")??"HEAD";const resolved=await defaultCommandExecutor("git",["-C",repo,"rev-parse","--verify","--end-of-options",`${ref}^{commit}`]);if(!resolved.ok)throw new Error(`base ref not resolvable: ${ref}`);out(JSON.stringify(addTask(db,title,repo,resolved.stdout.trim())));}
 else if(command==="ls"){const state=option(rest,"--state") as TaskState|undefined;if(state&&!STATES.includes(state))throw new Error(`Invalid state: ${state}`);for(const task of listTasks(db,state))out(`${task.task_id}\t${task.state}\t${task.repo}\t${task.title}`);}
 else if(command==="show"){if(rest.length!==1)usage();const task=getTask(db,rest[0]!);if(!task)throw new Error(`Task not found: ${rest[0]}`);out(JSON.stringify(task,null,2));}
 else if(command==="advance"){if(rest.length!==2)usage();out(JSON.stringify(transition(db,rest[0]!,rest[1]!)));}
 else if(command==="abandon"){if(rest.length!==1)usage();out(JSON.stringify(transition(db,rest[0]!,"human_abandon")));}
 else if(command==="reopen"){if(rest.length!==1)usage();out(JSON.stringify(transition(db,rest[0]!,"human_reopen")));}
 // §3.6: dryRun unless --apply. --older-than spares recently finished worktrees, the same grace the orchestrator's own sweep applies.
 else if(command==="gc"){const olderThan=option(rest,"--older-than");const results=await gcCandidates(db,!rest.includes("--apply"),undefined,undefined,undefined,olderThan?{minAgeMs:parseSince(olderThan,"--older-than")}:{});for(const r of results)out(JSON.stringify(r));}
 else usage();
 }finally{db.close();}}
if(import.meta.main)try{await runCli();}catch(error){console.error((error as Error).message);process.exitCode=1;}
