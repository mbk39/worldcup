"use strict";

const STORAGE_KEY = "wc2026-predictor-v1";
const NAME_KEY = "wc2026-player-name";
const PIN_KEY = "wc2026-player-pin";
let DATA = null;            // static: groups, flags, fixtures, bracket template
let state = { groupScores: {}, koPicks: {} };
let bracketLabels = {};     // mid -> {labelA, labelB}
let simTimer = null;

// ---------------------------------------------------------------- helpers
function teamHTML(team) {
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
function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${_DOW[dow]} ${d} ${_MON[m - 1]}`;
}
function chanClass(ch) {
  if (!ch) return "";
  if (ch.startsWith("BBC")) return "bbc";
  if (ch.startsWith("ITV")) return "itv";
  return "";
}
const _DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const _MON_LONG = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
function fmtFullDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${_DOW_LONG[dow]} ${d} ${_MON_LONG[m - 1]}`;
}

function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && s.groupScores) state = { groupScores: s.groupScores || {}, koPicks: s.koPicks || {} };
  } catch (_) {}
}

// ---------------------------------------------------------------- bootstrap
async function init() {
  DATA = await (await fetch("/api/data")).json();
  DATA.bracket.forEach(r => r.matches.forEach(m => {
    bracketLabels[m.id] = { labelA: m.labelA, labelB: m.labelB };
  }));
  loadState();
  renderGroups();
  renderBracketSkeleton();
  wireTabs();
  document.getElementById("reset-btn").addEventListener("click", resetAll);
  document.getElementById("save-btn").addEventListener("click", savePrediction);

  const nameInput = document.getElementById("player-name");
  const pinInput = document.getElementById("player-pin");
  nameInput.value = localStorage.getItem(NAME_KEY) || "";
  pinInput.value = localStorage.getItem(PIN_KEY) || "";
  nameInput.addEventListener("change", () =>
    localStorage.setItem(NAME_KEY, nameInput.value.trim()));
  pinInput.addEventListener("change", () =>
    localStorage.setItem(PIN_KEY, pinInput.value.trim()));
  const saveOnEnter = e => { if (e.key === "Enter") savePrediction(); };
  nameInput.addEventListener("keydown", saveOnEnter);
  pinInput.addEventListener("keydown", saveOnEnter);

  await simulate();
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
      if (tab.dataset.tab === "predictions") loadPredictionsList();
    });
  });
}

function resetAll() {
  if (!confirm("Clear all predicted scores and bracket picks?")) return;
  state = { groupScores: {}, koPicks: {} };
  saveState();
  document.querySelectorAll(".fixture input").forEach(i => (i.value = ""));
  simulate();
}

// ---------------------------------------------------------------- group stage
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

  // Auto-advance to the next box after a digit is entered (speeds up entry).
  if (v !== null && inp.value !== "") focusSibling(inp, +1);
}

// Flag a fixture that has exactly one of its two score boxes filled.
function markFixture(row) {
  if (!row) return;
  const filled = [...row.querySelectorAll("input")]
    .filter(i => i.value.trim() !== "").length;
  row.classList.toggle("half", filled === 1);
}

function onScoreKeydown(e) {
  if (e.key === "Enter") { focusSibling(e.target, +1); e.preventDefault(); }
  else if (e.key === "Backspace" && e.target.value === "") {
    focusSibling(e.target, -1); e.preventDefault();
  }
}

function focusSibling(current, dir) {
  const inputs = [...document.querySelectorAll("#groups-grid input")];
  const i = inputs.indexOf(current);
  const next = inputs[i + dir];
  if (next) { next.focus(); next.select(); }
}

function scheduleSim() {
  clearTimeout(simTimer);
  simTimer = setTimeout(simulate, 180);
}

