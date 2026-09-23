import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openMailbox} from '../decision-bot/mailbox';
import {createWork,recordStopCondition,getAttention,getWork} from '../control/store';
import type {Contract} from '../control/types';
import {startWebServer} from './server';

test('reviewed narrow refuses newly arrived cards; fresh review applies and archives siblings',async()=>{
 const root=mkdtempSync(join(tmpdir(),'contract-http-')),ledgerPath=join(root,'ledger.db'),controlPath=join(root,'control.db');
 const ledger=new Database(ledgerPath);ledger.exec(await Bun.file(new URL('../ingest/schema.sql',import.meta.url)).text());ledger.close();writeFileSync(join(root,'host'),'local\n');
 const db=openMailbox(controlPath);
 const contract:Contract={objective:'ship',acceptance:[{id:'a',kind:'human',description:'review'}],non_goals:[],scope:{cwd:'.'},budget:{},stop_conditions:[{id:'one',kind:'judgment',description:'one'},{id:'two',kind:'judgment',description:'two'}],decision_owner:'operator'};
 const work=createWork(db,{title:'review',source:'test',contract});const item=recordStopCondition(db,work.work_id,'one',{});
 process.env.OVERLOAD_ACTOR='operator'; const server=startWebServer({ledgerPath,controlPath,orchestratorPath:join(root,'orch.db'),spoolRoot:root,port:0});const base=`http://127.0.0.1:${server.port}`;
 const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});
 try{
  const replacement={...contract,objective:'narrowed'};
  const preview=await post(`/api/works/${work.work_id}/contract-preview`,{expected_revision:1,contract:replacement});expect(preview.status).toBe(200);
  const snapshot=await preview.json();
  const sibling=recordStopCondition(db,work.work_id,'two',{});
  const input={expected_revision:item.revision,expected_contract_revision:1,selected_option:'narrow',replacement_contract:replacement,reason:'bound scope',affected_cards:snapshot.affected_cards};
  expect((await post(`/api/attention/${encodeURIComponent(item.item_id)}/resolve`,input)).status).toBe(409);
  expect(getWork(db,work.work_id)?.revision).toBe(1);expect(getAttention(db,sibling.item_id)?.state).toBe('open');
  const fresh=await (await post(`/api/works/${work.work_id}/contract-preview`,{expected_revision:1,contract:replacement})).json();
  expect((await post(`/api/attention/${encodeURIComponent(item.item_id)}/resolve`,{...input,affected_cards:fresh.affected_cards})).status).toBe(200);
  expect(getWork(db,work.work_id)?.contract?.objective).toBe('narrowed');expect(getAttention(db,sibling.item_id)?.state).toBe('superseded');expect(getAttention(db,item.item_id)?.effect_state).toBe('succeeded');
 }finally{server.stop(true);db.close();rmSync(root,{recursive:true,force:true});}
});
