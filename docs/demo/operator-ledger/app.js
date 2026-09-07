/* Seeded local simulation. No requests, storage, or production effects. */
const HOUR = 3600000;
const now = Date.now();
const stamp = value => new Date(value).toLocaleTimeString('en-GB', {hour12:false});
const duration = hours => hours >= 1 ? `${Number(hours.toFixed(1))}h` : `${Math.round(hours * 60)}m`;
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const works = [
  {id:'w-pay',name:'Payment retry',owner:'operator',version:3,objective:'Recover payment processing without duplicate charges.',acceptance:'Retry suite passes; no duplicate charge in replay.',scope:'repo /repo/pay',budget:2,risk:'No writes to production payment records.',stop:'2 failed retries or value evidence absent.',state:'waiting',history:[{version:3,reason:'Bound retries after replay failure.',at:now-23*HOUR},{version:2,reason:'Exclude production writes.',at:now-48*HOUR},{version:1,reason:'Initial contract.',at:now-70*HOUR}]},
  {id:'w-export',name:'Invoice export',owner:'finance-owner',version:2,objective:'Ship a verifiable invoice export for finance.',acceptance:'100 fixture invoices match source totals.',scope:'repo /repo/billing',budget:3,risk:'Approval required before external delivery.',stop:'Stop on total mismatch or deadline expiry.',state:'waiting',history:[{version:2,reason:'Require approval for external delivery.',at:now-24*HOUR},{version:1,reason:'Initial contract.',at:now-60*HOUR}]},
  {id:'w-search',name:'Search index',owner:'search-owner',version:4,objective:'Reduce stale search results without dropping documents.',acceptance:'Replay has zero missing documents.',scope:'repo /repo/search',budget:2,risk:'No irreversible index deletion without approval.',stop:'Stop after 2 failed replays.',state:'waiting',history:[{version:4,reason:'Keep existing index until verification.',at:now-22*HOUR},{version:3,reason:'Limit replay budget to 2.',at:now-45*HOUR},{version:2,reason:'Add missing-document check.',at:now-65*HOUR},{version:1,reason:'Initial contract.',at:now-90*HOUR}]}
];
const seeds = [
 ['d1','w-pay','Is "Payment retry" still worth 1 more attempt?','bounded',19.2,'stop condition · 2/2 retries spent · value evidence absent','s1 triggered','retries 2/2 · last check exit 1 · diff +412 −38',null],
 ['d2','w-export','Should "Invoice export" leave the workspace?','irreversible',6,'external delivery · 100 invoices · approval expires in 2h','external delivery requested','100/100 fixtures match · recipient finance@example.test',2],
 ['d3','w-search','Is "Search index" worth another replay?','bounded',4,'stop condition · 2/2 replays spent · 3 missing documents','s2 triggered','replays 2/2 · 3 documents missing · checkpoint c18',null],
 ['d4','w-export','Should "Invoice export" continue with a smaller scope?','bounded',2,'scope boundary · 8 custom fields lack acceptance evidence','scope boundary crossed','8 custom fields unverified · core totals pass',null],
 ['d5','w-search','Should the old "Search index" be deleted?','irreversible',.5,'irreversible deletion · 1 retained index · recovery unavailable','irreversible action proposed','index v12 retained · replacement verified · deletion cannot be undone',null]
];
const decisions = seeds.map(([id,work,question,layer,wait,summary,trigger,evidence,expires]) => ({id,work,question,layer,summary,trigger,evidence,createdAt:now-wait*HOUR,expiresAt:expires ? now+expires*HOUR:null,state:'owed',expanded:false,stopTriggeredAt:now-wait*HOUR,source:'human',version:works.find(w=>w.id===work).version}));
// Historical event records supply week/day metrics and the automatic-handling audit.
for(let day=0;day<7;day++) {
  for(let n=0;n<(day===0?41:27+day*2);n++) {
    const ended=now-day*24*HOUR-(n+1)*.08*HOUR;
    decisions.push({id:`auto-${day}-${n}`,work:works[n%3].id,question:n%2?'Retry completed within contract.':'Idle worker released within contract.',layer:'automatic',createdAt:ended-.12*HOUR,decidedAt:ended,effectAt:ended+2000,source:'automatic',state:'done',action:n%2?'continue':'stop',before:n%2?'retry pending':'worker held',after:n%2?'replay verified':'worker released',version:works[n%3].version,hasStopCondition:n%6!==0,reason:'Inside the agreed budget.',deathDelayHours:n%2?null:.03});
  }
  for(let n=0;n<3;n++) {
    const ended=now-day*24*HOUR-(n+2)*.3*HOUR;
    const wait=[.2,.6,1.2,2.4,4.8,7.2,11][(day+n)%7];
    decisions.push({id:`human-${day}-${n}`,work:works[n].id,question:`Was "${works[n].name}" worth another attempt?`,layer:'bounded',createdAt:ended-wait*HOUR,decidedAt:ended,effectAt:ended+3000,source:'human',state:'done',action:n===0?'stop':'continue',before:'waiting for operator',after:n===0?'worker released':'checkpoint resumed',version:works[n].version,reason:'Evidence reviewed against contract.',hasStopCondition:day!==5,stopTriggeredAt:n===0?ended-wait*HOUR:null,deathDelayHours:n===0?wait:null});
  }
}
// Attribution is explicit event data, not inferred from display text.
const contractRevisions = [
  {work:'w-pay',at:now-23*HOUR,author:'operator',reason:'Scope too wide; retain verified core.',supersededCards:['pay-replay-1','pay-replay-2']},
  {work:'w-export',at:now-48*HOUR,author:'operator',reason:'Change export acceptance after review.',supersededCards:['export-1']},
  {work:'w-search',at:now-72*HOUR,author:'operator',reason:'Reduce index scope.',supersededCards:['search-1']},
  {work:'w-search',at:now-100*HOUR,author:'agent',reason:'Schema mismatch requires fixture rebuild.',supersededCards:['fixture-1','fixture-2','fixture-3']},
  {work:'w-pay',at:now-125*HOUR,author:'agent',reason:'Upstream replay format changed.',supersededCards:['replay-1','replay-2','replay-3','replay-4']}
];
const redirects = [
  {at:now-6*HOUR,work:'w-pay',fromCandidate:false,displacedWork:'w-export',displacedMs:2*HOUR},
  {at:now-40*HOUR,work:'w-search',fromCandidate:true,displacedWork:'w-pay',displacedMs:1.5*HOUR},
  {at:now-80*HOUR,work:'w-export',fromCandidate:false,displacedWork:'w-search',displacedMs:100*60000}
];
const rules = [
  {id:'rule-retry',enabledAt:now-140*HOUR,hits:[]},
  {id:'rule-release',enabledAt:now-100*HOUR,hits:[]}
];
// Each hit references a judgment that would otherwise require the operator.
[0,1,2,3,4,5].forEach((day,i)=>{
  const decision=decisions.find(d=>d.id===`auto-${day}-0`);
  rules[i%2].hits.push({decisionId:decision.id,at:decision.decidedAt});
});
// Previous-period rule hits are events as well, so delta uses the same calculation.
for(let i=0;i<4;i++){
  const at=now-(180+i*12)*HOUR,id=`prior-rule-${i}`;
  decisions.push({id,work:works[i%3].id,source:'automatic',state:'done',createdAt:at-60000,decidedAt:at,effectAt:at,action:'continue',before:'judgment pending',after:'resolved by rule',version:1,reason:'Enabled rule matched.'});
  rules[i%2].enabledAt=now-330*HOUR;
  rules[i%2].hits.push({decisionId:id,at});
}
const elapsed = ms => {const minutes=Math.max(0,Math.round(ms/60000));return `${Math.floor(minutes/60)}h ${minutes%60}m`;};
function intervalUnion(intervals){
  const sorted=intervals.filter(([a,b])=>b>=a).sort((a,b)=>a[0]-b[0]);
  let total=0,start=null,end=null;
  for(const [a,b] of sorted){if(start===null){start=a;end=b;}else if(a<=end){end=Math.max(end,b);}else{total+=end-start;start=a;end=b;}}
  return total+(start===null?0:end-start);
}
function attention(at=Date.now(),span=168*HOUR){
  const start=at-span;
  return decisions.filter(d=>d.source==='human'&&d.createdAt<=at&&(!d.decidedAt||d.decidedAt>=start));
}
function waitingMedian(at=Date.now(),span=168*HOUR){
  return quantile(attention(at,span).map(d=>Math.min(d.decidedAt||at,at)-d.createdAt),.5);
}
const candidates = ['Export reconciliation','Webhook deduplication','Search relevance audit','Payment trace sampler','Invoice retention policy','Replay fixture cleanup','Queue ownership map'].map((name,i)=>({id:`c${i}`,name,objective:'',acceptance:'',promoted:false}));
let page='decide', period='week', showDone=false, doneFilter='all';
const main=document.querySelector('#main');
const drawer=document.querySelector('#drawer');
const modal=document.querySelector('#modal');
const getWork=d=>works.find(w=>w.id===d.work);
const owed=()=>decisions.filter(d=>d.state==='owed');
const dot=color=>`<span class="dot ${color}" aria-hidden="true"></span>`;
function announce(text){document.querySelector('#announcement').textContent=text;}
function receipt(d){return `<div class="row receipt"><div class="receipt-head">${dot('green')}<strong>✓ ${escapeHTML(d.action)} · ${d.source==='automatic'?'agent':escapeHTML(getWork(d).owner)} · <time>${stamp(d.decidedAt)}</time></strong><span class="badge">${escapeHTML(getWork(d).name)} · r${d.version}</span></div><div class="mono">${escapeHTML(d.before)} → ${escapeHTML(d.after)}</div><div>effect verified at <time class="mono">${stamp(d.effectAt)}</time> · ${escapeHTML(d.verification || 'result checked against contract')} · simulated</div>${d.reason?`<div class="muted">Reason: ${escapeHTML(d.reason)}</div>`:''}</div>`;}
function row(d){
 const w=getWork(d),red=d.layer==='irreversible';
 return `<article class="row" id="${d.id}"><div class="row-title">${dot(red?'red':'yellow')}<button class="question" data-toggle="${d.id}" aria-expanded="${d.expanded}" aria-controls="evidence-${d.id}">${escapeHTML(d.question)}</button><span class="row-meta mono"><span>${w.owner} · r${d.version}</span><span>${duration((now-d.createdAt)/HOUR)}</span><span aria-hidden="true">↵</span></span></div><p class="row-note">${escapeHTML(d.summary)}</p><div class="actions"><button data-action="stop" data-id="${d.id}">stop</button><button data-action="continue" data-id="${d.id}">continue</button><button data-action="narrow" data-id="${d.id}">narrow</button><button class="text-button session" data-session="${d.id}">↗ open session</button></div>${d.expanded?`<div class="details" id="evidence-${d.id}"><dl class="facts"><dt>Why now</dt><dd>${escapeHTML(d.trigger)} at <time class="mono">${stamp(d.createdAt)}</time> (judgment) · <span class="badge">${red?'irreversible':'bounded'}</span></dd><dt>Impact</dt><dd>${w.scope} held · 1 worker occupying · ${d.expiresAt?'deadline '+new Date(d.expiresAt).toLocaleString('en-GB'):'deadline 09-08 18:00'} · ${red?'explicit confirmation required':'waiting holds one worker'}</dd><dt>Evidence</dt><dd>${escapeHTML(d.evidence)} · <button class="text-button" data-artifacts="${d.id}">↗ artifacts</button></dd><dt>Waiting</dt><dd class="mono">${elapsed(Date.now()-d.createdAt)} (your median this week: ${elapsed(waitingMedian())})</dd><dt>Options</dt><dd><span class="option"><code>stop</code> releases worker, keeps worktree 1h, work → stopped</span><span class="option"><code>continue</code> ${red?'authorizes this irreversible action once; effect cannot be undone':'spends nothing now, next attempt costs up to 1 retry, expires in 2h'}</span><span class="option"><code>narrow</code> edits contract → r${w.version+1}, reason required, restarts from checkpoint</span><span class="muted">Recommended: ${red?'stop until impact is accepted':'narrow to verified scope'}.</span></dd></dl></div>`:''}</article>`;
}
function renderDecide(){
 const pending=owed(),expiring=pending.filter(d=>d.expiresAt),oldest=Math.max(0,...pending.map(d=>(now-d.createdAt)/HOUR));
 const automatic=decisions.filter(d=>d.source==='automatic'&&d.decidedAt>=now-24*HOUR);
 main.innerHTML=`<h1>Decide</h1><div class="summary">${pending.length} decisions owed · ${expiring.length?`${expiring.length} expires in ${duration((Math.min(...expiring.map(d=>d.expiresAt))-now)/HOUR)}`:'0 expiring'} · oldest waiting ${duration(oldest)} · <button class="text-button" data-done="automatic">agents self-resolved ${automatic.length} today</button></div>${pending.length===0&&!decisions.some(d=>d.state==='receipt')?'<div class="empty"><h2>No decisions owed.</h2><p>Agents are operating within your contracts.</p><p>Next scheduled review: 09-08 09:00</p></div>':`<div class="section-heading"><h2>Owed to the system</h2><small>Now · ${pending.length} decisions · expand for evidence</small></div><div class="list">${decisions.filter(d=>d.state==='owed'||d.state==='receipt').map(d=>d.state==='receipt'?receipt(d):row(d)).join('')}</div>`}<div class="section-heading"><h2>Within contract</h2><small>Automatic · no decision required</small></div><div class="list auto">${dot('blue')}<span><strong class="mono">${automatic.length}</strong> handled without you</span><button class="text-button" data-done="automatic">Inspect Done ↗</button></div><div class="section-heading"><h2>Done <span class="muted mono">${decisions.filter(d=>d.state==='done').length}</span></h2><button data-done="all">${showDone?'Hide':'Show'} receipts</button></div>${showDone?`<p class="muted">${doneFilter==='automatic'?'Automatic effects · today':'Recent decisions and verified effects'}</p><div class="list">${decisions.filter(d=>d.state==='done'&&(doneFilter!=='automatic'||d.source==='automatic'&&d.decidedAt>=now-24*HOUR)).sort((a,b)=>b.decidedAt-a.decidedAt).slice(0,50).map(receipt).join('')}</div>`:''}`;
}
function quantile(values,q){if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);const p=(sorted.length-1)*q;return sorted[Math.floor(p)]+(sorted[Math.ceil(p)]-sorted[Math.floor(p)])*(p%1);}
function metrics(at=Date.now(),span=168*HOUR){
 const start=at-span, records=attention(at,span);
 const intervals=records.map(d=>[Math.max(start,d.createdAt),Math.min(d.decidedAt||at,at)]);
 const pending=records.filter(d=>!d.decidedAt||d.decidedAt>at);
 const totalWaiting=[...new Set(pending.map(d=>d.work))].reduce((sum,work)=>sum+intervalUnion(pending.filter(d=>d.work===work).map(d=>[Math.max(start,d.createdAt),at])),0);
 const revisions=contractRevisions.filter(r=>r.at>=start&&r.at<=at);
 const allRework=new Set(revisions.flatMap(r=>r.supersededCards));
 const operatorRework=new Set(revisions.filter(r=>r.author==='operator'&&r.reason.trim()).flatMap(r=>r.supersededCards));
 const redirected=redirects.filter(r=>r.at>=start&&r.at<=at);
 const hits=rules.filter(r=>r.enabledAt<=at).flatMap(r=>r.hits.filter(h=>h.at>=Math.max(start,r.enabledAt)&&h.at<=at));
 const previousHits=rules.flatMap(r=>r.hits.filter(h=>h.at>=r.enabledAt)).filter(h=>h.at>=start-span&&h.at<start).length;
 const humanDecided=decisions.filter(d=>d.source==='human'&&d.decidedAt>=start&&d.decidedAt<=at).length;
 const deaths=records.filter(d=>d.stopTriggeredAt&&d.decidedAt&&d.decidedAt<=at).map(d=>({work:d.work,delay:d.decidedAt-d.stopTriggeredAt}));
 const oldest=[...deaths].sort((a,b)=>b.delay-a.delay)[0];
 return {records,union:intervalUnion(intervals),workCount:new Set(records.map(d=>d.work)).size,waiting:totalWaiting,median:waitingMedian(at,span),rework:operatorRework.size,totalRework:allRework.size,redirects:redirected.length,unplanned:redirected.filter(r=>!r.fromCandidate).length,lost:redirected.reduce((sum,r)=>sum+r.displacedMs,0),hits:hits.length,delta:hits.length-previousHits,share:hits.length+humanDecided?hits.length/(hits.length+humanDecided)*100:0,death:quantile(deaths.map(d=>d.delay),.5),oldest:oldest?works.find(w=>w.id===oldest.work).name:'—'};
}
function sparkline(values,label){const max=Math.max(...values,1),min=Math.min(...values,0);return `<svg viewBox="0 0 160 36" role="img" aria-label="${label}: ${values.map(v=>v.toFixed(1)).join(', ')}"><polyline points="${values.map((v,i)=>`${i*160/Math.max(1,values.length-1)},${31-(v-min)/(max-min)*26}`).join(' ')}" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;}
function renderLedger(){
 const at=Date.now(),span=(period==='day'?24:168)*HOUR,m=metrics(at,span);
 const labels=['Waiting','Rework you caused','Redirects','Sunk to rules','Death delay'];
 const values=[elapsed(m.waiting),`${m.rework} / ${m.totalRework}`,`${m.redirects} (${m.unplanned} unplanned)`,`${m.hits} ${m.delta>=0?'↑':'↓'}${Math.abs(m.delta)}`,elapsed(m.death)];
 const details=[`median ${elapsed(m.median)}`,`${m.totalRework?(m.rework/m.totalRework*100).toFixed(0):0}%`,`lost ${elapsed(m.lost)}`,`${m.share.toFixed(0)}% of decisions`,`oldest: "${m.oldest}"`];
 const series=Array.from({length:7},(_,i)=>metrics(at-(6-i)*24*HOUR,span));
 const keys=['waiting','rework','redirects','hits','death'];
 const date=value=>new Date(value).toLocaleString('en-GB',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
 main.innerHTML=`<p class="mono">${period==='week'?'This week':'Today'} you were the bottleneck for ${elapsed(m.union)} across ${m.workCount} works.</p><div class="toolbar"><h1>Ledger</h1><label class="mono">Period <select id="period"><option value="week" ${period==='week'?'selected':''}>Week</option><option value="day" ${period==='day'?'selected':''}>Day</option></select></label></div><div class="metrics">${labels.map((label,i)=>`<section class="metric"><h2>${label}</h2><div class="metric-value">${escapeHTML(values[i])}</div><p class="mono">${escapeHTML(details[i])}</p>${sparkline(series.map(s=>s[keys[i]]),label)}</section>`).join('')}</div><div class="section-heading"><h2>Slowest 10 decisions</h2></div><div class="table-wrap"><table><thead><tr><th>Work</th><th>Asked</th><th>Decided</th><th>Waited</th><th>Chose</th><th>Effect</th></tr></thead><tbody>${m.records.sort((a,b)=>((b.decidedAt||at)-b.createdAt)-((a.decidedAt||at)-a.createdAt)).slice(0,10).map(d=>`<tr><td>${escapeHTML(getWork(d).name)}</td><td>${date(d.createdAt)}</td><td>${d.decidedAt?date(d.decidedAt):'—'}</td><td>${elapsed((d.decidedAt||at)-d.createdAt)}</td><td>${d.decidedAt?escapeHTML(d.action):'—'}</td><td>${d.effectAt?'verified':'—'}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderWorks(){main.innerHTML=`<h1>Works</h1><p class="subhead">${works.length} contracts. Every change carries a reason.</p>${works.map(w=>`<details class="work"><summary><h2>${escapeHTML(w.name)}</h2><span class="mono muted">${w.owner} · r${w.version} · ${w.state}</span></summary><dl class="facts contract">${[['Objective',w.objective],['Acceptance',w.acceptance],['Scope',w.scope],['Budget',`${w.budget} attempts`],['Risk boundary',w.risk],['Stop condition',w.stop]].map(([k,v])=>`<dt>${k}</dt><dd>${escapeHTML(v)}</dd>`).join('')}</dl><div class="history"><h2>Contract history</h2>${w.history.map(h=>`<p><span class="mono">r${h.version} · ${new Date(h.at).toLocaleString('en-GB')}</span><br>${escapeHTML(h.reason)}</p>`).join('')}</div></details>`).join('')}`;}
function renderCandidates(){main.innerHTML=`<h1>Candidates</h1><p class="subhead">${candidates.filter(c=>!c.promoted).length} ideas. Not work until the outcome is defined.</p><div class="grid-two">${candidates.map(c=>`<details class="work"><summary><h2>${c.name}</h2><span class="badge">${c.promoted?'promoted':'candidate'}</span></summary>${c.promoted?'<p>Contract r1 created. Available in Works.</p>':`<form class="candidate" data-candidate="${c.id}"><label>Objective<textarea name="objective" required placeholder="What outcome should change?">${escapeHTML(c.objective)}</textarea></label><label>Acceptance 1<input name="acceptance" required placeholder="What evidence is enough?" value="${escapeHTML(c.acceptance)}"></label><p class="muted">Promotion creates contract r1. No agent starts automatically.</p><button type="submit" ${c.objective.trim()&&c.acceptance.trim()?'':'disabled'}>promote → work</button></form>`}</details>`).join('')}</div>`;}
function renderAgents(){main.innerHTML=`<h1>Agents</h1><p class="subhead">Operational detail. No decisions here.</p><div class="table-wrap"><table><thead><tr><th>Agent</th><th>Session</th><th>Work</th><th>Tokens</th><th>State</th><th>Health</th></tr></thead><tbody>${works.slice(0,3).map((w,i)=>`<tr><td>worker-${i+1}</td><td><button class="text-button" data-session="d${i+1}">session-${i+1} ↗</button></td><td>${w.name}</td><td>${[18420,9210,12400][i].toLocaleString('en-US')}</td><td>${dot(w.state==='waiting'?'yellow':w.state==='stopped'?'green':'blue')} ${w.state}</td><td>last check received</td></tr>`).join('')}</tbody></table></div>`;}
function render(){document.title=`Overload — ${page[0].toUpperCase()+page.slice(1)}`;document.querySelector('nav').innerHTML=['decide','ledger','works','candidates','agents'].map(p=>`<a href="#${p}" ${page===p?'aria-current="page"':''}>${p[0].toUpperCase()+p.slice(1)}</a>`).join('');({decide:renderDecide,ledger:renderLedger,works:renderWorks,candidates:renderCandidates,agents:renderAgents})[page]();}
function resolve(d,action,reason=''){
 if(d.state!=='owed')return;
 const w=getWork(d),at=Date.now();
 Object.assign(d,{action,reason,decidedAt:at,effectAt:at,state:'receipt',hasStopCondition:true,before:`work: ${w.state} · worker held · contract r${d.version}`,after:action==='stop'?'work: stopped · worker released · worktree retained 1h':action==='narrow'?`work: running · checkpoint resumed · contract r${w.version}`:d.layer==='irreversible'?'authorized action completed · result archived':'work: running · checkpoint resumed · 1 retry added',verification:action==='stop'?'process exited, lease released':action==='narrow'?'contract saved, checkpoint restored':d.layer==='irreversible'?'authorized effect recorded':'checkpoint restored, attempt scheduled'});
 w.state=action==='stop'?'stopped':'running';announce(`${action} recorded. Effect verified at ${stamp(at)}.`);render();
 setTimeout(()=>{d.state='done';render();},3000);
}
function showModal(title,body){modal.innerHTML=`<div class="dialog-heading"><h2 id="modal-title">${title}</h2><button data-close="modal" aria-label="Close dialog">Close</button></div>${body}`;modal.showModal();}
function narrow(d){const w=getWork(d);drawer.innerHTML=`<div class="dialog-heading"><h2 id="drawer-title">Narrow contract</h2><button data-close="drawer">Close</button></div><p>${w.name} · <span class="mono">r${w.version} → r${w.version+1}</span></p><p class="muted">Reduce the allowed work. Resume from the retained checkpoint.</p><form id="narrow-form" data-id="${d.id}"><label>Scope<input name="scope" value="${escapeHTML(w.scope+' · verified core only')}" required></label><label>Attempt budget<input name="budget" type="number" min="1" max="${w.budget}" value="1" required></label><h3>Field diff</h3><div id="field-diff" class="diff mono"></div><label>Reason <span class="muted">required</span><textarea name="reason" required placeholder="Why is the smaller contract sufficient?"></textarea></label><p class="muted">Objective, acceptance, risk boundary, and stop condition remain unchanged.</p><div class="toolbar"><button type="button" data-close="drawer">Cancel</button><button type="submit" disabled>Apply r${w.version+1}</button></div></form>`;drawer.showModal();updateNarrow();}
function updateNarrow(){const form=document.querySelector('#narrow-form');if(!form)return;const w=getWork(decisions.find(d=>d.id===form.dataset.id));const scope=form.elements.scope.value,budget=Number(form.elements.budget.value);document.querySelector('#field-diff').innerHTML=`<del>− scope: ${escapeHTML(w.scope)}</del><ins>+ scope: ${escapeHTML(scope)}</ins><del>− budget: ${w.budget} attempts</del><ins>+ budget: ${budget} attempts</ins>`;form.querySelector('[type=submit]').disabled=!form.elements.reason.value.trim()||!scope.trim()||!form.checkValidity()||(scope===w.scope&&budget===w.budget);}
document.addEventListener('click',event=>{
 const b=event.target.closest('button');if(!b)return;
 if(b.dataset.close){document.getElementById(b.dataset.close).close();return;}
 if(b.dataset.toggle){const d=decisions.find(d=>d.id===b.dataset.toggle);d.expanded=!d.expanded;render();document.querySelector(`[data-toggle="${d.id}"]`).focus();}
 if(b.dataset.done){showDone=!(showDone&&doneFilter===b.dataset.done);doneFilter=b.dataset.done;render();}
 if(b.dataset.action){const d=decisions.find(d=>d.id===b.dataset.id);if(b.dataset.action==='narrow'){narrow(d);return;}if(d.layer==='irreversible'){showModal('Confirm decision',`<p>${escapeHTML(d.question)}</p><p class="muted">${b.dataset.action==='continue'?'This authorizes an irreversible external effect. It cannot be undone.':'This stops the work and releases its worker. The worktree is retained for 1h.'}</p><div class="diff mono">${escapeHTML(d.evidence)}</div><div class="toolbar"><button data-close="modal">Cancel</button><button data-confirm="${d.id}" data-choice="${b.dataset.action}">Confirm ${b.dataset.action}</button></div>`);}else resolve(d,b.dataset.action);}
 if(b.dataset.confirm){modal.close();resolve(decisions.find(d=>d.id===b.dataset.confirm),b.dataset.choice);}
 if(b.dataset.session||b.dataset.artifacts){const d=decisions.find(d=>d.id===(b.dataset.session||b.dataset.artifacts));showModal(b.dataset.session?'Original session':'Evidence artifacts',`<p>${escapeHTML(getWork(d).name)} · <span class="mono">${d.id} / checkpoint c18</span></p><div class="diff mono">${escapeHTML(d.evidence)}</div><p class="muted">Retained transcript: contract boundary reached. Worker exited after checkpoint. ${d.state==='owed'?'Waiting for operator judgment.':'Decision effect recorded.'}</p><p>Local demo context. No live session is opened or restarted.</p>`);}
 if(b.dataset.batch){const bounded=owed().filter(d=>d.layer==='bounded');modal.close();bounded.forEach(d=>resolve(d,b.dataset.batch,'Batch decision within contract boundary.'));}
});
document.addEventListener('input',event=>{if(event.target.closest('#narrow-form'))updateNarrow();const form=event.target.closest('[data-candidate]');if(form){const c=candidates.find(c=>c.id===form.dataset.candidate);c.objective=form.elements.objective.value;c.acceptance=form.elements.acceptance.value;form.querySelector('button').disabled=!c.objective.trim()||!c.acceptance.trim();}});
document.addEventListener('submit',event=>{
 event.preventDefault();const form=event.target;
 if(form.id==='narrow-form'){updateNarrow();if(form.querySelector('[type=submit]').disabled)return;const d=decisions.find(d=>d.id===form.dataset.id),w=getWork(d);const reason=form.elements.reason.value.trim();w.scope=form.elements.scope.value.trim();w.budget=Number(form.elements.budget.value);w.version++;contractRevisions.push({work:w.id,at:Date.now(),author:'operator',reason,supersededCards:[d.id]});w.history.unshift({version:w.version,reason,at:Date.now()});drawer.close();resolve(d,'narrow',reason);}
 if(form.dataset.candidate){const c=candidates.find(c=>c.id===form.dataset.candidate);if(!c.objective.trim()||!c.acceptance.trim())return;c.promoted=true;works.push({id:`w-${c.id}`,name:c.name,owner:'operator',version:1,objective:c.objective.trim(),acceptance:c.acceptance.trim(),scope:'Not assigned',budget:1,risk:'No external effects without approval.',stop:'Stop after one failed acceptance check.',state:'ready',history:[{version:1,reason:'Promoted with objective and acceptance.',at:Date.now()}]});announce(`${c.name} promoted to work.`);render();}
});
document.addEventListener('change',event=>{if(event.target.id==='period'){period=event.target.value;render();}});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(drawer.open||modal.open)return;const bounded=owed().filter(d=>d.layer==='bounded');showModal('Batch bounded decisions',`<p class="mono">${bounded.length} bounded decisions eligible · ${owed().filter(d=>d.layer==='irreversible').length} irreversible excluded</p><p class="muted">Only yellow rows are affected. Red rows require individual confirmation.</p><div class="list">${bounded.map(d=>`<div class="row">${dot('yellow')} ${escapeHTML(getWork(d).name)} · ${d.id}</div>`).join('')||'<div class="row">No bounded decisions owed.</div>'}</div><div class="toolbar"><button data-batch="stop" ${bounded.length?'':'disabled'}>Stop bounded</button><button data-batch="continue" ${bounded.length?'':'disabled'}>Continue bounded</button></div>`);}});
window.addEventListener('hashchange',()=>{const target=location.hash.slice(1);page=['decide','ledger','works','candidates','agents'].includes(target)?target:'decide';render();});
page=['decide','ledger','works','candidates','agents'].includes(location.hash.slice(1))?location.hash.slice(1):'decide';render();
