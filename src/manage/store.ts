import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { createWork } from "../control/store";
import { ensureMgmtSchema, setInputHead } from "./schema";

export const id = (...parts: unknown[]) => createHash("sha256").update(parts.join(":"), "utf8").digest("hex").slice(0, 32);
export const one = <T>(db: Database, sql: string, ...args: unknown[]) => db.query(sql).get(...args as any[]) as T | null;
export const all = <T>(db: Database, sql: string, ...args: unknown[]) => db.query(sql).all(...args as any[]) as T[];

export function createDiscoveredWork(db: Database, stableId: string, title: string, now: number): string {
  ensureMgmtSchema(db);
  const work = createWork(db, { title, source: "discovered", source_id: stableId, contract: undefined, candidate: true }, now);
  db.query(`INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at)
    VALUES(?,'discovered','mgmt','tracking','owner',?,?)`).run(work.work_id, title, now);
  return work.work_id;
}

export function bindExecution(db: Database, input: { workId:string; stableId:string; writerId:string; agent:string; cwd:string|null; coverage:string; state:string; startedAt:number; observedAt:number; evidence:unknown; role?:string }): string {
  const executionId = id("execution", input.stableId, input.writerId, 1);
  db.query("INSERT OR IGNORE INTO mgmt_session_binding(stable_id,work_id,role,evidence_ref,bound_at) VALUES(?,?,?,?,?)")
    .run(input.stableId,input.workId,input.role ?? "origin",JSON.stringify(input.evidence),input.observedAt);
  db.query(`INSERT OR IGNORE INTO mgmt_executions(execution_id,work_id,stable_id,writer_id,attempt_no,exec_state,source_coverage,ledger_evidence,agent,cwd,started_at,last_observed_at)
    VALUES(?,?,?,?,1,?,?,?,?,?,?,?)`).run(executionId,input.workId,input.stableId,input.writerId,input.state,input.coverage,JSON.stringify(input.evidence),input.agent,input.cwd,input.startedAt,input.observedAt);
  return executionId;
}

export function addInputs(db: Database, workId: string, executionId: string, messages: {at:number|null;text:string;lineNo:number}[], source: string, now: number): number {
  let previous = one<{input_head:string|null}>(db,"SELECT input_head FROM mgmt_work_profile WHERE work_id=?",workId)?.input_head ?? null;
  let version = one<{n:number}>(db,"SELECT COALESCE(MAX(version),0) n FROM mgmt_inputs WHERE work_id=? AND kind='user_message'",workId)?.n ?? 0;
  let added = 0;
  for (const message of messages) {
    const inputId = id("input", executionId, message.lineNo, message.text);
    const result = db.query(`INSERT OR IGNORE INTO mgmt_inputs(input_id,work_id,kind,version,supersedes,execution_id,source,evidence_ref,excerpt,actor,at)
      VALUES(?,?,'user_message',?,?,?,?,?,?,?,?)`).run(inputId,workId,++version,previous,executionId,source,`${source}#L${message.lineNo}`,message.text,"user",message.at ?? now);
    if (result.changes) { previous=inputId; added++; setInputHead(db,workId,inputId); } else version--;
  }
  return added;
}

export function updateCursor(db: Database, sourceKey: string, cursor: unknown, status: string, now: number): void {
  db.query(`INSERT INTO mgmt_cursors(source_key,cursor,failures,last_status,updated_at) VALUES(?,?,0,?,?)
    ON CONFLICT(source_key) DO UPDATE SET cursor=excluded.cursor,failures=0,last_status=excluded.last_status,updated_at=excluded.updated_at`).run(sourceKey,JSON.stringify(cursor),status,now);
}
