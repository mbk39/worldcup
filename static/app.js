"use strict";

const STORAGE_KEY = "wc2026-predictor-v1";   // local working copy of the bracket
let DATA = null;
let state = { groupScores: {}, koPicks: {} };
let bracketLabels = {};
let simTimer = null, serverSaveTimer = null;
let currentUser = null;
let verificationEnforced = false;
let authGate = false;   // true when the login/signup screen is the mandatory landing
let RESULTS = {};       // actual match results: match_id -> {home,away,status,scorers}
let LIVE_SCORES = {};   // this user's continuous per-match group picks
let LIVE_KO = {};       // this user's knockout picks {K-73: {home,away,adv}}
let ACTUAL_GROUP_COMPLETE = false;
let LOCKS = { tournamentLocked: false, lockedMatches: new Set(), tournamentLockTime: 0 };
const ZERO_PTS = { total: 0, perMatch: {} };
const ZERO_POINTS = () => ({ tournament: { ...ZERO_PTS }, group: { ...ZERO_PTS }, knockout: { ...ZERO_PTS } });
let MYPOINTS = ZERO_POINTS();
let LEAGUE_DATA = null, LEAGUE_TRACK = "tournament";
let ACTUAL_BRACKET = {};   // real knockout bracket resolved from results

async function fetchResults() {
  const r = await api("GET", "/api/results");
  RESULTS = r.ok ? (r.data || {}) : {};
}
async function fetchLocks() {
  const r = await api("GET", "/api/locks");
  if (r.ok) LOCKS = { ...r.data, lockedMatches: new Set(r.data.lockedMatches || []) };
}
async function fetchLive() {
  if (!currentUser) { LIVE_SCORES = {}; return; }
  const r = await api("GET", "/api/live");
  LIVE_SCORES = r.ok ? (r.data.scores || {}) : {};
}
async function fetchLiveKo() {
  if (!currentUser) { LIVE_KO = {}; return; }
  const r = await api("GET", "/api/live/ko");
  LIVE_KO = r.ok ? (r.data.scores || {}) : {};
}
async function fetchMyPoints() {
  if (!currentUser) { MYPOINTS = ZERO_POINTS(); return; }
  const r = await api("GET", "/api/me/points");
  MYPOINTS = r.ok ? r.data : ZERO_POINTS();
}

