/* FNB58 Monitor — frontend */

const MAX_READINGS     = 18000;   // ~3 min buffer at 100 Hz
const MAX_CHART_POINTS = 600;
const CHART_FPS        = 4;

// ── State ───────────────────────────────────────────────────────
let chart = null;
let zeroCount = 0;
let paused = false;
let windowSeconds = 60;
let readings = [];
let stats = mkStats();
let hzCount = 0, hzResetAt = Date.now();
let totalSamples = 0;
let chartDirty = false;

// Session history state
let viewingSession   = false;
let viewingSessionId = null;
let _liveReadings    = null;   // backup of live buffer while viewing historical session

// Comparison state
let compareMode      = false;
let compareSessionId = null;
let compareSessionNum = null;
let _compReadings    = null;   // raw readings of the comparison session

const $ = id => document.getElementById(id);

function mkStats() {
  const s = () => ({ min: Infinity, max: -Infinity, sum: 0, n: 0 });
  return { v: s(), a: s(), w: s() };
}

// ── Socket.IO ───────────────────────────────────────────────────
const socket = io();
socket.on("connect",    () => console.log("WS connected"));
socket.on("disconnect", () => console.log("WS disconnected"));

socket.on("reading", r => {
  updateMetrics(r);
  accumStats(r);
  storeReading(r);
  checkSignal(r);
  tickHz();
  updateProtocol(r);
  totalSamples++;
  $("last-update").textContent = r.timestamp.slice(11, 19);
  if (!paused) chartDirty = true;
});

// ── Connection ──────────────────────────────────────────────────
async function connect() {
  $("btn-connect").disabled = true;
  $("status-label").textContent = "Conectando…";
  try {
    const res = await fetch("/api/connect", { method: "POST" });
    const d   = await res.json();
    if (d.ok) setConnected(true);
    else {
      setConnected(false);
      $("status-label").textContent = d.error || "Error";
    }
  } catch {
    setConnected(false);
    $("status-label").textContent = "Sin servidor";
  }
}

async function disconnect() {
  const proto = _displayedProto;          // capture before clearProtocol() wipes it
  await fetch("/api/disconnect", { method: "POST" });
  setConnected(false);
  loadSessions();
  showSessionSummary(proto);
}

async function resetAccum() {
  await fetch("/api/reset", { method: "POST" });
  $("energy").textContent   = "0.000000";
  $("capacity").textContent = "0.0000";
  stats        = mkStats();
  readings     = [];
  totalSamples = 0;
  clearStatsDisplay();
  clearChart();
}

function setConnected(on) {
  $("btn-connect").disabled    = on;
  $("btn-disconnect").disabled = !on;
  $("btn-reset").disabled      = !on;
  $("btn-export").disabled     = !on;
  $("status-dot").className    = "status-dot" + (on ? " on" : "");
  $("status-label").textContent = on ? "Conectado" : "Desconectado";
  $("hz-badge").style.display  = on ? "" : "none";
  if (!on) { zeroCount = 0; clearProtocol(); }
}

// ── Metrics ─────────────────────────────────────────────────────
function fmt(v, dec) { return v.toFixed(dec); }

function updateMetrics(r) {
  $("voltage").textContent  = fmt(r.voltage, 5);
  $("current").textContent  = fmt(r.current, 5);
  $("power").textContent    = fmt(r.power, 5);
  $("energy").textContent   = fmt(r.energy_Wh, 6);
  $("capacity").textContent = fmt(r.capacity_mAh, 4);
  $("temp").textContent     = fmt(r.temperature, 1);
  $("dp").textContent       = fmt(r.dp, 3);
  $("dn").textContent       = fmt(r.dn, 3);
}

// ── Stats ────────────────────────────────────────────────────────
function accumStats(r) {
  const upd = (s, v) => {
    if (v < s.min) s.min = v;
    if (v > s.max) s.max = v;
    s.sum += v; s.n++;
  };
  upd(stats.v, r.voltage);
  upd(stats.a, r.current);
  upd(stats.w, r.power);

  // Update display (throttled by DOM — only fires 100x/s but cheap calls)
  if (stats.v.n % 10 === 0) updateStatDisplay();
}

