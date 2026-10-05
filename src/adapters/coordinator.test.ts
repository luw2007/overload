import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openMailbox} from '../decision-bot/mailbox';
import {openStore} from '../orchestrator/store';
import {createWork} from '../control/store';
import {ensureAdapterSchema,acceptMessage} from './store';
import type {Conversation} from './store';
import {CoordinatorBridge} from './coordinator';
test('coordinator HTTP tools require bound capability and current contract',async()=>{const dir=mkdtempSync(join(tmpdir(),'coordinator-bridge-'));const db=openMailbox(join(dir,'control.db')),orch=openStore(join(dir,'orch.db'));ensureAdapterSchema(db);const work=createWork(db,{title:'Bound task',source:'operator',contract:{objective:'inspect',acceptance:[{id:'report',kind:'artifact',description:'report'}],non_goals:[],scope:{repo:dir,allowed_effects:['read']},budget:{retry_limit:1},stop_conditions:[],decision_owner:'owner'}});const event={kind:'message' as const,eventId:'one',identity:{instanceId:'test',tenantId:'tenant',userId:'user'},address:{instanceId:'test',tenantId:'tenant',chatId:'chat'},messageId:'one',text:'inspect',receivedAt:Date.now()};const accepted=acceptMessage(db,event,'owner');const c=db.query('SELECT * FROM conversations WHERE id=?').get(accepted.conversationId) as import('./store').Conversation;const bridge=new CoordinatorBridge(db,orch);try{bridge.start(0);const binding=bridge.bind(c,{runtimeKind:'pi',sessionId:'session',ownerId:c.id,cwd:dir},work.work_id);const body=JSON.stringify({work_id:work.work_id});expect((await bridge.handle(new Request(binding.endpoint+'/coordinator_status',{method:'POST',body}))).status).toBe(403);const response=await bridge.handle(new Request(binding.endpoint+'/coordinator_status',{method:'POST',headers:{authorization:'Bearer '+binding.token},body}));expect(response.status).toBe(200);db.run('UPDATE control_works SET revision=revision+1 WHERE work_id=?',[work.work_id]);expect((await bridge.handle(new Request(binding.endpoint+'/coordinator_status',{method:'POST',headers:{authorization:'Bearer '+binding.token},body}))).status).toBe(409);}finally{bridge.stop();db.close();orch.close();rmSync(dir,{recursive:true,force:true});}});

test('completed coordinator status remains readable and rejects new controlled actions', async () => {
 const dir=mkdtempSync(join(tmpdir(),'coordinator-completed-'));
 const db=openMailbox(join(dir,'control.db')),orch=openStore(join(dir,'orch.db'));
 const bridge=new CoordinatorBridge(db,orch);
 try {
  const work=createWork(db,{title:'completed work',source:'test',contract:{objective:'read report',acceptance:[{id:'a',kind:'human',description:'review'}],non_goals:[],scope:{cwd:dir},budget:{},stop_conditions:[],decision_owner:'owner'}});
  db.run("INSERT INTO channel_coordinators(work_id,conversation_id,session_id,contract_revision,token) VALUES(?,?,?,?,?)",[work.work_id,'conversation','session',work.revision,'token']);
  bridge.coordinator.bind({work_id:work.work_id,conversation_id:'conversation',session_id:'session',contract_revision:work.revision});
  db.run("UPDATE control_works SET state='completed' WHERE work_id=?",[work.work_id]);
  const request=(method:string)=>new Request('http://localhost/'+method,{method:'POST',headers:{authorization:'Bearer token'},body:JSON.stringify({work_id:work.work_id})});
  const response=await bridge.handle(request('coordinator_status'));
  expect(response.status).toBe(200);
  expect((await response.json()).work.state).toBe('completed');
  for(const method of ['coordinator_dispatch','coordinator_review','coordinator_deliver'])expect((await bridge.handle(request(method))).status).toBe(409);
 } finally {bridge.stop();db.close();orch.close();rmSync(dir,{recursive:true,force:true});}
});