// ================================================================ helpers
const SHORT_NAMES = {
  "Bosnia & Herzegovina": "Bosnia-Herz.",
  "Korea Republic": "Korea Rep.",
};
function teamHTML(team) {
  if (!team) return "";
  const code = DATA.flagCodes && DATA.flagCodes[team];
  const img = code
    ? `<img class="flag-img" src="https://flagcdn.com/w40/${code}.png" ` +
      `srcset="https://flagcdn.com/w80/${code}.png 2x" alt="" loading="lazy" ` +
      `onerror="this.style.display='none'">`
    : `<span class="flag">${(DATA.flags && DATA.flags[team]) || "⚽"}</span>`;
  const c3 = (DATA.codes3 && DATA.codes3[team]) || "";
  const disp = SHORT_NAMES[team] || team;
  return `${img}<span class="tcol"><span class="tname" title="${escapeHTML(team)}">${disp}</span>` +
         (c3 ? `<span class="tcode">${c3}</span>` : "") + `</span>`;
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

// ================================================================ theme
const THEME_KEY = "wc2026-theme";
function applyTheme(t) {
  const theme = t === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "light" ? "🌙" : "☀️";
}
function wireTheme() {
  document.getElementById("theme-toggle").addEventListener("click", () =>
    applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light"));
}

// ================================================================ bootstrap
async function init() {
  applyTheme(localStorage.getItem(THEME_KEY) || "dark");
  wireTheme();
  DATA = (await api("GET", "/api/data")).data;
  DATA.bracket.forEach(r => r.matches.forEach(m => {
    bracketLabels[m.id] = { labelA: m.labelA, labelB: m.labelB };
  }));
  loadState();
  await fetchLocks();      // need lock state before rendering inputs
  renderGroups();
  renderBracketSkeleton();
  wireTabs();
  wireHeader();
  wireAuthModal();
  wireLeagues();
  wireSubToggle();
  wireLiveSubToggle();
  document.querySelectorAll(".home-card").forEach(c => c.addEventListener("click", () => {
    const t = document.querySelector(`.tab[data-tab="${c.dataset.goto}"]`);
    if (t) t.click();
  }));
  handleVerifyRedirect();
  parseJoin();
  await refreshAuth();     // loads server prediction if logged in
  await fetchLive();
  await fetchResults();
  await fetchMyPoints();
  await simulate();
  applyTournamentLock();
  await processPendingJoin();
  startLiveRefresh();
}

let pendingJoin = null;
function parseJoin() {
  const p = new URLSearchParams(location.search);
  if (p.has("join")) {
    pendingJoin = (p.get("join") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    history.replaceState({}, "", location.pathname);
  }
}
async function processPendingJoin() {
  if (!pendingJoin || !currentUser) return;   // if not logged in, handled after auth
  const code = pendingJoin; pendingJoin = null;
  const { ok, data } = await api("POST", "/api/leagues/join", { code });
  if (!ok) { alert(data.error || "Could not join that league."); return; }
  await refreshLeagues();
  document.querySelector('.tab[data-tab="leagues"]').click();
  openLeague(code);
}

// Poll for new results so scores/leaderboards update without a manual reload.
function startLiveRefresh() {
  setInterval(async () => {
    if (document.hidden || !currentUser) return;
    await fetchLocks();
    applyTournamentLock();
    const active = document.querySelector(".tab.active")?.dataset.tab;
    if (active === "results") {
      await renderResults();
    } else if (active === "live") {
      await renderLive();
      await renderLiveKnockout();
    } else if (active === "leagues" &&
               !document.getElementById("league-detail").classList.contains("hidden")) {
      const code = document.getElementById("league-detail-code").textContent;
      if (code) openLeague(code);
    } else {
      await fetchResults();
      await fetchMyPoints();
    }
  }, 60000);
}

// ---------------------------------------------------------------- tournament lock + live picks
function lockTimeText() {
  if (!LOCKS.tournamentLockTime) return "the first kick-off";
  try {
    return new Date(LOCKS.tournamentLockTime * 1000).toLocaleString("en-GB", {
      timeZone: "Europe/London", weekday: "short", day: "numeric",
      month: "short", hour: "2-digit", minute: "2-digit",
    }) + " BST";
  } catch (_) { return "11 Jun, 20:00 BST"; }
}

function applyTournamentLock() {
  const bar = document.getElementById("predictor-lock");
  const locked = LOCKS.tournamentLocked;
  if (bar) {
    bar.classList.remove("hidden");
    bar.className = "lockbar" + (locked ? " locked" : "");
    bar.innerHTML = locked
      ? "🔒 Tournament predictions are locked — the tournament has started. Use <b>Live Picks</b> to keep predicting upcoming games."
      : `🔓 Your Tournament bracket locks at the first kick-off — <b>${lockTimeText()}</b>. After that, use <b>Live Picks</b> for the rest of the tournament.`;
  }
  document.querySelectorAll("#groups-grid input").forEach(i => (i.disabled = locked));
  const sb = document.getElementById("save-btn");
  if (sb) sb.style.display = locked ? "none" : "";
}

async function renderLive() {
  const wrap = document.getElementById("live-list");
  if (!wrap || !DATA) return;
  await fetchLocks();
  await fetchLive();
  await fetchResults();
  await fetchMyPoints();
  document.getElementById("live-points").innerHTML =
    `Your rolling points so far: <b>${MYPOINTS.group?.total || 0}</b>`;

  const fx = [...DATA.fixtures].filter(f => f.date)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  let html = "", curDate = null;
  fx.forEach(f => {
    if (f.date !== curDate) { curDate = f.date; html += `<div class="sched-day">${fmtFullDate(f.date)}</div>`; }
    const locked = LOCKS.lockedMatches.has(f.id);
    const sc = LIVE_SCORES[f.id] || {};
    const res = RESULTS[f.id];
    const resBadge = (res && res.home != null)
      ? `<span class="st ${res.status === "live" ? "live" : "ft"}">${res.status === "live" ? "LIVE" : "FT"} ${res.home}–${res.away}</span>` : "";
    const lockChip = locked ? `<span class="lockchip">🔒</span>` : "";
    let pill = "";
    if (res && res.home != null && sc.home != null && sc.away != null) {
      const p = MYPOINTS.group?.perMatch?.[f.id];
      if (p != null) pill = `<span class="pts pts${p}">+${p}</span>`;
    }
    const inputs = locked
      ? `<span class="locked-pick">${sc.home ?? "–"} – ${sc.away ?? "–"}</span>`
      : `<input type="number" min="0" max="99" class="live-h" value="${sc.home ?? ""}">` +
        `<span>–</span><input type="number" min="0" max="99" class="live-a" value="${sc.away ?? ""}">`;
    html += `<div class="live-meta"><span class="when">${f.time} BST${f.venue ? ` · 📍 ${f.venue}, ${f.city}` : ""}</span> ${resBadge} ${lockChip} ${pill}</div>
      <div class="fixture-line"><span class="chan-left chan ${chanClass(f.channel)}">${f.channel || ""}</span>
        <div class="fixture${locked ? " locked" : ""}" data-mid="${f.id}">
          <span class="home">${teamHTML(f.home)}</span>
          <span class="score">${inputs}</span>
          <span class="away">${teamHTML(f.away)}</span>
        </div></div>`;
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll(".fixture:not(.locked) input").forEach(i => {
    i.addEventListener("change", onLiveChange);
    i.addEventListener("focus", () => i.select());
  });
}

async function onLiveChange(e) {
  const row = e.target.closest(".fixture");
  const mid = row.dataset.mid;
  const home = row.querySelector(".live-h").value;
  const away = row.querySelector(".live-a").value;
  const { ok, data } = await api("POST", "/api/live", { scores: { [mid]: { home, away } } });
  if (ok) LIVE_SCORES = data.scores;
  await fetchMyPoints();
  document.getElementById("live-points").innerHTML =
    `Your rolling points so far: <b>${MYPOINTS.group?.total || 0}</b>`;
}

async function renderLiveKnockout() {
  const wrap = document.getElementById("live-ko-list");
  if (!wrap || !DATA) return;
  await fetchLocks();
  await fetchActualBracket();
  await fetchLiveKo();
  await fetchResults();
  await fetchMyPoints();
  document.getElementById("live-ko-points").innerHTML =
    `Your knockout points so far: <b>${MYPOINTS.knockout?.total || 0}</b>`;

  const notice = document.getElementById("live-ko-notice");
  if (!ACTUAL_GROUP_COMPLETE) {
    notice.classList.remove("hidden");
    notice.textContent = "🔒 Knockout predictions open once the group stage finishes and the Round-of-32 is set.";
    wrap.innerHTML = "";
    return;
  }
  notice.classList.add("hidden");

  let html = "";
  DATA.bracket.forEach(round => {
    html += `<div class="ko-round-h">${round.name}</div>`;
    round.matches.forEach(m => {
      const a = ACTUAL_BRACKET[String(m.id)] || {};
      const kid = "K-" + m.id;
      const known = a.teamA && a.teamB;
      if (!known) {
        html += `<div class="ko-await">Match ${m.id} — awaiting earlier results</div>`;
        return;
      }
      const locked = LOCKS.lockedMatches.has(kid);
      const sc = LIVE_KO[kid] || {};
      const res = RESULTS[kid];
      const when = (m.date ? `${fmtDate(m.date)} · ${m.time} BST` : "") +
        (m.venue ? ` · 📍 ${escapeHTML(m.venue)}, ${escapeHTML(m.city)}` : "");
      const resBadge = (res && res.home != null)
        ? `<span class="st ${res.status === "live" ? "live" : "ft"}">${res.status === "live" ? "LIVE" : "FT"} ${res.home}–${res.away}</span>` : "";
      const lockChip = locked ? `<span class="lockchip">🔒</span>` : "";
      let pill = "";
      if (res && res.home != null && sc.home != null && sc.away != null) {
        const p = MYPOINTS.knockout?.perMatch?.[kid];
        if (p != null) pill = `<span class="pts pts${p}">+${p}</span>`;
      }
      const isDraw = sc.home != null && sc.home === sc.away;
      const penPicker = `<div class="ko-pen${isDraw ? "" : " hidden"}">
          <span class="ko-pen-label">Penalties:</span>
          <button type="button" class="pen-btn${sc.adv === a.teamA ? " sel" : ""}" data-team="${escapeHTML(a.teamA)}">${escapeHTML(a.teamA)}</button>
          <button type="button" class="pen-btn${sc.adv === a.teamB ? " sel" : ""}" data-team="${escapeHTML(a.teamB)}">${escapeHTML(a.teamB)}</button>
        </div>`;
      const advNote = sc.adv ? ` <span class="adv-note">→ ${escapeHTML(sc.adv)}</span>` : "";
      const inputs = locked
        ? `<span class="locked-pick">${sc.home ?? "–"} – ${sc.away ?? "–"}${sc.adv && isDraw ? " (" + escapeHTML(sc.adv) + ")" : ""}</span>`
        : `<input type="number" min="0" max="99" class="ko-h" value="${sc.home ?? ""}">` +
          `<span>–</span><input type="number" min="0" max="99" class="ko-a" value="${sc.away ?? ""}">`;
      html += `<div class="live-meta"><span class="when">${when}</span> ${resBadge} ${lockChip} ${pill}${locked ? "" : advNote}</div>
        <div class="fixture${locked ? " locked" : ""}" data-mid="${kid}" data-a="${escapeHTML(a.teamA)}" data-b="${escapeHTML(a.teamB)}">
          <span class="home">${teamHTML(a.teamA)}</span>
          <span class="score">${inputs}</span>
          <span class="away">${teamHTML(a.teamB)}</span>
        </div>
        ${locked ? "" : `<div class="ko-pen-row">${penPicker}</div>`}`;
    });
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll(".fixture:not(.locked)").forEach(row => {
    row.querySelectorAll("input").forEach(i => {
      i.addEventListener("input", () => toggleKoPen(row));
      i.addEventListener("change", () => onLiveKoChange(row));
      i.addEventListener("focus", () => i.select());
    });
    const pen = row.nextElementSibling?.querySelector(".ko-pen");
    if (pen) pen.querySelectorAll(".pen-btn").forEach(btn =>
      btn.addEventListener("click", () => {
        pen.querySelectorAll(".pen-btn").forEach(b => b.classList.toggle("sel", b === btn));
        onLiveKoChange(row);
      }));
  });
}

function toggleKoPen(row) {
  const h = row.querySelector(".ko-h").value, a = row.querySelector(".ko-a").value;
  const pen = row.nextElementSibling?.querySelector(".ko-pen");
  if (pen) pen.classList.toggle("hidden", !(h !== "" && a !== "" && +h === +a));
}

async function onLiveKoChange(row) {
  const kid = row.dataset.mid;
  const h = row.querySelector(".ko-h").value, a = row.querySelector(".ko-a").value;
  const pen = row.nextElementSibling?.querySelector(".ko-pen");
  let adv = null;
  if (h !== "" && a !== "") {
    if (+h === +a) {
      const sel = pen?.querySelector(".pen-btn.sel");
      adv = sel ? sel.dataset.team : null;
    } else {
      adv = (+h > +a) ? row.dataset.a : row.dataset.b;
    }
  }
  const { ok, data } = await api("POST", "/api/live/ko", { scores: { [kid]: { home: h, away: a, adv } } });
  if (ok) LIVE_KO = data.scores;
  await fetchMyPoints();
  document.getElementById("live-ko-points").innerHTML =
    `Your knockout points so far: <b>${MYPOINTS.knockout?.total || 0}</b>`;
}

function renderMap() {
  const wrap = document.getElementById("map-list");
  if (!wrap || !DATA || !DATA.venues) return;
  // count matches per venue
  const count = {};
  DATA.fixtures.forEach(f => { if (f.venue) count[f.venue] = (count[f.venue] || 0) + 1; });
  DATA.bracket.forEach(r => r.matches.forEach(m => { if (m.venue) count[m.venue] = (count[m.venue] || 0) + 1; }));
  const flag = { Mexico: "🇲🇽", Canada: "🇨🇦", USA: "🇺🇸" };
  const entries = Object.entries(DATA.venues).sort((a, b) =>
    a[1].country.localeCompare(b[1].country) || a[1].city.localeCompare(b[1].city));
  wrap.innerHTML = entries.map(([name, v]) => `
    <div class="venue-card">
      <div class="venue-city">${flag[v.country] || ""} ${v.city}</div>
      <div class="venue-name">${name}${v.alt ? ` <span class="venue-alt">(${v.alt})</span>` : ""}</div>
      <div class="venue-meta">${v.country} · ${count[name] || 0} match${(count[name] || 0) === 1 ? "" : "es"}</div>
    </div>`).join("");

  if (window.L) {
    if (!window._venueMap) {
      const map = window.L.map("venue-map", { scrollWheelZoom: false });
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
      const pts = [];
      entries.forEach(([name, v]) => {
        if (v.lat == null) return;
        window.L.circleMarker([v.lat, v.lng],
          { radius: 8, color: "#fff", weight: 2, fillColor: "#fb923c", fillOpacity: .95 })
          .addTo(map)
          .bindPopup(`<b>${name}</b><br>${v.city}, ${v.country}<br>${count[name] || 0} match${(count[name] || 0) === 1 ? "" : "es"}`);
        pts.push([v.lat, v.lng]);
      });
      if (pts.length) map.fitBounds(pts, { padding: [34, 34] });
      window._venueMap = map;
    }
    setTimeout(() => window._venueMap.invalidateSize(), 120);
  }
}

function wireSubToggle() {
  document.querySelectorAll("#tab-predictor > .subtoggle .subtab").forEach(b =>
    b.addEventListener("click", () => showSub(b.dataset.sub)));
}
function showSub(which) {
  document.querySelectorAll("#tab-predictor > .subtoggle .subtab").forEach(t =>
    t.classList.toggle("active", t.dataset.sub === which));
  document.getElementById("sub-groups").classList.toggle("active", which === "groups");
  document.getElementById("sub-knockout").classList.toggle("active", which === "knockout");
}

function wireLiveSubToggle() {
  document.querySelectorAll("#live-toggle .subtab").forEach(b =>
    b.addEventListener("click", () => {
      const which = b.dataset.livesub;
      document.querySelectorAll("#live-toggle .subtab").forEach(t =>
        t.classList.toggle("active", t.dataset.livesub === which));
      document.getElementById("live-group").classList.toggle("active", which === "group");
      document.getElementById("live-ko").classList.toggle("active", which === "knockout");
    }));
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
      if (tab.dataset.tab === "results") renderResults();
      if (tab.dataset.tab === "live") { renderLive(); renderLiveKnockout(); }
      if (tab.dataset.tab === "map") renderMap();
    });
  });
}

function wireHeader() {
  document.getElementById("reset-btn").addEventListener("click", resetAll);
  document.getElementById("save-btn").addEventListener("click", savePrediction);
  document.getElementById("login-btn").addEventListener("click", () => openAuth("login"));
  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("randomfill-btn").addEventListener("click", () => randomFill(true));
  document.getElementById("randomscores-btn").addEventListener("click", () => randomFill(false));
}

const _rnd = n => Math.floor(Math.random() * n);

async function randomFill(includeBracket) {
  if (LOCKS.tournamentLocked) { alert("Predictions are locked — the tournament has started."); return; }
  DATA.fixtures.forEach(f => {
    state.groupScores[f.id] = { home: _rnd(4), away: _rnd(4) };
  });
  if (includeBracket) {
    state.koPicks = {};
    saveState();
    for (let pass = 0; pass < 6; pass++) {
      const res = (await api("POST", "/api/simulate", state)).data;
      for (const [mid, m] of Object.entries(res.bracket)) {
        if (m.teamA && m.teamB && !(mid in state.koPicks)) {
          state.koPicks[mid] = Math.random() < 0.5 ? m.teamA : m.teamB;
        }
      }
    }
  }
  saveState();
  renderGroups();
  await simulate();
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
    await processPendingJoin();
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
    await processPendingJoin();
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
    b.textContent = "Copied!"; setTimeout(() => (b.textContent = "Copy code"), 1200);
  });
  document.getElementById("copy-invite-btn").addEventListener("click", () => {
    const code = document.getElementById("league-detail-code").textContent;
    navigator.clipboard?.writeText(location.origin + "/join/" + code);
    const b = document.getElementById("copy-invite-btn");
    b.textContent = "Link copied!"; setTimeout(() => (b.textContent = "Copy invite link"), 1400);
  });
  document.getElementById("league-member-close").addEventListener("click", () =>
    document.getElementById("league-member").classList.add("hidden"));
  document.getElementById("edit-save").addEventListener("click", saveLeagueEdit);
  document.getElementById("edit-cancel").addEventListener("click", () =>
    document.getElementById("league-edit").classList.add("hidden"));
  document.getElementById("edit-logo-file").addEventListener("change", async e => {
    const url = await uploadImage(e.target.files[0], e.target);
    if (url) document.getElementById("edit-logo").value = url;
  });
  document.getElementById("edit-sponsor-file").addEventListener("change", async e => {
    const url = await uploadImage(e.target.files[0], e.target);
    if (url) {
      const ta = document.getElementById("edit-sponsors");
      ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, "") + "\n" : "") + url;
    }
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
      <div class="pname">${lg.logo ? `<img class="card-logo" src="${lg.logo}" onerror="this.style.display='none'">` : ""}${escapeHTML(lg.name)}</div>
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

  const logo = document.getElementById("league-logo");
  if (data.logo) { logo.src = data.logo; logo.classList.remove("hidden"); logo.onerror = () => logo.classList.add("hidden"); }
  else logo.classList.add("hidden");
  renderSponsors(data.sponsors || []);
  document.getElementById("league-edit").classList.add("hidden");

  const actions = document.getElementById("league-detail-actions");
  actions.innerHTML = data.isOwner
    ? `<button class="btn ghost small" id="edit-league">🎨 Customise</button>
       <button class="btn ghost small danger" id="del-league">Delete league</button>`
    : `<button class="btn ghost small" id="leave-league">Leave league</button>`;
  const del = document.getElementById("del-league");
  if (del) del.addEventListener("click", () => deleteLeague(data.code));
  const leave = document.getElementById("leave-league");
  if (leave) leave.addEventListener("click", () => leaveLeague(data.code));
  const edit = document.getElementById("edit-league");
  if (edit) edit.addEventListener("click", () => openLeagueEdit(data));

  LEAGUE_DATA = data;
  document.querySelectorAll("#league-tracks .subtab").forEach(b =>
    b.onclick = () => { LEAGUE_TRACK = b.dataset.track; renderLeagueBoard(); });
  renderLeagueBoard();
}

function renderSponsors(sponsors) {
  const el = document.getElementById("league-sponsors");
  if (!sponsors || !sponsors.length) { el.innerHTML = ""; return; }
  el.innerHTML = sponsors.map(s => {
    const img = `<img src="${s.img}" alt="${escapeHTML(s.name || "")}" title="${escapeHTML(s.name || "")}" onerror="this.style.display='none'">`;
    return s.link ? `<a href="${s.link}" target="_blank" rel="noopener">${img}</a>` : img;
  }).join("");
}

function openLeagueEdit(data) {
  document.getElementById("edit-name").value = data.name || "";
  document.getElementById("edit-logo").value = data.logo || "";
  document.getElementById("edit-sponsors").value =
    (data.sponsors || []).map(s => [s.img, s.link, s.name].filter(Boolean).join(" | ")).join("\n");
  document.getElementById("league-edit").classList.remove("hidden");
}

async function uploadImage(file, inputEl) {
  if (!file) return null;
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (inputEl) inputEl.value = "";   // reset so the same file can be re-picked
  if (!res.ok) { alert(data.error || "Upload failed (max 3 MB)."); return null; }
  return data.url;
}

async function saveLeagueEdit() {
  const code = LEAGUE_DATA.code;
  const sponsors = document.getElementById("edit-sponsors").value.split("\n")
    .map(line => line.split("|").map(s => s.trim()))
    .filter(parts => parts[0])
    .map(parts => ({ img: parts[0], link: parts[1] || "", name: parts[2] || "" }));
  const body = {
    name: document.getElementById("edit-name").value.trim(),
    logo: document.getElementById("edit-logo").value.trim(),
    sponsors,
  };
  const { ok, data } = await api("POST", `/api/leagues/${encodeURIComponent(code)}/edit`, body);
  if (!ok) { alert(data.error || "Could not save."); return; }
  openLeague(code);
}

const TRACK_LABEL = { tournament: "Pre-tournament bracket", group: "Rolling group picks", knockout: "Knockout picks" };
function renderLeagueBoard() {
  const data = LEAGUE_DATA;
  if (!data) return;
  const track = LEAGUE_TRACK;
  document.querySelectorAll("#league-tracks .subtab").forEach(b =>
    b.classList.toggle("active", b.dataset.track === track));

  const note = document.getElementById("league-note");
  if (track === "knockout" && !data.knockoutReady) {
    note.innerHTML = "🔒 The Knockout league opens once the group stage finishes and the Round-of-32 is set.";
  } else {
    note.innerHTML = `<b>${TRACK_LABEL[track]}</b> — ${data.resultsScored || 0} group match${data.resultsScored === 1 ? "" : "es"} scored so far.`;
  }

  const members = [...data.members].sort((a, b) =>
    ((b.points?.[track] || 0) - (a.points?.[track] || 0)) || a.displayName.localeCompare(b.displayName));
  let html = `<tr><th>#</th><th>Player</th><th>Points</th></tr>`;
  members.forEach((m, i) => {
    const me = currentUser && m.userId === currentUser.id ? "me" : "";
    html += `<tr class="${me} clickable-row" data-uid="${m.userId}" data-name="${escapeHTML(m.displayName)}">
      <td>${i + 1}</td>
      <td>${escapeHTML(m.displayName)}${me ? " (you)" : ""}</td>
      <td><b>${m.points?.[track] || 0}</b></td></tr>`;
  });
  const board = document.getElementById("league-board");
  board.innerHTML = html;
  board.querySelectorAll("tr.clickable-row").forEach(tr =>
    tr.addEventListener("click", () => openMember(+tr.dataset.uid, tr.dataset.name)));
  document.getElementById("league-member").classList.add("hidden");
}

async function openMember(uid, name) {
  if (!LEAGUE_DATA) return;
  await fetchActualBracket();
  const { ok, data } = await api("GET",
    `/api/leagues/${encodeURIComponent(LEAGUE_DATA.code)}/member/${uid}`);
  if (!ok) { alert(data.error || "Could not load predictions."); return; }

  const fxById = {};
  DATA.fixtures.forEach(f => (fxById[f.id] = f));
  const teamsFor = mid => {
    if (mid.startsWith("G-")) { const f = fxById[mid]; return f ? [f.home, f.away] : ["?", "?"]; }
    const a = ACTUAL_BRACKET[mid.slice(2)] || {}; return [a.teamA || "?", a.teamB || "?"];
  };
  const line = (mid, sc) => {
    const [h, a] = teamsFor(mid);
    const adv = sc.adv ? ` · adv: ${escapeHTML(sc.adv)}` : "";
    return `<div class="mp-row">${teamHTML(h)} <b>${sc.home ?? "–"}–${sc.away ?? "–"}</b> ${teamHTML(a)}${adv}</div>`;
  };

  let html = "";
  // Tournament bracket (only revealed after the first kick-off)
  if (data.tournament) {
    const sim = (await api("POST", "/api/simulate", data.tournament)).data;
    html += `<div class="mp-sec"><b>Pre-tournament bracket</b> — predicted champion: ` +
      `${sim.champion ? teamHTML(sim.champion) : "—"}</div>`;
  } else {
    html += `<div class="mp-sec">🔒 Pre-tournament bracket hidden until the tournament starts.</div>`;
  }
  const grp = Object.entries(data.group || {});
  html += `<div class="mp-sec"><b>Rolling group picks</b> ${grp.length ? "" : "<span class='hint'>— none revealed yet (matches reveal as they kick off)</span>"}</div>`;
  grp.sort().forEach(([mid, sc]) => (html += line(mid, sc)));
  const ko = Object.entries(data.knockout || {});
  if (ko.length) {
    html += `<div class="mp-sec"><b>Knockout picks</b></div>`;
    ko.sort((x, y) => +x[0].slice(2) - +y[0].slice(2)).forEach(([mid, sc]) => (html += line(mid, sc)));
  }

  document.getElementById("league-member-title").textContent = `${name}'s predictions`;
  document.getElementById("league-member-body").innerHTML = html;
  document.getElementById("league-member").classList.remove("hidden");
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
async function fetchActualBracket() {
  const r = await api("GET", "/api/bracket/actual");
  ACTUAL_BRACKET = r.ok ? (r.data.bracket || {}) : {};
  ACTUAL_GROUP_COMPLETE = r.ok ? !!r.data.groupComplete : false;
}

async function renderAdmin() {
  await fetchResults();
  await fetchActualBracket();
  await Promise.all([renderAdminLeagues(), renderAdminUsers()]);
  renderAdminResults();
  renderAdminKoResults();
  document.getElementById("admin-members").classList.add("hidden");
  const close = document.getElementById("admin-members-close");
  close.onclick = () => document.getElementById("admin-members").classList.add("hidden");
}

function renderAdminResults() {
  const wrap = document.getElementById("admin-results");
  if (!wrap) return;
  const fx = [...DATA.fixtures].filter(f => f.date)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  let html = "", curDate = null;
  fx.forEach(f => {
    if (f.date !== curDate) { curDate = f.date; html += `<div class="sched-day">${fmtFullDate(f.date)}</div>`; }
    const r = RESULTS[f.id] || {};
    const sh = ((r.scorers || {}).home || []).join(", ");
    const sa = ((r.scorers || {}).away || []).join(", ");
    const st = r.status || "scheduled";
    html += `<div class="ares-row" data-mid="${f.id}">
      <span class="ares-teams">${teamHTML(f.home)} <b class="v">v</b> ${teamHTML(f.away)}</span>
      <input class="ares-h" type="number" min="0" max="99" value="${r.home ?? ""}" placeholder="–">
      <input class="ares-a" type="number" min="0" max="99" value="${r.away ?? ""}" placeholder="–">
      <select class="ares-st">
        <option value="scheduled"${st === "scheduled" ? " selected" : ""}>Scheduled</option>
        <option value="live"${st === "live" ? " selected" : ""}>Live</option>
        <option value="ft"${st === "ft" ? " selected" : ""}>FT</option>
      </select>
      <input class="ares-sh" type="text" value="${escapeHTML(sh)}" placeholder="home scorers (comma-sep)">
      <input class="ares-sa" type="text" value="${escapeHTML(sa)}" placeholder="away scorers (comma-sep)">
    </div>`;
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll(".ares-row").forEach(row =>
    row.querySelectorAll("input,select").forEach(el =>
      el.addEventListener("change", () => saveAdminResult(row))));
}

async function saveAdminResult(row) {
  const mid = row.dataset.mid;
  const body = {
    home: row.querySelector(".ares-h").value,
    away: row.querySelector(".ares-a").value,
    status: row.querySelector(".ares-st").value,
    scorers: {
      home: row.querySelector(".ares-sh").value,
      away: row.querySelector(".ares-sa").value,
    },
  };
  const { ok } = await api("PUT", "/api/admin/results/" + mid, body);
  row.classList.toggle("saved", ok);
  row.classList.toggle("err", !ok);
  setTimeout(() => row.classList.remove("saved", "err"), 900);
  await fetchResults();
  await fetchMyPoints();
}

function renderAdminKoResults() {
  const wrap = document.getElementById("admin-ko-results");
  if (!wrap) return;
  let html = "";
  DATA.bracket.forEach(round => {
    html += `<div class="ko-round-h">${round.name}</div>`;
    round.matches.forEach(m => {
      const a = ACTUAL_BRACKET[String(m.id)] || {};
      const known = a.teamA && a.teamB;
      const r = RESULTS["K-" + m.id] || {};
      const label = known ? `${a.teamA} v ${a.teamB}` : `${m.labelA} v ${m.labelB}`;
      const adv = known
        ? `<select class="ako-w"><option value="">advancer…</option>
             <option${r.winner === a.teamA ? " selected" : ""}>${escapeHTML(a.teamA)}</option>
             <option${r.winner === a.teamB ? " selected" : ""}>${escapeHTML(a.teamB)}</option></select>`
        : `<input class="ako-w" type="text" value="${escapeHTML(r.winner || "")}" placeholder="advancer">`;
      html += `<div class="ares-row ko" data-mid="K-${m.id}">
        <span class="ares-teams">M${m.id}: ${escapeHTML(label)}</span>
        <input class="ako-h" type="number" min="0" max="99" value="${r.home ?? ""}" placeholder="–">
        <input class="ako-a" type="number" min="0" max="99" value="${r.away ?? ""}" placeholder="–">
        <select class="ako-st">
          <option value="scheduled"${(!r.status || r.status === "scheduled") ? " selected" : ""}>Scheduled</option>
          <option value="live"${r.status === "live" ? " selected" : ""}>Live</option>
          <option value="ft"${r.status === "ft" ? " selected" : ""}>FT</option>
        </select>
        ${adv}
      </div>`;
    });
  });
  wrap.innerHTML = html;
  wrap.querySelectorAll(".ares-row.ko").forEach(row =>
    row.querySelectorAll("input,select").forEach(el =>
      el.addEventListener("change", () => saveAdminKoResult(row))));
}

async function saveAdminKoResult(row) {
  const mid = row.dataset.mid;
  const body = {
    home: row.querySelector(".ako-h").value,
    away: row.querySelector(".ako-a").value,
    status: row.querySelector(".ako-st").value,
    winner: row.querySelector(".ako-w").value,
  };
  const { ok } = await api("PUT", "/api/admin/results/" + mid, body);
  row.classList.toggle("saved", ok);
  row.classList.toggle("err", !ok);
  await fetchResults();
  await fetchActualBracket();   // an advancer may reveal the next round's teams
  renderAdminKoResults();
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
        meta.innerHTML = `<span class="when">${fmtDate(fx.date)} · ${fx.time} BST` +
          (fx.venue ? ` · 📍 ${fx.venue}, ${fx.city}` : "") + `</span>`;
        fxWrap.appendChild(meta);
      }
      const line = document.createElement("div");
      line.className = "fixture-line";
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
      line.innerHTML = `<span class="chan-left chan ${chanClass(fx.channel)}">${fx.channel || ""}</span>`;
      line.appendChild(row);
      fxWrap.appendChild(line);
      markFixture(row);
    });
  });

  grid.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("input", onScoreInput);
    inp.addEventListener("keydown", onScoreKeydown);
    inp.addEventListener("focus", () => inp.select());
  });
  applyTournamentLock();
}

