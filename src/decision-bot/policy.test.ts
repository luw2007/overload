import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openMailbox} from './mailbox';
import {rulesReport} from './policy';
test('bot consumed receipt increments matching rule weekly hits',()=>{const dir=mkdtempSync(join(tmpdir(),'rules-'));const db=openMailbox(join(dir,'db'));try{
 const now=Date.now();db.run("INSERT INTO bot_proposals(attempt_id,consumer_owner,approval_id,target_version,action,reason,evidence_refs,policy_hash,created_at,rule_id) VALUES('p','extension','a','v','answer','safe','[]','h',?, 'r1')",[now]);
 db.run("INSERT INTO decision_receipts(receipt_id,consumer_owner,approval_id,target_version,actor,answer,attempt_id,consumed_at) VALUES('receipt','extension','a','v','decision-bot','allow','p',?)",[now]);
 const report=rulesReport(db,{config:{enabled:true,model:'test',timeout_ms:1000,max_output_bytes:1024,rules:[{id:'r1',consumer_owner:'extension',gate:'action',effect:'read',answers:['allow']}]},hash:'h'},now);
 expect(report.hits_week).toBe(1);expect(report.rules[0].hits_week).toBe(1);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}});
test('candidate report exposes persisted approval and observations',()=>{const dir=mkdtempSync(join(tmpdir(),'rules-candidate-'));const db=openMailbox(join(dir,'db'));try{db.run("INSERT INTO policy_candidates(candidate_id,rule_json,scope_hash,approved_by,approved_at,observation_until,created_at) VALUES('c',?,'h','operator',1,100,1)",[JSON.stringify({id:'r',consumer_owner:'extension',gate:'action',effect:'read',answers:['allow'],repo:'/repo'})]);const r=rulesReport(db,{config:{enabled:false,model:'',timeout_ms:1000,max_output_bytes:1024,rules:[]},hash:'h'},10);expect(r.rules[0].state).toBe('observing');expect(r.rules[0].candidate_id).toBe('c');expect(r.rules[0].observed).toBe(0);}finally{db.close();rmSync(dir,{recursive:true,force:true});}});
