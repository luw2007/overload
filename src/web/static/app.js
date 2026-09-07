(() => {
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const e = escapeHtml;
  const pages = ['decide','ledger','works','candidates','rules','agents'];
  const LEGACY_ZONE = {now:'decide',inbox:'decide',done:'decide',q1:'agents',hung:'agents',q2:'agents',zombie:'agents',archive:'agents',sessions:'agents',health:'agents'};
  const state = {page:'decide',attention:{now:[],inbox:[],done:[]},rules:null,ledger:null,works:[],selected:new Set(),session:null,detail:null,q1:[],q2:[],archive:[],hung:[],zombie:{groups:[],orphaned_requests:[]},sessions:[],health:null,range:'week'};
  let generation = 0;
  const formatTime = value => value == null ? '—' : new Date(value).toLocaleString();
  const humanDuration = ms => ms == null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
  function showError(error) { $('error').hidden = false; $('error').textContent = error.message || String(error); }
  async function fetchJson(path, options) { const response = await fetch(path, options); const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }
  const post = (path, body = {}) => fetchJson(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const button = (label, action, id = '', extra = '') => `<button data-action="${action}" data-id="${e(id)}" ${extra}>${e(label)}</button>`;
  const empty = text => `<div class="empty">${e(text)}</div>`;
  const head = (title,subtitle) => `<div class="page-head"><div><h1>${e(title)}</h1><p class="subtitle">${e(subtitle)}</p></div></div>`;
  const json = data => `<pre>${e(JSON.stringify(data,null,2))}</pre>`;
  function sourceLink(value) { if (!value) return ''; try { const url = new URL(value,location.origin); if (!['http:','https:'].includes(url.protocol)) return `<code>${e(value)}</code>`; return `<a href="${e(url.href)}" target="_blank" rel="noopener noreferrer">↗ open session</a>`; } catch { return `<code>${e(value)}</code>`; } }
  function dialog(id,title,body,footer='') { const el=$(id); el.innerHTML=`<div class="dialog-head"><h2 id="${id}-title">${e(title)}</h2>${button('×','dismiss',id,'aria-label="Close"')}</div><div class="dialog-body">${body}</div>${footer?`<div class="dialog-foot">${footer}</div>`:''}`; if (!el.open) el.showModal(); }
  const duration = ms => {const hours=Math.max(0,ms||0)/3600000;return hours>=1?`${Number(hours.toFixed(1))}h`:`${Math.round(hours*60)}m`;};
  const stamp = value => value == null?'—':new Date(value).toLocaleTimeString('en-GB',{hour12:false});
  const dot = color => `<span class="dot ${color}"></span>`;
  const expanded = new Set(), receipts = new Map();
  const consequence={stop:'releases repo, work → stopped',continue:'spends nothing new; you accept the remaining budget',narrow:'requires new contract; supersedes other open cards'};
  function spark(series) {const max=Math.max(1,...series);return `<svg class="sparkline" viewBox="0 0 100 28" aria-hidden="true"><polyline points="${series.map((v,i)=>`${i*100/Math.max(1,series.length-1)},${27-v/max*25}`).join(' ')}"/></svg>`;}
  function metric(label,value,detail,series){return `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-detail">${detail}</div>${spark(series)}</div>`;}
  function decideTopLine(items,selfResolved) {const expiring=items.filter(x=>x.expires_at!=null),oldest=Math.max(0,...items.map(x=>Date.now()-x.created_at));return `${items.length} decisions owed · ${expiring.length?`${expiring.length} expires in ${duration(Math.min(...expiring.map(x=>x.expires_at))-Date.now())}`:'0 expiring'} · oldest waiting ${duration(oldest)} · <button class="text-button" data-done="automatic">agents self-resolved ${selfResolved} today</button> · ${state.today.rules.hits} answered by rules today`;}
  function automationReason(item) {if(state.rules.bot_disabled)return 'bot disabled';if(item.decision_mode==='human_only')return 'human-only by contract';const r=state.rules.rules.find(r=>r.state==='observing' && (r.scope.includes(item.work_id)||(item.evidence?.repo && r.scope.includes(item.evidence.repo))));return r?`rule ${r.id} proposed · observing ${r.observed}/5`:'no enabled rule matches';}
  function decisionRow(item) {const waited=duration(Date.now()-item.created_at),red=(item.decision_mode==='human_only'&&!item.item_id.startsWith('stop:'))||(item.expires_at!=null&&item.expires_at<=Date.now());return `<div class="row"><div>${dot(red?'red':'yellow')}</div><div><div class="row-title"><button class="text-button" data-action="expand" data-id="${e(item.item_id)}" aria-expanded="${expanded.has(item.item_id)}">${e(item.conclusion)}${item.conclusion.endsWith('?')?'':'?'}</button><span class="mono muted">${e(item.owner)} · r${item.contract_revision}</span></div><div class="row-note">${e(item.trigger)}</div>${expanded.has(item.item_id)?`<div class="facts"><b>Why now</b><span>${e(item.trigger)}</span><b>Impact</b><span>${e(item.impact)}</span><b>Evidence</b><span class="mono">${e(JSON.stringify(item.evidence))}</span><b>Options</b><span>${item.options.map(option=>`${e(option)} → ${e(consequence[option]||option)}`).join('<br>')}</span><b>Waiting</b><span>${waited} (your median this week: ${duration(state.ledger.waiting.median_ms)})</span><b>Automation</b><span>${e(automationReason(item))}</span></div>`:''}</div><span class="mono muted">${waited}</span><div class="actions">${item.options.map(option=>button(option,'resolve',item.item_id,`data-option="${e(option)}"`)).join('')}${sourceLink(item.source_link)}</div></div>`;}
  function receipt(item) {return `<div class="row receipt"><div>✓</div><div><div class="row-title">${e(item.conclusion)}</div><span class="mono muted">${e(item.owner)} · ${stamp(item.updated_at)} · effect ${item.effect_state==='succeeded'?'verified':'pending'}</span></div></div>`;}
  function renderDecide() {const items=[...state.attention.now,...state.attention.inbox],automatic=state.attention.done.filter(x=>x.decision_mode==='scoped_auto'&&x.state==='resolved'&&x.updated_at>=Date.now()-86400000);return `<h1>Decide</h1><div class="summary">${decideTopLine(items,automatic.length)}</div>${items.length||receipts.size?`<div class="section-heading"><h2>Owed to the system</h2><small>Now · ${items.length} decisions · expand for evidence</small></div><div class="list">${items.map(x=>receipts.get(x.item_id)||decisionRow(x)).join('')}${[...receipts].filter(([id])=>!items.some(x=>x.item_id===id)).map(([,html])=>html).join('')}</div>`:empty(`Nothing owed. Agents self-resolved ${automatic.length} decisions today.`)}<div class="section-heading"><h2>Within contract</h2><small>Automatic · no decision required</small></div><div class="list auto">${dot('blue')}<span><strong class="mono">${automatic.length}</strong> handled without you</span><button class="text-button" data-done="automatic">Inspect Done ↗</button></div><div class="section-heading"><h2>Done <span class="muted mono">${state.attention.done.length}</span></h2><button data-done="all">Show receipts</button></div>`;}
  function renderLedger() {const m=state.ledger,pct=m.rework.total?Math.round(m.rework.caused/m.rework.total*100):0;return `<div class="toolbar"><h1>Ledger</h1><select id="period" aria-label="Ledger period"><option value="week" ${state.range==='week'?'selected':''}>This week</option><option value="day" ${state.range==='day'?'selected':''}>Today</option></select><button data-action="export">Export CSV</button></div><p class="summary">${state.range==='week'?'This week':'Today'} you were the bottleneck for ${duration(m.bottleneck.total_ms)} across ${m.bottleneck.work_count} works.${m.coverage<1?` · coverage ${Math.round(m.coverage*100)}%`:''}</p><div class="metrics">${metric('Waiting',duration(m.waiting.total_ms),`median ${duration(m.waiting.median_ms)}`,m.waiting.series)}${metric('Rework you caused',`${m.rework.caused} / ${m.rework.total}`,`${pct}%`,m.rework.series)}${metric('Redirects',`${m.redirects.count} (${m.redirects.unplanned} unplanned)`,`lost ${duration(m.redirects.lost_ms)}`,m.redirects.series)}${metric('Sunk to rules',`${m.rules.hits} ${m.rules.delta>=0?'↑':'↓'}${Math.abs(m.rules.delta)}`,`${m.rules.share.toFixed(0)}% of decisions`,m.rules.series)}${metric('Death delay',duration(m.death.median_ms),`oldest: &quot;${e(m.death.oldest?.title??'—')}&quot;`,m.death.series)}</div><h2>Slowest decisions</h2><p class="muted">Waiting = asked → decided, or now while still owed. Raw rows behind the median.</p><table><thead><tr><th>Work</th><th>Asked</th><th>Decided</th><th>Waited</th><th>Chose</th><th>Effect</th></tr></thead><tbody>${m.slowest.map(r=>`<tr><td>${e(r.title)}</td><td class="mono">${stamp(r.asked_at)}</td><td class="mono">${stamp(r.decided_at)}</td><td class="mono">${duration(r.waited_ms)}</td><td>${e(r.chose??'—')}</td><td>${e(r.effect_state??'—')}</td></tr>`).join('')}</tbody></table>`;}
  function contractFacts(w) {const c=w.contract;return `<div class="facts"><b>Objective</b><span>${e(c?.objective??'—')}</span><b>Acceptance</b><span>${(c?.acceptance||[]).map(x=>e(x.description)).join('<br>')||'—'}</span><b>Scope</b><span class="mono">${e(JSON.stringify(c?.scope??null))}</span><b>Budget</b><span class="mono">${e(JSON.stringify(c?.budget??null))}</span><b>Stop conditions</b><span>${(c?.stop_conditions||[]).map(x=>e(x.description)).join('<br>')||'—'}</span><b>Decision owner</b><span>${e(c?.decision_owner??'—')}</span></div><p class="mono muted">updated ${stamp(w.updated_at)}</p>`;}
  function renderWorks() {return `<h1>Works</h1><p class="muted">Contracts, not agent transcripts.</p>${state.works.filter(w=>w.state!=='candidate').map(w=>`<details class="work"><summary>${e(w.title)} <span class="mono muted">${e(w.state)} · r${w.revision}</span></summary>${contractFacts(w)}</details>`).join('')}`;}
  function renderCandidates() {const candidates=state.works.filter(w=>w.state==='candidate');
    // Active operator works created this week are the best available promotion signal; no promoted_at exists.
    const promoted=state.works.filter(w=>w.state==='active'&&w.source==='operator'&&w.created_at>=Date.now()-7*86400000).length;
    return `<h1>Candidates</h1><p class="summary">${candidates.length} candidates · ${promoted} promoted this week · ${candidates.filter(w=>w.created_at<Date.now()-14*86400000).length} older than 14 days</p><form id="capture" class="capture"><input name="idea" id="candidate-title" aria-label="New candidate" placeholder="Capture an idea without interrupting active work…" required><button>Add candidate</button></form><div class="list">${candidates.map(w=>`<div class="row"><span>${dot('blue')}</span><div><div class="row-title">${e(w.title)} <span class="mono muted">${Math.floor((Date.now()-w.created_at)/86400000)}d old</span></div><details><summary>Promote to work</summary><form class="promote" data-id="${e(w.work_id)}"><label>Objective<textarea name="objective" required></textarea></label><label>Acceptance<textarea name="acceptance" required></textarea></label><button disabled>Promote</button></form></details></div><span class="mono muted">candidate</span></div>`).join('')}</div>`;}
  function renderRules() {const rows=state.rules.rules;return `<h1>Rules</h1><p class="summary">${rows.length} rules · ${rows.filter(r=>r.state==='enabled').length} enabled · ${rows.filter(r=>r.state==='observing').length} observing · ${state.rules.hits_week} hits this week</p><table><thead><tr><th>Rule</th><th>Scope</th><th>Answer</th><th>Observed</th><th>Matched</th><th>State</th><th>Enabled</th><th>Action</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${e(r.name)}<br><span class="mono muted">${e(r.id)}</span></td><td>${e(r.scope)}</td><td>${e(r.answers.join(', '))}</td><td class="mono">${r.observed}</td><td class="mono">${r.matched}</td><td><span class="badge">${e(r.state)}</span></td><td>${r.state==='enabled'?`yes<br><span class="mono muted">enabled · ${e(r.enabled_by??'you')} · ${stamp(r.enabled_at)}</span>`:'no'}</td><td>${r.source==='config'?'':r.state==='awaiting_approval'?button('approve','approve-rule',r.candidate_id):r.state==='observing'?`${button('enable','enable-rule',r.candidate_id,r.observed>=5&&r.matched===r.observed?'':'disabled')}${r.observed>=5&&r.matched===r.observed?'':'<span class="mono muted">needs 5 observed</span>'}`:''}</td></tr>`).join('')}</tbody></table><p class="muted">Rules answer on your behalf only when they match exactly. Every enable is signed by you.</p>`;}
  const bindingFor = (row) => row.binding ?? (row.host && row.host !== "local" ? `ssh ${row.host}` : "-");
  const formatDuration = (ms) => {
    const minutes = Math.floor(ms / 60000);
    return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  };
  const hungLabel = { turn_hung: "无进展", dead_connection: "连接已死" };
  const hungImpact = { turn_hung: "回合已停滞，上下文持续占用", dead_connection: "连接已断，会话无法继续" };
  const ASK_IMPACT = "会话挂起等待回答，此期间无进展";
  const ageText = (ms) => { const seconds = Math.floor(ms / 1000); if (seconds < 60) return `${seconds} 秒`; const minutes = Math.floor(ms / 60000); return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`; };
  const AGE_WARN_MS = 30 * 60 * 1000;
  const zombieHint = { stalled: "事件流已停止，需人工确认会话是否还在运行。", dead_incarnation: "进程已消失，记录保留供核查，无需动作。", telemetry_gap: "遥测出现缺口，可能丢失部分事件。", handoff_blocked: "Agent 已交接但未完成：决定是续跑、改派还是关闭。" };
  const handoffStatus = { partial: "部分完成", blocked: "受阻", complete: "已完成", unknown: "状态不明" };
  // AGENTS.md 决策卡最小载荷：结论、证据、要决定什么。HANDOFF.md 的字段就是那三样，卡上直接摆出来，不让人再去开文件。
  const handoffLine = (handoff) => handoff
    ? `<div class="impact-line">${escapeHtml(handoffStatus[handoff.status] ?? handoff.status)} · 未决 ${escapeHtml(handoff.uncertainties)} 项${handoff.task ? ` · ${escapeHtml(handoff.task)}` : ""}${handoff.next_owner ? ` · 下一责任人 ${escapeHtml(handoff.next_owner)}` : ""} · <code>${escapeHtml(handoff.path)}</code></div>`
    : "";

  const ageChip = value => e(value == null ? '—' : humanDuration(Date.now()-value));
  const keyValueTable = rows => `<dl>${rows.map(([key,value])=>`<dt>${e(key)}</dt><dd>${value}</dd>`).join('')}</dl>`;
  function resumeCapability(row) { const available=row.resume_capability?.resumable; const adapter=row.resume_capability?.runtime; return available ? `<button class="resume" data-id="${e(row.stable_id)}" data-adapter="${e(adapter)}">Resume</button>` : `<span class="meta">${e(row.resume_capability?.reason || 'Resume unavailable')}</span>`; }
  function rowCheckbox(id) {
    return `<input class="row-select" type="checkbox" data-id="${escapeHtml(id)}" ${state.selected.has(id) ? "checked" : ""} aria-label="选择 ${escapeHtml(id)}">`;
  }

  /** Every stable_id in the product is a door into the session's own history. */
  function sessionLink(id) {
    return `<a href="#" class="drill" data-id="${escapeHtml(id)}">${escapeHtml(id)}</a>`;
  }

  function missingJumpTarget(row) {
    return row.host_probe_error ? `跳转目标探测失败：${escapeHtml(row.host_probe_error)}` : "暂无可跳转目标";
  }

  /** Binding chip + copy/open pair, shared by decision cards and hung cards. */
  function jumpActions(row, idField, route) {
    const chip = `<span class="chip">${escapeHtml(bindingFor(row))}</span>`;
    if (!row.binding) return `${chip}<span>${missingJumpTarget(row)}</span>`;
    const routeAttr = route ? ` data-route="${route}"` : "";
    return `${chip} <button class="btn copy-jump" data-binding="${escapeHtml(row.binding)}">复制</button><button class="btn primary jump" data-id="${escapeHtml(row[idField])}"${routeAttr} data-binding="${escapeHtml(row.binding)}">打开</button><span class="jump-status" aria-live="polite"></span>`;
  }

  function decisionCard(row) {
    const isOrchestratorGate = row.detail && typeof row.detail.gate === "string";
    const approvalId = row.detail?.approval_id ?? row.detail?.request_id;
    const consumerOwner = row.detail?.consumer_owner ?? (row.detail?.gate === "action" ? "extension" : "orchestrator");
    const age = Date.now() - row.created_at;
    const options = Array.isArray(row.options) && row.options.length ? `<div class="option-chips">${row.options.map((option) => isOrchestratorGate && approvalId ? `<button class="btn primary approve" data-approval-id="${escapeHtml(approvalId)}" data-consumer-owner="${escapeHtml(consumerOwner)}" data-answer="${escapeHtml(option)}">${escapeHtml(option)}</button>` : `<span class="option-chip">${escapeHtml(option)}</span>`).join("")}</div>` : "";
    const gate = isOrchestratorGate ? `<div class="meta">门禁：${escapeHtml(row.detail.gate)}${row.detail.class ? ` · 类别：${escapeHtml(row.detail.class)}` : ""}${row.detail.rule ? ` · 规则：${escapeHtml(row.detail.rule)}` : ""}${row.detail.command ? ` · 命令：${escapeHtml(row.detail.command)}` : ""}${row.detail.bot_status ? ` · 决策机器人：${escapeHtml(row.detail.bot_status)}${row.detail.bot_outcome ? ` (${escapeHtml(row.detail.bot_outcome)})` : ""}` : ""}</div>` : "";
    return `<article class="card decision-card">${rowCheckbox(row.request_uid)}<div class="card-main"><div class="headline"><span class="dot red"></span>${escapeHtml(row.summary || row.detail?.question || row.detail?.prompt || `${row.kind} 需要决策`)}</div><div class="meta">${sessionLink(row.stable_id)} · ${escapeHtml(row.host || "未知主机")} · <span class="age-chip${age >= AGE_WARN_MS ? " age-warn" : ""}">等待 ${ageText(age)}</span></div>${gate}<div class="impact-line">${ASK_IMPACT}</div>${options}</div><div class="actions"><button class="btn danger ack" data-id="${escapeHtml(row.request_uid)}">确认并归档</button>${jumpActions(row, "request_uid", "q1")}</div></article>`;
  }

  function hungCard(row) {
    const evidence = row.detail?.local ? `${row.detail.local} -> ${row.detail.peer}` : bindingFor(row);
    const resumeBtn = resumeCapability(row);
    return `<article class="decision-card hung">
      <div class="decision-card-head"><strong>${sessionLink(row.stable_id)}</strong><span class="chip">${escapeHtml(hungLabel[row.q5_reason] ?? row.q5_reason)}</span></div>
      <div class="impact-line">${escapeHtml(hungImpact[row.q5_reason] ?? "会话异常，需人工确认")}</div>
      <div class="decision-card-meta">卡住 ${escapeHtml(formatDuration(row.hung_ms))} · 最后进展 ${ageChip(row.since)}</div>
      <div class="decision-card-meta">证据 <code>${escapeHtml(evidence)}</code></div>
      <div class="decision-card-actions">${jumpActions(row, "stable_id", "jump-session")}${resumeBtn}</div>
    </article>`;
  }

  const evidenceText = (evidence) => Object.keys(evidence || {}).length ? JSON.stringify(evidence) : "暂无附加证据";
  function closeoutCard(row) { return `<article class="card">${rowCheckbox(row.stable_id)}<div class="card-main">${sessionLink(row.stable_id)}<div class="meta">${e(row.origin)} · ${e(formatTime(row.last_event_at))}</div></div><button class="closeout" data-id="${e(row.stable_id)}">Close out</button></article>`; }
  function zombieCard(group) { return `<article class="card"><div class="card-main"><h3>${e(group.q5_reason)}</h3><p>${e(zombieHint[group.q5_reason] || 'Needs review.')}</p>${(group.rows||[]).map(row=>`<div class="inline">${sessionLink(row.stable_id)} · ${e(formatTime(row.last_event_at))}${resumeCapability(row)}${jumpActions(row,'stable_id','jump-session')}${handoffLine(row.handoff)}</div>`).join('')}</div></article>`; }
  function renderDetail() {
    const view = state.detail;
    if (!view) { $("detail").innerHTML = "<p class='empty'>加载中…</p>"; return; }
    const s = view.session;
    const clocks = `事件 ${formatTime(s.last_event_at)} · 进展 ${formatTime(s.last_progress_at)} · 心跳 ${formatTime(s.last_heartbeat_at)}`;
    const head = keyValueTable([
      ["会话", escapeHtml(s.stable_id)],
      ["状态", `${escapeHtml(s.state)}${s.queue ? ` <span class="chip">${escapeHtml(s.q5_reason ? `${s.queue}/${s.q5_reason}` : s.queue)}</span>` : ""}`],
      ["运行时 / 来源", `${escapeHtml(s.runtime)} / ${escapeHtml(s.origin)}`],
      ["宿主 App", escapeHtml(s.app ?? "-")],
      ["工作区", `${escapeHtml(s.cwd)}${s.branch ? ` (${escapeHtml(s.branch)})` : ""}`],
      ["时钟", escapeHtml(clocks)],
      ["跳转", jumpActions(s,"stable_id","jump-session")],
    ]);
    const replacement = view.latest_surface_session
      ? `<article class="decision-card"><strong>此 surface 已有较新会话</strong><div class="session-meta">${escapeHtml(view.latest_surface_session.state ?? "unknown")} · 最后事件 ${escapeHtml(formatTime(view.latest_surface_session.last_event_at))}</div><div class="session-actions">${sessionLink(view.latest_surface_session.stable_id)}</div></article>`
      : "";
    const incarnations = view.incarnations.length
      ? `<table class="b-table"><thead><tr><th>写入者</th><th>域</th><th>pid</th><th>启动</th><th>最后可见</th></tr></thead><tbody>${view.incarnations.map((row) => `<tr><td>${escapeHtml(row.writer_id)}</td><td>${escapeHtml(row.liveness_domain)}</td><td>${escapeHtml(row.pid)}</td><td>${escapeHtml(formatTime(row.started_at))}</td><td>${escapeHtml(formatTime(row.last_seen_at))}</td></tr>`).join("")}</tbody></table>`
      : "<p class='empty'>没有进程记录</p>";
    const requests = view.pending_requests.length
      ? `<table class="b-table"><tbody>${view.pending_requests.map((row) => `<tr><td>${escapeHtml(row.request_uid)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(formatTime(row.created_at))}</td><td><code>${escapeHtml(JSON.stringify(row.detail ?? {}))}</code></td></tr>`).join("")}</tbody></table>`
      : "<p class='empty'>没有待决策请求</p>";
    const events = view.events.length
      ? `<table class="b-table"><thead><tr><th>#</th><th>时间</th><th>事件</th><th>详情</th></tr></thead><tbody>${view.events.map((row) => `<tr><td>${escapeHtml(row.ingest_seq)}</td><td>${escapeHtml(formatTime(row.at))}</td><td>${escapeHtml(row.kind)}</td><td><code>${escapeHtml(JSON.stringify(row.detail ?? {}))}</code></td></tr>`).join("")}</tbody></table>`
      : "<p class='empty'>没有事件</p>";
    $("detail").innerHTML = `<p><button class="btn" id="detail-back">← 返回会话列表</button></p>${replacement}${head}${resumeCapability(state.sessions.find(row=>row.stable_id===s.stable_id)||s)}
      <h3>进程</h3>${incarnations}<h3>待决策</h3>${requests}
      <h3>事件（最新在前，已隐藏 heartbeat）</h3>${events}`;

  }

  function renderAgents() {
    return head('Agents','Session diagnostics and legacy recovery actions.')+`<div id="agent-summary" class="meta">${e(state.health?.open_incidents?.length||0)} open incidents · ${e(state.health?.coverage_gaps||0)} coverage gaps · ${e(state.health?.telemetry_gaps||0)} telemetry gaps</div><div id="agent-status" role="status"></div><section id="detail"></section><section id="content"><h2>Decision requests</h2>${button('Acknowledge selected','bulk-ack')}${state.q1.map(decisionCard).join('')||empty('No decision requests.')}<h2>Hung sessions</h2>${state.hung.map(hungCard).join('')||empty('No hung sessions.')}<h2>Closeout</h2>${button('Close out selected','bulk-closeout')}${button('Clear selection','clear-selection')}${state.q2.map(closeoutCard).join('')||empty('No closeout requests.')}<h2>Zombie / handoff</h2>${state.zombie.groups.map(zombieCard).join('')||empty('No zombie groups.')}<h3>Orphaned requests</h3>${state.zombie.orphaned_requests.map(r=>`<article class="card">${e(r.summary || r.request_uid)}${button('Acknowledge','orphan-ack',r.request_uid)}</article>`).join('')||empty('No orphaned requests.')}<h2>Sessions</h2><div class="table-wrap"><table><thead><tr><th>Session</th><th>Agent</th><th>Host</th><th>State / queue</th><th>Last event</th></tr></thead><tbody>${state.sessions.map(r=>`<tr><td>${sessionLink(r.stable_id)} ${resumeCapability(r)} ${jumpActions(r, "stable_id", "jump-session")}</td><td>${e(r.agent)}</td><td>${e(r.host)}</td><td>${e(r.run_state)} · ${e(r.queue)}</td><td>${e(formatTime(r.last_event_at))}</td></tr>`).join('')}</tbody></table></div><h2>Archive</h2><div class="table-wrap"><table><thead><tr><th>Session</th><th>Kind</th><th>Status</th><th>Time</th><th>Summary</th></tr></thead><tbody>${state.archive.map(r=>`<tr><td>${sessionLink(r.stable_id)}</td><td>${e(r.origin)}</td><td>${r.closed_out?'Closed out':'Archived'}</td><td>${e(formatTime(r.last_event_at))}</td><td>${e(r.state || r.run_state)}</td></tr>`).join('')}</tbody></table></div><h2>Health</h2>${json(state.health)}</section>`;
  }
  function render() { document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===state.page)); $('main').innerHTML=({decide:renderDecide,ledger:renderLedger,works:renderWorks,candidates:renderCandidates,rules:renderRules,agents:renderAgents})[state.page](); if(state.page==='agents' && state.session) { $('content').hidden=true; renderDetail(); } }
  async function refresh() {
    const current=++generation, page=state.page;
    const since=state.range==='all'?0:Date.now()-(state.range==='week'?7:1)*86400000;
    try {
      let data={};
      const rulesPromise=fetchJson('/api/rules');
      const pagePromise=(async()=>{
        if(page==='decide') { const [now,inbox,done,today,ledger]=await Promise.all(['now','inbox','done'].map(z=>fetchJson(`/api/attention/${z}`)).concat(fetchJson(`/api/ledger?since=${Date.now()-86400000}`),fetchJson(`/api/ledger?since=${Date.now()-7*86400000}`))); return {attention:{now,inbox,done},today,ledger}; }
        if(page==='ledger') return {ledger:await fetchJson(`/api/ledger?since=${since}`)};
        if(page==='works'||page==='candidates') return {works:await fetchJson('/api/works')};
        if(page==='agents') { const keys=['q1','q2','hung','zombie','sessions','health','archive']; const rows=await Promise.all(keys.map(k=>fetchJson(`/api/${k}`))); const result=Object.fromEntries(keys.map((k,i)=>[k,rows[i]])); if(state.session)result.detail=await fetchJson(`/api/sessions/${encodeURIComponent(state.session)}`); return result; }
        return {};
      })();
      const [rules,result]=await Promise.all([rulesPromise,pagePromise]); data={...result,rules};
      if(current!==generation || page!==state.page)return;
      Object.assign(state,data); $('bot-toggle').textContent=`bot · ${rules.bot_disabled?'off':'on'}`; $('bot-toggle').setAttribute('aria-pressed',String(!rules.bot_disabled)); render();
    } catch(error) { if(current===generation)showError(error); }
  }
  async function restoreRoute() { const parts=location.pathname.split('/').filter(Boolean), original=parts[0]; state.page=LEGACY_ZONE[original]||original||'decide'; if(!pages.includes(state.page))state.page='decide'; state.session=state.page==='agents' && (original==='sessions'||original==='agents') && parts[1]?decodeURIComponent(parts[1]):null; history.replaceState(null,'',`/${state.page}${state.session?'/'+encodeURIComponent(state.session):''}`); $('main').innerHTML=empty('Loading…'); await refresh(); if(original==='done')showDone(); }
  async function navigate(page,session=null) { $('drawer').close(); $('modal').close(); state.selected.clear(); history.pushState(null,'',`/${page}${session?'/'+encodeURIComponent(session):''}`); await restoreRoute(); }
  function findAttention(id) { return [...state.attention.now,...state.attention.inbox,...state.attention.done].find(x=>x.item_id===id); }
  function showDone() { dialog('drawer','Done',state.attention.done.map(x=>`<article class="receipt"><h3>${e(x.conclusion)}</h3><p>${e(x.state)} · ${e(x.effect_state)}</p>${sourceLink(x.source_link)}${json(x.evidence)}</article>`).join('')||empty('Nothing done yet.')); }
  async function openWork(id) {const w=await fetchJson(`/api/works/${encodeURIComponent(id)}`);dialog('drawer',w.title,`<p class="mono">r${w.revision}</p>${contractFacts(w)}`);}
  let editor=null;
  async function openNarrow(item) { const [detail,now,inbox]=await Promise.all([fetchJson(`/api/works/${encodeURIComponent(item.work_id)}`),fetchJson('/api/attention/now'),fetchJson('/api/attention/inbox')]); const n=[...now,...inbox].filter(x=>x.work_id===item.work_id && x.item_id!==item.item_id && x.state==='open').length; editor={kind:'narrow',item}; dialog('drawer','Narrow scope',`<label class="field">Replacement contract JSON<textarea id="replacement" rows="18">${e(JSON.stringify(detail.contract,null,2))}</textarea></label><label class="field">Reason<input id="reason" required></label><p id="editor-error" class="form-error" role="status"></p>`,`<span>This revision will supersede ${n} open cards.</span>${button('Apply','apply-editor','','class="primary" disabled')}`); }
  function validateEditor() {const apply=document.querySelector('[data-action="apply-editor"]');if(!apply)return;try {const c=JSON.parse($('replacement').value);if(!c||Array.isArray(c)||typeof c!=='object')throw new Error('Contract must be a JSON object.');if(!$('reason').value.trim())throw new Error('Reason is required.');apply.disabled=false;$('editor-error').textContent='';}catch(error){apply.disabled=true;$('editor-error').textContent=error.message;}}
  async function applyEditor() {await post(`/api/attention/${encodeURIComponent(editor.item.item_id)}/resolve`,{expected_revision:editor.item.revision,selected_option:'narrow',replacement_contract:JSON.parse($('replacement').value),reason:$('reason').value.trim()});$('drawer').close();await refresh();}
  async function resolveItem(id,option) {const item=findAttention(id);if(option==='narrow')return openNarrow(item);const result=await post(item.approval_id?`/api/orchestrator/answer/${encodeURIComponent(item.approval_id)}`:`/api/attention/${encodeURIComponent(id)}/resolve`,item.approval_id?{answer:option,consumer_owner:item.consumer_owner}:{expected_revision:item.revision,selected_option:option});receipts.set(id,`<div class="row receipt">✓ ${e(option)} · you · ${stamp(Date.now())} · effect ${result.effect_state==='succeeded'?'verified':'pending'}</div>`);render();setTimeout(()=>{receipts.delete(id);refresh();},3000);}
  async function resume(button) {
    const stableId=button.dataset.id;
    if(button.dataset.adapter==='claude-code') { dialog('modal','Confirm resume',`<p>Claude Code resume creates a new tmux window. Confirm that you want to restart this terminated session.</p>`,`${buttonHtmlResume(stableId)}${windowCancel()}`); return; }
    await performResume(stableId);
  }
  function buttonHtmlResume(id) { return button('Resume','confirm-resume',id,'class="primary"'); }
  function windowCancel() { return button('Cancel','dismiss','modal'); }
  async function performResume(id) { const result=await post(`/api/resume-session/${encodeURIComponent(id)}`); $('modal').close(); await refresh(); const status=$('agent-status'); if(status)status.textContent=`Resume: ${result.resumed ? 'started' : result.reason || 'submitted'}${result.new_binding?' · '+result.new_binding:''}`; }
  async function jump(target) {
    const status=target.parentElement.querySelector('.jump-status');
    try { const result=await post(`/api/${target.dataset.route || 'jump'}/${encodeURIComponent(target.dataset.id)}`); if(result.opened) {if(status)status.textContent='已打开并聚焦目标终端';return;} if(result.error)showError(new Error(result.error)); }
    catch(error) {showError(error);}
    try {await navigator.clipboard.writeText(target.dataset.binding);if(status)status.textContent='打开失败，已复制跳转标识';} catch(error) {showError(error);if(status)status.textContent='打开失败，复制跳转标识失败';}
  }
  async function handleAction(target) {
    const action=target.dataset.action,id=target.dataset.id;
    if(action==='dismiss')return $(id).close();
    if(action==='done'||target.dataset.done)return showDone();
    if(action==='expand'){if(expanded.has(id))expanded.delete(id);else expanded.add(id);render();return;}
    if(action==='export')return exportCsv();
    if(action==='clear-selection') {state.selected.clear();render();return;}
    if(action==='range') {state.range=id;return refresh();}
    if(action==='resolve')return resolveItem(id,target.dataset.option);
    if(action==='attention-evidence') {const item=findAttention(id);return dialog('drawer',item.conclusion,json(item.evidence)+sourceLink(item.source_link));}
    if(action==='work')return openWork(id);
    if(action==='apply-editor')return applyEditor();
    if(action==='approve-rule') {await post(`/api/rules/${encodeURIComponent(id)}/approve`);return refresh();}
    if(action==='enable-rule') {await post(`/api/rules/${encodeURIComponent(id)}/enable`,{});return refresh();}
    if(action==='bulk-ack'||action==='bulk-closeout'||action==='orphan-ack') {
      const closing=action==='bulk-closeout';
      const ids=action==='orphan-ack'?[id]:[...state.selected].filter(uid=>(closing?state.q2:state.q1).some(r=>(closing?r.stable_id:r.request_uid)===uid));
      for(const uid of ids) {await post(`/api/${closing?'closeout':'ack'}/${encodeURIComponent(uid)}`);state.selected.delete(uid);}
      return refresh();
    }
    if(action==='confirm-resume')return performResume(id);
    if(target.classList.contains('drill'))return navigate('agents',id);
    if(target.classList.contains('resume'))return resume(target);
    if(target.classList.contains('jump'))return jump(target);
    if(target.classList.contains('copy-jump')) {await navigator.clipboard.writeText(target.dataset.binding);target.textContent='已复制';return;}
    if(target.classList.contains('ack')||target.classList.contains('closeout')) {await post(`/api/${target.classList.contains('ack')?'ack':'closeout'}/${encodeURIComponent(id)}`);state.selected.delete(id);return refresh();}
    if(target.classList.contains('approve')) {await post(`/api/orchestrator/answer/${encodeURIComponent(target.dataset.approvalId)}`,{answer:target.dataset.answer,consumer_owner:target.dataset.consumerOwner});return refresh();}
    if(target.id==='detail-back')return navigate('agents');
    if(target.id==='bot-toggle') {if(!state.rules)throw new Error('Rules have not loaded.');await post(`/api/decision-bot/${state.rules.bot_disabled?'enable':'disable'}`);return refresh();}
  }
  function exportCsv() {const rows=[['Work','Asked','Decided','Waited','Chose','Effect'],...state.ledger.slowest.map(r=>[r.title,r.asked_at,r.decided_at??'—',r.waited_ms,r.chose??'—',r.effect_state??'—'])];const csv=rows.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='overload-ledger.csv';a.click();URL.revokeObjectURL(url);}
  document.addEventListener('submit',async event=>{const form=event.target;if(form.id!=='capture'&&!form.matches('form.promote'))return;event.preventDefault();const submit=form.querySelector('button');submit.disabled=true;try {if(form.id==='capture')await post('/api/works',{title:form.elements.idea.value.trim(),source:'operator',candidate:true});else {const work=state.works.find(w=>w.work_id===form.dataset.id);await post(`/api/works/${encodeURIComponent(work.work_id)}/promote`,{expected_revision:work.revision,reason:'promoted from candidates',contract:{objective:form.elements.objective.value.trim(),acceptance:[{id:'a1',kind:'human',description:form.elements.acceptance.value.trim()}],non_goals:[],scope:{cwd:'.'},budget:{},stop_conditions:[{id:'s1',kind:'judgment',description:'operator review'}],decision_owner:'operator'}});}await refresh();}catch(error){showError(error);}finally{submit.disabled=false;}});
  document.addEventListener('click',async event=>{const target=event.target.closest('button,a[data-nav],a.drill');if(!target)return;if(target.closest('form'))return;event.preventDefault();if(target.dataset.nav)return navigate(target.dataset.nav);target.disabled=true;try {await handleAction(target);}catch(error){showError(error);}finally{target.disabled=false;if(target.dataset.action==='apply-editor')validateEditor();}});
  document.addEventListener('input',event=>{if(event.target.closest('#drawer'))validateEditor();const form=event.target.closest('form.promote');if(form)form.querySelector('button').disabled=!(form.elements.objective.value.trim()&&form.elements.acceptance.value.trim());});
  document.addEventListener('change',event=>{if(event.target.id==='period'){state.range=event.target.value;refresh();}if(event.target.matches('.row-select')) {if(event.target.checked)state.selected.add(event.target.dataset.id);else state.selected.delete(event.target.dataset.id);}});
  window.addEventListener('popstate',restoreRoute);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();dialog('modal','Navigate',pages.map(page=>`<a class="command-link" href="/${page}" data-nav="${page}">${e(page[0].toUpperCase()+page.slice(1))}</a>`).join(''));}});
  setInterval(()=>{if(!document.hidden)refresh();},15000);
  restoreRoute();
})();