function onScoreInput(e) {
  if (LOCKS.tournamentLocked) return;
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
  renderStatRow(res);
}

function renderStatRow(res) {
  const el = document.getElementById("stat-row");
  if (!el) return;
  const total = DATA.fixtures.length;
  const done = DATA.fixtures.filter(f => {
    const s = state.groupScores[f.id] || {}; return s.home != null && s.away != null;
  }).length;
  const groupsComplete = Object.values(res.standings || {}).filter(d => d.complete).length;
  const koPicks = Object.keys(state.koPicks || {}).length;
  const wild = res.groupsComplete
    ? res.thirdPlaceRanked.filter(t => t.qualified).map(t => t.group).sort().join(" ")
    : "—";
  const champ = res.champion ? teamHTML(res.champion) : `<span class="muted">—</span>`;
  el.innerHTML =
    `<div class="stat"><div class="stat-k">Group picks</div><div class="stat-v">${done} / ${total}</div></div>` +
    `<div class="stat"><div class="stat-k">Groups complete</div><div class="stat-v">${groupsComplete} / 12</div></div>` +
    `<div class="stat"><div class="stat-k">Bracket picks</div><div class="stat-v">${koPicks} / 32</div></div>` +
    `<div class="stat"><div class="stat-k">Wildcard line</div><div class="stat-v wild">${wild}</div></div>` +
    `<div class="stat champ-stat"><div class="stat-k">Champion</div><div class="stat-v">${champ}</div></div>`;
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
  document.querySelector('.tab[data-tab="predictor"]').click();
  showSub("groups");
  const inp = document.querySelector(`#groups-grid input[data-mid="${fid}"]`);
  if (!inp) return;
  const row = inp.closest(".fixture");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  const empty = [...row.querySelectorAll("input")].find(i => i.value.trim() === "");
  (empty || inp).focus();
}

