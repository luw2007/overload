import type { Database } from "bun:sqlite";
import { all } from "./store";

export type ArchiveReport={ended:number;archived:number};
export function deriveCloseoutAndArchive(db:Database,ledger:Database|null,opts:{now?:number;archiveGraceMs?:number}={}):ArchiveReport{
  const now=opts.now??Date.now(),grace=opts.archiveGraceMs??30*60_000; let ended=0,archived=0;
  for(const execution of all<any>(db,"SELECT * FROM mgmt_executions WHERE exec_state IN ('running','unknown')")){
    let current:any=null;
    try{current=ledger?.query("SELECT state,last_event_at,last_heartbeat_at FROM current WHERE stable_id=?").get(execution.stable_id)??null;}catch{}
    const last=Math.max(execution.last_observed_at??0,current?.last_event_at??0,current?.last_heartbeat_at??0);
    if(current?.state==="ended"||current?.state==="completed"||current?.state==="failed"||(!current&&last&&now-last>=grace)){
      const state=current?.state==="failed"?"ended_failed":"ended_ok";
      const evidence={derived:true,ledger_state:current?.state??null,last_observed_at:last,at:now};
      db.query("UPDATE mgmt_executions SET exec_state=?,ended_at=?,closeout_evidence=? WHERE execution_id=?").run(state,now,JSON.stringify(evidence),execution.execution_id); ended++;
    }
  }
  for(const work of all<any>(db,`SELECT p.work_id FROM mgmt_work_profile p WHERE p.track_state='tracking' AND p.closeout_owner='mgmt'
    AND EXISTS(SELECT 1 FROM mgmt_executions e WHERE e.work_id=p.work_id)
    AND NOT EXISTS(SELECT 1 FROM mgmt_executions e WHERE e.work_id=p.work_id AND e.exec_state NOT IN ('ended_ok','ended_failed'))
    AND NOT EXISTS(SELECT 1 FROM mgmt_executions e WHERE e.work_id=p.work_id AND ? - e.ended_at < ?)
    AND NOT EXISTS(SELECT 1 FROM control_attention a WHERE a.work_id=p.work_id AND a.state='open' AND a.item_id LIKE 'mgmt:%')
    AND NOT EXISTS(SELECT 1 FROM mgmt_handoffs h WHERE h.work_id=p.work_id AND h.state IN ('ready_to_launch','launching','launch_unknown','bound'))`,now,grace)){
    db.query("UPDATE mgmt_work_profile SET track_state='archived',archived_at=?,archive_reason='all_executions_ended',updated_at=? WHERE work_id=? AND track_state='tracking'").run(now,now,work.work_id); archived++;
  }
  return {ended,archived};
}