function updateStatDisplay() {
  if (stats.v.n === 0) return;
  $("v-min").textContent = fmt(stats.v.min, 4);
  $("v-max").textContent = fmt(stats.v.max, 4);
  $("v-avg").textContent = fmt(stats.v.sum / stats.v.n, 4);
  $("a-min").textContent = fmt(stats.a.min, 4);
  $("a-max").textContent = fmt(stats.a.max, 4);
  $("a-avg").textContent = fmt(stats.a.sum / stats.a.n, 4);
  $("w-min").textContent = fmt(stats.w.min, 4);
  $("w-max").textContent = fmt(stats.w.max, 4);
  $("w-avg").textContent = fmt(stats.w.sum / stats.w.n, 4);
}

function clearStatsDisplay() {
  ["v-min","v-max","v-avg","a-min","a-max","a-avg","w-min","w-max","w-avg"]
    .forEach(id => $(id).textContent = "—");
}

// ── Signal ───────────────────────────────────────────────────────
function checkSignal(r) {
  if (r.voltage === 0 && r.current === 0) {
    if (++zeroCount >= 10) $("setup-note").style.display = "block";
  } else {
    zeroCount = 0;
    $("setup-note").style.display = "none";
  }
}

// ── Hz counter ──────────────────────────────────────────────────
function tickHz() {
  hzCount++;
  const elapsed = (Date.now() - hzResetAt) / 1000;
  if (elapsed >= 1) {
    $("hz-badge").textContent = `${Math.round(hzCount / elapsed)} Hz`;
    hzCount = 0;
    hzResetAt = Date.now();
  }
}

// ── Readings buffer ─────────────────────────────────────────────
function storeReading(r) {
  // While viewing a historical session, accumulate live data in the backup buffer
  const target = viewingSession ? _liveReadings : readings;
  target.push(r);
  if (target.length > MAX_READINGS) target.shift();
}

// ── Chart ────────────────────────────────────────────────────────
function initChart() {
  const ctx = $("chart").getContext("2d");
  const mkDS = (label, color, fill) => ({
    label, data: [],
    borderColor: color, backgroundColor: fill,
    borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false,
  });

  const axisStyle = (pos) => ({
    position: pos,
    beginAtZero: true,
    ticks: { color: "#aaa", font: { size: 10, family: "'JetBrains Mono', monospace" } },
    grid:  { color: pos === "left" ? "#ebebeb" : "transparent" },
    border: { color: "#e0e0e0" },
  });

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { ...mkDS("Voltaje (V)",   "#111111", "rgba(0,0,0,.04)"),         yAxisID: "y"  },
        { ...mkDS("Corriente (A)", "#666666", "rgba(0,0,0,.02)"),         yAxisID: "y1" },
        { ...mkDS("Potencia (W)",  "#aaaaaa", "rgba(0,0,0,.01)"),         yAxisID: "y1" },
        // Comparison datasets — hidden until compare mode is active
        { ...mkDS("V₂ (V)",  "#2563eb", "rgba(37,99,235,.06)"),  yAxisID: "y",  hidden: true, borderDash: [5, 3] },
        { ...mkDS("A₂ (A)",  "#16a34a", "rgba(22,163,74,.04)"),  yAxisID: "y1", hidden: true, borderDash: [5, 3] },
        { ...mkDS("W₂ (W)",  "#ea580c", "rgba(234,88,12,.03)"),  yAxisID: "y1", hidden: true, borderDash: [5, 3] },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#111", titleColor: "#fff",
          bodyColor: "#ccc", borderColor: "#333", borderWidth: 1, padding: 10,
          callbacks: { label: c => `  ${c.dataset.label}: ${c.parsed.y.toFixed(4)}` },
        },
        zoom: {
          zoom: {
            wheel:   { enabled: true, speed: 0.08 },
            pinch:   { enabled: false },
            mode:    "x",
            onZoomComplete: () => $("btn-reset-zoom").style.display = "",
          },
          pan: {
            enabled: true,
            mode:    "x",
            onPanComplete: () => $("btn-reset-zoom").style.display = "",
          },
          limits: { x: { minRange: 5 } },
        },
      },
      scales: {
        x:  {
          ticks: { color: "#aaa", maxTicksLimit: 6, font: { size: 10, family: "'JetBrains Mono', monospace" } },
          grid:  { color: "#ebebeb" },
          border: { color: "#e0e0e0" },
        },
        y:  { ...axisStyle("left"),  title: { display: true, text: "V", color: "#bbb", font: { size: 9 } } },
        y1: { ...axisStyle("right"), title: { display: true, text: "A / W", color: "#bbb", font: { size: 9 } } },
      },
    },
  });

  // Throttled refresh loop — avoids pushing 100 chart updates/s
  setInterval(() => {
    if (chartDirty) {
      chartDirty = false;
      rebuildChart();
      $("chart-samples").textContent = `${totalSamples} muestras`;
    }
  }, 1000 / CHART_FPS);
}

