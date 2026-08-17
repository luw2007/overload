(() => {
  const state = { tab: "q1", selected: new Set(), summary: null, q1: [], q2: [], zombie: { groups: [], orphaned_requests: [] }, health: null };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "-").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const formatTime = (value) => value == null ? "-" : new Date(value).toLocaleString();
  const bindingFor = (row) => row.binding ?? (row.host && row.host !== "local" ? `ssh ${row.host}` : "-");

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

  function renderQ1() {
    $("table-head").innerHTML = "<tr><th style='width:42px'><input id='select-all' type='checkbox' aria-label='全选'></th><th>请求</th><th>会话</th><th>类型</th><th>时间</th><th>跳转标识</th><th>操作</th></tr>";
    $("table-body").innerHTML = state.q1.length ? state.q1.map((row) => `<tr class="${row.failed ? "failed" : ""}"><td>${rowCheckbox(row.request_uid)}</td><td>${row.failed ? "[DELIVERY FAILED] " : ""}${escapeHtml(row.request_uid)}</td><td>${escapeHtml(row.stable_id)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(formatTime(row.created_at))}</td><td><span class="chip">${escapeHtml(bindingFor(row))}</span> <button class="btn copy-jump" data-binding="${escapeHtml(bindingFor(row))}">复制</button><span class="jump-status" aria-live="polite"></span></td><td><button class="btn primary jump" data-id="${escapeHtml(row.request_uid)}" data-binding="${escapeHtml(bindingFor(row))}">打开</button> <button class="btn ${row.failed ? "danger" : ""} ack" data-id="${escapeHtml(row.request_uid)}">Ack</button></td></tr>`).join("") : "<tr><td class='empty' colspan='7'>没有待决策请求</td></tr>";
    const selectAll = $("select-all");
    selectAll.checked = state.q1.length > 0 && state.q1.every((row) => state.selected.has(row.request_uid));
    selectAll.addEventListener("change", () => {
      state.selected = selectAll.checked ? new Set(state.q1.map((row) => row.request_uid)) : new Set();
      renderTable();
    });
  }

  function renderQ2() {
    $("table-head").innerHTML = "<tr><th>会话</th><th>来源</th><th>最后事件</th></tr>";
    $("table-body").innerHTML = state.q2.length ? state.q2.map((row) => `<tr><td>${escapeHtml(row.stable_id)}</td><td>${escapeHtml(row.origin)}</td><td>${escapeHtml(formatTime(row.last_event_at))}</td></tr>`).join("") : "<tr><td class='empty' colspan='3'>没有已完成会话</td></tr>";
  }

  function renderZombie() {
    const rows = state.zombie.groups.flatMap((group) => group.rows.map((row) => ({ reason: group.q5_reason, ...row })));
    const orphaned = state.zombie.orphaned_requests.map((row) => ({ reason: "orphaned_request", stable_id: row.stable_id, request_uid: row.request_uid, last_event_at: row.resolved_at }));
    $("table-head").innerHTML = "<tr><th>原因</th><th>会话 / 请求</th><th>时间</th></tr>";
    $("table-body").innerHTML = [...rows, ...orphaned].map((row) => `<tr><td>${escapeHtml(row.reason)}</td><td>${escapeHtml(row.request_uid ?? row.stable_id)}</td><td>${escapeHtml(formatTime(row.last_event_at))}</td></tr>`).join("") || "<tr><td class='empty' colspan='3'>没有 Zombie 会话</td></tr>";
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
    if (state.tab === "q1") renderQ1();
    else if (state.tab === "q2") renderQ2();
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
  }

  async function copyBinding(binding, status) {
    try {
      await navigator.clipboard.writeText(binding);
      status.textContent = "已复制";
    } catch {
      status.textContent = "复制失败";
    }
    setTimeout(() => { status.textContent = ""; }, 2000);
  }

  async function jump(button) {
    const status = button.closest("tr").querySelector(".jump-status");
    try {
      const result = await fetchJson(`/api/jump/${encodeURIComponent(button.dataset.id)}`, { method: "POST" });
      if (!result.opened) {
        await copyBinding(button.dataset.binding, status);
        status.textContent = "打开失败，已退回复制";
      }
    } catch (error) {
      await copyBinding(button.dataset.binding, status);
      status.textContent = "打开失败，已退回复制";
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
      const [summary, q1, q2, zombie, health] = await Promise.all(["summary", "q1", "q2", "zombie", "health"].map((name) => fetchJson(`/api/${name}`)));
      Object.assign(state, { summary, q1, q2, zombie, health });
      const liveIds = new Set(q1.map((row) => row.request_uid));
      state.selected = new Set([...state.selected].filter((id) => liveIds.has(id)));
      $("error").classList.add("hidden");
      renderSummary(); renderTable();
    } catch (error) { showError(error); }
  }

  document.querySelectorAll(".b-tab").forEach((tab) => tab.addEventListener("click", () => {
    state.tab = tab.dataset.tab;
    document.querySelectorAll(".b-tab").forEach((item) => item.classList.toggle("active", item === tab));
    renderTable();
  }));
  $("clear-selection").addEventListener("click", () => { state.selected.clear(); renderTable(); });
  $("bulk-ack").addEventListener("click", () => ack([...state.selected]));
  refresh();
  setInterval(refresh, 3000);
})();
