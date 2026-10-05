import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWork, openControl, getAttention, getAttentionMaterial, upsertAttention } from '../control/store';
import { insertManifest, requestAcceptance } from '../manage/manifest';
import { Coordinator } from '../orchestrator/coordinator';
import { openStore } from '../orchestrator/store';
import { startWebServer } from './server';

const roots: string[]=[];
const servers: Array<{stop(force?: boolean): void}>=[];
afterEach(()=>{for(const server of servers.splice(0))server.stop(true);for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

test.each(['manifest','coordinator'] as const)('%s decisions use the trusted actor, never the card owner as a substitute',async kind=>{
  const root=mkdtempSync(join(tmpdir(),'overload-owner-'));roots.push(root);writeFileSync(join(root,'host'),'local');
  const controlPath=join(root,'control.db'),orchestratorPath=join(root,'orch.db');
  const db=openControl(controlPath),orch=openStore(orchestratorPath);
  const work=createWork(db,{title:'owner review',source:'test',contract:{objective:'review',acceptance:[{id:'a',kind:'human',description:'owner reviews'}],non_goals:[],scope:{cwd:root},budget:{},stop_conditions:[],decision_owner:'owner'}});
  let itemId: string;
  if(kind==='manifest'){
    db.run("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES(?,'discovered','mgmt','tracking','owner','review',?)",[work.work_id,Date.now()]);
    const manifest=insertManifest(db,{work_id:work.work_id,repo_root:null,git_head:null,git_tree_sha:null,base_ref:null,base_sha:null,verification:[],entries:[]},'owner',Date.now());
    itemId=requestAcceptance(db,manifest.manifest_id,Date.now()).item_id;
  } else {
    new Coordinator(orch,db).bind({work_id:work.work_id,conversation_id:'conversation',session_id:'session',contract_revision:work.revision});
    itemId=`coordinator:delivery:${work.work_id}:${work.revision}`;
    upsertAttention(db,{item_id:itemId,work_id:work.work_id,state:'open',effect_state:'not_started',urgency:'now',conclusion:'review delivery',trigger:'children reviewed',impact:'final review',recommendation:'reject',options:['accept','reject'],owner:'owner',expires_at:null,source_link:null,approval_id:null,consumer_owner:'orchestrator',contract_revision:work.revision,decision_mode:'human_only',evidence:{kind:'coordinator_delivery'}});
  }
  const item=getAttention(db,itemId)!;
  const material=getAttentionMaterial(db,itemId)!;
  async function decide(actor:string){
    const server=startWebServer({ledgerPath:join(root,'ledger.db'),controlPath,orchestratorPath,spoolRoot:root,actor,port:0,publishIntervalMs:60000});servers.push(server);
    const base=`http://127.0.0.1:${server.port}`;
    return fetch(`${base}/api/attention/${encodeURIComponent(itemId)}/resolve`,{method:'POST',headers:{origin:base,'sec-fetch-site':'same-origin','content-type':'application/json'},body:JSON.stringify({attention_revision:item.revision,material_fingerprint:material.fingerprint,selected_option:'reject',actor:'owner'})});
  }
  try {
    expect((await decide('intruder')).status).toBe(409);
    expect(getAttention(db,itemId)).toMatchObject({state:'open',revision:item.revision});
    expect((await decide('owner')).status).toBe(200);
    expect(getAttention(db,itemId)?.state).toBe(kind==='manifest'?'superseded':'resolved');
    if(kind==='manifest')expect(db.query('SELECT actor,verdict FROM mgmt_acceptances').get()).toEqual({actor:'owner',verdict:'rejected'});
    else expect(getAttention(db,itemId)?.evidence.rejected_by).toBe('owner');
  } finally {db.close();orch.close();}
});