function getWindowedReadings() {
  if (windowSeconds === 0 || readings.length === 0) return readings;
  const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
  // Binary search for first reading within the window
  let lo = 0, hi = readings.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (readings[mid].timestamp < cutoff) lo = mid + 1;
    else hi = mid;
  }
  return readings.slice(lo);
}

function toElapsedLabels(readings) {
  if (!readings.length) return [];
  const t0 = new Date(readings[0].timestamp).getTime();
  return readings.map(r => {
    const s = Math.round((new Date(r.timestamp).getTime() - t0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  });
}

function resampleToLength(arr, len) {
  if (!arr.length || len <= 0) return [];
  if (arr.length <= len) return arr;  // shorter — line ends early in chart
  const step = arr.length / len;
  return Array.from({length: len}, (_, i) => arr[Math.floor(i * step)]);
}

function rebuildChart() {
  let visible = getWindowedReadings();
  if (visible.length > MAX_CHART_POINTS) {
    const step = Math.ceil(visible.length / MAX_CHART_POINTS);
    visible = visible.filter((_, i) => i % step === 0);
  }
  const ds = chart.data.datasets;
  chart.data.labels = compareMode
    ? toElapsedLabels(visible)
    : visible.map(r => r.timestamp.slice(11, 19));
  ds[0].data = visible.map(r => r.voltage);
  ds[1].data = visible.map(r => r.current);
  ds[2].data = visible.map(r => r.power);

  if (compareMode && _compReadings) {
    const comp = resampleToLength(_compReadings, visible.length);
    ds[3].data = comp.map(r => r.voltage);
    ds[4].data = comp.map(r => r.current);
    ds[5].data = comp.map(r => r.power);
  }
  chart.update("none");
}

function clearChart() {
  chart.data.labels = [];
  chart.data.datasets.forEach(d => d.data = []);
  chart.update("none");
  $("chart-samples").textContent = "0 muestras";
  $("last-update").textContent = "";
}

// ── Chart controls ───────────────────────────────────────────────
function toggleSeries(idx) {
  const ids = ["tog-v", "tog-a", "tog-w"];
  const ds = chart.data.datasets;
  ds[idx].hidden = !ds[idx].hidden;
  if (compareMode) ds[idx + 3].hidden = ds[idx].hidden;
  $(ids[idx]).classList.toggle("active", !ds[idx].hidden);
  chart.update("none");
}

function setWindow(seconds) {
  windowSeconds = seconds;
  ["win-30","win-60","win-300","win-all"].forEach(id => $(id).classList.remove("active"));
  const map = { 30: "win-30", 60: "win-60", 300: "win-300", 0: "win-all" };
  if (map[seconds]) $(map[seconds]).classList.add("active");
  rebuildChart();
}

function togglePause() {
  paused = !paused;
  $("btn-pause").classList.toggle("paused", paused);
  $("pause-icon").textContent = paused ? "▶" : "⏸";
  if (!paused) chartDirty = true;
}

// ── Zoom & PNG ───────────────────────────────────────────────────
function resetZoom() {
  chart.resetZoom();
  $("btn-reset-zoom").style.display = "none";
}

function exportChartPNG() {
  const src = $("chart");
  const out = document.createElement("canvas");
  out.width  = src.width;
  out.height = src.height;
  const ctx  = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);
  const a = document.createElement("a");
  a.href     = out.toDataURL("image/png");
  a.download = `fnb58_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.png`;
  a.click();
}

// ── CSV export ───────────────────────────────────────────────────
function exportCSV() {
  if (!readings.length) return;
  const cols = ["timestamp","voltage","current","power","energy_Wh","capacity_mAh","temperature","dp","dn"];
  const csv  = [cols.join(","), ...readings.map(r => cols.map(c => r[c]).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `fnb58_${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Session history ──────────────────────────────────────────────

function fmtDuration(s) {
  if (s == null) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function loadSessions() {
  let sessions;
  try {
    sessions = await fetch("/api/sessions").then(r => r.json());
  } catch { return; }

  const tbody = $("sessions-tbody");
  const empty = $("sessions-empty");
  const wrap  = $("sessions-table-wrap");
  tbody.innerHTML = "";

  const completed = sessions.filter(s => s.ended_at);
  if (!completed.length) {
    empty.style.display = "";
    wrap.style.display  = "none";
    return;
  }
  empty.style.display = "none";
  wrap.style.display  = "";

  const total = completed.length;
  completed.forEach((s, i) => {
    const num = total - i;
    const tr  = document.createElement("tr");
    if (s.id === viewingSessionId) tr.classList.add("session-active");
    const started    = s.started_at ? s.started_at.slice(0, 16).replace("T", " ") : "—";
    const nameHtml   = s.name
      ? escapeHtml(s.name)
      : '<span class="name-ph">Añadir…</span>';
    const isComparing = s.id === compareSessionId;
    const compareBtn  = isComparing
      ? `<button class="sess-btn sess-compare active" onclick="clearComparison()">Quitar</button>`
      : `<button class="sess-btn sess-compare" onclick="compareSession(${s.id},${num})">Comparar</button>`;

    tr.innerHTML = `
      <td class="num">${num}</td>
      <td class="session-name" data-name="${escapeHtml(s.name || '')}"
          onclick="editSessionName(this,${s.id})">${nameHtml}</td>
      <td>${started}</td>
      <td>${fmtDuration((new Date(s.ended_at) - new Date(s.started_at)) / 1000)}</td>
      <td class="num">${s.energy_Wh    != null ? s.energy_Wh.toFixed(4)    : "—"}</td>
      <td class="num">${s.capacity_mAh != null ? s.capacity_mAh.toFixed(2) : "—"}</td>
      <td class="num">${s.v_max != null ? s.v_max.toFixed(4) : "—"}</td>
      <td class="num">${s.a_max != null ? s.a_max.toFixed(4) : "—"}</td>
      <td class="num">${s.w_max != null ? s.w_max.toFixed(4) : "—"}</td>
      <td class="num">${s.w_avg != null ? s.w_avg.toFixed(4) : "—"}</td>
      <td class="num">${s.samples ?? "—"}</td>
      <td>
        <div class="session-btns">
          <button class="sess-btn sess-view" onclick="viewSession(${s.id},${num})">Ver</button>
          ${compareBtn}
          <a class="sess-btn sess-csv" href="/api/sessions/${s.id}/csv?num=${num}" download>CSV</a>
          <button class="sess-btn sess-delete" onclick="deleteSession(${s.id},${num})">✕</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

// ── Inline session name editing ───────────────────────────────────

function editSessionName(cell, id) {
  if (cell.querySelector("input")) return;   // already editing
  const currentName = cell.dataset.name || "";
  const input = document.createElement("input");
  input.className   = "name-input";
  input.value       = currentName;
  input.placeholder = "Nombre de sesión…";
  cell.innerHTML = "";
  cell.appendChild(input);
  input.focus();

  let saved = false;
  const save = async () => {
    if (saved) return;
    saved = true;
    const name = input.value.trim();
    cell.dataset.name = name;
    cell.innerHTML = name ? escapeHtml(name) : '<span class="name-ph">Añadir…</span>';
    await fetch(`/api/sessions/${id}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ name }),
    });
  };
  const cancel = () => {
    saved = true;
    cell.innerHTML = currentName
      ? escapeHtml(currentName)
      : '<span class="name-ph">Añadir…</span>';
  };

  input.addEventListener("blur",    save);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter")  { input.blur(); }
    if (e.key === "Escape") { cancel(); }
  });
}

// ── View historical session ───────────────────────────────────────

async function viewSession(id, num) {
  _clearCompState();   // clear any existing comparison first
  let data;
  try {
    data = await fetch(`/api/sessions/${id}/readings`).then(r => r.json());
  } catch { return; }

  if (!data.length) { alert("Esta sesión no tiene lecturas guardadas."); return; }

  viewingSession   = true;
  viewingSessionId = id;
  paused           = true;
  $("btn-pause").classList.add("paused");
  $("pause-icon").textContent = "▶";

  _liveReadings = readings;
  readings = data.map(r => ({
    timestamp: r.ts, voltage: r.voltage, current: r.current, power: r.power,
    energy_Wh: r.energy_Wh, capacity_mAh: r.capacity_mAh,
    temperature: r.temperature, dp: r.dp, dn: r.dn,
  }));

  windowSeconds = 0;
  ["win-30","win-60","win-300"].forEach(i => $(i).classList.remove("active"));
  $("win-all").classList.add("active");
  rebuildChart();
  $("chart-samples").textContent = `${readings.length} puntos · sesión #${num}`;

  $("session-view-badge").style.display = "";
  $("session-view-id").textContent      = num;
  $("btn-exit-session").style.display   = "";

  loadSessions();
}

function exitSessionView() {
  _clearCompState();
  viewingSession   = false;
  viewingSessionId = null;
  paused           = false;
  $("btn-pause").classList.remove("paused");
  $("pause-icon").textContent = "⏸";

  readings      = _liveReadings || [];
  _liveReadings = null;

  $("session-view-badge").style.display = "none";
  $("btn-exit-session").style.display   = "none";

  windowSeconds = 60;
  ["win-30","win-300","win-all"].forEach(i => $(i).classList.remove("active"));
  $("win-60").classList.add("active");

  chartDirty = true;
  loadSessions();
}

async function deleteSession(id, num) {
  if (!confirm(`¿Borrar sesión #${num}? Esta acción no se puede deshacer.`)) return;
  if (viewingSessionId === id) exitSessionView();
  if (compareSessionId === id) clearComparison();
  await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  loadSessions();
}

// ── Session comparison ────────────────────────────────────────────

function _clearCompState() {
  compareMode       = false;
  compareSessionId  = null;
  compareSessionNum = null;
  _compReadings     = null;
  const ds = chart.data.datasets;
  ds[3].data = ds[4].data = ds[5].data = [];
  ds[3].hidden = ds[4].hidden = ds[5].hidden = true;
  $("compare-badge").style.display    = "none";
  $("btn-clear-compare").style.display = "none";
}

async function compareSession(id, num) {
  let data;
  try {
    data = await fetch(`/api/sessions/${id}/readings`).then(r => r.json());
  } catch { return; }
  if (!data.length) { alert("Sin lecturas en esa sesión."); return; }

  compareMode       = true;
  compareSessionId  = id;
  compareSessionNum = num;
  _compReadings     = data.map(r => ({ ...r, timestamp: r.ts }));

  const ds = chart.data.datasets;
  ds[3].hidden = ds[0].hidden;
  ds[4].hidden = ds[1].hidden;
  ds[5].hidden = ds[2].hidden;

  rebuildChart();

  $("compare-badge").style.display     = "";
  $("compare-badge-text").textContent  = `sesión #${num}`;
  $("btn-clear-compare").style.display = "";

  loadSessions();
}

function clearComparison() {
  _clearCompState();
  chartDirty = true;
  loadSessions();
}

// ── Session summary modal ────────────────────────────────────────

async function showSessionSummary(proto) {
  let sessions;
  try { sessions = await fetch("/api/sessions").then(r => r.json()); }
  catch { return; }

  const completed = sessions.filter(s => s.ended_at);
  if (!completed.length) return;

  const session = completed[0];                   // most recently closed
  const num     = completed.length;
  const dur     = (new Date(session.ended_at) - new Date(session.started_at)) / 1000;

  const protoHtml = proto
    ? `<span class="protocol-badge ${proto.cls}" style="margin-bottom:0">${proto.label}</span>`
    : "";

  const nameHtml = session.name
    ? `<span class="summary-session-label">${escapeHtml(session.name)}</span>`
    : `<span class="summary-session-label" style="color:var(--subtle)">Sin nombre</span>`;

  const f = (v, d) => v != null ? v.toFixed(d) : "—";

  $("summary-body").innerHTML = `
    <div class="summary-heading">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-family:var(--font-num);font-size:11px;color:var(--subtle)">#${num}</span>
        ${nameHtml}
      </div>
      ${protoHtml}
    </div>

    <div class="summary-grid">
      <div class="summary-stat">
        <div class="summary-label">Duración</div>
        <div class="summary-value" style="font-size:16px">${fmtDuration(dur)}</div>
      </div>
      <div class="summary-stat">
        <div class="summary-label">Energía</div>
        <div class="summary-value">${f(session.energy_Wh, 4)}<span class="summary-unit">Wh</span></div>
      </div>
      <div class="summary-stat">
        <div class="summary-label">Capacidad</div>
        <div class="summary-value">${f(session.capacity_mAh, 2)}<span class="summary-unit">mAh</span></div>
      </div>
      <div class="summary-stat">
        <div class="summary-label">W pico</div>
        <div class="summary-value">${f(session.w_max, 3)}<span class="summary-unit">W</span></div>
      </div>
      <div class="summary-stat">
        <div class="summary-label">W media</div>
        <div class="summary-value">${f(session.w_avg, 3)}<span class="summary-unit">W</span></div>
      </div>
      <div class="summary-stat">
        <div class="summary-label">V pico</div>
        <div class="summary-value">${f(session.v_max, 3)}<span class="summary-unit">V</span></div>
      </div>
    </div>

    ${!session.name ? `
      <div class="summary-name-row" id="summary-name-row">
        <input class="name-input" id="summary-name-input"
               placeholder="Dar nombre a esta sesión…"
               onkeydown="if(event.key==='Enter') saveSummaryName(${session.id})">
        <button onclick="saveSummaryName(${session.id})">Guardar</button>
      </div>` : ""}
  `;

  $("summary-overlay").style.display = "flex";
}

function closeSummaryModal() {
  $("summary-overlay").style.display = "none";
}

async function saveSummaryName(sessionId) {
  const input = $("summary-name-input");
  const name  = input.value.trim();
  if (!name) return;
  await fetch(`/api/sessions/${sessionId}`, {
    method:  "PATCH",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ name }),
  });
  $("summary-name-row").innerHTML =
    `<span class="summary-saved">✓ Guardado como <strong>${escapeHtml(name)}</strong></span>`;
  loadSessions();
}

// Close on Escape
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeSummaryModal();
});

// ── Protocol detection ───────────────────────────────────────────
let _displayedProto = null;
let _pendingProto   = null;
let _pendingCount   = 0;
const PROTO_CONFIRM = 50;   // lecturas consecutivas antes de mostrar (~0.5 s)

const PROTOCOLS = [
  // High-voltage — voltage alone is definitive
  { test: (v)       => v > 17.5,                           label: "PD · 20V",    cls: "proto-pd"    },
  { test: (v)       => v > 13.0,                           label: "PD · 15V",    cls: "proto-pd"    },
  { test: (v)       => v > 10.5,                           label: "QC/PD · 12V", cls: "proto-qc"    },
  { test: (v)       => v > 7.0,                            label: "QC/PD · 9V",  cls: "proto-qc"    },
  // ~5 V — use D+/D- signature
  { test: (v,dp,dn) => v >= 4.5 && sym(dp,dn) && dp > 2.5,          label: "Apple · 2.4A", cls: "proto-apple" },
  { test: (v,dp,dn) => v >= 4.5 && sym(dp,dn) && dp > 1.8,          label: "Apple · 2A",   cls: "proto-apple" },
  { test: (v,dp,dn) => v >= 4.5 && sym(dp,dn) && dp > 1.0,          label: "Apple · 1A",   cls: "proto-apple" },
  { test: (v,dp,dn) => v >= 4.5 && sym(dp,dn) && dp > 0.2,          label: "DCP · 5V",     cls: "proto-dcp"   },
  { test: (v)       => v >= 4.5,                                      label: "USB · 5V",     cls: "proto-std"   },
];

function sym(dp, dn) { return Math.abs(dp - dn) < 0.2; }

function detectProtocol(v, dp, dn) {
  if (v < 0.5) return null;
  return PROTOCOLS.find(p => p.test(v, dp, dn)) ?? null;
}

function updateProtocol(r) {
  const proto = detectProtocol(r.voltage, r.dp, r.dn);
  const label = proto?.label ?? "";

  if (label === (_displayedProto?.label ?? "")) {
    // Already showing the right protocol — reset any pending change
    _pendingProto = null;
    _pendingCount = 0;
    return;
  }

  if (label === (_pendingProto?.label ?? "")) {
    if (++_pendingCount >= PROTO_CONFIRM) {
      _displayedProto = proto;
      _pendingProto   = null;
      _pendingCount   = 0;
      renderProtocol(proto);
    }
  } else {
    _pendingProto = proto;
    _pendingCount = 1;
  }
}

function renderProtocol(proto) {
  const el = $("protocol-badge");
  if (!proto) {
    el.style.display = "none";
    return;
  }
  el.textContent   = proto.label;
  el.className     = `protocol-badge ${proto.cls}`;
  el.style.display = "";
}

function clearProtocol() {
  _displayedProto = _pendingProto = null;
  _pendingCount   = 0;
  renderProtocol(null);
}

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  initChart();
  fetch("/api/status")
    .then(r => r.json())
    .then(d => { if (d.connected) setConnected(true); });
  loadSessions();
});
