"use strict";

const STORAGE_KEY = "wc2026-predictor-v1";   // local working copy of the bracket
let DATA = null;
let state = { groupScores: {}, koPicks: {} };
let bracketLabels = {};
let simTimer = null, serverSaveTimer = null;
let currentUser = null;
let verificationEnforced = false;
let authGate = false;   // true when the login/signup screen is the mandatory landing

// ================================================================ helpers
function teamHTML(team) {
  if (!team) return "";
  const code = DATA.flagCodes && DATA.flagCodes[team];
  const img = code
    ? `<img class="flag-img" src="https://flagcdn.com/w40/${code}.png" ` +
      `srcset="https://flagcdn.com/w80/${code}.png 2x" alt="" loading="lazy" ` +
      `onerror="this.style.display='none'">`
    : `<span class="flag">${(DATA.flags && DATA.flags[team]) || "⚽"}</span>`;
  return `${img}<span class="tname">${team}</span>`;
}

const _DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const _MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const _DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const _MON_LONG = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${_DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${_MON[m - 1]}`;
}
function fmtFullDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${_DOW_LONG[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${_MON_LONG[m - 1]}`;
}
function chanClass(ch) {
  if (!ch) return "";
  if (ch.startsWith("BBC")) return "bbc";
  if (ch.startsWith("ITV")) return "itv";
  return "";
}
function escapeHTML(s) {
  return (s || "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function updatedAgo(ts) {
  if (!ts) return "";
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60) return "just now";
  if (secs < 3600) return Math.floor(secs / 60) + "m ago";
  if (secs < 86400) return Math.floor(secs / 3600) + "h ago";
  return Math.floor(secs / 86400) + "d ago";
}
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, data };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleServerSave();
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && s.groupScores) state = { groupScores: s.groupScores || {}, koPicks: s.koPicks || {} };
  } catch (_) {}
}

// ================================================================ bootstrap
async function init() {
  DATA = (await api("GET", "/api/data")).data;
  DATA.bracket.forEach(r => r.matches.forEach(m => {
    bracketLabels[m.id] = { labelA: m.labelA, labelB: m.labelB };
  }));
  loadState();
  renderGroups();
  renderBracketSkeleton();
  wireTabs();
  wireHeader();
  wireAuthModal();
  wireLeagues();
  handleVerifyRedirect();
  await refreshAuth();   // loads server prediction if logged in
  await simulate();
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "leagues" && currentUser) refreshLeagues();
      if (tab.dataset.tab === "admin" && currentUser && currentUser.isAdmin) renderAdmin();
    });
  });
}

function wireHeader() {
  document.getElementById("reset-btn").addEventListener("click", resetAll);
  document.getElementById("save-btn").addEventListener("click", savePrediction);
  document.getElementById("login-btn").addEventListener("click", () => openAuth("login"));
  document.getElementById("logout-btn").addEventListener("click", logout);
}

function resetAll() {
  if (!confirm("Clear all your predicted scores and bracket picks?")) return;
  state = { groupScores: {}, koPicks: {} };
  saveState();
  document.querySelectorAll(".fixture input").forEach(i => (i.value = ""));
  document.querySelectorAll(".fixture").forEach(r => r.classList.remove("half"));
  simulate();
}

// ================================================================ auth
function handleVerifyRedirect() {
  const p = new URLSearchParams(location.search);
  if (p.has("verified")) {
    setTimeout(() => {
      alert(p.get("verified") === "1"
        ? "Email confirmed — you're logged in!"
        : "That confirmation link is invalid or expired.");
    }, 100);
    history.replaceState({}, "", location.pathname);
  }
}

async function refreshAuth() {
  const { data } = await api("GET", "/api/auth/me");
  currentUser = data.user;
  verificationEnforced = !!data.verificationEnforced;
  updateAuthUI();
  if (currentUser) await loadServerPrediction();
}

