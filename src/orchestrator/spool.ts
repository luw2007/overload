import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope, EventKind, HostId } from "../shared/types";
import { SEGMENT_MAX_AGE_MS, SEGMENT_MAX_BYTES } from "../shared/types";

export type Clock = { now():number };
export class SpoolWriter {
  readonly host:HostId; readonly dir:string; private openedAt:number|null=null;
  constructor(private db:Database, root=join(homedir(),".overload"), private clock:Clock={now:Date.now}) {
    const host=readFileSync(join(root,"host"),"utf8").trim(); if(host!=="local"&&host!=="devbox")throw new Error(`Invalid host: ${host}`); this.host=host;
    this.dir=join(root,"spool",host,"orchestrator"); mkdirSync(this.dir,{recursive:true,mode:0o700}); chmodSync(this.dir,0o700);
  }
  private row():{seq:number;segment:number}{return this.db.query("SELECT seq,segment FROM spool_seq WHERE id=1").get() as {seq:number;segment:number};}
  private active(segment:number){return join(this.dir,`active-orchestrator-${segment}.ndjson`);}
  private seal(segment:number):void { const p=this.active(segment); if(existsSync(p))renameSync(p,join(this.dir,`seg-orchestrator-${segment}.ndjson`)); this.db.run("UPDATE spool_seq SET segment=segment+1 WHERE id=1"); this.openedAt=null; }
  emit(session:string,kind:EventKind,detail?:Record<string,unknown>):EventEnvelope {
    let envelope!:EventEnvelope; this.db.exec("BEGIN IMMEDIATE");
    try { let {seq,segment}=this.row(); const now=this.clock.now(); const active=this.active(segment);
      if(this.openedAt!==null && existsSync(active) && now-this.openedAt>=SEGMENT_MAX_AGE_MS){this.seal(segment); segment++;}
      if(this.openedAt===null)this.openedAt=now; seq++;
      envelope={v:1,at:now,host:this.host,runtime:"overload",session,emitter_id:"orchestrator",writer_id:"orchestrator",seq,kind,dropped_total:0,write_error_total:0,...(detail?{detail}:{})};
      appendFileSync(this.active(segment),`${JSON.stringify(envelope)}\n`,{mode:0o600}); chmodSync(this.active(segment),0o600); this.db.run("UPDATE spool_seq SET seq=? WHERE id=1",[seq]);
      if(statSync(this.active(segment)).size>=SEGMENT_MAX_BYTES)this.seal(segment); this.db.exec("COMMIT"); return envelope;
    } catch(error){try{this.db.exec("ROLLBACK");}catch{} throw error;}
  }
  close():void { const {segment}=this.row(); if(existsSync(this.active(segment)))this.seal(segment); }
}