// ---------------------------------------------------------------- simulate + render
async function simulate() {
  const res = await (await fetch("/api/simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  })).json();
  renderStandings(res);
  renderThirdPlace(res);
  renderBracket(res);
  renderChampion(res);
  renderProgress();
  renderSchedule();
}

function renderSchedule() {
  const wrap = document.getElementById("schedule-list");
  if (!wrap || !DATA) return;
  const fx = [...DATA.fixtures]
    .filter(f => f.date)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  let html = "";
  let curDate = null;
  fx.forEach(f => {
    if (f.date !== curDate) {
      curDate = f.date;
      html += `<div class="sched-day">${fmtFullDate(f.date)}</div>`;
    }
    const sc = state.groupScores[f.id] || {};
    const has = sc.home != null && sc.away != null;
    const mid = has
      ? `<span class="sc">${sc.home} – ${sc.away}</span>`
      : `<span class="vs">v</span>`;
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

function renderProgress() {
  const total = DATA.fixtures.length;
  let done = 0;
  DATA.fixtures.forEach(f => {
    const s = state.groupScores[f.id];
    if (s && s.home != null && s.away != null) done++;
  });
  document.getElementById("progress-fill").style.width = (100 * done / total) + "%";
  document.getElementById("progress-text").textContent =
    `${done} / ${total} group matches predicted`;
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
  if (!res.groupsComplete || !res.thirdPlaceRanked.length) {
    wrap.classList.add("hidden");
    return;
  }
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
    round.matches.forEach(m => {
      const b = res.bracket[m.id] || {};
      container.appendChild(koMatchEl(m.id, b));
    });
  });
}

function koMatchEl(mid, b) {
  const el = document.createElement("div");
  el.className = "ko-match";
  const lbl = bracketLabels[mid] || {};
  el.appendChild(koTeamEl(mid, b.teamA, lbl.labelA, b.winner, b.teamA && b.teamB));
  el.appendChild(koTeamEl(mid, b.teamB, lbl.labelB, b.winner, b.teamA && b.teamB));
  const tag = document.createElement("div");
  tag.className = "mid";
  tag.textContent = "Match " + mid;
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
  if (state.koPicks[String(mid)] === team) {
    delete state.koPicks[String(mid)];   // click again to unpick
  } else {
    state.koPicks[String(mid)] = team;
  }
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

// ---------------------------------------------------------------- predictions
let loadedName = null;   // whose prediction is currently loaded (if any)

async function savePrediction() {
  const input = document.getElementById("player-name");
  const pinInput = document.getElementById("player-pin");
  const name = input.value.trim();
  const pin = pinInput.value.trim();
  if (!name) { input.focus(); alert("Enter your name first, then save."); return; }
  if (pin.length < 3) {
    pinInput.focus();
    alert("Set a PIN (3–20 characters). You'll need it to update or delete this prediction later.");
    return;
  }
  localStorage.setItem(NAME_KEY, name);
  localStorage.setItem(PIN_KEY, pin);
  const res = await fetch("/api/predictions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, pin, state }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || "Could not save."); return; }

  loadedName = name;
  const btn = document.getElementById("save-btn");
  const orig = btn.textContent;
  btn.textContent = "Saved ✓";
  setTimeout(() => (btn.textContent = orig), 1400);
  loadPredictionsList();
}

async function loadPredictionsList() {
  const grid = document.getElementById("predictions-grid");
  const empty = document.getElementById("predictions-empty");
  const list = await (await fetch("/api/predictions")).json();

  if (!list.length) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  grid.innerHTML = "";
  list.forEach(p => grid.appendChild(predCard(p)));
}

function predCard(p) {
  const card = document.createElement("div");
  card.className = "pred-card" + (p.name === loadedName ? " loaded" : "");

  const champ = p.champion
    ? `<div class="champ"><span class="lbl">Champion</span>${teamHTML(p.champion)}</div>`
    : `<div class="champ"><span class="lbl">Champion</span><span class="placeholder">not decided yet</span></div>`;

  const runner = p.runnerUp
    ? `<div class="line">Runner-up: <b>${teamHTML(p.runnerUp)}</b></div>` : "";
  const finalists = (p.finalists && p.finalists.length === 2 && !p.champion)
    ? `<div class="line">Final: <b>${p.finalists.map(teamHTML).join("</b> vs <b>")}</b></div>` : "";

  const pct = p.total ? Math.round(100 * p.predicted / p.total) : 0;

  card.innerHTML = `
    <button class="del" title="Delete">✕</button>
    <div class="pname">${escapeHTML(p.name)}</div>
    ${champ}${runner}${finalists}
    <div class="pbar"><div style="width:${pct}%"></div></div>
    <div class="meta">
      <span>${p.predicted}/${p.total} group games</span>
      <span>${updatedAgo(p.updated)}</span>
    </div>`;

  card.addEventListener("click", e => {
    if (e.target.classList.contains("del")) return;
    loadPrediction(p.name);
  });
  card.querySelector(".del").addEventListener("click", e => {
    e.stopPropagation();
    deletePrediction(p.name);
  });
  return card;
}

async function loadPrediction(name) {
  const res = await fetch("/api/predictions/" + encodeURIComponent(name));
  if (!res.ok) { alert("Could not load that prediction."); return; }
  const rec = await res.json();
  state = {
    groupScores: rec.state.groupScores || {},
    koPicks: rec.state.koPicks || {},
  };
  loadedName = rec.name;
  saveState();
  document.getElementById("player-name").value = rec.name;
  localStorage.setItem(NAME_KEY, rec.name);
  renderGroups();            // rebuild inputs from loaded scores
  await simulate();
  // jump to the group stage so the loaded picks are visible
  document.querySelector('.tab[data-tab="groups"]').click();
}

async function deletePrediction(name) {
  const pin = prompt(`Enter the PIN for "${name}" to delete this prediction:`);
  if (pin === null) return;   // cancelled
  const res = await fetch(
    "/api/predictions/" + encodeURIComponent(name) + "?pin=" + encodeURIComponent(pin),
    { method: "DELETE" }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || "Could not delete.");
    return;
  }
  if (loadedName === name) loadedName = null;
  loadPredictionsList();
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => (
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

init();
