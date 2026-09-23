import {afterEach,expect,test} from "bun:test";import {chmodSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";import {tmpdir} from "node:os";import {join} from "node:path";import {collectEvidence,evidenceReady,parseStructuredCheckOutput,type Evidence,type StructuredCheckItem} from "./evidence";import {defaultCommandExecutor,type CommandExecutor} from "./worktree";
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
const base:Evidence={diff:"x",commits:"abc message\n",status:"",checksExitCode:0,checksOutput:"ok",runnerLogTail:"",structured_checks:null};
test("evidenceReady rejects no changes",()=>expect(evidenceReady({...base,diff:""})).toEqual({ready:false,reason:"no_changes"}));
test("evidenceReady rejects no commits",()=>expect(evidenceReady({...base,commits:""})).toEqual({ready:false,reason:"no_changes"}));
test("evidenceReady rejects dirty worktree",()=>expect(evidenceReady({...base,status:" M x"})).toEqual({ready:false,reason:"dirty_worktree"}));
test("evidenceReady distinguishes missing check",()=>expect(evidenceReady({...base,checksExitCode:null})).toEqual({ready:false,reason:"no_check"}));
test("evidenceReady rejects failed check",()=>expect(evidenceReady({...base,checksExitCode:1})).toEqual({ready:false,reason:"checks_failed"}));
test("evidenceReady accepts complete evidence collected from real git",async()=>{const root=mkdtempSync(join(tmpdir(),"evidence-"));dirs.push(root);const repo=join(root,"repo"),art=join(root,"art");Bun.spawnSync(["git","init",repo]);Bun.spawnSync(["git","-C",repo,"config","user.email","t@e.st"]);Bun.spawnSync(["git","-C",repo,"config","user.name","T"]);writeFileSync(join(repo,"a"),"a");Bun.spawnSync(["git","-C",repo,"add","."]);Bun.spawnSync(["git","-C",repo,"commit","-m","base"]);const baseRef=Bun.spawnSync(["git","-C",repo,"rev-parse","HEAD"]).stdout.toString().trim();writeFileSync(join(repo,"a"),"b");writeFileSync(join(repo,"orchestrator.check"),"#!/bin/sh\necho checked\n");chmodSync(join(repo,"orchestrator.check"),0o755);Bun.spawnSync(["git","-C",repo,"add","."]);Bun.spawnSync(["git","-C",repo,"commit","-m","change"]);const e=await collectEvidence(repo,"t",baseRef,defaultCommandExecutor,art);expect(evidenceReady(e)).toEqual({ready:true});expect(e.checksOutput).toContain("checked");});

test("collectEvidence reports a present but non-executable check as failed, not absent",async()=>{const root=mkdtempSync(join(tmpdir(),"evidence-nonexec-"));dirs.push(root);const repo=join(root,"repo"),art=join(root,"art");Bun.spawnSync(["git","init",repo]);Bun.spawnSync(["git","-C",repo,"config","user.email","t@e.st"]);Bun.spawnSync(["git","-C",repo,"config","user.name","T"]);writeFileSync(join(repo,"a"),"a");Bun.spawnSync(["git","-C",repo,"add","."]);Bun.spawnSync(["git","-C",repo,"commit","-m","base"]);const baseRef=Bun.spawnSync(["git","-C",repo,"rev-parse","HEAD"]).stdout.toString().trim();writeFileSync(join(repo,"a"),"b");writeFileSync(join(repo,"orchestrator.check"),"#!/bin/sh\necho checked\n");chmodSync(join(repo,"orchestrator.check"),0o644);Bun.spawnSync(["git","-C",repo,"add","."]);Bun.spawnSync(["git","-C",repo,"commit","-m","change"]);const evidence=await collectEvidence(repo,"task",baseRef,defaultCommandExecutor,art);expect(evidence.checksExitCode).toBe(1);expect(evidence.checksOutput).not.toBe("");expect(evidenceReady(evidence)).toEqual({ready:false,reason:"checks_failed"});});

// --- parseStructuredCheckOutput ---

test("parseStructuredCheckOutput parses a JSON array", () => {
  const out = JSON.stringify([
    { id: "lint", status: "pass", fingerprint: null, check_def_version: "v1" },
    { id: "test", status: "fail", fingerprint: "abc", check_def_version: "v2" },
  ]);
  const items = parseStructuredCheckOutput(out);
  expect(items).not.toBeNull();
  expect(items!.length).toBe(2);
  expect(items![0]).toEqual({ check_id: "lint", status: "pass", fingerprint: null, check_def_version: "v1" });
  expect(items![1]).toEqual({ check_id: "test", status: "fail", fingerprint: "abc", check_def_version: "v2" });
});

test("parseStructuredCheckOutput parses line-delimited JSON objects", () => {
  const out = [
    `{"id":"lint","status":"pass","fingerprint":null,"check_def_version":"v1"}`,
    `{"id":"test","status":"fail","fingerprint":"xyz","check_def_version":"v2"}`,
  ].join("\n");
  const items = parseStructuredCheckOutput(out);
  expect(items).not.toBeNull();
  expect(items!.length).toBe(2);
  expect(items![0].check_id).toBe("lint");
  expect(items![1].check_id).toBe("test");
  expect(items![1].fingerprint).toBe("xyz");
});

test("parseStructuredCheckOutput returns null for plain text", () => {
  expect(parseStructuredCheckOutput("all tests passed\n123 passing\n")).toBeNull();
  expect(parseStructuredCheckOutput("")).toBeNull();
  expect(parseStructuredCheckOutput("   \n  \n")).toBeNull();
});

test("parseStructuredCheckOutput mixes text and JSON lines, only parses JSON lines", () => {
  const out = [
    "Running lint...",
    `{"id":"lint","status":"pass","fingerprint":null,"check_def_version":"v1"}`,
    "Done.",
    `{"id":"test","status":"pass","fingerprint":null,"check_def_version":"v1"}`,
  ].join("\n");
  const items = parseStructuredCheckOutput(out);
  expect(items).not.toBeNull();
  expect(items!.length).toBe(2);
  expect(items!.map(i => i.check_id)).toEqual(["lint", "test"]);
});

test("parseStructuredCheckOutput marks unknown status as unknown", () => {
  const out = `{"id":"x","status":"flaky","fingerprint":null,"check_def_version":"v1"}`;
  const items = parseStructuredCheckOutput(out);
  expect(items).not.toBeNull();
  expect(items![0].status).toBe("unknown");
});

test("parseStructuredCheckOutput missing fingerprint becomes null", () => {
  const out = `{"id":"x","status":"pass","check_def_version":"v1"}`;
  const items = parseStructuredCheckOutput(out);
  expect(items![0].fingerprint).toBeNull();
});

test("parseStructuredCheckOutput missing check_def_version becomes unknown", () => {
  const out = `{"id":"x","status":"pass","fingerprint":null}`;
  const items = parseStructuredCheckOutput(out);
  expect(items![0].check_def_version).toBe("unknown");
});

test("parseStructuredCheckOutput ignores JSON without id", () => {
  const out = `{"foo":"bar"}\n{"id":"real","status":"pass","check_def_version":"v1"}`;
  const items = parseStructuredCheckOutput(out);
  expect(items).not.toBeNull();
  expect(items!.length).toBe(1);
  expect(items![0].check_id).toBe("real");
});

// --- collectEvidence integration ---

function mockExecutor(checkedStdout: string, checkedStderr = "", checkOk = true): CommandExecutor {
  return async (cmd, args, opts) => {
    if (cmd === "git") {
      if (args[0] === "diff") return { ok: true, stdout: "diff --git a/a b/a\n", stderr: "" };
      if (args[0] === "log") return { ok: true, stdout: "abc message\n", stderr: "" };
      if (args[0] === "status") return { ok: true, stdout: "", stderr: "" };
    }
    // check script
    return { ok: checkOk, stdout: checkedStdout, stderr: checkedStderr };
  };
}

test("collectEvidence fills structured_checks from structured check output", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-struct-"));
  dirs.push(root);
  const art = join(root, "art");
  const checkOut = JSON.stringify([
    { id: "lint", status: "pass", fingerprint: null, check_def_version: "v1" },
    { id: "test", status: "fail", fingerprint: "f1", check_def_version: "v2" },
  ]);
  // worktree needs to exist for orchestrator.check existence check; create it
  const worktreeDir = join(root, "wt");
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(join(worktreeDir, "orchestrator.check"), "#!/bin/sh\necho hi\n");
  chmodSync(join(worktreeDir, "orchestrator.check"), 0o755);

  const e = await collectEvidence(worktreeDir, "task-struct", "main", mockExecutor(checkOut), art);
  expect(e.structured_checks).not.toBeNull();
  expect(e.structured_checks!.length).toBe(2);
  expect(e.structured_checks![0].check_id).toBe("lint");
  expect(e.structured_checks![1].status).toBe("fail");
  expect(e.checksOutput).toContain(checkOut);
});

test("collectEvidence structured_checks is null when no check script", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-nostruct-"));
  dirs.push(root);
  const art = join(root, "art");
  const worktreeDir = join(root, "wt");
  mkdirSync(worktreeDir, { recursive: true });
  // no orchestrator.check file
  const e = await collectEvidence(worktreeDir, "task-nostruct", "main", mockExecutor(""), art);
  expect(e.structured_checks).toBeNull();
  expect(e.checksExitCode).toBeNull();
});

test("collectEvidence structured_checks is null when check output has no JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-plain-"));
  dirs.push(root);
  const art = join(root, "art");
  const worktreeDir = join(root, "wt");
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(join(worktreeDir, "orchestrator.check"), "#!/bin/sh\necho hi\n");
  chmodSync(join(worktreeDir, "orchestrator.check"), 0o755);
  const e = await collectEvidence(worktreeDir, "task-plain", "main", mockExecutor("all tests passed\n"), art);
  expect(e.structured_checks).toBeNull();
});

test("evidenceReady behavior unaffected by structured_checks", () => {
  expect(evidenceReady({ ...base, structured_checks: [{ check_id: "x", status: "pass", fingerprint: null, check_def_version: "v1" }] })).toEqual({ ready: true });
});
