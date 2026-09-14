import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWork,getWork} from '../control/store';
import {openMailbox} from '../decision-bot/mailbox';
import {Coordinator} from './coordinator';
import {getTask,openStore} from './store';

function fixture(retryLimit=1){
 const root=mkdtempSync(join(tmpdir(),'coordinator-continuation-'));
 const tasks=openStore(join(root,'tasks.db')),control=openMailbox(join(root,'control.db'));
 const work=createWork(control,{title:'Inspect',source:'operator',contract:{objective:'inspect',acceptance:[{id:'report',kind:'artifact',description:'report'}],non_goals:[],scope:{repo:root,allowed_effects:['read']},budget:{retry_limit:retryLimit},stop_conditions:[],decision_owner:'owner'}});
 const coordinator=new Coordinator(tasks,control);coordinator.bind({work_id:work.work_id,conversation_id:'conversation',session_id:'session',contract_revision:work.revision});
 const child=coordinator.dispatch({work_id:work.work_id,request_id:'child',title:'Inspect',repo:root,kind:'scout',scope:{repo:root,allowed_effects:['read']},acceptance:['report']});
 const report=join(root,'report.txt');writeFileSync(report,'first');tasks.run("UPDATE tasks SET state='awaiting_human',attempt_id='attempt-1',worktree=? WHERE task_id=?",[root,child.task_id]);
 const evidence=()=>[{path:report,sha256:createHash('sha256').update(readFileSync(report)).digest('hex')}];
 return {root,tasks,control,work,coordinator,child,report,evidence};
}

test('coordinator rework consumes budget and queues a fresh attempt',()=>{const f=fixture();try{
 f.coordinator.review({work_id:f.work.work_id,task_id:f.child.task_id,attempt_id:'attempt-1',state:'awaiting_human',verdict:'rework',reason:'revise',evidence:f.evidence()});
 const task=getTask(f.tasks,f.child.task_id)!;expect(task.state).toBe('queued');expect(task.attempt_id).toBeNull();expect(task.retry_budget).toBe(0);
}finally{f.tasks.close();f.control.close();rmSync(f.root,{recursive:true,force:true});}});

test('final acceptance rechecks evidence and completed status remains readable',()=>{const f=fixture();try{
 f.coordinator.review({work_id:f.work.work_id,task_id:f.child.task_id,attempt_id:'attempt-1',state:'awaiting_human',verdict:'accept',reason:'verified',evidence:f.evidence()});
 const delivery=f.coordinator.deliver({work_id:f.work.work_id,summary:'ready'});writeFileSync(f.report,'mutated');
 expect(()=>f.coordinator.acceptDelivery(f.work.work_id,delivery.item_id!,delivery.revision!,'owner')).toThrow('final_not_ready');
 writeFileSync(f.report,'first');f.coordinator.acceptDelivery(f.work.work_id,delivery.item_id!,delivery.revision!,'owner');
 expect(getWork(f.control,f.work.work_id)?.state).toBe('completed');expect(f.coordinator.status(f.work.work_id).work.state).toBe('completed');
}finally{f.tasks.close();f.control.close();rmSync(f.root,{recursive:true,force:true});}});