function updateAuthUI() {
  const loggedIn = !!currentUser;
  document.getElementById("login-btn").classList.toggle("hidden", loggedIn);
  document.getElementById("user-menu").classList.toggle("hidden", !loggedIn);
  if (loggedIn) document.getElementById("user-name").textContent = currentUser.displayName;
  document.getElementById("leagues-gate").classList.toggle("hidden", loggedIn);
  document.getElementById("leagues-main").classList.toggle("hidden", !loggedIn);
  const admin = loggedIn && currentUser.isAdmin;
  document.querySelectorAll(".admin-only").forEach(el => el.classList.toggle("hidden", !admin));

  // Logged out → mandatory sign-up/login landing. Logged in → close it.
  if (loggedIn) closeAuthGate();
  else openAuth("signup", true);
}

function openAuth(which, gate) {
  authGate = !!gate;
  const modal = document.getElementById("auth-modal");
  modal.classList.remove("hidden");
  modal.classList.toggle("gate", authGate);
  document.getElementById("auth-close").classList.toggle("hidden", authGate);
  switchAuthTab(which || "login");
}
function closeAuth() {
  if (authGate) return;   // can't dismiss the landing gate while logged out
  document.getElementById("auth-modal").classList.add("hidden");
  hideAuthMsgs();
}
function closeAuthGate() {
  authGate = false;
  const modal = document.getElementById("auth-modal");
  modal.classList.add("hidden");
  modal.classList.remove("gate");
  hideAuthMsgs();
}
function hideAuthMsgs() {
  document.getElementById("auth-error").classList.add("hidden");
  document.getElementById("auth-message").classList.add("hidden");
}
function authError(msg) {
  const e = document.getElementById("auth-error");
  e.textContent = msg; e.classList.remove("hidden");
  document.getElementById("auth-message").classList.add("hidden");
}
function authMessage(msg) {
  const e = document.getElementById("auth-message");
  e.textContent = msg; e.classList.remove("hidden");
  document.getElementById("auth-error").classList.add("hidden");
}
function switchAuthTab(which) {
  hideAuthMsgs();
  document.querySelectorAll(".auth-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.auth === which));
  document.getElementById("login-form").classList.toggle("hidden", which !== "login");
  document.getElementById("signup-form").classList.toggle("hidden", which !== "signup");
}

function wireAuthModal() {
  document.getElementById("auth-close").addEventListener("click", closeAuth);
  document.getElementById("auth-modal").addEventListener("click", e => {
    if (e.target.id === "auth-modal") closeAuth();
  });
  document.querySelectorAll(".auth-tab").forEach(t =>
    t.addEventListener("click", () => switchAuthTab(t.dataset.auth)));

  document.getElementById("login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const { ok, data } = await api("POST", "/api/auth/login", { email, password });
    if (!ok) { authError(data.error || "Login failed."); return; }
    closeAuth();
    await refreshAuth();
    await refreshLeagues();
  });

  document.getElementById("signup-form").addEventListener("submit", async e => {
    e.preventDefault();
    const displayName = document.getElementById("signup-name").value.trim();
    const email = document.getElementById("signup-email").value.trim();
    const password = document.getElementById("signup-password").value;
    const { ok, data } = await api("POST", "/api/auth/signup", { displayName, email, password });
    if (!ok) { authError(data.error || "Sign-up failed."); return; }
    if (data.needVerify) {
      switchAuthTab("login");   // (clears messages first)
      authMessage(`✅ Account created! We've emailed a confirmation link to ${email}. ` +
        `Please open it to verify your email, then log in here.`);
      return;
    }
    await refreshAuth();        // dev auto-verify: logs in + closes the gate
    await refreshLeagues();
  });
}

async function logout() {
  await api("POST", "/api/auth/logout");
  currentUser = null;
  updateAuthUI();
}

// ================================================================ prediction sync
async function loadServerPrediction() {
  const { ok, data } = await api("GET", "/api/prediction");
  if (ok && data.state && data.state.groupScores) {
    state = { groupScores: data.state.groupScores || {}, koPicks: data.state.koPicks || {} };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    renderGroups();
    await simulate();
  }
}
function scheduleServerSave() {
  if (!currentUser) return;
  clearTimeout(serverSaveTimer);
  serverSaveTimer = setTimeout(() => api("POST", "/api/prediction", { state }), 1200);
}
async function savePrediction() {
  if (!currentUser) { openAuth("login"); return; }
  const { ok } = await api("POST", "/api/prediction", { state });
  const btn = document.getElementById("save-btn");
  const orig = btn.textContent;
  btn.textContent = ok ? "Saved ✓" : "Error";
  setTimeout(() => (btn.textContent = orig), 1400);
}

