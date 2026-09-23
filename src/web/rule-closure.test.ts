import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openMailbox} from '../decision-bot/mailbox';
import {loadPolicy,rulesReport} from '../decision-bot/policy';
import {startWebServer} from './server';

test('HTTP per-rule disable persists and enables without disabling another signed rule',async()=>{
 const root=mkdtempSync(join(tmpdir(),'rule-http-')),ledgerPath=join(root,'ledger.db'),controlPath=join(root,'control.db'),policyPath=join(root,'config.json');
 const ledger=new Database(ledgerPath);ledger.exec(await Bun.file(new URL('../ingest/schema.sql',import.meta.url)).text());ledger.close();writeFileSync(join(root,'host'),'local\n');
 const rule={id:'one',consumer_owner:'extension',gate:'action',effect:'read',answers:['allow'],cwd:'/repo',command:'cat one'};
 writeFileSync(policyPath,JSON.stringify({decision_bot:{enabled:true,model:'test',rules:[rule,{...rule,id:'two',command:'cat two'}]}}));
 const server=startWebServer({ledgerPath,controlPath,policyPath,orchestratorPath:join(root,'orch.db'),spoolRoot:root,port:0}),base=`http://127.0.0.1:${server.port}`;
 const post=(operation:string)=>fetch(`${base}/api/rules/one/${operation}`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({reason:'operator review'})});
 try{
  expect((await post('disable')).status).toBe(200);
  let db=openMailbox(controlPath);let policy=loadPolicy(policyPath,db);let report=rulesReport(db,policy,Date.now());
  expect(report.rules.find(r=>r.id==='one')?.state).toBe('disabled');expect(report.rules.find(r=>r.id==='two')?.state).toBe('enabled');db.close();
  expect((await post('enable')).status).toBe(200);
  db=openMailbox(controlPath);policy=loadPolicy(policyPath,db);report=rulesReport(db,policy,Date.now());expect(report.rules.find(r=>r.id==='one')?.state).toBe('enabled');db.close();
 }finally{server.stop(true);rmSync(root,{recursive:true,force:true});}
});