// Highlight class for a standings row.
// 1st & 2nd = direct qualifiers (q12). 3rd = conditional (q3) — but once the
// group stage is complete, only the qualifying 3rd-placed teams keep it.
function standRowClass(pos, letter, complete, qualThirds) {
  if (pos <= 2) return "q12";
  if (pos === 3) return (!complete || qualThirds.has(letter)) ? "q3" : "";
  return "";
}

function renderStandings(res) {
  const qualThirds = new Set((res.thirdPlaceRanked || []).filter(t => t.qualified).map(t => t.group));
  Object.entries(res.standings).forEach(([letter, data]) => {
    const t = document.getElementById("standings-" + letter);
    if (!t) return;
    let html = `<tr><th class="team">Team</th><th>Pl</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr>`;
    data.rows.forEach(r => {
      const cls = standRowClass(r.pos, letter, res.groupsComplete, qualThirds);
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
  const cards = document.getElementById("third-cards");
  const table = document.getElementById("third-table");
  if (!res.groupsComplete || !res.thirdPlaceRanked.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");

  const status = i => (i < 6 ? "safe" : i < 8 ? "bubble" : "out");
  const label = i => (i < 6 ? "Safe" : i < 8 ? "Bubble" : "Out");
  cards.innerHTML = res.thirdPlaceRanked.map((t, i) => `
    <div class="tp-card ${status(i)}">
      <div class="tp-top">#${i + 1} · Group ${t.group} · ${label(i)}</div>
      <div class="tp-team">${teamHTML(t.team)}</div>
      <div class="tp-stat">${t.points} pts · ${t.gd > 0 ? "+" + t.gd : t.gd} GD · ${t.gf} GF</div>
    </div>`).join("");

  let html = `<tr><th>Rank</th><th>Group</th><th>Team</th><th>Pts</th><th>GD</th><th>GF</th><th>Status</th></tr>`;
  res.thirdPlaceRanked.forEach((t, i) => {
    html += `<tr class="${t.qualified ? "q" : ""}">
      <td>${i + 1}</td><td>${t.group}</td><td class="team">${teamHTML(t.team)}</td>
      <td>${t.points}</td><td>${t.gd > 0 ? "+" + t.gd : t.gd}</td><td>${t.gf}</td>
      <td>${t.qualified ? '<span class="badge-r32">R32</span>' : '<span class="badge-out">Out</span>'}</td></tr>`;
  });
  table.innerHTML = html;
}

function renderResultsStandings(st) {
  const wrap = document.getElementById("results-standings");
  if (!wrap) return;
  const allComplete = Object.keys(DATA.groups).every(l => (st[l] || {}).complete);
  let qualThirds = new Set();
  if (allComplete) {
    const thirds = Object.entries(st).map(([l, d]) => ({ group: l, ...(d.rows[2] || {}) }));
    thirds.sort((a, b) => (b.points - a.points) || (b.gd - a.gd) || (b.gf - a.gf));
    qualThirds = new Set(thirds.slice(0, 8).map(t => t.group));
  }
  let html = "";
  Object.keys(DATA.groups).forEach(letter => {
    const rows = (st[letter] || {}).rows || [];
    html += `<div class="group-card"><h3>Group ${letter}</h3>
      <table class="standings"><tr><th class="team">Team</th><th>Pl</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr>`;
    rows.forEach(r => {
      const cls = standRowClass(r.pos, letter, allComplete, qualThirds);
      const gd = r.gd > 0 ? "+" + r.gd : r.gd;
      html += `<tr class="${cls}"><td class="team">${teamHTML(r.team)}</td>
        <td>${r.played}</td><td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td>
        <td>${gd}</td><td><b>${r.points}</b></td></tr>`;
    });
    html += `</table></div>`;
  });
  wrap.innerHTML = html;
}

async function renderResults() {
  const wrap = document.getElementById("results-list");
  if (!wrap || !DATA) return;
  await fetchResults();
  await fetchMyPoints();
  renderResultsStandings((await api("GET", "/api/standings")).data || {});
  const fx = [...DATA.fixtures].filter(f => f.date)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  let html = "", curDate = null;
  fx.forEach(f => {
    if (f.date !== curDate) { curDate = f.date; html += `<div class="sched-day">${fmtFullDate(f.date)}</div>`; }
    const r = RESULTS[f.id];
    const hasScore = r && r.home != null && r.away != null;
    let mid;
    if (hasScore) {
      const badge = r.status === "live" ? `<span class="st live">LIVE</span>`
                  : r.status === "ft" ? `<span class="st ft">FT</span>` : "";
      mid = `<span class="sc">${r.home} – ${r.away}${badge}</span>`;
    } else {
      mid = `<span class="vs">v</span>`;
    }

    // scorers line
    let scLine = "";
    const sh = (r && r.scorers && r.scorers.home) || [];
    const sa = (r && r.scorers && r.scorers.away) || [];
    if (sh.length || sa.length) {
      scLine = `<div class="scorers"><span>${sh.map(escapeHTML).join(", ")}</span>` +
               `<span class="ball">⚽</span><span>${sa.map(escapeHTML).join(", ")}</span></div>`;
    }

    // your prediction + points
    let predLine = "";
    const p = LIVE_SCORES[f.id];
    if (p && p.home != null && p.away != null) {
      const pts = MYPOINTS.group?.perMatch ? MYPOINTS.group.perMatch[f.id] : undefined;
      const ptsTxt = (hasScore && pts != null)
        ? ` <span class="pts pts${pts}">+${pts}</span>` : "";
      predLine = `<div class="your-pick">Your live pick: <b>${p.home}–${p.away}</b>${ptsTxt}</div>`;
    }

    html += `<div class="res-block">
      <div class="sched-row">
        <span class="t">${f.time}</span>
        <span class="grp" title="Group ${f.group}">${f.group}</span>
        <span class="h">${teamHTML(f.home)}</span>
        ${mid}
        <span class="a">${teamHTML(f.away)}</span>
        <span class="chan ${chanClass(f.channel)}">${f.channel || ""}</span>
      </div>
      ${f.venue ? `<div class="fixture-venue">📍 ${f.venue}, ${f.city}</div>` : ""}
      ${scLine}${predLine}
    </div>`;
  });
  wrap.innerHTML = html;
}

// Mirrored bracket: left half feeds SF 101, right half feeds SF 102, Final in centre.
const BK_LEFT = [
  ["Round of 32", [74, 77, 73, 75, 83, 84, 81, 82]],
  ["Round of 16", [89, 90, 93, 94]],
  ["Quarter-finals", [97, 98]],
  ["Semi-final", [101]],
];
const BK_RIGHT = [
  ["Semi-final", [102]],
  ["Quarter-finals", [99, 100]],
  ["Round of 16", [91, 92, 95, 96]],
  ["Round of 32", [76, 78, 79, 80, 86, 88, 85, 87]],
];

function renderBracketSkeleton() {
  const wrap = document.getElementById("bracket");
  wrap.className = "bracket2";
  wrap.innerHTML = "";
  const col = (name, id) => {
    const c = document.createElement("div");
    c.className = "bk-col";
    c.innerHTML = `<h4>${name}</h4><div class="bk-matches" id="${id}"></div>`;
    return c;
  };
  BK_LEFT.forEach(([name], i) => wrap.appendChild(col(name, "bk-L" + i)));
  const fin = col("Final", "bk-final");
  fin.classList.add("bk-finalcol");
  wrap.appendChild(fin);
  BK_RIGHT.forEach(([name], i) => wrap.appendChild(col(name, "bk-R" + i)));
}

function renderBracket(res) {
  const notice = document.getElementById("ko-notice");
  if (!res.groupsComplete) {
    notice.classList.remove("hidden");
    notice.textContent = "Finish predicting all 72 group matches to unlock the knockout bracket.";
  } else {
    notice.classList.add("hidden");
  }
  const fill = (id, ids) => {
    const c = document.getElementById(id);
    if (!c) return;
    c.innerHTML = "";
    ids.forEach(mid => c.appendChild(koMatchEl(mid, res.bracket[mid] || {})));
  };
  BK_LEFT.forEach(([, ids], i) => fill("bk-L" + i, ids));
  BK_RIGHT.forEach(([, ids], i) => fill("bk-R" + i, ids));
  const fc = document.getElementById("bk-final");
  if (fc) {
    fc.innerHTML = "";
    const finalEl = koMatchEl(104, res.bracket[104] || {});
    finalEl.classList.add("final-match");
    fc.appendChild(finalEl);
    const tp = document.createElement("div");
    tp.className = "bk-tp-label";
    tp.textContent = "3rd place play-off";
    fc.appendChild(tp);
    fc.appendChild(koMatchEl(103, res.bracket[103] || {}));
  }
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
  if (LOCKS.tournamentLocked) return;
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