// ================================================================ leagues
function wireLeagues() {
  document.getElementById("create-league-btn").addEventListener("click", createLeague);
  document.getElementById("join-league-btn").addEventListener("click", joinLeague);
  document.getElementById("league-back").addEventListener("click", showLeaguesHome);
  document.getElementById("copy-code-btn").addEventListener("click", () => {
    const code = document.getElementById("league-detail-code").textContent;
    navigator.clipboard?.writeText(code);
    const b = document.getElementById("copy-code-btn");
    b.textContent = "Copied!"; setTimeout(() => (b.textContent = "Copy"), 1200);
  });
  document.getElementById("join-code").addEventListener("keydown",
    e => { if (e.key === "Enter") joinLeague(); });
  document.getElementById("league-name").addEventListener("keydown",
    e => { if (e.key === "Enter") createLeague(); });
}

async function refreshLeagues() {
  if (!currentUser) return;
  const { data } = await api("GET", "/api/leagues");
  const list = document.getElementById("leagues-list");
  const empty = document.getElementById("leagues-empty");
  list.innerHTML = "";
  if (!Array.isArray(data) || !data.length) { empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  data.forEach(lg => {
    const card = document.createElement("div");
    card.className = "pred-card";
    card.innerHTML = `
      <div class="pname">${escapeHTML(lg.name)}</div>
      <div class="line">Code: <b class="code-inline">${lg.code}</b></div>
      <div class="line">${lg.members} member${lg.members === 1 ? "" : "s"}${lg.isOwner ? " · you own this" : ""}</div>`;
    card.addEventListener("click", () => openLeague(lg.code));
    list.appendChild(card);
  });
}

async function createLeague() {
  const input = document.getElementById("league-name");
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const { ok, data } = await api("POST", "/api/leagues", { name });
  if (!ok) { alert(data.error || "Could not create league."); return; }
  input.value = "";
  await refreshLeagues();
  openLeague(data.code);
}

async function joinLeague() {
  const input = document.getElementById("join-code");
  const code = input.value.trim().toUpperCase();
  if (!code) { input.focus(); return; }
  const { ok, data } = await api("POST", "/api/leagues/join", { code });
  if (!ok) { alert(data.error || "Could not join league."); return; }
  input.value = "";
  await refreshLeagues();
  openLeague(data.code);
}

function showLeaguesHome() {
  document.getElementById("league-detail").classList.add("hidden");
  document.getElementById("leagues-home").classList.remove("hidden");
  refreshLeagues();
}

async function openLeague(code) {
  const { ok, data } = await api("GET", "/api/leagues/" + encodeURIComponent(code));
  if (!ok) { alert(data.error || "Could not open league."); return; }
  document.getElementById("leagues-home").classList.add("hidden");
  document.getElementById("league-detail").classList.remove("hidden");
  document.getElementById("league-detail-name").textContent = data.name;
  document.getElementById("league-detail-code").textContent = data.code;

  const actions = document.getElementById("league-detail-actions");
  actions.innerHTML = data.isOwner
    ? `<button class="btn ghost small danger" id="del-league">Delete league</button>`
    : `<button class="btn ghost small" id="leave-league">Leave league</button>`;
  const del = document.getElementById("del-league");
  if (del) del.addEventListener("click", () => deleteLeague(data.code));
  const leave = document.getElementById("leave-league");
  if (leave) leave.addEventListener("click", () => leaveLeague(data.code));

  // Members board, sorted: most progress first, then name.
  const members = [...data.members].sort((a, b) =>
    ((b.summary?.predicted || 0) - (a.summary?.predicted || 0)) ||
    a.displayName.localeCompare(b.displayName));
  let html = `<tr><th>Player</th><th>Champion</th><th>Runner-up</th><th>Predicted</th></tr>`;
  members.forEach(m => {
    const s = m.summary || {};
    const me = currentUser && m.userId === currentUser.id ? ' class="me"' : "";
    html += `<tr${me}>
      <td>${escapeHTML(m.displayName)}${me ? " (you)" : ""}</td>
      <td>${s.champion ? teamHTML(s.champion) : "—"}</td>
      <td>${s.runnerUp ? teamHTML(s.runnerUp) : "—"}</td>
      <td>${s.predicted || 0}/${s.total || 72}</td>
    </tr>`;
  });
  document.getElementById("league-board").innerHTML = html;
}

async function leaveLeague(code) {
  if (!confirm("Leave this league?")) return;
  const { ok, data } = await api("POST", `/api/leagues/${encodeURIComponent(code)}/leave`);
  if (!ok) { alert(data.error || "Could not leave."); return; }
  showLeaguesHome();
}
async function deleteLeague(code) {
  if (!confirm("Delete this league for everyone? This cannot be undone.")) return;
  const { ok, data } = await api("DELETE", "/api/leagues/" + encodeURIComponent(code));
  if (!ok) { alert(data.error || "Could not delete."); return; }
  showLeaguesHome();
}

// ================================================================ admin panel
async function renderAdmin() {
  await Promise.all([renderAdminLeagues(), renderAdminUsers()]);
  document.getElementById("admin-members").classList.add("hidden");
  const close = document.getElementById("admin-members-close");
  close.onclick = () => document.getElementById("admin-members").classList.add("hidden");
}

async function renderAdminLeagues() {
  const { ok, data } = await api("GET", "/api/admin/leagues");
  const t = document.getElementById("admin-leagues");
  if (!ok) { t.innerHTML = ""; return; }
  let html = `<tr><th>Name</th><th>Code</th><th>Owner</th><th>Members</th><th>Actions</th></tr>`;
  data.forEach(l => {
    html += `<tr>
      <td>${escapeHTML(l.name)}</td>
      <td><span class="code-inline">${l.code}</span></td>
      <td>${escapeHTML(l.owner_name)}</td>
      <td>${l.members}</td>
      <td class="actions">
        <button class="btn ghost small" data-act="members" data-code="${l.code}" data-name="${escapeHTML(l.name)}">Members</button>
        <button class="btn ghost small" data-act="rename" data-code="${l.code}" data-name="${escapeHTML(l.name)}">Rename</button>
        <button class="btn ghost small danger" data-act="del" data-code="${l.code}">Delete</button>
      </td></tr>`;
  });
  t.innerHTML = html;
  t.querySelectorAll("button[data-act]").forEach(b => b.addEventListener("click", () => {
    const code = b.dataset.code;
    if (b.dataset.act === "del") adminDeleteLeague(code);
    else if (b.dataset.act === "rename") adminRenameLeague(code, b.dataset.name);
    else if (b.dataset.act === "members") adminViewMembers(code, b.dataset.name);
  }));
}

async function adminRenameLeague(code, current) {
  const name = prompt("Rename league:", current);
  if (name === null) return;
  const { ok, data } = await api("PATCH", "/api/admin/leagues/" + encodeURIComponent(code), { name: name.trim() });
  if (!ok) { alert(data.error || "Rename failed."); return; }
  renderAdminLeagues();
}
async function adminDeleteLeague(code) {
  if (!confirm(`Delete league ${code} for everyone?`)) return;
  const { ok, data } = await api("DELETE", "/api/admin/leagues/" + encodeURIComponent(code));
  if (!ok) { alert(data.error || "Delete failed."); return; }
  renderAdminLeagues();
}

async function adminViewMembers(code, name) {
  const { ok, data } = await api("GET", "/api/admin/leagues/" + encodeURIComponent(code));
  if (!ok) { alert(data.error || "Could not load members."); return; }
  document.getElementById("admin-members").classList.remove("hidden");
  document.getElementById("admin-members-title").textContent = `Members of ${name} (${code})`;
  const list = document.getElementById("admin-members-list");
  if (!data.members.length) { list.innerHTML = `<div class="hint">No members.</div>`; return; }
  list.innerHTML = data.members.map(m =>
    `<div class="admin-member-row">
       <span>${escapeHTML(m.displayName)}${m.summary ? ` — champion: ${m.summary.champion || "—"}, ${m.summary.predicted || 0}/72` : " — no prediction"}</span>
       <button class="btn ghost small danger" data-uid="${m.userId}">Remove</button>
     </div>`).join("");
  list.querySelectorAll("button[data-uid]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Remove this member from the league?")) return;
    const r = await api("POST", `/api/admin/leagues/${encodeURIComponent(code)}/remove-member`, { userId: +b.dataset.uid });
    if (!r.ok) { alert(r.data.error || "Failed."); return; }
    adminViewMembers(code, name);
    renderAdminLeagues();
  }));
}

