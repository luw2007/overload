import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { listWorks, loadManageConfig, scanOnce, setTracking, showWork } from "../manage/manage";
import { ensureControlSchema } from "../control/store";

export async function runMgmtCli(args:string[]):Promise<void>{
  const home=process.env.OVERLOAD_HOME??join(homedir(),".overload");
  const db=new Database(process.env.OVERLOAD_ANSWERS_PATH??join(home,"orchestrator-answers.db"),{create:true});
  const ledgerPath=process.env.OVERLOAD_LEDGER_PATH??join(home,"ledger.db");let ledger:Database|null=null;
  try{try{ledger=new Database(ledgerPath,{readonly:true});}catch{}
    ensureControlSchema(db);const [command,...rest]=args;
    if(command==="scan"){console.log(JSON.stringify(await scanOnce(db,ledger,loadManageConfig(home))));return;}
    if(command==="works"){const track=rest[0]==="--track"?rest[1] as "tracking"|"paused"|"archived"|undefined:undefined;console.log(JSON.stringify(listWorks(db,track?{track}:{})));return;}
    if(command==="show"&&rest.length===1){const row=showWork(db,rest[0]!);if(!row)throw new Error("work not found");console.log(JSON.stringify(row));return;}
    if(command==="track"&&rest.length===2&&(rest[1]==="on"||rest[1]==="off")){setTracking(db,rest[0]!,rest[1]==="on");return;}
    throw new Error("usage: overload mgmt scan [--once] | works [--track tracking] | show <work_id> | track <work_id> on|off");
  }finally{ledger?.close();db.close();}
}
