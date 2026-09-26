import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {consumeDecision,openMailbox,registerTarget,writeHumanAnswer} from '../decision-bot/mailbox';
import {createWork,recordStopCondition,getAttention,getAttentionMaterial,projectAttentionMaterial,getWork,upsertAttention} from '../control/store';
import type {Contract} from '../control/types';
import {startWebServer} from './server';

test('reviewed narrow refuses newly arrived cards; fresh review applies and archives siblings',async()=>{
 const root=mkdtempSync(join(tmpdir(),'contract-http-')),ledgerPath=join(root,'ledger.db'),controlPath=join(root,'control.db');
 const ledger=new Database(ledgerPath);ledger.exec(await Bun.file(new URL('../ingest/schema.sql',import.meta.url)).text());ledger.close();writeFileSync(join(root,'host'),'local\n');
 const db=openMailbox(controlPath);
 const contract:Contract={objective:'ship',acceptance:[{id:'a',kind:'human',description:'review'}],non_goals:[],scope:{cwd:'.'},budget:{},stop_conditions:[{id:'one',kind:'judgment',description:'one'},{id:'two',kind:'judgment',description:'two'}],decision_owner:'operator'};
 const work=createWork(db,{title:'review',source:'test',contract});const item=recordStopCondition(db,work.work_id,'one',{});
 process.env.OVERLOAD_ACTOR='operator'; const server=startWebServer({ledgerPath,controlPath,orchestratorPath:join(root,'orch.db'),spoolRoot:root,port:0});const base=`http://127.0.0.1:${server.port}`;
 const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','Sec-Fetch-Site':'same-origin'},body:JSON.stringify(body)});
 const decisionPackage=()=>fetch(base+`/api/context/decision-package?item_id=${encodeURIComponent(item.item_id)}&work_id=${encodeURIComponent(work.work_id)}`).then(response=>response.json());
 try{
  const replacement={...contract,objective:'narrowed'};
  const preview=await post(`/api/works/${work.work_id}/contract-preview`,{expected_revision:1,contract:replacement});expect(preview.status).toBe(200);
  const snapshot=await preview.json();
  const sibling=recordStopCondition(db,work.work_id,'two',{});
  const pkg=await decisionPackage();const input={attention_revision:pkg.attention_revision,material_fingerprint:pkg.material_fingerprint,expected_contract_revision:1,selected_option:'narrow',replacement_contract:replacement,reason:'bound scope',affected_cards:snapshot.affected_cards};
  expect((await post(`/api/attention/${encodeURIComponent(item.item_id)}/resolve`,input)).status).toBe(409);
  expect(getWork(db,work.work_id)?.revision).toBe(1);expect(getAttention(db,sibling.item_id)?.state).toBe('open');
  const fresh=await (await post(`/api/works/${work.work_id}/contract-preview`,{expected_revision:1,contract:replacement})).json();
  const refreshedPackage=await decisionPackage();
  expect((await post(`/api/attention/${encodeURIComponent(item.item_id)}/resolve`,{...input,attention_revision:refreshedPackage.attention_revision,material_fingerprint:refreshedPackage.material_fingerprint,affected_cards:fresh.affected_cards})).status).toBe(200);
  expect(getWork(db,work.work_id)?.contract?.objective).toBe('narrowed');expect(getAttention(db,sibling.item_id)?.state).toBe('superseded');expect(getAttention(db,item.item_id)?.effect_state).toBe('succeeded');
 }finally{server.stop(true);db.close();rmSync(root,{recursive:true,force:true});}
});