async function renderAdminUsers() {
  const { ok, data } = await api("GET", "/api/admin/users");
  const t = document.getElementById("admin-users");
  if (!ok) { t.innerHTML = ""; return; }
  let html = `<tr><th>Name</th><th>Email</th><th>Verified</th><th>Leagues</th><th>Prediction</th><th>Actions</th></tr>`;
  data.forEach(u => {
    html += `<tr>
      <td>${escapeHTML(u.display_name)}</td>
      <td>${escapeHTML(u.email)}</td>
      <td>${u.verified ? "✅" : "❌"}</td>
      <td>${u.leagues}</td>
      <td>${u.has_pred ? "yes" : "—"}</td>
      <td class="actions">
        ${u.verified ? "" : `<button class="btn ghost small" data-act="verify" data-id="${u.id}">Verify</button>`}
        <button class="btn ghost small danger" data-act="del" data-id="${u.id}" data-name="${escapeHTML(u.display_name)}">Delete</button>
      </td></tr>`;
  });
  t.innerHTML = html;
  t.querySelectorAll("button[data-act]").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.act === "verify") adminVerifyUser(b.dataset.id);
    else adminDeleteUser(b.dataset.id, b.dataset.name);
  }));
}
async function adminVerifyUser(id) {
  const { ok, data } = await api("POST", `/api/admin/users/${id}/verify`);
  if (!ok) { alert(data.error || "Failed."); return; }
  renderAdminUsers();
}
async function adminDeleteUser(id, name) {
  if (!confirm(`Delete user "${name}"? This removes their account, prediction, and any leagues they own.`)) return;
  const { ok, data } = await api("DELETE", `/api/admin/users/${id}`);
  if (!ok) { alert(data.error || "Failed."); return; }
  renderAdminUsers();
  renderAdminLeagues();
}

