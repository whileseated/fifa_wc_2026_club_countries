"use strict";

/* ------------------------------------------------------------------ *
 * World Cup 2026 — club-country visualizer
 * Three tiers: Players | Clubs | Pro-team countries, joined by SVG lines.
 * Data model is built to grow: a `groupBy` mode (pro-team vs birth country)
 * and country → league → club nesting can slot in later.
 * ------------------------------------------------------------------ */

// Flags + colors for the club COUNTRIES shown on the right tier.
// Colors drive both the country swatch and the connector chain for its players.
const COUNTRY_META = {
  "England":       { flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", color: "#ef476f" },
  "Scotland":      { flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", color: "#b5e48c" },
  "Spain":         { flag: "🇪🇸", color: "#ffd166" },
  "France":        { flag: "🇫🇷", color: "#4895ef" },
  "Italy":         { flag: "🇮🇹", color: "#06d6a0" },
  "Germany":       { flag: "🇩🇪", color: "#f78c6b" },
  "Netherlands":   { flag: "🇳🇱", color: "#ff9e00" },
  "United States": { flag: "🇺🇸", color: "#7b8cff" },
  "Canada":        { flag: "🇨🇦", color: "#ff5c8a" },
  "Mexico":        { flag: "🇲🇽", color: "#c77dff" },
  "Argentina":     { flag: "🇦🇷", color: "#6ac1e8" },
  "Brazil":        { flag: "🇧🇷", color: "#57cc99" },
  "Portugal":      { flag: "🇵🇹", color: "#e07a5f" },
  "Belgium":       { flag: "🇧🇪", color: "#f4a259" }
};
const FALLBACK_PALETTE = [
  "#8ecae6", "#e5989b", "#a3b18a", "#cdb4db", "#f6bd60", "#84a59d", "#e56b6f",
  "#b8c0ff", "#ffb4a2", "#95d5b2", "#d4a373", "#9b5de5", "#00bbf9", "#f15bb5", "#c9ada7"
];

const POS_ORDER = ["GK", "DF", "MF", "FW"];
const POS_LABEL = { GK: "Goalkeepers", DF: "Defenders", MF: "Midfielders", FW: "Forwards" };

// ---- DOM handles -------------------------------------------------
const wrap = document.getElementById("wrap");
const svg = document.getElementById("overlay");
const gPaths = document.getElementById("paths");
const board = document.getElementById("board");
const colPlayers = document.getElementById("colPlayers");
const colClubs = document.getElementById("colClubs");
const colCountries = document.getElementById("colCountries");
const teamSelect = document.getElementById("teamSelect");
const noticeEl = document.getElementById("notice");
const clubHeader = document.getElementById("clubHeader");

let CLUBS = {};           // club name -> { country, league }
let COUNTRY_FLAGS = {};   // country name -> flag emoji (from data/countries.json)
let TEAM_FLAGS = {};      // national-team name -> flag emoji (from data/teams.json)
let TEAM_ROSTER = {};     // national-team name -> roster slug (null if no roster yet)
let TEAM_CODE = {};       // roster slug -> 3-letter code (for shareable URLs)
let CODE_TO_ROSTER = {};  // 3-letter code (upper) -> roster slug
let CLUB_INDEX = {};      // club name -> [ {team, code, no, pos, name, captain} ]  (cross-team)
let CLUB_SLUG_TO_NAME = {}; // slug -> club name (for clean, lowercase #club= URLs)
let connectors = [];      // { el, from, to, seg, player, clubSlug, country }
let currentColors = {};   // country -> color (assigned per team render)
let lockedNode = null;    // a clicked node whose focus "sticks" through scrolling
let currentTeam = null;   // roster slug of the team view to return to from a club view

// ---- helpers -----------------------------------------------------
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const countryFlag = (c) => COUNTRY_FLAGS[c] || (COUNTRY_META[c] && COUNTRY_META[c].flag) || "🏳️";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// A club name rendered as an underlined link into the cross-team club view.
const clubLinkHTML = (name) => `<span class="club-link" data-club="${esc(name)}">${esc(name)}</span>`;

function stripFootnote(s) {
  return s.replace(/\[[^\]]*\]/g, "").trim();
}

function posGroupOf(pos) {
  const m = /(GK|DF|MF|FW)/.exec(pos || "");
  return m ? m[1] : "MF";
}

// Minimal CSV parser: handles quoted fields and "" escapes.
function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const fields = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { fields.push(cur); cur = ""; }
      else cur += ch;
    }
    fields.push(cur);
    rows.push(fields);
  }
  return rows;
}