test('extension decision effect requires the consumed receipt and updates linked card only after real result',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gate-effect-http-')),ledgerPath=join(root,'ledger.db'),controlPath=join(root,'control.db');const ledger=new Database(ledgerPath);ledger.exec(await Bun.file(new URL('../ingest/schema.sql',import.meta.url)).text());ledger.close();writeFileSync(join(root,'host'),'local\n');const db=openMailbox(controlPath);const work=createWork(db,{title:'gate',source:'test',contract:{objective:'gate',acceptance:[{id:'effect',kind:'artifact',description:'effect'}],non_goals:[],scope:{cwd:root,human_only_effects:['gated_tool']},budget:{},stop_conditions:[],decision_owner:'operator'}});const approvalId='gate-approval',toolCallId='tool-1';const {targetVersion}=registerTarget(db,{consumerOwner:'extension',approvalId,question:'approve?',options:['approve','deny'],effect:'gated_tool',scope:{cwd:root},evidence:{toolCallId},expiresAt:Date.now()+60000,workId:work.work_id,contractRevision:work.revision,decisionMode:'human_only',toolCallId});upsertAttention(db,{item_id:approvalId,work_id:work.work_id,state:'applying',effect_state:'applying',urgency:'now',conclusion:'approve?',trigger:'gate',impact:'blocked',recommendation:null,options:[],owner:'operator',expires_at:Date.now()+60000,source_link:null,approval_id:approvalId,consumer_owner:'extension',contract_revision:work.revision,decision_mode:'human_only',evidence:{toolCallId}});writeHumanAnswer(db,'extension',approvalId,'approve','operator');consumeDecision(db,{consumerOwner:'extension',approvalId,targetVersion,policyHash:'human',liveValid:()=>true,contractValid:()=>true,policyValid:()=>false});const server=startWebServer({ledgerPath,controlPath,orchestratorPath:join(root,'orch.db'),spoolRoot:root,port:0});const base=`http://127.0.0.1:${server.port}`;try{const bad=await fetch(base+'/api/decision/effect',{method:'POST',headers:{'Content-Type':'application/json','Sec-Fetch-Site':'same-origin'},body:JSON.stringify({receipt_id:'wrong',toolCallId,effect_state:'succeeded',evidence:{}})});expect(await bad.json()).toEqual({observed:false});expect(getAttention(db,approvalId)?.effect_state).toBe('applying');const receipt=db.query('SELECT receipt_id FROM decision_receipts WHERE approval_id=?').get(approvalId) as {receipt_id:string};const ok=await fetch(base+'/api/decision/effect',{method:'POST',headers:{'Content-Type':'application/json','Sec-Fetch-Site':'same-origin'},body:JSON.stringify({receipt_id:receipt.receipt_id,toolCallId,effect_state:'succeeded',evidence:{marker:'observed'}})});expect(await ok.json()).toEqual({observed:true});expect(getAttention(db,approvalId)?.effect_state).toBe('succeeded');}finally{server.stop(true);db.close();rmSync(root,{recursive:true,force:true});}
test('resolve with projected material enforces fingerprint CAS and returns a stale body on mismatch',async()=>{
 const root=mkdtempSync(join(tmpdir(),'contract-http-')),ledgerPath=join(root,'ledger.db'),controlPath=join(root,'control.db');
 const ledger=new Database(ledgerPath);ledger.exec(await Bun.file(new URL('../ingest/schema.sql',import.meta.url)).text());ledger.close();writeFileSync(join(root,'host'),'local\n');
 const db=openMailbox(controlPath);
 const contract:Contract={objective:'ship',acceptance:[{id:'a',kind:'human',description:'review'}],non_goals:[],scope:{cwd:'.'},budget:{},stop_conditions:[{id:'one',kind:'judgment',description:'one'}],decision_owner:'operator'};
 const work=createWork(db,{title:'review',source:'test',contract});const item=recordStopCondition(db,work.work_id,'one',{});
 projectAttentionMaterial(db,item.item_id,{risk:'wrong call wastes the run',decision:'operator picks continue or stop',option_effects:[{option:'continue',effect:'proceed'},{option:'stop',effect:'halt'}],decisive_evidence:[{object_id:'obj-1',revision:1,conclusion:'blocked on operator'}],validity:{expires_at:null,expired:false},consequence:'work drifts if misjudged'});
 const material=getAttentionMaterial(db,item.item_id)!;
 process.env.OVERLOAD_ACTOR='operator'; const server=startWebServer({ledgerPath,controlPath,orchestratorPath:join(root,'orch.db'),spoolRoot:root,port:0});const base=`http://127.0.0.1:${server.port}`;
 const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});
 try{
  // fingerprint mismatch → 409 with the full stale body
  const bad=await post(`/api/attention/${encodeURIComponent(item.item_id)}/resolve`,{attention_revision:item.revision,selected_option:'continue',material_fingerprint:'rotated-fingerprint'});
  expect(bad.status).toBe(409);
  const badBody=await bad.json();
  expect(badBody.current_revision).toBe(item.revision);
  expect(badBody.current_state).toBe('open');
  expect(badBody.decision_package_url).toContain('decision-package');
  // correct fingerprint but stale revision → 409, body reflects the current revision
  const stale=await post(`/api/attention/${encodeURIComponent(item.item_id)}/resolve`,{attention_revision:item.revision+99,selected_option:'continue',material_fingerprint:material.fingerprint});
  expect(stale.status).toBe(409);
  const staleBody=await stale.json();
  expect(staleBody.current_revision).toBe(item.revision);
  expect(staleBody.expected_revision).toBe(item.revision+99);
  expect(staleBody.current_state).toBe('open');
  // fresh fingerprint + fresh revision → decision succeeds
  const ok=await post(`/api/attention/${encodeURIComponent(item.item_id)}/resolve`,{attention_revision:item.revision,selected_option:'continue',material_fingerprint:material.fingerprint});
  expect(ok.status).toBe(200);
  expect(getAttention(db,item.item_id)?.state).toBe('resolved');
 }finally{server.stop(true);db.close();rmSync(root,{recursive:true,force:true});}
});