// ================================================================ group stage
function renderGroups() {
  const grid = document.getElementById("groups-grid");
  grid.innerHTML = "";
  const byGroup = {};
  DATA.fixtures.forEach(f => (byGroup[f.group] = byGroup[f.group] || []).push(f));

  Object.keys(DATA.groups).forEach(letter => {
    const card = document.createElement("div");
    card.className = "group-card";
    card.innerHTML = `
      <h3>Group ${letter}</h3>
      <table class="standings" id="standings-${letter}"></table>
      <div class="fixtures" id="fixtures-${letter}"></div>`;
    grid.appendChild(card);

    const fxWrap = card.querySelector(`#fixtures-${letter}`);
    let lastMd = 0;
    byGroup[letter].forEach(fx => {
      if (fx.matchday !== lastMd) {
        lastMd = fx.matchday;
        const lbl = document.createElement("div");
        lbl.className = "matchday-label";
        lbl.textContent = "Matchday " + fx.matchday;
        fxWrap.appendChild(lbl);
      }
      const sc = state.groupScores[fx.id] || {};
      if (fx.date) {
        const meta = document.createElement("div");
        meta.className = "fixture-meta";
        meta.innerHTML =
          `<span class="when">${fmtDate(fx.date)} · ${fx.time} BST</span>` +
          `<span class="chan ${chanClass(fx.channel)}">${fx.channel}</span>`;
        fxWrap.appendChild(meta);
      }
      const row = document.createElement("div");
      row.className = "fixture";
      row.innerHTML = `
        <span class="home">${teamHTML(fx.home)}</span>
        <span class="score">
          <input type="number" min="0" max="99" data-mid="${fx.id}" data-side="home" value="${sc.home ?? ""}">
          <span>–</span>
          <input type="number" min="0" max="99" data-mid="${fx.id}" data-side="away" value="${sc.away ?? ""}">
        </span>
        <span class="away">${teamHTML(fx.away)}</span>`;
      fxWrap.appendChild(row);
      markFixture(row);
    });
  });

  grid.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("input", onScoreInput);
    inp.addEventListener("keydown", onScoreKeydown);
    inp.addEventListener("focus", () => inp.select());
  });
}

