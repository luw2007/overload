(() => {
  // Legacy internal-queue paths still resolve; the client redirects them into
  // the attention zone that now owns their data (AGENTS.md 产品界面原则).
  const LEGACY_ZONE = { q1: "now", hung: "now", q2: "inbox", zombie: "inbox", archive: "done" };
  const ZONES = ["now", "inbox", "done", "sessions", "health"];
  const state = { tab: "now", selected: new Set(), summary: null, q1: [], q2: [], archive: [], hung: [], sessions: [], session: null, detail: null, zombie: { groups: [], orphaned_requests: [] }, health: null };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "-").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const formatTime = (value) => value == null ? "-" : new Date(value).toLocaleString();
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
  const zombieHint = { stalled: "事件流已停止，需人工确认会话是否还在运行。", dead_incarnation: "进程已消失，记录保留供核查，无需动作。", telemetry_gap: "遥测出现缺口，可能丢失部分事件。" };

  async function fetchJson(path, options) {
    const response = await fetch(path, options);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  function showError(error) {
    $("error").textContent = `刷新失败：${error.message}`;
    $("error").classList.remove("hidden");
  }

  function renderSummary() {
    const summary = state.summary;
    if (!summary) return;
    $("tile-now").textContent = (summary.q1 ?? 0) + (summary.hung ?? 0);
    const zombies = state.zombie.groups.reduce((total, group) => total + group.rows.length, 0) + state.zombie.orphaned_requests.length;
    $("tile-inbox").textContent = zombies;
    const unhealthy = summary.open_incidents + summary.coverage_gaps + summary.telemetry_gaps > 0;
    $("health-pill").classList.toggle("warn", unhealthy);
    $("health-label").textContent = unhealthy ? `${summary.open_incidents} open incident · ${summary.coverage_gaps + summary.telemetry_gaps} gaps` : "health OK";
  }

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
    const age = Date.now() - row.created_at;
    const options = Array.isArray(row.options) && row.options.length ? `<div class="option-chips">${row.options.map((option) => isOrchestratorGate && approvalId ? `<button class="btn primary approve" data-approval-id="${escapeHtml(approvalId)}" data-answer="${escapeHtml(option)}">${escapeHtml(option)}</button>` : `<span class="option-chip">${escapeHtml(option)}</span>`).join("")}</div>` : "";
    const gate = isOrchestratorGate ? `<div class="meta">门禁：${escapeHtml(row.detail.gate)}${row.detail.rule ? ` · 规则：${escapeHtml(row.detail.rule)}` : ""}${row.detail.command ? ` · 命令：${escapeHtml(row.detail.command)}` : ""}</div>` : "";
    return `<article class="card decision-card">${rowCheckbox(row.request_uid)}<div class="card-main"><div class="headline"><span class="dot red"></span>${escapeHtml(row.summary || row.detail?.question || row.detail?.prompt || `${row.kind} 需要决策`)}</div><div class="meta">${sessionLink(row.stable_id)} · ${escapeHtml(row.host || "未知主机")} · <span class="age-chip${age >= AGE_WARN_MS ? " age-warn" : ""}">等待 ${ageText(age)}</span></div>${gate}<div class="impact-line">${ASK_IMPACT}</div>${options}</div><div class="actions"><button class="btn danger ack" data-id="${escapeHtml(row.request_uid)}">确认并归档</button>${jumpActions(row, "request_uid", "q1")}</div></article>`;
  }

  function hungCard(row) {
    const evidence = row.detail?.local ? `${row.detail.local} -> ${row.detail.peer}` : bindingFor(row);
    const capability = row.resume_capability;
    const resumeBtn = capability?.resumable ? `<button class="btn primary resume-session" data-id="${escapeHtml(row.stable_id)}">Resume</button><span class="resume-status" aria-live="polite"></span>` : "";
    return `<article class="decision-card hung">
      <div class="decision-card-head"><strong>${sessionLink(row.stable_id)}</strong><span class="chip">${escapeHtml(hungLabel[row.q5_reason] ?? row.q5_reason)}</span></div>
      <div class="impact-line">${escapeHtml(hungImpact[row.q5_reason] ?? "会话异常，需人工确认")}</div>
      <div class="decision-card-meta">卡住 ${escapeHtml(formatDuration(row.hung_ms))} · 最后进展 ${ageChip(row.since)}</div>
      <div class="decision-card-meta">证据 <code>${escapeHtml(evidence)}</code></div>
      <div class="decision-card-actions">${jumpActions(row, "stable_id", "jump-session")}${resumeBtn}</div>
    </article>`;
  }

  function renderNow() {
    const groups = [];
    const byId = new Map();
    for (const row of state.q1) {
      let group = byId.get(row.stable_id);
      if (!group) { group = { stable_id: row.stable_id, rows: [] }; byId.set(row.stable_id, group); groups.push(group); }
      group.rows.push(row);
    }
    const groupsHtml = groups.length
      ? `<div class="decision-groups">${groups.map((group) => `<div class="decision-group"><div class="group-head"><strong>${sessionLink(group.stable_id)}</strong><span class="chip">${group.rows.length} 项待决策</span></div><div class="decision-cards">${group.rows.map(decisionCard).join("")}</div></div>`).join("")}</div>`
      : "<p class='empty'>没有待决策请求</p>";
    const hungHtml = state.hung.length ? `<h3>卡死会话</h3><div class="decision-cards">${state.hung.map(hungCard).join("")}</div>` : "";
    $("content").innerHTML = `${state.q1.length ? `<p><label><input id="select-all" type="checkbox"> 全选待决策</label></p>` : ""}${groupsHtml}${hungHtml}`;
    const selectAll = $("select-all");
    if (selectAll) {
      selectAll.checked = state.q1.every((row) => state.selected.has(row.request_uid));
      selectAll.addEventListener("change", () => {
        state.selected = selectAll.checked ? new Set(state.q1.map((row) => row.request_uid)) : new Set();
        renderZone();
      });
    }
  }

  function renderInbox() {
    const q2Html = state.q2.length
      ? `<div class="b-table-wrap"><table class="b-table"><thead><tr><th></th><th>会话</th><th>来源</th><th>最后事件</th><th></th></tr></thead><tbody>${state.q2.map((row) => `<tr><td>${rowCheckbox(row.stable_id)}</td><td>${sessionLink(row.stable_id)}</td><td>${escapeHtml(row.origin)}</td><td>${escapeHtml(formatTime(row.last_event_at))}</td><td><button class="btn closeout" data-id="${escapeHtml(row.stable_id)}">收尾</button></td></tr>`).join("")}</tbody></table></div>`
      : "<p class='empty'>没有待收尾会话</p>";
    const groupCards = state.zombie.groups.map((group) => `<article class="hint-card"><div class="decision-card-head"><strong>${escapeHtml(group.q5_reason)}</strong><span class="chip">${group.rows.length} 个会话</span></div><p class="hint-text">${escapeHtml(zombieHint[group.q5_reason] ?? "需人工核查。")}</p><div class="decision-cards">${group.rows.map((row) => {
      const capability = row.resume_capability;
      const resumeBtn = capability?.resumable ? `<button class="btn primary resume-session" data-id="${escapeHtml(row.stable_id)}">Resume</button><span class="resume-status" aria-live="polite"></span>` : "";
      return `<span class="chip">${sessionLink(row.stable_id)} · ${escapeHtml(formatTime(row.last_event_at))}</span>${resumeBtn}`;
    }).join(" ")}</div></article>`).join("");
    const orphanedCards = state.zombie.orphaned_requests.map((row) => `<article class="hint-card"><div class="decision-card-head"><strong>orphaned_request</strong><span class="chip">${sessionLink(row.stable_id)}</span></div><p class="hint-text">会话已结束，请求随之失效。</p><div class="decision-card-actions"><button class="btn ack" data-id="${escapeHtml(row.request_uid)}">Ack</button></div></article>`).join("");
    const zombieHtml = groupCards || orphanedCards ? `<h3>Zombie</h3>${groupCards}${orphanedCards}` : "";
    $("content").innerHTML = `<h3>待收尾</h3>${q2Html}${zombieHtml}`;
  }

  function renderDone() {
    $("content").innerHTML = state.archive.length
      ? `<div class="b-table-wrap"><table class="b-table"><thead><tr><th>会话</th><th>来源</th><th>最后事件</th></tr></thead><tbody>${state.archive.map((row) => `<tr><td>${sessionLink(row.stable_id)} ${row.closed_out ? `<span class="chip">${escapeHtml("已收尾")}</span>` : ""}</td><td>${escapeHtml(row.origin)}</td><td>${escapeHtml(formatTime(row.last_event_at))}</td></tr>`).join("")}</tbody></table></div>`
      : "<p class='empty'>没有已归档会话</p>";
  }

  function renderSessions() {
    $("content").innerHTML = state.sessions.length ? `<div class="session-grid">${state.sessions.map((row) => {
      const capability = row.resume_capability;
      const action = capability?.resumable
        ? `<button class="btn primary resume-session" data-id="${escapeHtml(row.stable_id)}">Resume</button>`
        : `<span class="chip">${escapeHtml(capability?.reason === "process_alive" ? "进程运行中" : capability?.reason === "orchestrator_owned" ? "编排器托管" : "仅查看")}</span>`;
      return `<article class="session-card"><div class="session-card-head"><strong>${sessionLink(row.stable_id)}</strong><span class="chip">${escapeHtml(row.runtime)}</span></div><div class="session-meta">${escapeHtml(row.origin)} · ${escapeHtml(row.state)}${row.queue ? ` · ${escapeHtml(row.q5_reason ? `${row.queue}/${row.q5_reason}` : row.queue)}` : ""}</div><div class="session-time">最后事件 ${escapeHtml(formatTime(row.last_event_at))}</div><div class="session-actions">${action}<span class="resume-status" aria-live="polite"></span></div></article>`;
    }).join("")}</div>` : "<p class='empty'>没有会话</p>";
  }

  function keyValueTable(pairs) {
    return `<table class="b-table"><tbody>${pairs.map(([key, value]) => `<tr><th style="width:160px">${escapeHtml(key)}</th><td>${value}</td></tr>`).join("")}</tbody></table>`;
  }

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
      ["跳转", s.binding ? `<span class="chip">${escapeHtml(s.binding)}</span> <button class="btn primary jump" data-route="jump-session" data-id="${escapeHtml(s.stable_id)}" data-binding="${escapeHtml(s.binding)}">打开</button><span class="jump-status" aria-live="polite"></span>` : missingJumpTarget(s)],
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
    $("detail").innerHTML = `<p><button class="btn" id="detail-back">← 返回会话列表</button></p>${replacement}${head}
      <h3>进程</h3>${incarnations}<h3>待决策</h3>${requests}
      <h3>事件（最新在前，已隐藏 heartbeat）</h3>${events}`;
    $("detail-back").addEventListener("click", () => { state.session = null; state.detail = null; navigate("/sessions"); renderZone(); });
  }

  async function openSession(stableId, push = true) {
    state.tab = "sessions";
    state.session = stableId;
    state.detail = null;
    if (push) navigate(`/sessions/${encodeURIComponent(stableId)}`);
    syncActiveTab();
    renderZone();
    try {
      state.detail = await fetchJson(`/api/sessions/${encodeURIComponent(stableId)}`);
    } catch (error) {
      state.session = null;
      showError(error);
    }
    renderZone();
  }

  function renderHealth() {
    const health = state.health;
    const rows = health?.open_incidents.length
      ? health.open_incidents.map((row) => `<tr><td>${escapeHtml(row.source)}</td><td>${escapeHtml(formatTime(row.opened_at))}</td><td><code>${escapeHtml(JSON.stringify(row.detail ?? {}))}</code></td></tr>`).join("")
      : `<tr><td class='empty' colspan='3'>无开放事件 · coverage gaps ${health?.coverage_gaps ?? 0} · telemetry gaps ${health?.telemetry_gaps ?? 0}</td></tr>`;
    $("content").innerHTML = `<div class="b-table-wrap"><table class="b-table"><thead><tr><th>来源</th><th>打开时间</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function navigate(path) {
    if (location.pathname !== path) history.pushState(null, "", path);
  }

  function syncActiveTab() {
    document.querySelectorAll(".b-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === state.tab));
  }

  function restoreRoute() {
    const parts = location.pathname.split("/").filter(Boolean);
    let zone = LEGACY_ZONE[parts[0]] ?? parts[0];
    if (!ZONES.includes(zone)) zone = "now";
    if (zone === "sessions" && parts[1]) return openSession(decodeURIComponent(parts[1]), false);
    state.tab = zone;
    const canonical = `/${zone}`;
    if (location.pathname !== canonical) history.replaceState(null, "", canonical);
    syncActiveTab();
  }

  function renderToolbar() {
    const show = (state.tab === "now" || state.tab === "inbox") && state.selected.size > 0;
    $("toolbar").classList.toggle("show", show);
    $("selected-count").textContent = `${state.selected.size} 项已选`;
    $("bulk-ack").classList.toggle("hidden", state.tab !== "now");
    $("bulk-closeout").classList.toggle("hidden", state.tab !== "inbox");
  }

  function renderZone() {
    const detailMode = state.tab === "sessions" && state.session;
    $("detail").classList.toggle("hidden", !detailMode);
    $("content").classList.toggle("hidden", !!detailMode);
    if (detailMode) renderDetail();
    else if (state.tab === "now") renderNow();
    else if (state.tab === "inbox") renderInbox();
    else if (state.tab === "done") renderDone();
    else if (state.tab === "sessions") renderSessions();
    else renderHealth();
    renderToolbar();
    document.querySelectorAll(".row-select").forEach((checkbox) => checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(checkbox.dataset.id); else state.selected.delete(checkbox.dataset.id);
      renderZone();
    }));
    document.querySelectorAll(".ack").forEach((button) => button.addEventListener("click", () => ack([button.dataset.id])));
    document.querySelectorAll(".closeout").forEach((button) => button.addEventListener("click", () => closeout([button.dataset.id])));
    document.querySelectorAll(".approve").forEach((button) => button.addEventListener("click", () => approve(button)));
    document.querySelectorAll(".copy-jump").forEach((button) => button.addEventListener("click", () => copyBinding(button.dataset.binding, button.parentElement.querySelector(".jump-status"))));
    document.querySelectorAll(".jump").forEach((button) => button.addEventListener("click", () => jump(button)));
    document.querySelectorAll(".resume-session").forEach((button) => button.addEventListener("click", () => resume(button)));
    document.querySelectorAll(".drill").forEach((link) => link.addEventListener("click", (event) => {
      event.preventDefault();
      openSession(link.dataset.id);
    }));
  }

  async function copyBinding(binding, status) {
    try {
      await navigator.clipboard.writeText(binding);
      status.textContent = "已复制";
      setTimeout(() => { status.textContent = ""; }, 2000);
      return true;
    } catch {
      status.textContent = "复制失败";
      setTimeout(() => { status.textContent = ""; }, 2000);
      return false;
    }
  }

  async function jump(button) {
    const status = button.parentElement.querySelector(".jump-status");
    const fallback = async (reason) => {
      const copied = await copyBinding(button.dataset.binding, status);
      const suffix = reason ? `（${reason}）` : "";
      status.textContent = copied ? `打开失败${suffix}，已复制跳转标识` : `打开失败${suffix}，复制跳转标识失败`;
    };
    try {
      const result = await fetchJson(`/api/${button.dataset.route ?? "jump"}/${encodeURIComponent(button.dataset.id)}`, { method: "POST" });
      if (!result.opened) await fallback(result.error);
      else {
        status.textContent = "已打开并聚焦目标终端";
        setTimeout(() => { status.textContent = ""; }, 2000);
      }
    } catch {
      await fallback();
    }
  }

  async function resume(button) {
    const status = button.parentElement.querySelector(".resume-status");
    button.disabled = true;
    status.textContent = "正在恢复…";
    try {
      await fetchJson(`/api/resume-session/${encodeURIComponent(button.dataset.id)}`, { method: "POST" });
      status.textContent = "已拉起";
      await refresh();
    } catch (error) {
      status.textContent = `恢复失败：${error.message}`;
      button.disabled = false;
    }
  }

  async function ack(ids) {
    try {
      await Promise.all(ids.map((id) => fetchJson(`/api/ack/${encodeURIComponent(id)}`, { method: "POST" })));
      ids.forEach((id) => state.selected.delete(id));
      await refresh();
    } catch (error) { showError(error); }
  }

  async function closeout(ids) {
    try {
      await Promise.all(ids.map((id) => fetchJson(`/api/closeout/${encodeURIComponent(id)}`, { method: "POST" })));
      ids.forEach((id) => state.selected.delete(id));
      await refresh();
    } catch (error) { showError(error); }
  }

  async function approve(button) {
    button.disabled = true;
    try {
      await fetchJson(`/api/orchestrator/answer/${encodeURIComponent(button.dataset.approvalId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: button.dataset.answer }),
      });
      await refresh();
    } catch (error) {
      showError(error);
      button.disabled = false;
    }
  }

  async function refresh() {
    try {
      const names = ["summary", "q1", "q2", "archive", "hung", "sessions", "zombie", "health"];
      const [summary, q1, q2, archive, hung, sessions, zombie, health] = await Promise.all(names.map((name) => fetchJson(`/api/${name}`)));
      Object.assign(state, { summary, q1, q2, archive, hung, sessions, zombie, health });
      const q1Ids = q1.map((row) => row.request_uid);
      const q2Ids = q2.map((row) => row.stable_id);
      const liveIds = new Set([...q1Ids, ...q2Ids]);
      state.selected = new Set([...state.selected].filter((id) => liveIds.has(id)));
      // An open drill-down owns the pane; refreshing under it would scroll the
      // reader back to the top every three seconds.
      if (state.session) { $("error").classList.add("hidden"); renderSummary(); return; }
      $("error").classList.add("hidden");
      renderSummary(); renderZone();
    } catch (error) { showError(error); }
  }

  document.querySelectorAll(".b-tab").forEach((tab) => tab.addEventListener("click", () => {
    state.tab = tab.dataset.tab;
    state.session = null;
    state.detail = null;
    navigate(`/${state.tab}`);
    syncActiveTab();
    renderZone();
  }));
  $("clear-selection").addEventListener("click", () => { state.selected.clear(); renderZone(); });
  $("bulk-ack").addEventListener("click", () => ack([...state.selected]));
  $("bulk-closeout").addEventListener("click", () => closeout([...state.selected]));
  restoreRoute();
  refresh();
  addEventListener("popstate", () => { state.session = null; state.detail = null; restoreRoute(); refresh(); });
  setInterval(refresh, 15000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
})();
