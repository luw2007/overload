import { expect,test } from "bun:test";
import { existsSync,mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRunner } from "./runner";
import type { Task } from "./store";
test("runner spawn records attempt-scoped executor evidence",async()=>{const root=mkdtempSync(join(tmpdir(),"runner-log-"));try{const result=await spawnRunner({task_id:"task"} as Task,root,"attempt","prompt",async()=>({ok:false,error:"cmux unavailable",stderr:"broken"}),root);expect(result.ok).toBe(false);const path=join(root,"task","runner-attempt.log");expect(existsSync(path)).toBe(true);expect(readFileSync(path,"utf8")).toContain("cmux unavailable");}finally{rmSync(root,{recursive:true,force:true});}});