function onScoreInput(e) {
  const inp = e.target;
  const mid = inp.dataset.mid, side = inp.dataset.side;
  const sc = state.groupScores[mid] || {};
  const v = inp.value === "" ? null : Math.max(0, parseInt(inp.value, 10));
  if (v === null || Number.isNaN(v)) delete sc[side];
  else sc[side] = v;
  if (sc.home == null && sc.away == null) delete state.groupScores[mid];
  else state.groupScores[mid] = sc;
  saveState();
  scheduleSim();
  markFixture(inp.closest(".fixture"));
  if (v !== null && inp.value !== "") focusSibling(inp, +1);
}

function onScoreKeydown(e) {
  if (e.key === "Enter") { focusSibling(e.target, +1); e.preventDefault(); }
  else if (e.key === "Backspace" && e.target.value === "") {
    focusSibling(e.target, -1); e.preventDefault();
  }
}
function focusSibling(current, dir) {
  const inputs = [...document.querySelectorAll("#groups-grid input")];
  const next = inputs[inputs.indexOf(current) + dir];
  if (next) { next.focus(); next.select(); }
}
function markFixture(row) {
  if (!row) return;
  const filled = [...row.querySelectorAll("input")].filter(i => i.value.trim() !== "").length;
  row.classList.toggle("half", filled === 1);
}
function scheduleSim() {
  clearTimeout(simTimer);
  simTimer = setTimeout(simulate, 180);
}

// ================================================================ simulate + render
async function simulate() {
  const res = (await api("POST", "/api/simulate", state)).data;
  renderStandings(res);
  renderThirdPlace(res);
  renderBracket(res);
  renderChampion(res);
  renderProgress();
  renderSchedule();
}

function renderProgress() {
  const total = DATA.fixtures.length;
  const remaining = DATA.fixtures.filter(f => {
    const s = state.groupScores[f.id] || {};
    return s.home == null || s.away == null;
  });
  const done = total - remaining.length;
  document.getElementById("progress-fill").style.width = (100 * done / total) + "%";
  document.getElementById("progress-text").textContent =
    done === total ? `All ${total} group matches predicted ✓`
                   : `${done} / ${total} group matches predicted`;

  const miss = document.getElementById("progress-missing");
  if (remaining.length && remaining.length <= 8) {
    miss.innerHTML = `<span class="ml">${remaining.length} left:</span>` +
      remaining.map(f => `<button class="miss-chip" data-fid="${f.id}">${f.home} v ${f.away}</button>`).join("");
    miss.classList.remove("hidden");
    miss.querySelectorAll(".miss-chip").forEach(b =>
      b.addEventListener("click", () => jumpToFixture(b.dataset.fid)));
  } else {
    miss.innerHTML = ""; miss.classList.add("hidden");
  }
}
function jumpToFixture(fid) {
  document.querySelector('.tab[data-tab="groups"]').click();
  const inp = document.querySelector(`#groups-grid input[data-mid="${fid}"]`);
  if (!inp) return;
  const row = inp.closest(".fixture");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  const empty = [...row.querySelectorAll("input")].find(i => i.value.trim() === "");
  (empty || inp).focus();
}

function renderStandings(res) {
  Object.entries(res.standings).forEach(([letter, data]) => {
    const t = document.getElementById("standings-" + letter);
    if (!t) return;
    let html = `<tr><th class="team">Team</th><th>Pl</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr>`;
    data.rows.forEach(r => {
      const cls = r.pos <= 3 ? `pos${r.pos}` : "";
      const gd = r.gd > 0 ? "+" + r.gd : r.gd;
      html += `<tr class="${cls}">
        <td class="team">${teamHTML(r.team)}</td>
        <td>${r.played}</td><td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td>
        <td>${gd}</td><td><b>${r.points}</b></td></tr>`;
    });
    t.innerHTML = html;
  });
}

