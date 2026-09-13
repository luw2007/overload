(() => {
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const e = escapeHtml;
  const pages = ['decide','conversations','ledger','works','tasks','candidates','rules','agents'];
  const LEGACY_ZONE = {now:'decide',inbox:'decide',done:'decide',q1:'agents',hung:'agents',q2:'agents',zombie:'agents',archive:'agents',sessions:'agents',health:'agents'};
  const state = {
    page: "decide",
    mgmtWorks: [],
    mgmtHtml: "",
    taskManifests: [],
    taskDrift: null,
    attention: { now: [], inbox: [], done: [] },
    rules: null,
    ledger: null,
    works: [],
    selected: new Set(),
    session: null,
    detail: null,
    q1: [],
    q2: [],
    archive: [],
    hung: [],
    zombie: { groups: [], orphaned_requests: [] },
    sessions: [],
    health: null,
    range: "week",
    conversationId: null,
    conversations: [],
    conversationDraft: "",
    conversationDrafts: {},
    conversationPosting: false,
    conversationPending: null,
  };
  let generation = 0;
  const formatTime = value => value == null ? '—' : new Date(value).toLocaleString();
  const humanDuration = ms => ms == null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
  function showError(error) {
    $('error').hidden=false;$('error').textContent=error.message||String(error);
    if(error.status===409){const reload=document.createElement('button');reload.textContent='Reload current decisions';reload.onclick=async()=>{if($('drawer').open)$('drawer').close();editor=null;await refresh();};$('error').append(' No changes were applied. Review the current contract before trying again. ',reload);}
  }
  async function fetchJson(path, options) {const response=await fetch(path,options);const data=await response.json();if(!response.ok){const error=new Error(data.message||data.error||`HTTP ${response.status}`);error.status=response.status;error.data=data;throw error;}return data;}
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
  function decisionRow(item) {
    const waited=duration(Date.now()-item.created_at),red=item.decision_mode==='human_only'||(item.expires_at!=null&&item.expires_at<=Date.now());
    return `<div class="row"><div>${dot(red?'red':'yellow')}</div><div><div class="row-title"><button class="text-button" data-action="expand" data-id="${e(item.item_id)}" aria-expanded="${expanded.has(item.item_id)}">${e(item.conclusion)}${item.conclusion.endsWith('?')?'':'?'}</button><span class="mono muted">${e(item.owner)} · r${item.contract_revision}</span></div><div class="row-note">${e(item.trigger)}</div>${expanded.has(item.item_id)?`<div class="facts"><b>Why now</b><span>${e(item.trigger)}</span><b>Impact</b><span>${e(item.impact)}</span><b>Evidence</b>${json(item.evidence)}<b>Options</b><span>${item.options.map(o=>`${e(o)}: ${e(consequence[o]||'Answer the linked approval')}`).join('<br>')}</span><b>Waiting</b><span>${waited} (your median this week: ${duration(state.ledger.waiting.median_ms)})</span><b>Automation</b><span>${e(automationReason(item))}${item.approval_id&&item.decision_mode!=='human_only'?button('propose rule','propose-rule',item.item_id):'<p>Rule proposal requires an eligible linked approval.</p>'}</span></div>`:''}</div><span class="mono muted">${waited}</span><div class="actions">${item.options.map(option=>button(option,'resolve',item.item_id,`data-option="${e(option)}"`)).join('')}${sourceLink(item.source_link)}</div></div>`;
  }
  function receipt(item) {return `<div class="row receipt"><div>✓</div><div><div class="row-title">${e(item.conclusion)}</div><span class="mono muted">${e(item.owner)} · ${stamp(item.updated_at)} · effect ${item.effect_state==='succeeded'?'verified':'pending'}</span></div></div>`;}
  function renderDecide() {const items=[...state.attention.now,...state.attention.inbox],automatic=state.attention.done.filter(x=>x.decision_mode==='scoped_auto'&&x.state==='resolved'&&x.updated_at>=Date.now()-86400000);return `<h1>Decide</h1><div class="summary">${decideTopLine(items,automatic.length)}</div>${items.length||receipts.size?`<div class="section-heading"><h2>Owed to the system</h2><small>Now · ${items.length} decisions · expand for evidence</small></div><div class="list">${items.map(x=>receipts.get(x.item_id)||decisionRow(x)).join('')}${[...receipts].filter(([id])=>!items.some(x=>x.item_id===id)).map(([,html])=>html).join('')}</div>`:empty(`Nothing owed. Agents self-resolved ${automatic.length} decisions today.`)}<div class="section-heading"><h2>Within contract</h2><small>Automatic · no decision required</small></div><div class="list auto">${dot('blue')}<span><strong class="mono">${automatic.length}</strong> handled without you</span><button class="text-button" data-done="automatic">Inspect Done ↗</button></div><div class="section-heading"><h2>Done <span class="muted mono">${state.attention.done.length}</span></h2><button data-done="all">Show receipts</button></div>`;}
  function taskBadge(v, fallback='—') { return `<span class="badge">${e(v||fallback)}</span>`; }
  function taskTable(headers, rows) { return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows||`<tr><td colspan="${headers.length}">暂无</td></tr>`}</tbody></table></div>`; }
  function acceptanceBadge(value) {
    return taskBadge(
      {
        draft: "草稿",
        pending: "待验收",
        accepted: "已接受",
        rejected: "已拒绝",
        invalidated: "已失效",
      }[value] || "草稿",
    );
  }
  function submissionBadge(submission) {
    const state = submission?.state || submission,
      label =
        {
          pending: "未提交",
          pushed: "已推送",
          pr_created: "PR 已创建",
          merged: "已合并",
          failed: "提交失败",
          unsupported: "需要人工发布",
        }[state] || "未提交";
    if (state === "pr_created" && submission?.external_ref) {
      const match = submission.external_ref.match(/\/pull\/(\d+)(?:\/)?$/);
      return `<a class="badge" href="${e(submission.external_ref)}" target="_blank" rel="noopener noreferrer">${e(match ? `PR #${match[1]}` : label)}</a>`;
    }
    return taskBadge(label);
  }
  function manifestAcceptance(manifest) {
    return manifest?.acceptance
      ? manifest.acceptance.invalidated_at
        ? "invalidated"
        : manifest.acceptance.verdict
      : "draft";
  }
  function manifestSection(d) {
    const rows = state.taskManifests || [],
      accepted = rows.find(
        (x) =>
          x.acceptance?.verdict === "accepted" &&
          !x.acceptance.invalidated_at &&
          (!x.submission || x.submission.state === "failed"),
      ),
      acceptedAny = rows.find(
        (x) =>
          x.acceptance?.verdict === "accepted" && !x.acceptance.invalidated_at,
      ),
      submitTitle = accepted
        ? "提交已接受的清单"
        : acceptedAny
          ? "该清单已有进行中或完成的提交"
          : "须先有未失效且已接受的清单",
      base =
        d.executions
          ?.map((x) => {
            try {
              return JSON.parse(x.ledger_evidence || "{}").base_ref;
            } catch {
              return null;
            }
          })
          .find(Boolean) || "main";
    return `<section class="card"><h2>交付物清单</h2>${taskTable(["built_at", "entries", "验收", "提交", "manifest_id"], rows.map((x) => `<tr><td>${e(formatTime(x.built_at))}</td><td>${e(x.entries)}</td><td>${acceptanceBadge(manifestAcceptance(x))}</td><td>${submissionBadge(x.submission)}</td><td><code>${e(String(x.manifest_id).slice(0, 8))}</code></td></tr>`).join(""))}<div class="task-manifest-actions"><label>验证证据 JSON<textarea id="manifest-verification" placeholder='[{"kind":"test","at":0}]'></textarea></label><button data-action="task-manifest">生成清单并请求验收</button><label>Base ref <input id="submission-target" value="${e(base)}"></label><button data-action="task-submit"${accepted ? ` data-id="${e(accepted.acceptance.acceptance_id)}"` : " disabled"} title="${e(submitTitle)}">提交为 PR</button><button data-action="task-poll">刷新提交状态</button></div>${state.taskDrift ? `<div class="error"><b>manifest_drift</b>${json(state.taskDrift)}</div>` : ""}</section>`;
  }
  function taskList() { const track=state.taskTrack||'tracking', works=state.mgmtWorks||[]; return `<h1>Tasks</h1><p class="summary">治理工作项</p><div class="tabs">${['tracking','paused','archived'].map(t=>`<a href="/tasks?track=${t}" class="${track===t?'active':''}" data-task-track="${t}">${t==='tracking'?'跟踪中':t==='paused'?'已暂停':'已归档'}</a>`).join('')} <button data-action="task-scan">扫描</button></div>${track==='archived'?'<p class="meta">未作为正式 Work 完成（可升级后走验收）</p>':''}<div class="list">${works.length?works.map(w=>`<a class="card drill" href="/tasks/${encodeURIComponent(w.work_id)}" data-task-id="${e(w.work_id)}"><h2>${e(w.discovered_title||w.title||w.work_id)}</h2>${taskBadge(w.origin_mode==='discovered'?'未契约治理':null,'未契约治理')}${taskBadge(w.track_state==='archived'?'已归档':w.track_state,'tracking')}${taskBadge(w.coverage,'coverage 未知')}<p class="meta">${w.track_state==='archived'?'未作为正式 Work 完成（可升级后走验收）':`${e(w.state||'')} · ${e(w.executions||0)} executions · ${e(formatTime(w.updated_at))}`}</p></a>`).join(''):empty('暂无工作项')}</div>`; }
  function taskDetail(d) {
    const input =
      (d.inputs || []).find((x) => x.input_id === d.input_head) ||
      (d.inputs || [])[0] ||
      {};
    const host = (d.executions || [])[0]?.host || "local";
    const artifacts = d.artifacts || [],
      versions = new Map(
        artifacts.map((a) => [
          a.artifact_id,
          artifacts.filter((x) => x.artifact_id === a.artifact_id).length,
        ]),
      ),
      exec = d.executions || [],
      att = (d.attention || []).filter(
        (x) => x.state === "open" || x.status === "open",
      ),
      hs = d.handoffs || [];
    const latestManifest = (state.taskManifests || [])[0];
    return `<div class="task-detail"><p><a href="/tasks">← Tasks</a></p><h1>${e(d.discovered_title || d.title || d.work_id)}</h1><p>${e(d.state || "")} ${taskBadge(d.track_state === "archived" ? "已归档" : d.track_state)} ${taskBadge(d.origin_mode === "discovered" ? "未契约治理" : null, "未契约治理")}</p>${d.track_state === "archived" ? '<p class="meta">未作为正式 Work 完成（可升级后走验收）</p>' : ""}<section class="card"><h2>一句话结论</h2><p>${e(d.summary || d.conclusion || d.title || "待治理工作项")}</p><h3>当前输入头版本摘录</h3><p>${e(String(input.content || input.text || input.body || "").slice(0, 200))}</p></section><section class="card"><h2>产物列表</h2>${taskTable(["path", "version", "版本数", "验收", "提交", "共享"], artifacts.map((a) => `<tr><td>${e(a.display_path || a.path)}</td><td><code>${e(String(a.content_sha256 || a.version_id || "").slice(0, 8))}</code></td><td>${e(a.version_count || a.versions || versions.get(a.artifact_id) || 1)}</td><td>${acceptanceBadge(a.acceptance_state || manifestAcceptance(latestManifest))}</td><td>${a.submission_state ? submissionBadge(a.submission_state) : submissionBadge(latestManifest?.submission)}</td><td>${taskBadge(a.shareable === 1 ? "可分享" : null, "不可分享")}</td></tr>`).join(""))}</section><section class="card"><h2>执行列表</h2>${taskTable(["agent", "host", "exec_state", "coverage", "started"], exec.map((x) => `<tr><td>${e(x.agent)}</td><td>${e(x.host)}</td><td>${e(x.exec_state || x.state)}</td><td>${e(x.source_coverage || x.coverage)}</td><td>${e(formatTime(x.started_at || x.started))}${x.stable_id ? `<br><a href="/ledger?session=${encodeURIComponent(x.stable_id)}">返回原现场</a>` : ""}</td></tr>`).join(""))}</section><section class="card"><h2>待决策</h2>${att.map((x) => `<p>${e(x.summary || x.title || x.item_id)}</p>`).join("") || empty("暂无待决策")}</section>${manifestSection(d)}<section class="card"><h2>Agent 接力记录</h2>${taskTable(["id", "target", "host", "state"], hs.map((x) => `<tr><td>${e(x.handoff_id || x.id)}</td><td>${e(x.target_agent)}</td><td>${e(x.target_host)}</td><td>${e(x.state)}</td></tr>`).join(""))}</section><section class="card"><h2>交给另一个 Agent</h2><form id="task-handoff" data-work-id="${e(d.work_id)}"><label>Agent <select name="target_agent"><option>pi</option><option>omp</option><option>claude</option></select></label><label>Host <input name="target_host" value="${e(host)}"></label><label><input type="checkbox" name="isolate"> isolate</label><label id="override-wrap" hidden>理由 <input name="override_reason"></label><button type="button" data-action="task-preconditions">检查前置条件</button><button type="submit" class="primary">生成交接点</button><div id="task-preconditions"></div><div id="task-handoff-error" role="alert"></div></form></section></div>`;
  }
  function renderTasks() { return state.taskDetail ? taskDetail(state.taskDetail) : taskList(); }
  function renderLedger() {const m=state.ledger,pct=m.rework.total?Math.round(m.rework.caused/m.rework.total*100):0;return `<div class="toolbar"><h1>Ledger</h1><select id="period" aria-label="Ledger period"><option value="week" ${state.range==='week'?'selected':''}>This week</option><option value="day" ${state.range==='day'?'selected':''}>Today</option></select><button data-action="export">Export CSV</button></div><p class="summary">${state.range==='week'?'This week':'Today'} you were the bottleneck for ${duration(m.bottleneck.total_ms)} across ${m.bottleneck.work_count} works.${m.coverage<1?` · coverage ${Math.round(m.coverage*100)}%`:''}</p><div class="metrics">${metric('Waiting',duration(m.waiting.total_ms),`median ${duration(m.waiting.median_ms)}`,m.waiting.series)}${metric('Rework you caused',`${m.rework.caused} / ${m.rework.total}`,`${pct}%`,m.rework.series)}${metric('Redirects',`${m.redirects.count} (${m.redirects.unplanned} unplanned)`,`lost ${duration(m.redirects.lost_ms)}`,m.redirects.series)}${metric('Sunk to rules',`${m.rules.hits} ${m.rules.delta>=0?'↑':'↓'}${Math.abs(m.rules.delta)}`,`${m.rules.share.toFixed(0)}% of decisions`,m.rules.series)}${metric('Death delay',duration(m.death.median_ms),`oldest: &quot;${e(m.death.oldest?.title??'—')}&quot;`,m.death.series)}</div><h2>Slowest decisions</h2><p class="muted">Waiting = asked → decided, or now while still owed. Raw rows behind the median.</p><table><thead><tr><th>Work</th><th>Asked</th><th>Decided</th><th>Waited</th><th>Chose</th><th>Effect</th></tr></thead><tbody>${m.slowest.map(r=>`<tr><td>${e(r.title)}</td><td class="mono">${stamp(r.asked_at)}</td><td class="mono">${stamp(r.decided_at)}</td><td class="mono">${duration(r.waited_ms)}</td><td>${e(r.chose??'—')}</td><td>${e(r.effect_state??'—')}</td></tr>`).join('')}</tbody></table>`;}
  function contractFacts(w) {const c=w.contract;return `<div class="facts"><b>Objective</b><span>${e(c?.objective??'—')}</span><b>Acceptance</b><span>${(c?.acceptance||[]).map(x=>e(x.description)).join('<br>')||'—'}</span><b>Scope</b><span class="mono">${e(JSON.stringify(c?.scope??null))}</span><b>Budget</b><span class="mono">${e(JSON.stringify(c?.budget??null))}</span><b>Stop conditions</b><span>${(c?.stop_conditions||[]).map(x=>e(x.description)).join('<br>')||'—'}</span><b>Decision owner</b><span>${e(c?.decision_owner??'—')}</span></div><p class="mono muted">updated ${stamp(w.updated_at)}</p>`;}
  function renderWorks() {return `<h1>Works</h1><p class="muted">Contracts, not agent transcripts.</p>${state.works.filter(w=>w.state!=='candidate').map(w=>`<details class="work"><summary>${e(w.title)} <span class="mono muted">${e(w.state)} · r${w.revision}</span></summary>${contractFacts(w)}</details>`).join('')}`;}
  function renderCandidates() {const candidates=state.works.filter(w=>w.state==='candidate');
    // Active operator works created this week are the best available promotion signal; no promoted_at exists.
    const promoted=state.works.filter(w=>w.state==='active'&&w.source==='operator'&&w.created_at>=Date.now()-7*86400000).length;
    return `<h1>Candidates</h1><p class="summary">${candidates.length} candidates · ${promoted} promoted this week · ${candidates.filter(w=>w.created_at<Date.now()-14*86400000).length} older than 14 days</p><form id="capture" class="capture"><input name="idea" id="candidate-title" aria-label="New candidate" placeholder="Capture an idea without interrupting active work…" required><button>Add candidate</button></form><div class="list">${candidates.map(w=>`<div class="row"><span>${dot('blue')}</span><div><div class="row-title">${e(w.title)} <span class="mono muted">${Math.floor((Date.now()-w.created_at)/86400000)}d old</span></div><details><summary>Promote to work</summary><form class="promote" data-id="${e(w.work_id)}"><label>Objective<textarea name="objective" required></textarea></label><label>Acceptance<textarea name="acceptance" required></textarea></label><button disabled>Promote</button></form></details></div><span class="mono muted">candidate</span></div>`).join('')}</div>`;}
  function renderRules() {
    const rows=state.rules.rules;
    return `<h1>Rules</h1><p class="summary">${rows.length} rules · ${rows.filter(r=>r.state==='enabled').length} enabled · ${rows.filter(r=>r.state==='observing').length} observing · ${state.rules.hits_week} hits this week</p><table><thead><tr><th>Rule</th><th>Scope</th><th>Answer</th><th>Observed / Matched</th><th>State</th><th>Action</th></tr></thead><tbody>${rows.map(r=>{
      const id=r.operation_id||r.candidate_id||r.id;
      const controls=r.state==='awaiting_approval'?button('approve','approve-rule',id):r.state==='enabled'?button('disable','disable-rule',id):button('enable','enable-rule',id,r.can_enable?'':'disabled');
      return `<tr><td>${e(r.name)}<br><code>${e(r.id)}</code></td><td>${e(r.scope)}</td><td>${e(r.answers.join(', '))}</td><td>${r.observed} / ${r.matched}</td><td>${e(r.state)}${r.state==='disabled'&&r.disabled_at?`<p>disabled · ${e(r.disabled_by)} · ${e(formatTime(r.disabled_at))}<br>${e(r.disabled_reason)}</p>`:''}</td><td>${controls}${r.state!=='enabled'&&r.enable_blocker?`<p>${e(r.enable_blocker)}</p>`:''}</td></tr>`;
    }).join('')}</tbody></table><p class="muted">Rules answer on your behalf only when they match exactly. Every enable is signed by you.</p>`;
  }
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

  function conversationValue(value) {
    if (value == null) return '—';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  function conversationState(value) {
    const raw = value == null ? 'unknown' : String(value).toLowerCase();
    if (raw === 'submitting') return {label:'submitting',raw};
    if (['queued','pending','accepted','waiting'].includes(raw)) return {label:'queued',raw};
    if (['running','started','executing','in_progress','in-progress'].includes(raw)) return {label:'running',raw};
    if (['completed','complete','done','succeeded','success'].includes(raw)) return {label:'completed',raw};
    if (!value || raw === 'unknown') return {label:'unknown',raw};
    return {label:raw,raw};
  }
  function conversationStatus(value) {
    const stateValue = conversationState(value);
    const className = stateValue.label.replace(/[^a-z0-9_-]/g,'-');
    return `<span class="conversation-status status-${className}" data-state="${e(stateValue.raw)}">${e(stateValue.label)}</span>`;
  }
  function conversationAddress(conversation) {
    const address = conversation.address;
    if (typeof address === 'string') return address;
    if (address && typeof address === 'object') {
      const short = address.chatId;
      if (short != null) return `${address.instanceId} · ${short}${address.threadId ? ' · '+address.threadId : ''}`;
    }
    return conversationValue(address);
  }
  function conversationRelated(conversation) {
    const links = [];
    if (conversation.work_id) links.push(`<a href="/works" data-nav="works">Work ${e(conversation.work_id)}</a>`);
    const reference = conversation.session_reference;
    const sessionId = typeof reference === 'string' ? reference : reference?.sessionId;
    if (sessionId) links.push(`<span>Runtime session <code>${e(sessionId)}</code></span>`);
    const attentionId = conversation.attention_id ?? conversation.attention?.item_id ?? conversation.attention?.id ?? (typeof reference === 'object' ? reference?.attention_id : null);
    if (attentionId) links.push(`<a href="/decide" data-nav="decide">Attention ${e(attentionId)}</a>`);
    return links.length ? `<div class="conversation-related">${links.join('<span aria-hidden="true">·</span>')}</div>` : '';
  }
  function conversationChoice(conversation) {
    const selected = String(conversation.id) === String(state.conversationId);
    const turns = Array.isArray(conversation.turns) ? conversation.turns.length : 0;
    return `<button type="button" class="conversation-choice${selected ? ' selected' : ''}" data-action="select-conversation" data-id="${e(conversation.id)}" aria-current="${selected ? 'true' : 'false'}"><span class="conversation-choice-title">${e(conversationAddress(conversation))}</span><span class="conversation-choice-meta">${e(conversation.owner_id ?? 'unknown owner')} · ${turns} turn${turns === 1 ? '' : 's'} · ${e(formatTime(conversation.created_at))}</span></button>`;
  }
  function conversationTurn(turn) {
    const sequence = turn.sequence == null ? turn.id : `#${turn.sequence}`;
    const output = turn.output == null ? '' : `<div class="conversation-output"><span class="conversation-label">Output</span><pre>${e(conversationValue(turn.output))}</pre></div>`;
    const reason = turn.reason == null ? '' : `<p class="conversation-reason">${e(turn.reason)}</p>`;
    return `<article class="conversation-turn"><header><strong>Turn ${e(sequence)}</strong>${conversationStatus(turn.state)}<time datetime="${e(turn.created_at ?? '')}">${e(formatTime(turn.created_at))}</time></header><div class="conversation-message"><span class="conversation-label">Message</span><p>${e(turn.text ?? '')}</p></div>${output}${reason}</article>`;
  }
  function conversationPendingMarkup() {
    const pending = state.conversationPending;
    if (!pending || String(pending.conversationId) !== String(state.conversationId)) return '';
    return `<article class="conversation-turn conversation-turn-pending"><header><strong>New turn</strong>${conversationStatus(pending.state)}<time>now</time></header><div class="conversation-message"><span class="conversation-label">Message</span><p>${e(pending.text)}</p></div><p class="conversation-reason">No output has been fabricated; waiting for the server turn state.</p></article>`;
  }
  function conversationComposerMarkup() {
    const disabled = state.conversationPosting || !state.conversationId;
    const canSend = !disabled && Boolean(state.conversationDraft.trim());
    return `<form id="conversation-message" class="conversation-composer"><label for="conversation-text">Message</label><textarea id="conversation-text" name="text" rows="4" placeholder="Send a message to this conversation" ${state.conversationPosting ? 'disabled' : ''}>${e(state.conversationDraft)}</textarea><div class="conversation-composer-actions"><span class="conversation-compose-status" aria-live="polite">${state.conversationPosting ? 'submitting…' : 'Messages queue a turn; they do not approve or steer execution.'}</span><button type="submit" class="primary" ${canSend ? '' : 'disabled'}>${state.conversationPosting ? 'Submitting…' : 'Queue message'}</button></div></form>`;
  }
  function renderConversations() {
    const selected = state.conversations.find(conversation => String(conversation.id) === String(state.conversationId));
    const list = state.conversations.length ? state.conversations.map(conversationChoice).join('') : empty('No conversations yet. Receive an authorized channel message first; this page cannot create one.');
    if (!selected) return `${head('Conversations','Read-only conversation context and explicit queued messages.') }<section class="conversations-page"><section class="conversation-list" aria-label="Conversations"><h2>Choose a conversation</h2>${list}</section>${state.conversationId ? `<p class="conversation-unavailable" role="status">Conversation ${e(state.conversationId)} is not available in the authorized response.</p>` : `<p class="conversation-empty-hint">Choose a conversation above. New conversations arrive from an authorized channel.</p>`}</section>`;
    const turns = Array.isArray(selected.turns) ? [...selected.turns].sort((a,b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0)) : [];
    const binding = `<dl class="conversation-binding"><dt>Owner</dt><dd>${e(selected.owner_id ?? 'unknown')}</dd><dt>Address</dt><dd>${e(conversationAddress(selected))}</dd><dt>Session reference</dt><dd>${e(conversationValue(selected.session_reference))}</dd><dt>Created</dt><dd>${e(formatTime(selected.created_at))}</dd></dl>`;
    return `${head('Conversations','Read-only conversation context and explicit queued messages.') }<section class="conversations-page"><section class="conversation-list" aria-label="Conversations"><h2>Choose a conversation</h2>${list}</section><article class="conversation-panel"><div class="conversation-panel-head"><h2>${e(conversationAddress(selected))}</h2><p class="conversation-id mono">${e(selected.id)}</p></div>${binding}${conversationRelated(selected)}<section class="conversation-turns" aria-label="Conversation messages">${turns.map(conversationTurn).join('') || empty('No turns received yet.')}<div id="conversation-pending">${conversationPendingMarkup()}</div></section>${conversationComposerMarkup()}</article></section>`;
  }
  function conversationPayload(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.conversations)) return data.conversations;
    throw new Error('Conversation response was not a list.');
  }
  function renderAgents() {
    return head('Agents','Session diagnostics and legacy recovery actions.')+`<div id="agent-summary" class="meta">${e(state.health?.open_incidents?.length||0)} open incidents · ${e(state.health?.coverage_gaps||0)} coverage gaps · ${e(state.health?.telemetry_gaps||0)} telemetry gaps</div><div id="agent-status" role="status"></div><section id="detail"></section><section id="content"><h2>Decision requests</h2>${button('Acknowledge selected','bulk-ack')}${state.q1.map(decisionCard).join('')||empty('No decision requests.')}<h2>Hung sessions</h2>${state.hung.map(hungCard).join('')||empty('No hung sessions.')}<h2>Closeout</h2>${button('Close out selected','bulk-closeout')}${button('Clear selection','clear-selection')}${state.q2.map(closeoutCard).join('')||empty('No closeout requests.')}<h2>Zombie / handoff</h2>${state.zombie.groups.map(zombieCard).join('')||empty('No zombie groups.')}<h3>Orphaned requests</h3>${state.zombie.orphaned_requests.map(r=>`<article class="card">${e(r.summary || r.request_uid)}${button('Acknowledge','orphan-ack',r.request_uid)}</article>`).join('')||empty('No orphaned requests.')}<h2>Sessions</h2><div class="table-wrap"><table><thead><tr><th>Session</th><th>Agent</th><th>Host</th><th>State / queue</th><th>Last event</th></tr></thead><tbody>${state.sessions.map(r=>`<tr><td>${sessionLink(r.stable_id)} ${resumeCapability(r)} ${jumpActions(r, "stable_id", "jump-session")}</td><td>${e(r.agent)}</td><td>${e(r.host)}</td><td>${e(r.run_state)} · ${e(r.queue)}</td><td>${e(formatTime(r.last_event_at))}</td></tr>`).join('')}</tbody></table></div><h2>Archive</h2><div class="table-wrap"><table><thead><tr><th>Session</th><th>Kind</th><th>Status</th><th>Time</th><th>Summary</th></tr></thead><tbody>${state.archive.map(r=>`<tr><td>${sessionLink(r.stable_id)}</td><td>${e(r.origin)}</td><td>${r.closed_out?'Closed out':'Archived'}</td><td>${e(formatTime(r.last_event_at))}</td><td>${e(r.state || r.run_state)}</td></tr>`).join('')}</tbody></table></div><h2>Health</h2>${json(state.health)}</section>`;
  }
  function render() {if(editor)return;document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===state.page));$('main').innerHTML=({decide:renderDecide,conversations:renderConversations,ledger:renderLedger,works:renderWorks,tasks:renderTasks,candidates:renderCandidates,rules:renderRules,agents:renderAgents})[state.page]();$('workspace-actions').hidden=state.page==='conversations';if(state.page!=='conversations')$('workspace-actions').innerHTML=`<div>Operator workspace<small>真实数据 · 需要你判断时才介入</small></div><span class="muted">选择工作项，审阅证据与影响</span>`;if(state.page==='agents'&&state.session){$('content').hidden=true;renderDetail();}}
  async function refresh() {
    const current=++generation, page=state.page;
    if(page==='conversations'&&!state.conversationPosting){const text=$('conversation-text');if(text){state.conversationDraft=text.value;state.conversationDrafts[state.conversationId]=text.value;}}
    const since=state.range==='all'?0:Date.now()-(state.range==='week'?7:1)*86400000;
    try {
      let data={};
      const rulesPromise=fetchJson('/api/rules');
      const pagePromise=(async()=>{
        if(page==='decide') { const [now,inbox,done,today,ledger]=await Promise.all(['now','inbox','done'].map(z=>fetchJson(`/api/attention/${z}`)).concat(fetchJson(`/api/ledger?since=${Date.now()-86400000}`),fetchJson(`/api/ledger?since=${Date.now()-7*86400000}`))); return {attention:{now,inbox,done},today,ledger}; }
        if(page==='ledger') return {ledger:await fetchJson(`/api/ledger?since=${since}`)};
        if(page==='works'||page==='candidates') return {works:await fetchJson('/api/works')};
        if(page==='conversations') return {conversations:conversationPayload(await fetchJson('/api/conversations'))};
        if(page==='agents') { const keys=['q1','q2','hung','zombie','sessions','health','archive']; const rows=await Promise.all(keys.map(k=>fetchJson(`/api/${k}`))); const result=Object.fromEntries(keys.map((k,i)=>[k,rows[i]])); if(state.session)result.detail=await fetchJson(`/api/sessions/${encodeURIComponent(state.session)}`); return result; }
        return {};
      })();
      const [rules,result]=await Promise.all([rulesPromise,pagePromise]); data={...result,rules};
      if(current!==generation || page!==state.page)return;
      Object.assign(state,data);
      if(page==='conversations'&&state.conversationPending){const selected=state.conversations.find(row=>String(row.id)===String(state.conversationPending.conversationId));if(selected?.turns?.some(turn=>String(turn.id)===String(state.conversationPending.turnId)))state.conversationPending=null;}
      $('bot-toggle').textContent=`bot · ${rules.bot_disabled?'off':'on'}`; $('bot-toggle').setAttribute('aria-pressed',String(!rules.bot_disabled));
      if(page==='conversations'&&(state.conversationPosting||document.activeElement?.id==='conversation-text'))return;
      render();
    }catch(error){showError(error);}
  }
  async function submitConversationMessage(form) {
    if(state.conversationPosting) return;
    const text=(form.elements.text?.value ?? '').trim();
    if(!text){showError(new Error('Message cannot be blank.'));return;}
    const conversationId=state.conversationId;
    if(!conversationId){showError(new Error('Choose a conversation before sending a message.'));return;}
    state.conversationDraft=text;state.conversationDrafts[conversationId]=text;state.conversationPosting=true;state.conversationPending={conversationId,text,state:'submitting',turnId:null};render();
    try {
      const result=await post(`/api/conversations/${encodeURIComponent(conversationId)}/messages`,{text});
      const turnId=result?.turn_id;
      if(turnId==null) throw new Error('Message accepted without a turn_id.');
      state.conversationPending={conversationId,text,turnId,state:'queued'};state.conversationDraft='';state.conversationDrafts[conversationId]='';
      await refresh();
    } catch(error) { state.conversationPending=null;showError(error);render(); }
    finally { state.conversationPosting=false;render(); }
  }
  async function restoreRoute() {
    const parts = location.pathname.split("/").filter(Boolean),
      original = parts[0],
      query = new URLSearchParams(location.search);
    state.taskDetail = null;
    state.taskTrack = query.get("track") || "tracking";
    if (original === "tasks") {
      try {
        if (parts[1])
          [state.taskDetail, state.taskManifests] = await Promise.all([
            fetchJson(
              `/api/mgmt/works/${encodeURIComponent(decodeURIComponent(parts[1]))}`,
            ),
            fetchJson(
              `/api/mgmt/works/${encodeURIComponent(decodeURIComponent(parts[1]))}/manifests`,
            ),
          ]);
        else
          state.mgmtWorks = await fetchJson(
            `/api/mgmt/works?track=${encodeURIComponent(state.taskTrack)}`,
          );
        state.mgmtHtml = renderTasks();
      } catch (error) {
        showError(error);
        state.mgmtHtml = empty(error.message);
      }
    }
    state.page = LEGACY_ZONE[original] || original || "decide";
    if (!pages.includes(state.page)) state.page = "decide";
    state.session =
      state.page === "agents" &&
      (original === "sessions" || original === "agents") &&
      parts[1]
        ? decodeURIComponent(parts[1])
        : null;
    state.conversationId =
      state.page === "conversations" && parts[1]
        ? decodeURIComponent(parts[1])
        : null;
    state.conversationDraft = state.conversationId
      ? state.conversationDrafts[state.conversationId] || ""
      : "";
    if (original !== "tasks")
      history.replaceState(
        null,
        "",
        `/${state.page}${state.page === "conversations" && state.conversationId ? "/" + encodeURIComponent(state.conversationId) : state.session ? "/" + encodeURIComponent(state.session) : ""}`,
      );
    $("main").innerHTML = empty("Loading…");
    await refresh();
    if (original === "done") showDone();
    if (original === "tasks" && query.get("demo") === "confirm")
      showHandoffConfirm(
        {
          handoff_id: "demo",
          target_agent: "pi",
          target_host: state.taskDetail?.executions?.[0]?.host || "local",
          isolate: true,
        },
        true,
      );
  }
  async function navigate(page,session=null) {editor=null;$('drawer').close();$('modal').close();state.selected.clear();history.pushState(null,'',`/${page}${session?'/'+encodeURIComponent(session):''}`);await restoreRoute();}
  function findAttention(id) { return [...state.attention.now,...state.attention.inbox,...state.attention.done].find(x=>x.item_id===id); }
  function showDone() { dialog('drawer','Done',state.attention.done.map(x=>`<article class="receipt"><h3>${e(x.conclusion)}</h3><p>${e(x.state)} · ${e(x.effect_state)}</p>${sourceLink(x.source_link)}${json(x.evidence)}</article>`).join('')||empty('Nothing done yet.')); }
  async function openWork(id) {const w=await fetchJson(`/api/works/${encodeURIComponent(id)}`);dialog('drawer',w.title,`<p class="mono">r${w.revision}</p>${contractFacts(w)}`);}
  let editor=null;
  async function openNarrow(item) {
    const detail=await fetchJson(`/api/works/${encodeURIComponent(item.work_id)}`);
    editor={item,original:detail.contract,revision:detail.revision,draft:JSON.stringify(detail.contract,null,2),reason:'',preview:null,stage:'edit',busy:false};
    renderEditor();
  }
  function renderEditor() {
    const preview=editor.stage==='preview',complete=editor.stage==='complete';
    $('main').innerHTML=`<section class="review-hero"><span class="eyebrow">CONTRACT REVIEW · r${editor.revision}</span><h1>${complete?'决定已回流':preview?'确认这次改变':'审阅范围，再批准改变'}</h1><p>${e(editor.item.conclusion)}</p><div class="review-steps"><span class="${!preview&&!complete?'current':''}">01 编辑契约</span><span class="${preview?'current':''}">02 预览影响</span><span class="${complete?'current':''}">03 批准回执</span></div></section>`;
    if(complete){$('main').innerHTML+=`<section class="review-panel"><h2>契约变更已记录</h2><p>Effect: ${e(editor.result.effect_state)} · ${e(editor.result.state)}</p><p>原工作项与受影响卡片已回流。只有 succeeded 表示效果已核实。</p>${json(editor.result.evidence)}</section>`;reviewActions('决定已提交','真实服务回执',button('返回待决','exit-editor'));return;}
    if(preview){
      const c=editor.preview.replacement,keys=[...new Set([...Object.keys(editor.original),...Object.keys(c)])],cards=editor.preview.result.affected_cards.filter(x=>x.item_id!==editor.item.item_id);
      $('main').innerHTML+=`<section class="review-panel"><h2>新旧契约差异</h2>${keys.filter(k=>JSON.stringify(editor.original[k])!==JSON.stringify(c[k])).map(k=>`<h3>${e(k)}</h3><div class="review-columns"><div><span class="muted">Before</span>${json(editor.original[k])}</div><div class="review-after"><span>After</span>${json(c[k])}</div></div>`).join('')||'<p>契约内容未改变。</p>'}<h3>理由</h3><p>${e(editor.reason)}</p></section><section class="review-panel"><h2>${cards.length} 张其他卡片将失效</h2>${cards.map(x=>`<p>${e(x.conclusion)} <code>${e(x.item_id)} · r${x.revision}</code></p>`).join('')||'<p>没有其他受影响卡片。</p>'}<p class="muted">版本或卡片集合有变化时拒绝应用，不覆盖并发决定。</p><label><input type="checkbox" id="approve-contract">我已核对契约差异与受影响工作项</label></section>`;
      reviewActions('等待你的批准','当前仍未应用任何改变',button('返回编辑','edit-again')+button('批准并应用','apply-editor','','class="primary" disabled'));return;
    }
    $('main').innerHTML+=`<section class="review-panel"><h2>任务现场</h2><dl><dt>触发原因</dt><dd>${e(editor.item.trigger)}</dd><dt>影响</dt><dd>${e(editor.item.impact)}</dd><dt>责任人</dt><dd>${e(editor.item.owner)} · r${editor.revision}</dd></dl><details><summary>查看证据</summary>${json(editor.item.evidence)}</details></section><section class="review-panel"><h2>编辑替换契约</h2><p class="muted">完整保留预算、范围与停止条件。下一步会逐字段比较，不会直接执行。</p><label for="replacement">契约 JSON</label><textarea id="replacement" rows="16">${e(editor.draft)}</textarea><label for="reason">变更理由</label><input id="reason" value="${e(editor.reason)}" placeholder="说明为什么改变边界"><p id="editor-error" role="status"></p></section>`;
    reviewActions('先编辑，再预览批准','不改变原契约，直到最后确认',button('取消','exit-editor')+button('预览改变','preview-editor','','class="primary" disabled'));validateEditor();
  }
  function reviewActions(title,detail,buttons){$('workspace-actions').hidden=false;$('workspace-actions').innerHTML=`<div>${title}<small>${detail}</small></div><div class="review-buttons">${buttons}</div>`;}
  function validateEditor() {
    if(!editor||editor.stage!=='edit')return;
    editor.draft=$('replacement').value;editor.reason=$('reason').value;editor.preview=null;
    const next=document.querySelector('[data-action="preview-editor"]');next.disabled=true;
    try{const c=JSON.parse(editor.draft);if(!c||Array.isArray(c)||typeof c!=='object')throw new Error('契约必须是 JSON 对象');if(!editor.reason.trim())throw new Error('请填写变更理由');$('editor-error').textContent='';next.disabled=false;}catch(error){$('editor-error').textContent=error.message;}
  }
  async function previewEditor(){
    if(editor.busy)return;validateEditor();if(document.querySelector('[data-action="preview-editor"]').disabled)return;
    editor.busy=true;const active=editor;
    try{const replacement=JSON.parse(editor.draft),result=await post(`/api/works/${encodeURIComponent(editor.item.work_id)}/contract-preview`,{expected_revision:editor.revision,contract:replacement});if(editor!==active)return;editor.preview={replacement,result};editor.stage='preview';renderEditor();window.scrollTo(0,0);}finally{active.busy=false;}
  }
  async function applyEditor(){
    if(!editor?.preview||editor.busy||!$('approve-contract')?.checked)return;
    editor.busy=true;document.querySelector('[data-action="apply-editor"]').disabled=true;const active=editor;
    try{const result=await post(`/api/attention/${encodeURIComponent(editor.item.item_id)}/resolve`,{expected_revision:editor.item.revision,expected_contract_revision:editor.revision,affected_cards:editor.preview.result.affected_cards.map(({item_id,revision})=>({item_id,revision})),selected_option:'narrow',replacement_contract:editor.preview.replacement,reason:editor.reason.trim()});if(editor!==active)return;editor.result=result;editor.stage='complete';renderEditor();window.scrollTo(0,0);}finally{active.busy=false;}
  }
  async function resolveItem(id,option) {const item=findAttention(id);if(option==='narrow')return openNarrow(item);const result=await post(item.approval_id?`/api/orchestrator/answer/${encodeURIComponent(item.approval_id)}`:`/api/attention/${encodeURIComponent(id)}/resolve`,item.approval_id?{answer:option,consumer_owner:item.consumer_owner,expected_revision:item.revision}:{expected_revision:item.revision,selected_option:option});receipts.set(id,`<div class="row receipt">${e(option)} · you · ${stamp(Date.now())} · effect ${result.effect_state==='succeeded'?'verified':'pending'}</div>`);render();setTimeout(()=>{receipts.delete(id);refresh();},3000);}
  async function resume(button) {
    const stableId=button.dataset.id;
    if(button.dataset.adapter==='claude-code') { dialog('modal','Confirm resume',`<p>Claude Code resume creates a new tmux window. Confirm that you want to restart this terminated session.</p>`,`${buttonHtmlResume(stableId)}${windowCancel()}`); return; }
    await performResume(stableId);
  }
  function buttonHtmlResume(id) { return button('Resume','confirm-resume',id,'class="primary"'); }
  function windowCancel() { return button('Cancel','dismiss','modal'); }
  async function performResume(id) { const result=await post(`/api/resume-session/${encodeURIComponent(id)}`); $('modal').close(); await refresh(); const status=$('agent-status'); if(status)status.textContent=`Resume: ${result.resumed ? 'started' : result.reason || 'submitted'}${result.new_binding?' · '+result.new_binding:''}`; }
  function handoffValues(form) { return {target_agent:form.elements.target_agent.value,target_host:form.elements.target_host.value.trim()||'local',isolate:form.elements.isolate.checked,override_reason:form.elements.override_reason.value.trim()||undefined}; }
  function renderPreconditions(result) { const box=$('task-preconditions'), form=$('task-handoff'); if(!box||!form)return; const allowed=result.allowed||[]; $('override-wrap').hidden=!allowed.includes('isolate_with_confirmation'); box.innerHTML=taskTable(['ok','cause','allowed','evidence'],`<tr><td>${e(result.ok)}</td><td>${e(result.cause||'—')}</td><td>${e(allowed.join(', ')||'—')}</td><td><code>${e(JSON.stringify(result.evidence||{}))}</code></td></tr>`); }
  async function checkTaskPreconditions() { const form=$('task-handoff'); renderPreconditions(await fetchJson(`/api/mgmt/works/${encodeURIComponent(form.dataset.workId)}/handoff/preconditions`)); }
  function showHandoffConfirm(handoff,demo=false) { const id=handoff.handoff_id||handoff.id; state.pendingHandoff=handoff; dialog('modal','确认启动',`<p><b>Agent</b> ${e(handoff.target_agent)} · <b>Host</b> ${e(handoff.target_host)} · <b>isolate</b> ${e(handoff.isolate)}</p><p>将在目标工作区启动新 Agent；原执行已终止；不会重复外部副作用</p>`,`${demo?'<button class="primary" disabled>确认启动</button>':button('确认启动','task-launch',id,'class="primary"')}${windowCancel()}`); }
  async function submitTaskHandoff(form) { const error=$('task-handoff-error'); error.textContent=''; try { const values=handoffValues(form), handoff=await post(`/api/mgmt/works/${encodeURIComponent(form.dataset.workId)}/handoffs`,values); showHandoffConfirm({...handoff,...values}); } catch(ex) { error.textContent=`${ex.message}${ex.data?.allowed?` · allowed: ${ex.data.allowed.join(', ')}`:''}`; } }
  async function launchTaskHandoff(id) { const result=await post(`/api/mgmt/handoffs/${encodeURIComponent(id)}/launch`,{confirmed:true}); $('modal').close(); await refreshTaskDetail(); const raw=result.attempt_state||result.state||'unknown', attempt=raw==='launching'?'started':raw; const box=$('task-handoff-error'); if(box)box.innerHTML=`启动结果：${e(attempt)}${attempt==='unknown'?` <a href="/ledger?session=${encodeURIComponent(result.stable_id||'')}">jump</a> ${button('attach','task-attach',id)} ${button('abandon','task-abandon',id)}`:''}`; }
  async function refreshTaskDetail() {
    if (!state.taskDetail) return;
    const id = state.taskDetail.work_id;
    [state.taskDetail, state.taskManifests] = await Promise.all([
      fetchJson(`/api/mgmt/works/${encodeURIComponent(id)}`),
      fetchJson(`/api/mgmt/works/${encodeURIComponent(id)}/manifests`),
    ]);
    state.mgmtHtml = renderTasks();
    render();
  }
  async function jump(target) {
    const status=target.parentElement.querySelector('.jump-status');
    try { const result=await post(`/api/${target.dataset.route || 'jump'}/${encodeURIComponent(target.dataset.id)}`); if(result.opened) {if(status)status.textContent='已打开并聚焦目标终端';return;} if(result.error)showError(new Error(result.error)); }
    catch(error) {showError(error);}
    try {await navigator.clipboard.writeText(target.dataset.binding);if(status)status.textContent='打开失败，已复制跳转标识';} catch(error) {showError(error);if(status)status.textContent='打开失败，复制跳转标识失败';}
  }
  async function handleAction(target) {
    const action = target.dataset.action,
      id = target.dataset.id;
    if (action === "dismiss") return $(id).close();
    if (action === "task-scan") {
      await post("/api/mgmt/scan");
      state.mgmtWorks = await fetchJson(
        `/api/mgmt/works?track=${encodeURIComponent(state.taskTrack)}`,
      );
      state.mgmtHtml = renderTasks();
      return render();
    }
    if (action === "task-manifest") {
      let verification = [];
      try {
        verification = JSON.parse($("manifest-verification").value || "[]");
      } catch {
        return showError(new Error("验证证据必须为 JSON"));
      }
      await post(
        `/api/mgmt/works/${encodeURIComponent(state.taskDetail.work_id)}/manifests`,
        { verification },
      );
      return refreshTaskDetail();
    }
    if (action === "task-submit") {
      if (
        !confirm(
          `提交为 PR？\n目标：${$("submission-target").value}\n将推送并创建外部 PR。`,
        )
      )
        return;
      state.taskDrift = null;
      try {
        await post(`/api/mgmt/acceptances/${encodeURIComponent(id)}/submit`, {
          target_kind: "github_pr",
          target: $("submission-target").value || "main",
        });
      } catch (error) {
        if (error.status === 409 && error.data?.error === "manifest_drift") {
          state.taskDrift = error.data.diff || [];
          return render();
        }
        throw error;
      }
      return refreshTaskDetail();
    }
    if (action === "task-poll") {
      await post("/api/mgmt/submissions/poll");
      return refreshTaskDetail();
    }
    if (action === "task-preconditions") return checkTaskPreconditions();
    if (action === "task-launch") return launchTaskHandoff(id);
    if (action === "task-abandon") {
      await post(`/api/mgmt/handoffs/${encodeURIComponent(id)}/abandon`, {
        reason: "operator abandoned unknown launch",
      });
      return refreshTaskDetail();
    }
    if (action === "task-attach")
      return showError(new Error("attach 需在原现场绑定现有 Agent"));
    if (action === "done" || target.dataset.done) return showDone();
    if (action === "expand") {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      render();
      return;
    }
    if (action === "export") return exportCsv();
    if (action === "select-conversation") {
      state.conversationDraft = state.conversationDrafts[id] || "";
      return navigate("conversations", id);
    }
    if (action === "refresh-conversations") return refresh();
    if (action === "conversation-message")
      return submitConversationMessage(target);
    if (action === "clear-selection") {
      state.selected.clear();
      render();
      return;
    }
    if (action === "range") {
      state.range = id;
      return refresh();
    }
    if (action === "resolve") return resolveItem(id, target.dataset.option);
    if (action === "attention-evidence") {
      const item = findAttention(id);
      return dialog(
        "drawer",
        item.conclusion,
        json(item.evidence) + sourceLink(item.source_link),
      );
    }
    if (action === "work") return openWork(id);
    if (action === "preview-editor") return previewEditor();
    if (action === "apply-editor") return applyEditor();
    if (action === "exit-editor") {
      editor = null;
      return refresh();
    }
    if (action === "edit-again") {
      editor.stage = "edit";
      editor.preview = null;
      renderEditor();
      return;
    }
    if (action === "propose-rule") {
      const item = findAttention(id);
      dialog(
        "modal",
        "Propose rule",
        `<p>The server derives exact scope from this approval. This does not answer or resolve the decision.</p><label>Suggested answer<select id="rule-answer">${item.options.map((o) => `<option value="${e(o)}">${e(o)}</option>`).join("")}</select></label>`,
        button("Create candidate", "submit-rule", id),
      );
      return;
    }
    if (action === "submit-rule") {
      await post(`/api/attention/${encodeURIComponent(id)}/propose-rule`, {
        answer: $("rule-answer").value,
      });
      $("modal").close();
      return navigate("rules");
    }
    if (action === "disable-rule") {
      dialog(
        "modal",
        "Disable rule",
        `<p>Pending proposals from this rule will no longer authorize an answer. Already consumed decisions are not undone.</p><label>Reason<input id="disable-reason" required></label>`,
        button("Disable rule", "confirm-disable-rule", id),
      );
      return;
    }
    if (action === "confirm-disable-rule") {
      const reason = $("disable-reason").value.trim();
      if (!reason) throw new Error("Reason is required.");
      await post(`/api/rules/${encodeURIComponent(id)}/disable`, { reason });
      $("modal").close();
      return refresh();
    }
    if (action === "approve-rule") {
      await post(`/api/rules/${encodeURIComponent(id)}/approve`);
      return refresh();
    }
    if (action === "enable-rule") {
      await post(`/api/rules/${encodeURIComponent(id)}/enable`, {});
      return refresh();
    }
    if (
      action === "bulk-ack" ||
      action === "bulk-closeout" ||
      action === "orphan-ack"
    ) {
      const closing = action === "bulk-closeout";
      const ids =
        action === "orphan-ack"
          ? [id]
          : [...state.selected].filter((uid) =>
              (closing ? state.q2 : state.q1).some(
                (r) => (closing ? r.stable_id : r.request_uid) === uid,
              ),
            );
      for (const uid of ids) {
        await post(
          `/api/${closing ? "closeout" : "ack"}/${encodeURIComponent(uid)}`,
        );
        state.selected.delete(uid);
      }
      return refresh();
    }
    if (action === "confirm-resume") return performResume(id);
    if (target.classList.contains("drill")) return navigate("agents", id);
    if (target.classList.contains("resume")) return resume(target);
    if (target.classList.contains("jump")) return jump(target);
    if (target.classList.contains("copy-jump")) {
      await navigator.clipboard.writeText(target.dataset.binding);
      target.textContent = "已复制";
      return;
    }
    if (
      target.classList.contains("ack") ||
      target.classList.contains("closeout")
    ) {
      await post(
        `/api/${target.classList.contains("ack") ? "ack" : "closeout"}/${encodeURIComponent(id)}`,
      );
      state.selected.delete(id);
      return refresh();
    }
    if (target.classList.contains("approve")) {
      await post(
        `/api/orchestrator/answer/${encodeURIComponent(target.dataset.approvalId)}`,
        {
          answer: target.dataset.answer,
          consumer_owner: target.dataset.consumerOwner,
        },
      );
      return refresh();
    }
    if (target.id === "detail-back") return navigate("agents");
    if (target.id === "bot-toggle") {
      if (!state.rules) throw new Error("Rules have not loaded.");
      await post(
        `/api/decision-bot/${state.rules.bot_disabled ? "enable" : "disable"}`,
      );
      return refresh();
    }
  }
  function exportCsv() {const rows=[['Work','Asked','Decided','Waited','Chose','Effect'],...state.ledger.slowest.map(r=>[r.title,r.asked_at,r.decided_at??'—',r.waited_ms,r.chose??'—',r.effect_state??'—'])];const csv=rows.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='overload-ledger.csv';a.click();URL.revokeObjectURL(url);}
  document.addEventListener('submit',event=>{if(event.target.id==='conversation-message'){event.preventDefault();void submitConversationMessage(event.target);}if(event.target.id==='task-handoff'){event.preventDefault();void submitTaskHandoff(event.target);}});
  document.addEventListener('input',event=>{if(event.target.id==='conversation-text'){state.conversationDraft=event.target.value;state.conversationDrafts[state.conversationId]=event.target.value;event.target.form.querySelector('button[type="submit"]').disabled=state.conversationPosting||!event.target.value.trim();}});
  document.addEventListener('submit',async event=>{const form=event.target;if(form.id!=='capture'&&!form.matches('form.promote'))return;event.preventDefault();const submit=form.querySelector('button');submit.disabled=true;try {if(form.id==='capture')await post('/api/works',{title:form.elements.idea.value.trim(),source:'operator',candidate:true});else {const work=state.works.find(w=>w.work_id===form.dataset.id);await post(`/api/works/${encodeURIComponent(work.work_id)}/promote`,{expected_revision:work.revision,reason:'promoted from candidates',contract:{objective:form.elements.objective.value.trim(),acceptance:[{id:'a1',kind:'human',description:form.elements.acceptance.value.trim()}],non_goals:[],scope:{cwd:'.'},budget:{},stop_conditions:[{id:'s1',kind:'judgment',description:'operator review'}],decision_owner:'operator'}});}await refresh();}catch(error){showError(error);}finally{submit.disabled=false;}});
  document.addEventListener('click',async event=>{const target=event.target.closest('button,a[data-nav],a.drill,[data-task-track]');if(!target)return;if(target.closest('form')&&target.dataset.action!=='task-preconditions')return;event.preventDefault();if(target.dataset.nav)return navigate(target.dataset.nav);if(target.dataset.taskTrack){history.pushState(null,'',`/tasks?track=${target.dataset.taskTrack}`);return restoreRoute();}if(target.dataset.taskId){history.pushState(null,'',`/tasks/${encodeURIComponent(target.dataset.taskId)}`);return restoreRoute();}target.disabled=true;try {await handleAction(target);}catch(error){showError(error);}finally{target.disabled=false;if(target.dataset.action==='apply-editor')validateEditor();}});
  document.addEventListener('input',event=>{if(['replacement','reason'].includes(event.target.id)&&editor)validateEditor();if(event.target.id==='approve-contract'){const b=document.querySelector('[data-action="apply-editor"]');b.disabled=!event.target.checked;}const form=event.target.closest('form.promote');if(form)form.querySelector('button').disabled=!(form.elements.objective.value.trim()&&form.elements.acceptance.value.trim());});
  document.addEventListener('change',event=>{if(event.target.id==='period'){state.range=event.target.value;refresh();}if(event.target.matches('.row-select')) {if(event.target.checked)state.selected.add(event.target.dataset.id);else state.selected.delete(event.target.dataset.id);}});
  window.addEventListener('popstate',()=>{editor=null;restoreRoute();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();dialog('modal','Navigate',pages.map(page=>`<a class="command-link" href="/${page}" data-nav="${page}">${e(page[0].toUpperCase()+page.slice(1))}</a>`).join(''));}});
  setInterval(()=>{if(!document.hidden)refresh();},15000);
  restoreRoute();
})();