// Roster CSV columns: [_, No., Pos., Player, DOB, Caps, Goals, Club]
function playersFromCSV(text) {
  const rows = parseCSV(text);
  const players = [];
  let idx = 0;
  for (const r of rows) {
    const num = (r[1] || "").trim();
    const pos = (r[2] || "").trim();
    let name = (r[3] || "").trim();
    const club = stripFootnote(r[7] || "");
    if (!name || pos.toLowerCase() === "pos." || !club) continue; // skip header/blank rows
    let captain = false;
    if (/\(captain\)/i.test(name)) { captain = true; name = name.replace(/\s*\(captain\)/i, "").trim(); }
    players.push({
      id: `player-${idx++}`,
      num, name, captain,
      posGroup: posGroupOf(pos),
      club
    });
  }
  return players;
}

// ---- team selector ----------------------------------------------
async function loadRegistry() {
  const [teamsRes, clubsRes, countriesRes, playersRes] = await Promise.all([
    fetch("data/teams.json"),
    fetch("data/clubs.json"),
    fetch("data/countries.json"),
    fetch("data/all_players.json")
  ]);
  const teamsData = await teamsRes.json();
  CLUBS = (await clubsRes.json()).clubs;
  const countriesDoc = await countriesRes.json();
  for (const [name, meta] of Object.entries(countriesDoc.countries)) COUNTRY_FLAGS[name] = meta.flag;

  // cross-team index: club name -> its WC players (from every national team)
  const allPlayers = (await playersRes.json()).players;
  for (const p of allPlayers) {
    (CLUB_INDEX[p.club] ||= []).push(p);
    CLUB_SLUG_TO_NAME[slug(p.club)] = p.club;
  }

  // placeholder shown while viewing a club (no national team is "selected")
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select";
  teamSelect.appendChild(placeholder);

  for (const conf of teamsData.confederations) {
    const og = document.createElement("optgroup");
    og.label = conf.name;
    for (const t of conf.teams) {
      TEAM_FLAGS[t.name] = t.flag;
      TEAM_ROSTER[t.name] = t.roster || null;
      if (t.roster && t.code) { TEAM_CODE[t.roster] = t.code; CODE_TO_ROSTER[t.code.toUpperCase()] = t.roster; }
      const opt = document.createElement("option");
      opt.value = t.roster || "";
      opt.textContent = `${t.flag} ${t.name}` + (t.roster ? "" : " — (no roster yet)");
      if (!t.roster) opt.disabled = true;
      opt.dataset.name = t.name;
      opt.dataset.flag = t.flag;
      og.appendChild(opt);
    }
    teamSelect.appendChild(og);
  }

  // Initial view: a #team=CODE deep link wins; otherwise default to Argentina,
  // else the first team that has a roster.
  const initialHash = location.hash;
  const urlCode = (/^#team=([a-z]{3})$/i.exec(initialHash) || [])[1];
  const argentina = TEAM_ROSTER["Argentina"] ? teamSelect.querySelector('option[data-name="Argentina"]') : null;
  const firstWithRoster = teamSelect.querySelector("option:not([disabled])[value]:not([value=''])");
  const defaultRoster =
    (urlCode && CODE_TO_ROSTER[urlCode.toUpperCase()]) ||
    (argentina && argentina.value) ||
    (firstWithRoster && firstWithRoster.value);
  if (defaultRoster) await renderTeam(defaultRoster);

  // A #club=NAME deep link opens on top of the default team view.
  const club = /^#club=(.+)$/.exec(initialHash);
  if (club) openClubView(CLUB_SLUG_TO_NAME[club[1]] || decodeURIComponent(club[1]));
}

// Deep-link support: #club=<name> opens that club's cross-team view.
function handleHash() {
  const club = /^#club=(.+)$/.exec(location.hash);
  if (club) { openClubView(CLUB_SLUG_TO_NAME[club[1]] || decodeURIComponent(club[1])); return; }
  const team = /^#team=([a-z]{3})$/i.exec(location.hash);
  if (team) {
    const roster = CODE_TO_ROSTER[team[1].toUpperCase()];
    if (roster && roster !== currentTeam) renderTeam(roster);
  }
}
window.addEventListener("hashchange", handleHash);

teamSelect.addEventListener("change", () => {
  if (teamSelect.value) renderTeam(teamSelect.value);
});

// ---- render ------------------------------------------------------
async function renderTeam(rosterName) {
  currentTeam = rosterName;
  teamSelect.value = rosterName;
  board.classList.remove("club-mode");
  clubHeader.hidden = true;
  const code = TEAM_CODE[rosterName];
  history.replaceState(null, "", code ? "#team=" + code.toLowerCase() : location.pathname + location.search);
  document.getElementById("headCountries").childNodes[0].nodeValue = "Pro-team countries ";
  clearBoard();
  let players;
  try {
    const res = await fetch(`data/rosters/${rosterName}.csv`);
    if (!res.ok) throw new Error(res.status);
    players = playersFromCSV(await res.text());
  } catch (e) {
    colPlayers.innerHTML = `<div class="empty-state">Couldn't load roster “${rosterName}”.</div>`;
    return;
  }

  // enrich with club → country/league
  const unmapped = new Set();
  for (const p of players) {
    const info = CLUBS[p.club];
    if (info) { p.country = info.country; p.league = info.league; }
    else { p.country = "Unknown"; p.league = ""; unmapped.add(p.club); }
    p.clubSlug = slug(p.club);
  }
  showNotice(unmapped);

  // aggregate
  const clubMap = new Map();     // slug -> { name, country, league, players:[] }
  const countryMap = new Map();  // country -> { players:[], clubs:Set }
  for (const p of players) {
    if (!clubMap.has(p.clubSlug))
      clubMap.set(p.clubSlug, { name: p.club, country: p.country, league: p.league, players: [] });
    clubMap.get(p.clubSlug).players.push(p);
    if (!countryMap.has(p.country)) countryMap.set(p.country, { players: [], clubs: new Set() });
    countryMap.get(p.country).players.push(p);
    countryMap.get(p.country).clubs.add(p.clubSlug);
  }

  // country order: most players first
  const countriesSorted = [...countryMap.entries()].sort((a, b) => b[1].players.length - a[1].players.length);
  assignColors(countriesSorted.map(([c]) => c));

  renderPlayers(players);
  renderClubs(clubMap, countriesSorted);
  renderCountries(countriesSorted, players.length);
  updateCounts(players.length, clubMap.size, countryMap.size);

  buildConnectors(players, clubMap);
  requestAnimationFrame(layoutConnectors);
}

function assignColors(countryNames) {
  currentColors = {};
  let fb = 0;
  for (const c of countryNames) {
    if (c === "Unknown") { currentColors[c] = "#5a6180"; continue; }
    currentColors[c] = (COUNTRY_META[c] && COUNTRY_META[c].color) || FALLBACK_PALETTE[fb++ % FALLBACK_PALETTE.length];
  }
}

function renderPlayers(players) {
  const byPos = {};
  for (const p of players) (byPos[p.posGroup] ||= []).push(p);
  for (const pos of POS_ORDER) {
    const list = byPos[pos];
    if (!list) continue;
    const label = document.createElement("div");
    label.className = "group-label";
    label.textContent = POS_LABEL[pos];
    colPlayers.appendChild(label);
    for (const p of list) {
      const node = document.createElement("div");
      node.className = "node player";
      node.id = p.id;
      node.dataset.country = p.country;
      node.dataset.clubSlug = p.clubSlug;
      node.style.setProperty("--node-color", currentColors[p.country]);
      node.innerHTML =
        `<div class="p-top"><span class="p-num">${p.num || ""}</span>` +
        `<span class="p-name">${p.name}${p.captain ? '<span class="p-cap">(C)</span>' : ""}</span></div>` +
        `<div class="p-club">${clubLinkHTML(p.club)}</div>`;
      attachHover(node, { players: new Set([p.id]), clubs: new Set([p.clubSlug]), countries: new Set([p.country]) });
      colPlayers.appendChild(node);
    }
  }
}

function renderClubs(clubMap, countriesSorted) {
  // Nest clubs as country › league › club, following the country order.
  const totalPlayers = (list) => list.reduce((s, [, c]) => s + c.players.length, 0);
  for (const [country] of countriesSorted) {
    const entries = [...clubMap.entries()].filter(([, c]) => c.country === country);
    if (!entries.length) continue;

    const cLabel = document.createElement("div");
    cLabel.className = "group-label country-group";
    cLabel.textContent = `${countryFlag(country)} ${country}`;
    colClubs.appendChild(cLabel);

    // bucket this country's clubs by league
    const leagues = new Map();
    for (const e of entries) {
      const lg = e[1].league || "Other";
      if (!leagues.has(lg)) leagues.set(lg, []);
      leagues.get(lg).push(e);
    }
    const leaguesSorted = [...leagues.entries()].sort((a, b) => totalPlayers(b[1]) - totalPlayers(a[1]));

    for (const [lg, list] of leaguesSorted) {
      const lLabel = document.createElement("div");
      lLabel.className = "group-label league-group";
      lLabel.textContent = lg;
      colClubs.appendChild(lLabel);

      list.sort((a, b) => b[1].players.length - a[1].players.length);
      for (const [s, club] of list) {
        const node = document.createElement("div");
        node.className = "node club";
        node.id = `club-${s}`;
        node.dataset.country = country;
        node.dataset.clubSlug = s;
        node.style.setProperty("--node-color", currentColors[country]);
        const n = club.players.length;
        node.innerHTML =
          `<div class="c-name">${clubLinkHTML(club.name)}</div>` +
          `<div class="c-meta">${n} player${n > 1 ? "s" : ""}</div>`;
        attachHover(node, {
          players: new Set(club.players.map((p) => p.id)),
          clubs: new Set([s]),
          countries: new Set([country])
        });
        colClubs.appendChild(node);
      }
    }
  }
}

function renderCountries(countriesSorted, total) {
  const max = countriesSorted[0] ? countriesSorted[0][1].players.length : 1;
  for (const [country, data] of countriesSorted) {
    const node = document.createElement("div");
    node.className = "node country";
    node.id = `country-${slug(country)}`;
    node.dataset.country = country;
    node.style.setProperty("--node-color", currentColors[country]);
    const n = data.players.length;
    node.innerHTML =
      `<span class="flag">${countryFlag(country)}</span>` +
      `<span class="c-info"><span class="c-name">${country}</span>` +
      `<span class="c-count">${n} player${n > 1 ? "s" : ""} · ${data.clubs.size} club${data.clubs.size > 1 ? "s" : ""}</span></span>` +
      `<span class="c-bar" style="width:${20 + (n / max) * 90}px;background:${currentColors[country]}"></span>`;
    attachHover(node, {
      players: new Set(data.players.map((p) => p.id)),
      clubs: data.clubs,
      countries: new Set([country])
    });
    colCountries.appendChild(node);
  }
}

function updateCounts(p, c, n) {
  document.getElementById("countPlayers").textContent = p;
  document.getElementById("countClubs").textContent = c;
  document.getElementById("countCountries").textContent = n;
}

function showNotice(unmapped) {
  if (!unmapped.size) { noticeEl.hidden = true; return; }
  noticeEl.hidden = false;
  noticeEl.textContent = `⚠ ${unmapped.size} club${unmapped.size > 1 ? "s" : ""} not in the country map (shown as “Unknown”): ${[...unmapped].join(", ")}. Add them to data/clubs.json.`;
  console.warn("Unmapped clubs:", [...unmapped]);
}

function clearBoard() {
  colPlayers.innerHTML = colClubs.innerHTML = colCountries.innerHTML = "";
  gPaths.innerHTML = "";
  connectors = [];
  lockedNode = null;
  clearHover();
}

// Click anywhere off a node clears a locked selection.
board.addEventListener("click", () => { if (lockedNode) unlock(); });

// Capture-phase: an underlined club name opens the cross-team club view.
// Capture runs before node/board handlers so it can pre-empt the pin/clear.
board.addEventListener("click", (e) => {
  const link = e.target.closest(".club-link");
  if (!link) return;
  e.stopPropagation();
  e.preventDefault();
  openClubView(link.dataset.club);
}, true);

// ---- club view (all WC players at one club, by national team) ----
function openClubView(clubName) {
  const roster = CLUB_INDEX[clubName] || [];
  board.classList.add("club-mode");
  teamSelect.value = "";  // no national team is "selected" in a club view
  const hash = "#club=" + slug(clubName);
  if (location.hash !== hash) history.replaceState(null, "", hash);
  clearBoard();
  window.scrollTo({ top: 0, behavior: "smooth" });

  const info = CLUBS[clubName] || {};
  const clubCountry = info.country || "";
  clubHeader.hidden = false;
  clubHeader.innerHTML =
    `<span class="ch-flag">${countryFlag(clubCountry)}</span>` +
    `<span class="ch-title">${esc(clubName)}</span>` +
    `<span class="ch-meta">${esc(info.league || "")}${info.league ? " · " : ""}${esc(clubCountry)}` +
    ` — ${roster.length} World Cup player${roster.length === 1 ? "" : "s"}</span>` +
    `<button class="close-btn" id="closeClub" title="Clear" aria-label="Clear club view">×</button>`;
  document.getElementById("closeClub").addEventListener("click", () => {
    if (currentTeam) renderTeam(currentTeam);
  });
  document.getElementById("headCountries").childNodes[0].nodeValue = "National teams ";

  if (!roster.length) {
    colPlayers.innerHTML = `<div class="empty-state">No World Cup players found at ${esc(clubName)}.</div>`;
    return;
  }

  // group this club's players by national team, most-represented first
  const teams = new Map(); // team name -> [players]
  for (const p of roster) (teams.get(p.team) || teams.set(p.team, []).get(p.team)).push(p);
  const teamsSorted = [...teams.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  assignColors(teamsSorted.map(([t]) => t));

  // left: players grouped by national team
  let idx = 0;
  const idOf = new Map(); // player object -> dom id
  for (const [team, list] of teamsSorted) {
    const label = document.createElement("div");
    label.className = "group-label";
    label.textContent = `${TEAM_FLAGS[team] || "🏳️"} ${team}`;
    colPlayers.appendChild(label);
    for (const p of list) {
      const id = `player-${idx++}`;
      idOf.set(p, id);
      const node = document.createElement("div");
      node.className = "node player";
      node.id = id;
      node.dataset.country = team;
      node.style.setProperty("--node-color", currentColors[team]);
      node.innerHTML =
        `<div class="p-top"><span class="p-num">${p.no || ""}</span>` +
        `<span class="p-name">${esc(p.name)}${p.captain ? '<span class="p-cap">(C)</span>' : ""}</span></div>` +
        `<div class="p-club">${esc(p.pos)} · ${esc(team)}</div>`;
      attachHover(node, { players: new Set([id]), clubs: new Set(), countries: new Set([team]) });
      colPlayers.appendChild(node);
    }
  }

  // right: national teams these players represent
  const max = teamsSorted[0][1].length;
  for (const [team, list] of teamsSorted) {
    const node = document.createElement("div");
    node.className = "node country";
    node.id = `natteam-${slug(team)}`;
    node.dataset.country = team;
    node.style.setProperty("--node-color", currentColors[team]);
    const n = list.length;
    const rosterSlug = TEAM_ROSTER[team];
    node.classList.toggle("navigable", !!rosterSlug);
    if (rosterSlug) node.title = `View ${team}'s squad`;
    node.innerHTML =
      `<span class="flag">${TEAM_FLAGS[team] || "🏳️"}</span>` +
      `<span class="c-info"><span class="c-name">${esc(team)}</span>` +
      `<span class="c-count">${n} player${n > 1 ? "s" : ""}</span></span>` +
      `<span class="c-bar" style="width:${20 + (n / max) * 90}px;background:${currentColors[team]}"></span>`;
    attachPreview(node, {
      players: new Set(list.map((p) => idOf.get(p))),
      clubs: new Set(),
      countries: new Set([team])
    });
    if (rosterSlug) node.addEventListener("click", (e) => { e.stopPropagation(); renderTeam(rosterSlug); });
    colCountries.appendChild(node);
  }

  // connectors: player -> its national team
  gPaths.innerHTML = "";
  connectors = [];
  for (const [team, list] of teamsSorted) {
    for (const p of list) {
      addConnector({ from: idOf.get(p), to: `natteam-${slug(team)}`, seg: "pc", player: idOf.get(p), clubSlug: null, country: team });
    }
  }
  updateCounts(roster.length, "", teamsSorted.length);
  requestAnimationFrame(layoutConnectors);
}

// ---- connectors --------------------------------------------------
function buildConnectors(players, clubMap) {
  gPaths.innerHTML = "";
  connectors = [];
  // player -> club
  for (const p of players) {
    addConnector({ from: p.id, to: `club-${p.clubSlug}`, seg: "pc", player: p.id, clubSlug: p.clubSlug, country: p.country });
  }
  // club -> country
  for (const [s, club] of clubMap) {
    addConnector({ from: `club-${s}`, to: `country-${slug(club.country)}`, seg: "cc", player: null, clubSlug: s, country: club.country });
  }
}

function addConnector(meta) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
  el.classList.add("connector");
  el.setAttribute("stroke", currentColors[meta.country] || "var(--line)");
  gPaths.appendChild(el);
  connectors.push({ el, ...meta });
}

function layoutConnectors() {
  const w = wrap.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${w.width} ${w.height}`);
  for (const c of connectors) {
    const a = document.getElementById(c.from);
    const b = document.getElementById(c.to);
    if (!a || !b) { c.el.removeAttribute("d"); continue; }
    // `from` is the left node, `to` is the right node: right-edge -> left-edge bézier.
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const sx = ra.right - w.left, sy = ra.top + ra.height / 2 - w.top;
    const ex = rb.left - w.left, ey = rb.top + rb.height / 2 - w.top;
    const mx = sx + (ex - sx) / 2;
    c.el.setAttribute("d", `M ${sx} ${sy} C ${mx} ${sy} ${mx} ${ey} ${ex} ${ey}`);
  }
}

// ---- hover / focus ----------------------------------------------
function attachHover(node, sets) {
  // Hover previews a chain; clicking locks it so it survives scrolling until
  // another node is clicked (or the background is clicked to clear).
  node.addEventListener("mouseenter", () => { if (!lockedNode) applyFocus(sets); });
  node.addEventListener("mouseleave", () => { if (!lockedNode) clearHover(); });
  node.addEventListener("click", (e) => {
    e.stopPropagation();
    if (lockedNode === node) { unlock(); return; }
    if (lockedNode) lockedNode.classList.remove("is-locked");
    lockedNode = node;
    node.classList.add("is-locked");
    applyFocus(sets);
  });
}

function unlock() {
  if (lockedNode) lockedNode.classList.remove("is-locked");
  lockedNode = null;
  clearHover();
}

// Hover-preview only (no click-to-lock) — for nodes whose click does something
// else, e.g. a national-team node in the club view that navigates to its squad.
function attachPreview(node, sets) {
  node.addEventListener("mouseenter", () => { if (!lockedNode) applyFocus(sets); });
  node.addEventListener("mouseleave", () => { if (!lockedNode) clearHover(); });
}

function applyFocus(sets) {
  board.classList.add("has-focus");
  svg.classList.add("has-focus");
  for (const node of board.querySelectorAll(".node")) {
    const isP = sets.players.has(node.id);
    const isC = node.dataset.clubSlug && sets.clubs.has(node.dataset.clubSlug) && node.classList.contains("club");
    const isN = node.classList.contains("country") && sets.countries.has(node.dataset.country);
    node.classList.toggle("is-active", isP || isC || isN);
  }
  for (const c of connectors) {
    const active = c.seg === "pc" ? sets.players.has(c.player) : sets.clubs.has(c.clubSlug);
    c.el.classList.toggle("is-active", active);
  }
}

function clearHover() {
  board.classList.remove("has-focus");
  svg.classList.remove("has-focus");
  for (const node of board.querySelectorAll(".node.is-active")) node.classList.remove("is-active");
  for (const c of connectors) c.el.classList.remove("is-active");
}

// ---- reflow ------------------------------------------------------
let rafPending = false;
function scheduleLayout() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; layoutConnectors(); });
}
window.addEventListener("resize", scheduleLayout);
if (window.ResizeObserver) new ResizeObserver(scheduleLayout).observe(board);
document.fonts && document.fonts.ready.then(scheduleLayout);

// ---- footer ------------------------------------------------------
// Loads the shared footer markup and stamps in the per-file "last edited"
// time from includes/file-timestamps.json (regenerated at build time by
// scripts/generate-timestamps.sh).
function loadFooter() {
  const container = document.getElementById("dynamic-footer");
  if (!container) return;
  fetch("includes/footer.html")
    .then((r) => r.text())
    .then((html) => {
      container.innerHTML = html;
      return fetch("includes/file-timestamps.json");
    })
    .then((r) => r.json())
    .then((timestamps) => {
      const file = location.pathname.split("/").pop() || "index.html";
      const tsEl = document.getElementById("last-updated");
      if (tsEl) tsEl.textContent = timestamps[file] || "unknown";
    })
    .catch(() => {
      const tsEl = document.getElementById("last-updated");
      if (tsEl) tsEl.textContent = "unknown";
    });
}
loadFooter();

// ---- go ----------------------------------------------------------
loadRegistry().catch((e) => {
  colPlayers.innerHTML = `<div class="empty-state">Failed to load data. Serve this folder over http (e.g. <code>python3 -m http.server</code>) rather than opening the file directly.<br><br>${e}</div>`;
});
