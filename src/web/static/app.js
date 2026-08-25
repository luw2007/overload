(() => {
  const state = { tab: "q1", selected: new Set(), summary: null, q1: [], q2: [], hung: [], sessions: [], session: null, detail: null, zombie: { groups: [], orphaned_requests: [] }, health: null };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "-").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const formatTime = (value) => value == null ? "-" : new Date(value).toLocaleString();
  const bindingFor = (row) => row.binding ?? (row.host && row.host !== "local" ? `ssh ${row.host}` : "-");
  const formatDuration = (ms) => {
    const minutes = Math.floor(ms / 60000);
    return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  };
  const hungLabel = { turn_hung: "无进展", dead_connection: "连接已死" };

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
    $("tile-q1").textContent = summary.q1;
    $("tile-q2").textContent = summary.q2;
    $("tile-hung").textContent = summary.hung ?? 0;
    $("tile-incidents").textContent = summary.open_incidents;
    const zombies = state.zombie.groups.reduce((total, group) => total + group.rows.length, 0) + state.zombie.orphaned_requests.length;
    $("tile-zombie").textContent = zombies;
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

  function renderQ1() {
    $("table-head").innerHTML = "<tr><th style='width:42px'><input id='select-all' type='checkbox' aria-label='全选'></th><th>请求</th><th>会话</th><th>类型</th><th>时间</th><th>跳转标识</th><th>操作</th></tr>";
    $("table-body").innerHTML = state.q1.length ? state.q1.map((row) => `<tr><td>${rowCheckbox(row.request_uid)}</td><td>${escapeHtml(row.request_uid)}</td><td>${sessionLink(row.stable_id)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(formatTime(row.created_at))}</td><td><span class="chip">${escapeHtml(bindingFor(row))}</span>${row.binding ? ` <button class="btn copy-jump" data-binding="${escapeHtml(row.binding)}">复制</button>` : ""}<span class="jump-status" aria-live="polite"></span></td><td>${row.binding ? `<button class="btn primary jump" data-id="${escapeHtml(row.request_uid)}" data-binding="${escapeHtml(row.binding)}">打开</button>` : "<span>暂无可跳转目标</span>"} <button class="btn ack" data-id="${escapeHtml(row.request_uid)}">Ack</button></td></tr>`).join("") : "<tr><td class='empty' colspan='7'>没有待决策请求</td></tr>";
    const selectAll = $("select-all");
    selectAll.checked = state.q1.length > 0 && state.q1.every((row) => state.selected.has(row.request_uid));
    selectAll.addEventListener("change", () => {
      state.selected = selectAll.checked ? new Set(state.q1.map((row) => row.request_uid)) : new Set();
      renderTable();
    });
  }

  function renderQ2() {
    $("table-head").innerHTML = "<tr><th>会话</th><th>来源</th><th>最后事件</th></tr>";
    $("table-body").innerHTML = state.q2.length ? state.q2.map((row) => `<tr><td>${sessionLink(row.stable_id)}</td><td>${escapeHtml(row.origin)}</td><td>${escapeHtml(formatTime(row.last_event_at))}</td></tr>`).join("") : "<tr><td class='empty' colspan='3'>没有已完成会话</td></tr>";
  }

  function renderHung() {
    $("table-head").innerHTML = "<tr><th>会话</th><th>判据</th><th>卡住时长</th><th>最后进展</th><th>证据</th><th>操作</th></tr>";
    $("table-body").innerHTML = state.hung.length ? state.hung.map((row) => `<tr class="failed"><td>${sessionLink(row.stable_id)}</td><td>${escapeHtml(hungLabel[row.q5_reason] ?? row.q5_reason)}</td><td>${escapeHtml(formatDuration(row.hung_ms))}</td><td>${escapeHtml(formatTime(row.since))}</td><td><code>${escapeHtml(row.detail?.local ? `${row.detail.local} -> ${row.detail.peer}` : bindingFor(row))}</code></td><td>${row.binding ? `<button class="btn primary jump" data-route="jump-session" data-id="${escapeHtml(row.stable_id)}" data-binding="${escapeHtml(row.binding)}">打开</button>` : "<span>暂无可跳转目标</span>"}<span class="jump-status" aria-live="polite"></span></td></tr>`).join("") : "<tr><td class='empty' colspan='6'>没有卡死会话</td></tr>";
  }

  function renderZombie() {
    const rows = state.zombie.groups.flatMap((group) => group.rows.map((row) => ({ reason: group.q5_reason, ...row })));
    const orphaned = state.zombie.orphaned_requests.map((row) => ({ reason: "orphaned_request", stable_id: row.stable_id, request_uid: row.request_uid, last_event_at: row.resolved_at }));
    $("table-head").innerHTML = "<tr><th>原因</th><th>会话 / 请求</th><th>时间</th></tr>";
    $("table-body").innerHTML = [...rows, ...orphaned].map((row) => `<tr><td>${escapeHtml(row.reason)}</td><td>${row.request_uid ? escapeHtml(row.request_uid) : sessionLink(row.stable_id)}</td><td>${escapeHtml(formatTime(row.last_event_at))}</td></tr>`).join("") || "<tr><td class='empty' colspan='3'>没有 Zombie 会话</td></tr>";
  }

  function renderSessions() {
    $("table-head").innerHTML = "<tr><th>会话</th><th>运行时</th><th>来源</th><th>状态</th><th>队列</th><th>最后事件</th></tr>";
    $("table-body").innerHTML = state.sessions.length ? state.sessions.map((row) => `<tr><td>${sessionLink(row.stable_id)}</td><td>${escapeHtml(row.runtime)}</td><td>${escapeHtml(row.origin)}</td><td>${escapeHtml(row.state)}</td><td>${escapeHtml(row.q5_reason ? `${row.queue}/${row.q5_reason}` : row.queue)}</td><td>${escapeHtml(formatTime(row.last_event_at))}</td></tr>`).join("") : "<tr><td class='empty' colspan='6'>没有会话</td></tr>";
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
      ["跳转", s.binding ? `<span class="chip">${escapeHtml(s.binding)}</span> <button class="btn primary jump" data-route="jump-session" data-id="${escapeHtml(s.stable_id)}" data-binding="${escapeHtml(s.binding)}">打开</button><span class="jump-status" aria-live="polite"></span>` : "暂无可跳转目标"],
    ]);
    const incarnations = view.incarnations.length
      ? `<table class="b-table"><thead><tr><th>写入者</th><th>域</th><th>pid</th><th>启动</th><th>最后可见</th></tr></thead><tbody>${view.incarnations.map((row) => `<tr><td>${escapeHtml(row.writer_id)}</td><td>${escapeHtml(row.liveness_domain)}</td><td>${escapeHtml(row.pid)}</td><td>${escapeHtml(formatTime(row.started_at))}</td><td>${escapeHtml(formatTime(row.last_seen_at))}</td></tr>`).join("")}</tbody></table>`
      : "<p class='empty'>没有进程记录</p>";
    const requests = view.pending_requests.length
      ? `<table class="b-table"><tbody>${view.pending_requests.map((row) => `<tr><td>${escapeHtml(row.request_uid)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(formatTime(row.created_at))}</td><td><code>${escapeHtml(JSON.stringify(row.detail ?? {}))}</code></td></tr>`).join("")}</tbody></table>`
      : "<p class='empty'>没有待决策请求</p>";
    const events = view.events.length
      ? `<table class="b-table"><thead><tr><th>#</th><th>时间</th><th>事件</th><th>详情</th></tr></thead><tbody>${view.events.map((row) => `<tr><td>${escapeHtml(row.ingest_seq)}</td><td>${escapeHtml(formatTime(row.at))}</td><td>${escapeHtml(row.kind)}</td><td><code>${escapeHtml(JSON.stringify(row.detail ?? {}))}</code></td></tr>`).join("")}</tbody></table>`
      : "<p class='empty'>没有事件</p>";
    $("detail").innerHTML = `<p><button class="btn" id="detail-back">← 返回会话列表</button></p>${head}
      <h3>进程</h3>${incarnations}<h3>待决策</h3>${requests}
      <h3>最近事件（倒序，已隐去心跳）</h3>${events}`;
    $("detail-back").addEventListener("click", () => { state.session = null; state.detail = null; renderTable(); });
  }

  async function openSession(stableId) {
    state.tab = "sessions";
    state.session = stableId;
    state.detail = null;
    document.querySelectorAll(".b-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === "sessions"));
    renderTable();
    try {
      state.detail = await fetchJson(`/api/sessions/${encodeURIComponent(stableId)}`);
    } catch (error) {
      state.session = null;
      showError(error);
    }
    renderTable();
  }

  function renderHealth() {
    const health = state.health;
    $("table-head").innerHTML = "<tr><th>来源</th><th>打开时间</th><th>详情</th></tr>";
    $("table-body").innerHTML = health?.open_incidents.length ? health.open_incidents.map((row) => `<tr><td>${escapeHtml(row.source)}</td><td>${escapeHtml(formatTime(row.opened_at))}</td><td><code>${escapeHtml(JSON.stringify(row.detail ?? {}))}</code></td></tr>`).join("") : `<tr><td class='empty' colspan='3'>无开放事件 · coverage gaps ${health?.coverage_gaps ?? 0} · telemetry gaps ${health?.telemetry_gaps ?? 0}</td></tr>`;
  }

  function renderToolbar() {
    const show = state.tab === "q1" && state.selected.size > 0;
    $("toolbar").classList.toggle("show", show);
    $("selected-count").textContent = `${state.selected.size} 项已选`;
  }

  function renderTable() {
    const detailMode = state.tab === "sessions" && state.session;
    $("detail").classList.toggle("hidden", !detailMode);
    $("table-wrap").classList.toggle("hidden", !!detailMode);
    if (detailMode) renderDetail();
    else if (state.tab === "q1") renderQ1();
    else if (state.tab === "q2") renderQ2();
    else if (state.tab === "hung") renderHung();
    else if (state.tab === "sessions") renderSessions();
    else if (state.tab === "zombie") renderZombie();
    else renderHealth();
    renderToolbar();
    document.querySelectorAll(".row-select").forEach((checkbox) => checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selected.add(checkbox.dataset.id); else state.selected.delete(checkbox.dataset.id);
      renderTable();
    }));
    document.querySelectorAll(".ack").forEach((button) => button.addEventListener("click", () => ack([button.dataset.id])));
    document.querySelectorAll(".copy-jump").forEach((button) => button.addEventListener("click", () => copyBinding(button.dataset.binding, button.parentElement.querySelector(".jump-status"))));
    document.querySelectorAll(".jump").forEach((button) => button.addEventListener("click", () => jump(button)));
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
    const status = button.closest("tr").querySelector(".jump-status");
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

  async function ack(ids) {
    try {
      await Promise.all(ids.map((id) => fetchJson(`/api/ack/${encodeURIComponent(id)}`, { method: "POST" })));
      ids.forEach((id) => state.selected.delete(id));
      await refresh();
    } catch (error) { showError(error); }
  }

  async function refresh() {
    try {
      const names = ["summary", "q1", "q2", "hung", "sessions", "zombie", "health"];
      const [summary, q1, q2, hung, sessions, zombie, health] = await Promise.all(names.map((name) => fetchJson(`/api/${name}`)));
      Object.assign(state, { summary, q1, q2, hung, sessions, zombie, health });
      const liveIds = new Set(q1.map((row) => row.request_uid));
      state.selected = new Set([...state.selected].filter((id) => liveIds.has(id)));
      // An open drill-down owns the pane; refreshing under it would scroll the
      // reader back to the top every three seconds.
      if (state.session) { $("error").classList.add("hidden"); renderSummary(); return; }
      $("error").classList.add("hidden");
      renderSummary(); renderTable();
    } catch (error) { showError(error); }
  }

  document.querySelectorAll(".b-tab").forEach((tab) => tab.addEventListener("click", () => {
    state.tab = tab.dataset.tab;
    state.session = null;
    state.detail = null;
    document.querySelectorAll(".b-tab").forEach((item) => item.classList.toggle("active", item === tab));
    renderTable();
  }));
  $("clear-selection").addEventListener("click", () => { state.selected.clear(); renderTable(); });
  $("bulk-ack").addEventListener("click", () => ack([...state.selected]));
  refresh();
  setInterval(refresh, 3000);
})();
