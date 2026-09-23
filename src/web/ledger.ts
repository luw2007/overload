import type { Database } from "bun:sqlite";
const median=(xs:number[])=>{const a=[...xs].sort((a,b)=>a-b);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:0;};
function union(rows:number[][]){let total=0,end=-Infinity;for(const [a,b] of rows.sort((x,y)=>x[0]-y[0])){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return total;}
export function ledgerReport(db:Database,{since,until}:{since:number;until:number}) {
  // Attention events supply actual resolution timestamps; overlapping wall-clock waits count once for bottleneck.
  const rows=db.query(`SELECT a.*,w.title,(SELECT MIN(created_at) FROM control_attention_events e WHERE e.item_id=a.item_id AND e.kind IN ('resolved','resolve')) AS decided_at FROM control_attention a JOIN control_works w USING(work_id) WHERE a.created_at<=?`).all(until) as any[];
  const records=rows.map(r=>{const decided=r.decided_at??(['resolved','superseded'].includes(r.state)?r.updated_at:null);return {...r,decided_at:decided,waited_ms:Math.max(0,Math.min(decided??until,until)-Math.max(r.created_at,since))};}).filter(r=>(r.decided_at??until)>=since);
  const series=(events:{at:number,value:number}[])=>Array.from({length:7},(_,i)=>events.filter(e=>e.at>=since+(until-since)*i/7&&e.at<(i===6?until+1:since+(until-since)*(i+1)/7)).reduce((n,e)=>n+e.value,0));
  // Rework is the distinct superseded cards recorded by revision outbox events; an explicit reason attributes it to the operator.
  const revs=db.query(`SELECT o.item_id,r.reason,o.created_at FROM control_outbox o LEFT JOIN control_contract_revisions r ON r.work_id=o.work_id AND r.created_at=o.created_at WHERE o.kind='attention.superseded' AND o.created_at BETWEEN ? AND ?`).all(since,until) as any[];
  const all=new Set<string>(),caused=new Set<string>();for(const r of revs){all.add(r.item_id);if(r.reason?.trim())caused.add(r.item_id);}
  // Redirects are unplanned unless the original creation event recorded candidate state. Lost execution time is not recorded.
  const redirects=db.query(`SELECT r.*,(SELECT payload FROM control_outbox o WHERE o.work_id=r.work_id AND o.kind='work.created' LIMIT 1) AS origin FROM control_redirects r WHERE r.created_at BETWEEN ? AND ?`).all(since,until) as any[];
  // Bot hits require a bot-owned consumed receipt. Missing legacy rule attribution lowers report coverage.
  let hits:any[]=[];let coverage=1;
  try {hits=db.query(`SELECT r.consumed_at AS created_at,p.rule_id FROM decision_receipts r JOIN bot_proposals p ON p.attempt_id=r.attempt_id WHERE r.actor='decision-bot' AND r.consumed_at BETWEEN ? AND ?`).all(since-(until-since),until) as any[];}catch{coverage-=0.2;}
  if(hits.some(h=>!h.rule_id))coverage-=0.1;
  if(redirects.length)coverage-=0.2; // No measured execution-loss field exists; never equate waiting with wasted execution.
  if(redirects.some(r=>!r.origin))coverage-=0.1;
  const current=hits.filter(h=>h.created_at>=since),previous=hits.filter(h=>h.created_at<since);
  // A stop-trigger death delay ends only when a decision actually resolves the stop card.
  const deaths=records.filter(r=>r.item_id.startsWith('stop:')&&r.state==='resolved'&&r.decided_at!=null&&r.decided_at>=since&&r.decided_at<=until).map(r=>({...r,delay_ms:r.decided_at-r.created_at})).sort((a,b)=>b.delay_ms-a.delay_ms);
  const total=records.reduce((n,r)=>n+r.waited_ms,0);
  const chose=(r:any)=>{try{const evidence=JSON.parse(r.evidence);return evidence.selected_option??null;}catch{return null;}};
  return {window:{since,until},coverage:Math.max(0,coverage),bottleneck:{total_ms:union(records.map(r=>[Math.max(since,r.created_at),Math.min(until,r.decided_at??until)])),work_count:new Set(records.map(r=>r.work_id)).size},waiting:{total_ms:total,median_ms:median(records.map(r=>r.waited_ms)),series:series(records.map(r=>({at:Math.min(r.decided_at??until,until),value:r.waited_ms})))},rework:{caused:caused.size,total:all.size,series:series(revs.map(r=>({at:r.created_at,value:1})))},redirects:{count:redirects.length,unplanned:redirects.filter(r=>!r.origin||JSON.parse(r.origin).state!=='candidate').length,lost_ms:0,series:series(redirects.map(r=>({at:r.created_at,value:1})))},rules:{hits:current.length,delta:current.length-previous.length,share:current.length+records.filter(r=>r.decided_at!=null).length?100*current.length/(current.length+records.filter(r=>r.decided_at!=null).length):0,series:series(current.map(r=>({at:r.created_at,value:1})))},death:{median_ms:median(deaths.map(r=>r.delay_ms)),oldest:deaths.length?{work_id:deaths[0].work_id,title:deaths[0].title,delay_ms:deaths[0].delay_ms}:null,series:series(deaths.map(r=>({at:r.decided_at,value:r.delay_ms})))},slowest:records.sort((a,b)=>b.waited_ms-a.waited_ms).slice(0,10).map(r=>({work_id:r.work_id,title:r.title,item_id:r.item_id,asked_at:r.created_at,decided_at:r.decided_at,waited_ms:r.waited_ms,chose:chose(r),effect_state:r.effect_state}))};
}
export type LedgerReport=ReturnType<typeof ledgerReport>;