function renderThirdPlace(res) {
  const wrap = document.getElementById("third-place");
  const table = document.getElementById("third-table");
  if (!res.groupsComplete || !res.thirdPlaceRanked.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  let html = `<tr><th>Rank</th><th>Group</th><th>Team</th><th>Pts</th><th>GD</th><th>GF</th><th>Status</th></tr>`;
  res.thirdPlaceRanked.forEach((t, i) => {
    html += `<tr class="${t.qualified ? "q" : ""}">
      <td>${i + 1}</td><td>${t.group}</td><td>${teamHTML(t.team)}</td>
      <td>${t.points}</td><td>${t.gd > 0 ? "+" + t.gd : t.gd}</td><td>${t.gf}</td>
      <td>${t.qualified ? "✅ Qualified" : "Eliminated"}</td></tr>`;
  });
  table.innerHTML = html;
}

function renderSchedule() {
  const wrap = document.getElementById("schedule-list");
  if (!wrap || !DATA) return;
  const fx = [...DATA.fixtures].filter(f => f.date)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  let html = "", curDate = null;
  fx.forEach(f => {
    if (f.date !== curDate) { curDate = f.date; html += `<div class="sched-day">${fmtFullDate(f.date)}</div>`; }
    const sc = state.groupScores[f.id] || {};
    const has = sc.home != null && sc.away != null;
    const mid = has ? `<span class="sc">${sc.home} – ${sc.away}</span>` : `<span class="vs">v</span>`;
    html += `<div class="sched-row">
      <span class="t">${f.time}</span>
      <span class="grp" title="Group ${f.group}">${f.group}</span>
      <span class="h">${teamHTML(f.home)}</span>
      ${mid}
      <span class="a">${teamHTML(f.away)}</span>
      <span class="chan ${chanClass(f.channel)}">${f.channel || ""}</span>
    </div>`;
  });
  wrap.innerHTML = html;
}

function renderBracketSkeleton() {
  const wrap = document.getElementById("bracket");
  wrap.innerHTML = "";
  DATA.bracket.forEach(round => {
    const col = document.createElement("div");
    col.className = "round";
    col.innerHTML = `<h4>${round.name}</h4><div class="round-matches" id="round-${round.name.replace(/\W/g, "")}"></div>`;
    wrap.appendChild(col);
  });
}

function renderBracket(res) {
  const notice = document.getElementById("ko-notice");
  if (!res.groupsComplete) {
    notice.classList.remove("hidden");
    notice.textContent = "Finish predicting all 72 group matches to unlock the knockout bracket.";
  } else {
    notice.classList.add("hidden");
  }
  DATA.bracket.forEach(round => {
    const container = document.getElementById("round-" + round.name.replace(/\W/g, ""));
    container.innerHTML = "";
    round.matches.forEach(m => container.appendChild(koMatchEl(m.id, res.bracket[m.id] || {})));
  });
}

function koMatchEl(mid, b) {
  const el = document.createElement("div");
  el.className = "ko-match";
  const lbl = bracketLabels[mid] || {};
  el.appendChild(koTeamEl(mid, b.teamA, lbl.labelA, b.winner, b.teamA && b.teamB));
  el.appendChild(koTeamEl(mid, b.teamB, lbl.labelB, b.winner, b.teamA && b.teamB));
  const tag = document.createElement("div");
  tag.className = "mid"; tag.textContent = "Match " + mid;
  el.appendChild(tag);
  return el;
}
function koTeamEl(mid, team, placeholder, winner, clickable) {
  const div = document.createElement("div");
  div.className = "ko-team";
  if (team) {
    div.innerHTML = teamHTML(team);
    if (winner === team) div.classList.add("winner");
    if (clickable) {
      div.classList.add("clickable");
      div.addEventListener("click", () => pickWinner(mid, team));
    }
  } else {
    div.classList.add("placeholder");
    div.textContent = placeholder || "—";
  }
  return div;
}
function pickWinner(mid, team) {
  if (state.koPicks[String(mid)] === team) delete state.koPicks[String(mid)];
  else state.koPicks[String(mid)] = team;
  saveState();
  simulate();
}
function renderChampion(res) {
  const banner = document.getElementById("champion-banner");
  if (res.champion) {
    banner.classList.remove("hidden");
    banner.innerHTML = `Champion: ${teamHTML(res.champion)}`;
  } else {
    banner.classList.add("hidden");
  }
}

init();
