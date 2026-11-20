// Sportpedia 2.0 — Live Flask + C-Core Frontend Client
const STORAGE_KEYS = {
  theme: "sportpedia2_theme",
  bookmarks: "sportpedia2_bookmarks",
  history: "sportpedia2_history",
  triviaBest: "sportpedia2_trivia_best"
};

const state = {
  view: "explore",
  theme: "editorial",
  query: "",
  category: "All",
  quickFilter: "all",
  sort: "relevance",
  allSports: [],
  currentResults: [],
  latencyMs: 0.4,
  engineType: "c-binary",
  spotlightId: null,
  versusA: null,
  versusB: null,
  bookmarks: [],
  history: [],
  user: null,
  authMode: "login",
  mm: { environment: "Outdoor", playStyle: "Team", pace: "High-Adrenaline" },
  audio: { active: false, paused: false, rate: 1.0, title: "", text: "", htmlAudio: null },
  trivia: { questions: [], index: 0, score: 0, streak: 0, best: 0, answered: false }
};

let radarChartInstance = null;
let speechRecognition = null;
let searchDebounce = null;
const ttsBlobCache = new Map();

function safeStorageGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), 2600);
}

// Enrich raw C-engine records {id, title, category, snippet, score} with attributes for Versus/Matchmaker/Dossier
function enrichSport(raw) {
  const text = `${raw.title || ""} ${raw.category || ""} ${raw.snippet || ""}`.toLowerCase();
  const hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return Math.abs(h);
  };
  const h = hash(raw.title || String(raw.id));
  const isIndoor = /(indoor|table|chess|badminton|boxing|wrestling|judo|gymnastics|swimming|pool|court|kabaddi|bowling|squash|fencing|shooting|basketball|volleyball)/.test(text);
  const isTeam = /(team|11|7 vs 7|5 vs 5|6 vs 6|rugby|football|soccer|cricket|hockey|basketball|volleyball|kabaddi|kho|polo|relay)/.test(text);
  const isOlympic = /(olympic|ioc|track|athletics|swimming|gymnastics|tennis|badminton|hockey|football|basketball|boxing|wrestling|judo|archery|shooting|fencing|rowing)/.test(text);
  const isIndia = /(india|indian|kabaddi|kho|cricket|chess|chaturanga|poona|mallakhamb|gilli)/.test(text);
  const isTactical = /(chess|strategy|tactical|archery|shooting|golf|snooker|cricket|fencing|judo|curling)/.test(text);

  return {
    id: Number(raw.id),
    title: raw.title || "Untitled Sport",
    category: raw.category || "General",
    snippet: raw.snippet || "No description available.",
    _score: raw.score != null ? Number(raw.score) : 100,
    origin: isIndia ? "India / South Asia" : "Global Heritage",
    governingBody: raw.category ? `${raw.category} Federation` : "International Body",
    players: isTeam ? "Team Format" : "Individual / 1v1",
    olympic: isOlympic ? "Yes" : "Regional / Global",
    environment: isIndoor ? "Indoor" : "Outdoor",
    playStyle: isTeam ? "Team" : "Solo",
    pace: isTactical ? "Tactical" : ((h % 3 === 0) ? "Balanced" : "High-Adrenaline"),
    equipment: "Standard regulation arena & sport gear",
    keyRule: raw.snippet || "Compete under official international rules.",
    funFact: `Indexed in Sportpedia C-Core under ${raw.category || "General"} (Record #${raw.id}).`,
    isIndia,
    profile: {
      endurance: 55 + (h % 42),
      agility: 50 + ((h >> 3) % 47),
      strength: 45 + ((h >> 6) % 50),
      strategy: isTactical ? 86 + (h % 14) : 60 + ((h >> 9) % 35),
      teamwork: isTeam ? 82 + (h % 17) : 20 + ((h >> 12) % 35),
      accessibility: 50 + ((h >> 15) % 46)
    }
  };
}

// ==================== API CALLS ====================
async function fetchSportsFromBackend(query = "", category = "All") {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (category && category !== "All") params.set("category", category);

  const res = await fetch(`/search?${params.toString()}`);
  if (!res.ok) throw new Error("Search API failed");
  const data = await res.json();
  // Support both new object format {results, latency_ms} and legacy array format
  const rawList = Array.isArray(data) ? data : (data.results || []);
  state.latencyMs = data.latency_ms != null ? data.latency_ms : 0.4;
  state.engineType = data.engine || "c-binary";
  return rawList.map(enrichSport);
}

async function syncAuthState() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    state.user = data.authenticated ? data.username : null;
  } catch (e) {
    state.user = null;
  }
  renderAuthUI();
  if (state.user) {
    await Promise.all([fetchCloudHistory(), fetchCloudBookmarks()]);
  } else {
    state.history = safeStorageGet(STORAGE_KEYS.history, []);
    state.bookmarks = safeStorageGet(STORAGE_KEYS.bookmarks, []);
    renderHistoryChips();
    updateLockerBadge();
  }
}

async function fetchCloudHistory() {
  try {
    const res = await fetch("/api/history");
    const data = await res.json();
    state.history = data.history || [];
    renderHistoryChips();
  } catch (e) {}
}

async function fetchCloudBookmarks() {
  try {
    const res = await fetch("/api/bookmarks");
    const data = await res.json();
    state.bookmarks = (data.bookmarks || []).map(b => Number(b.sport_id));
    updateLockerBadge();
    renderResults();
  } catch (e) {}
}

// ==================== THEME ====================
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  safeStorageSet(STORAGE_KEYS.theme, theme);
  const icon = document.getElementById("themeIcon");
  if (icon) {
    icon.setAttribute("data-lucide", theme === "editorial" ? "moon" : "sun");
    lucide.createIcons();
  }
  if (state.view === "versus") renderVersusChart();
}

function highlightText(text, query) {
  const q = query.trim();
  if (!q) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const tokens = q.split(/\s+/).filter(t => t.length > 1);
  if (!tokens.length) return escaped;
  const pattern = new RegExp(`(${tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return escaped.replace(pattern, '<mark class="highlight-mark">$1</mark>');
}

// ==================== EXPLORE RENDERING ====================
function renderCategoryRibbon() {
  const counts = { All: state.allSports.length };
  state.allSports.forEach(s => { counts[s.category] = (counts[s.category] || 0) + 1; });
  const cats = Object.keys(counts);

  const container = document.getElementById("categoryRibbon");
  container.innerHTML = cats.map(cat => {
    const active = state.category === cat ? "active" : "";
    return `
      <button type="button" data-cat="${escapeHtml(cat)}" class="cat-pill pill-chip ${active} px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-2 shrink-0">
        <span>${escapeHtml(cat)}</span>
        <span class="font-mono-tech text-[10px] opacity-75">${counts[cat]}</span>
      </button>
    `;
  }).join("");

  container.querySelectorAll(".cat-pill").forEach(btn => {
    btn.addEventListener("click", async () => {
      state.category = btn.getAttribute("data-cat");
      renderCategoryRibbon();
      await runLiveSearch();
    });
  });
}

function renderSpotlight() {
  const sport = state.allSports.find(s => s.id === state.spotlightId) || state.allSports[0];
  if (!sport) return;
  document.getElementById("spotlightCategory").textContent = sport.category;
  document.getElementById("spotlightTitle").textContent = sport.title;
  document.getElementById("spotlightSnippet").textContent = sport.snippet;
  document.getElementById("spotlightOrigin").textContent = sport.origin;
  document.getElementById("spotlightBody").textContent = sport.governingBody;
}

function renderHistoryChips() {
  const container = document.getElementById("historyChips");
  const bar = document.getElementById("historyBar");
  if (!state.history.length) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  container.innerHTML = state.history.slice(0, 8).map(term => `
    <button type="button" data-hist="${escapeHtml(term)}" class="hist-chip px-2.5 py-1 rounded-md text-xs font-medium border transition hover:opacity-80" style="background-color: var(--bg-surface-alt); border-color: var(--border-hairline); color: var(--ink-primary);">
      ${escapeHtml(term)}
    </button>
  `).join("");

  container.querySelectorAll(".hist-chip").forEach(btn => {
    btn.addEventListener("click", async () => {
      const term = btn.getAttribute("data-hist");
      state.query = term;
      document.getElementById("searchInput").value = term;
      document.getElementById("clearSearchBtn").classList.remove("hidden");
      await runLiveSearch();
    });
  });
}

async function runLiveSearch() {
  try {
    state.currentResults = await fetchSportsFromBackend(state.query, state.category);
    if (state.user && state.query.trim()) {
      fetchCloudHistory();
    } else if (state.query.trim()) {
      const clean = state.query.trim();
      state.history = [clean, ...state.history.filter(h => h.toLowerCase() !== clean.toLowerCase())].slice(0, 8);
      safeStorageSet(STORAGE_KEYS.history, state.history);
      renderHistoryChips();
    }
    renderResults();
  } catch (err) {
    showToast("Could not reach search backend.");
  }
}

function applyClientSubfilters(list) {
  let out = [...list];
  if (state.quickFilter === "olympic") out = out.filter(s => s.olympic === "Yes");
  else if (state.quickFilter === "india") out = out.filter(s => s.isIndia);
  else if (state.quickFilter === "indoor") out = out.filter(s => s.environment === "Indoor");
  else if (state.quickFilter === "outdoor") out = out.filter(s => s.environment === "Outdoor");
  else if (state.quickFilter === "team") out = out.filter(s => s.playStyle === "Team");
  else if (state.quickFilter === "solo") out = out.filter(s => s.playStyle === "Solo");

  if (state.sort === "relevance") out.sort((a, b) => b._score - a._score || a.title.localeCompare(b.title));
  else if (state.sort === "alpha") out.sort((a, b) => a.title.localeCompare(b.title));
  else if (state.sort === "olympic") out.sort((a, b) => (b.olympic === "Yes" ? 1 : 0) - (a.olympic === "Yes" ? 1 : 0) || a.title.localeCompare(b.title));
  else if (state.sort === "intensity") out.sort((a, b) => b.profile.endurance - a.profile.endurance);
  return out;
}

function renderResults() {
  const list = applyClientSubfilters(state.currentResults);
  const grid = document.getElementById("resultsGrid");
  const empty = document.getElementById("emptyState");
  const countEl = document.getElementById("resultsCountText");
  const latencyEl = document.getElementById("latencyBadge");
  const resetBtn = document.getElementById("resetAllFiltersBtn");

  countEl.textContent = `${list.length} ${list.length === 1 ? "SPORT" : "SPORTS"} MATCHED`;
  latencyEl.textContent = `${state.engineType.toUpperCase()} LATENCY: ${state.latencyMs} ms`;

  const hasFilters = state.query || state.category !== "All" || state.quickFilter !== "all";
  resetBtn.classList.toggle("hidden", !hasFilters);

  if (!list.length) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  // Render up to 60 cards at a time for snappy DOM performance on 200+ corpus
  const displayList = list.slice(0, 60);
  grid.innerHTML = displayList.map(sport => {
    const isSaved = state.bookmarks.includes(sport.id);
    const isCompared = state.versusA === sport.id || state.versusB === sport.id;
    const scoreTag = state.query.trim()
      ? `<span class="font-mono-tech text-[10px] font-bold px-2 py-0.5 rounded" style="background-color: var(--accent-soft); color: var(--accent-primary);">${sport._score}% MATCH</span>`
      : `<span class="font-mono-tech text-[10px] font-bold px-2 py-0.5 rounded" style="background-color: var(--bg-surface-alt); color: var(--ink-muted);">${escapeHtml(sport.olympic === "Yes" ? "OLYMPIC" : "GLOBAL")}</span>`;

    return `
      <article class="surface-card surface-card-interactive rounded-2xl p-5 flex flex-col justify-between cursor-pointer sport-card" data-id="${sport.id}">
        <div>
          <div class="flex items-center justify-between gap-2 mb-2.5">
            <span class="font-mono-tech text-[10px] uppercase font-bold tracking-wider" style="color: var(--accent-secondary);">${escapeHtml(sport.category)}</span>
            ${scoreTag}
          </div>
          <h3 class="font-display font-bold text-xl leading-snug mb-2">${highlightText(sport.title, state.query)}</h3>
          <p class="text-xs sm:text-sm leading-relaxed mb-4 line-clamp-3" style="color: var(--ink-secondary);">${highlightText(sport.snippet, state.query)}</p>
          <div class="flex flex-wrap gap-1.5 mb-4 text-[11px] font-medium" style="color: var(--ink-muted);">
            <span class="px-2 py-0.5 rounded" style="background-color: var(--bg-surface-alt);">${escapeHtml(sport.environment)}</span>
            <span class="px-2 py-0.5 rounded" style="background-color: var(--bg-surface-alt);">${escapeHtml(sport.players)}</span>
          </div>
        </div>
        <div class="flex items-center justify-between gap-2 pt-3 border-t" style="border-color: var(--border-hairline);">
          <button type="button" class="card-listen-btn btn-secondary px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1" data-id="${sport.id}">
            <i data-lucide="volume-2" class="w-3.5 h-3.5"></i> Listen
          </button>
          <div class="flex items-center gap-1.5">
            <button type="button" class="card-compare-btn px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 border" data-id="${sport.id}" style="border-color: ${isCompared ? 'var(--accent-primary)' : 'var(--border-hairline)'}; background-color: ${isCompared ? 'var(--accent-soft)' : 'transparent'}; color: ${isCompared ? 'var(--accent-primary)' : 'var(--ink-secondary)'};">
              <i data-lucide="swords" class="w-3.5 h-3.5"></i> ${isCompared ? "Pinned" : "Compare"}
            </button>
            <button type="button" class="card-save-btn p-1.5 rounded-lg border" data-id="${sport.id}" title="Save to Locker" style="border-color: ${isSaved ? 'var(--accent-secondary)' : 'var(--border-hairline)'}; background-color: ${isSaved ? 'var(--accent-warm-soft)' : 'transparent'}; color: ${isSaved ? 'var(--accent-secondary)' : 'var(--ink-secondary)'};">
              <i data-lucide="bookmark" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>
      </article>
    `;
  }).join("");

  grid.querySelectorAll(".sport-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openDossier(Number(card.getAttribute("data-id")));
    });
  });
  grid.querySelectorAll(".card-listen-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const s = findSportById(Number(btn.getAttribute("data-id")));
      if (s) speakSport(s);
    });
  });
  grid.querySelectorAll(".card-compare-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      pinToVersus(Number(btn.getAttribute("data-id")));
    });
  });
  grid.querySelectorAll(".card-save-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBookmark(Number(btn.getAttribute("data-id")));
    });
  });

  lucide.createIcons();
}

function findSportById(id) {
  return state.allSports.find(s => s.id === id) || state.currentResults.find(s => s.id === id);
}

// ==================== DOSSIER MODAL ====================
function openDossier(id) {
  const sport = findSportById(id);
  if (!sport) return;
  const isSaved = state.bookmarks.includes(sport.id);
  const related = state.allSports.filter(s => s.category === sport.category && s.id !== sport.id).slice(0, 3);
  const dims = [
    ["Endurance", sport.profile.endurance],
    ["Agility", sport.profile.agility],
    ["Strength", sport.profile.strength],
    ["Strategy", sport.profile.strategy],
    ["Team Synergy", sport.profile.teamwork],
    ["Accessibility", sport.profile.accessibility]
  ];

  document.getElementById("dossierContent").innerHTML = `
    <div class="pr-10 mb-4">
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <span class="font-mono-tech text-[11px] font-bold uppercase px-2.5 py-0.5 rounded-full" style="background-color: var(--accent-warm-soft); color: var(--accent-secondary);">${escapeHtml(sport.category)}</span>
        <span class="font-mono-tech text-[11px] font-bold uppercase px-2.5 py-0.5 rounded-full" style="background-color: var(--accent-soft); color: var(--accent-primary);">Record #${sport.id}</span>
      </div>
      <h2 class="font-display font-bold text-3xl leading-tight">${escapeHtml(sport.title)}</h2>
    </div>
    <p class="text-sm leading-relaxed mb-5" style="color: var(--ink-secondary);">${escapeHtml(sport.snippet)}</p>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-5 text-xs">
      <div class="p-3 rounded-xl" style="background-color: var(--bg-surface-alt);">
        <div class="font-mono-tech text-[10px] uppercase mb-0.5" style="color: var(--ink-muted);">Category</div>
        <div class="font-bold">${escapeHtml(sport.category)}</div>
      </div>
      <div class="p-3 rounded-xl" style="background-color: var(--bg-surface-alt);">
        <div class="font-mono-tech text-[10px] uppercase mb-0.5" style="color: var(--ink-muted);">Format</div>
        <div class="font-bold">${escapeHtml(sport.players)}</div>
      </div>
      <div class="p-3 rounded-xl" style="background-color: var(--bg-surface-alt);">
        <div class="font-mono-tech text-[10px] uppercase mb-0.5" style="color: var(--ink-muted);">Venue</div>
        <div class="font-bold">${escapeHtml(sport.environment)}</div>
      </div>
      <div class="p-3 rounded-xl" style="background-color: var(--bg-surface-alt);">
        <div class="font-mono-tech text-[10px] uppercase mb-0.5" style="color: var(--ink-muted);">Olympic</div>
        <div class="font-bold">${escapeHtml(sport.olympic)}</div>
      </div>
    </div>
    <div class="mb-5">
      <div class="font-mono-tech text-[10px] uppercase font-bold mb-2.5" style="color: var(--ink-muted);">Athletic Profile Index</div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        ${dims.map(([label, val]) => `
          <div>
            <div class="flex justify-between text-xs mb-1">
              <span class="font-medium">${label}</span>
              <span class="font-mono-tech font-bold">${val}</span>
            </div>
            <div class="h-1.5 rounded-full overflow-hidden" style="background-color: var(--bg-surface-alt);">
              <div class="h-full rounded-full" style="width: ${val}%; background-color: var(--accent-primary);"></div>
            </div>
          </div>
        `).join("")}
      </div>
    </div>
    ${related.length ? `
      <div class="mb-5">
        <div class="font-mono-tech text-[10px] uppercase font-bold mb-2" style="color: var(--ink-muted);">Related in ${escapeHtml(sport.category)}</div>
        <div class="flex flex-wrap gap-2">
          ${related.map(r => `<button type="button" data-rel-id="${r.id}" class="rel-sport-btn btn-secondary px-3 py-1.5 rounded-lg text-xs font-semibold">${escapeHtml(r.title)}</button>`).join("")}
        </div>
      </div>
    ` : ""}
    <div class="flex flex-wrap items-center gap-2 pt-4 border-t" style="border-color: var(--border-hairline);">
      <button type="button" id="dossierListenBtn" class="btn-primary px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5">
        <i data-lucide="volume-2" class="w-4 h-4"></i> Play Neural Commentary
      </button>
      <button type="button" id="dossierCompareBtn" class="btn-secondary px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5">
        <i data-lucide="swords" class="w-4 h-4"></i> Send to Versus Arena
      </button>
      <button type="button" id="dossierSaveBtn" class="btn-secondary px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5">
        <i data-lucide="bookmark" class="w-4 h-4"></i> ${isSaved ? "Saved in Locker" : "Save to Locker"}
      </button>
    </div>
  `;

  document.getElementById("dossierListenBtn").addEventListener("click", () => speakSport(sport));
  document.getElementById("dossierCompareBtn").addEventListener("click", () => {
    pinToVersus(sport.id);
    document.getElementById("dossierModal").classList.add("hidden");
    switchView("versus");
  });
  document.getElementById("dossierSaveBtn").addEventListener("click", async () => {
    await toggleBookmark(sport.id);
    openDossier(sport.id);
  });
  document.querySelectorAll(".rel-sport-btn").forEach(btn => {
    btn.addEventListener("click", () => openDossier(Number(btn.getAttribute("data-rel-id"))));
  });

  document.getElementById("dossierModal").classList.remove("hidden");
  lucide.createIcons();
}

// ==================== VERSUS ARENA ====================
function pinToVersus(id) {
  if (state.versusA === id || state.versusB === id) {
    showToast("Already pinned in Versus Arena!");
    return;
  }
  state.versusB = state.versusA;
  state.versusA = id;
  const s = findSportById(id);
  showToast(`${s ? s.title : "Sport"} pinned to Versus Arena!`);
  renderResults();
  if (state.view === "versus") renderVersusView();
}

function populateVersusSelects() {
  const selA = document.getElementById("versusSelectA");
  const selB = document.getElementById("versusSelectB");
  const opts = state.allSports.map(s => `<option value="${s.id}">${escapeHtml(s.title)} (${escapeHtml(s.category)})</option>`).join("");
  selA.innerHTML = opts;
  selB.innerHTML = opts;
  if (state.versusA) selA.value = String(state.versusA);
  if (state.versusB) selB.value = String(state.versusB);
}

function renderVersusView() {
  if (state.allSports.length < 2) return;
  populateVersusSelects();
  const a = findSportById(state.versusA) || state.allSports[0];
  const b = findSportById(state.versusB) || state.allSports[1];

  const rows = [
    ["Category", a.category, b.category],
    ["Format", a.players, b.players],
    ["Venue", a.environment, b.environment],
    ["Olympic Status", a.olympic, b.olympic],
    ["Overview", a.snippet, b.snippet]
  ];

  document.getElementById("versusComparisonTable").innerHTML = rows.map(([label, valA, valB]) => `
    <div class="p-3 rounded-xl border text-xs" style="background-color: var(--bg-page); border-color: var(--border-hairline);">
      <div class="font-mono-tech text-[10px] uppercase font-bold mb-1.5" style="color: var(--ink-muted);">${label}</div>
      <div class="grid grid-cols-2 gap-3">
        <div class="font-semibold pr-2 border-r" style="border-color: var(--border-hairline); color: var(--accent-primary);">${escapeHtml(valA)}</div>
        <div class="font-semibold" style="color: var(--accent-secondary);">${escapeHtml(valB)}</div>
      </div>
    </div>
  `).join("");
  renderVersusChart();
}

function renderVersusChart() {
  const a = findSportById(state.versusA) || state.allSports[0];
  const b = findSportById(state.versusB) || state.allSports[1];
  if (!a || !b) return;
  const styles = getComputedStyle(document.documentElement);
  const ctx = document.getElementById("versusRadarChart").getContext("2d");
  if (radarChartInstance) radarChartInstance.destroy();

  radarChartInstance = new Chart(ctx, {
    type: "radar",
    data: {
      labels: ["Endurance", "Agility", "Strength", "Strategy", "Teamwork", "Accessibility"],
      datasets: [
        {
          label: a.title,
          data: [a.profile.endurance, a.profile.agility, a.profile.strength, a.profile.strategy, a.profile.teamwork, a.profile.accessibility],
          backgroundColor: styles.getPropertyValue("--chart-a-bg").trim(),
          borderColor: styles.getPropertyValue("--chart-a-border").trim(),
          borderWidth: 2.5,
          pointRadius: 3
        },
        {
          label: b.title,
          data: [b.profile.endurance, b.profile.agility, b.profile.strength, b.profile.strategy, b.profile.teamwork, b.profile.accessibility],
          backgroundColor: styles.getPropertyValue("--chart-b-bg").trim(),
          borderColor: styles.getPropertyValue("--chart-b-border").trim(),
          borderWidth: 2.5,
          pointRadius: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        r: {
          min: 0, max: 100,
          ticks: { stepSize: 25, display: false },
          grid: { color: styles.getPropertyValue("--chart-grid").trim() },
          angleLines: { color: styles.getPropertyValue("--chart-grid").trim() },
          pointLabels: { color: styles.getPropertyValue("--chart-tick").trim(), font: { family: "JetBrains Mono", size: 11, weight: "600" } }
        }
      },
      plugins: { legend: { position: "bottom", labels: { color: styles.getPropertyValue("--ink-primary").trim(), font: { family: "Inter", size: 12, weight: "700" } } } }
    }
  });
}

// ==================== MATCHMAKER ====================
function renderMatchmaker() {
  const { environment, playStyle, pace } = state.mm;
  document.getElementById("mmSummaryLabel").textContent = `${environment} • ${playStyle} • ${pace}`;
  const scored = state.allSports.map(s => {
    let score = 40;
    if (environment === "Any" || s.environment === environment) score += 22;
    if (playStyle === "Any" || s.playStyle === playStyle) score += 20;
    if (s.pace === pace) score += 18;
    else if (pace === "Balanced") score += 10;
    return { ...s, matchPct: Math.min(99, score) };
  }).sort((a, b) => b.matchPct - a.matchPct || a.title.localeCompare(b.title)).slice(0, 6);

  const container = document.getElementById("matchmakerResults");
  container.innerHTML = scored.map((s, idx) => `
    <div class="p-4 rounded-xl border flex flex-col justify-between" style="background-color: var(--bg-page); border-color: ${idx === 0 ? 'var(--accent-primary)' : 'var(--border-hairline)'};">
      <div>
        <div class="flex items-center justify-between mb-2">
          <span class="font-mono-tech text-[10px] uppercase font-bold" style="color: var(--ink-muted);">#${idx + 1} MATCH</span>
          <span class="font-mono-tech text-xs font-bold px-2 py-0.5 rounded-full" style="background-color: var(--accent-soft); color: var(--accent-primary);">${s.matchPct}% FIT</span>
        </div>
        <h4 class="font-display font-bold text-lg mb-1">${escapeHtml(s.title)}</h4>
        <p class="text-xs mb-3 line-clamp-2" style="color: var(--ink-secondary);">${escapeHtml(s.snippet)}</p>
      </div>
      <div class="flex items-center gap-2">
        <button type="button" data-mm-open="${s.id}" class="mm-open-btn btn-primary flex-1 py-1.5 rounded-lg text-xs font-bold">Inspect Dossier</button>
        <button type="button" data-mm-cmp="${s.id}" class="mm-cmp-btn btn-secondary px-2.5 py-1.5 rounded-lg text-xs font-bold">Compare</button>
      </div>
    </div>
  `).join("");

  container.querySelectorAll(".mm-open-btn").forEach(btn => btn.addEventListener("click", () => openDossier(Number(btn.getAttribute("data-mm-open")))));
  container.querySelectorAll(".mm-cmp-btn").forEach(btn => btn.addEventListener("click", () => { pinToVersus(Number(btn.getAttribute("data-mm-cmp"))); switchView("versus"); }));
}

// ==================== TRIVIA BLITZ ====================
function buildTriviaRound() {
  if (state.allSports.length < 4) return;
  const pool = [...state.allSports].sort(() => Math.random() - 0.5).slice(0, 8);
  const questions = pool.map(sport => {
    const distractors = state.allSports.filter(s => s.id !== sport.id).sort(() => Math.random() - 0.5).slice(0, 3);
    const clue = sport.snippet.replace(new RegExp(sport.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "this sport");
    return {
      type: sport.category,
      prompt: `Which sport matches this dossier? "${clue}"`,
      answer: sport.title,
      options: [sport.title, ...distractors.map(d => d.title)].sort(() => Math.random() - 0.5),
      fact: `${sport.title} (${sport.category}): ${sport.snippet}`
    };
  });
  state.trivia.questions = questions;
  state.trivia.index = 0;
  state.trivia.score = 0;
  state.trivia.streak = 0;
  state.trivia.answered = false;
  document.getElementById("triviaQuestionBox").classList.remove("hidden");
  document.getElementById("triviaSummaryBox").classList.add("hidden");
  renderTriviaQuestion();
}

function renderTriviaQuestion() {
  const { questions, index, score, streak, best } = state.trivia;
  document.getElementById("triviaScore").textContent = String(score);
  document.getElementById("triviaStreak").textContent = String(streak);
  document.getElementById("triviaBest").textContent = String(best);
  const q = questions[index];
  document.getElementById("triviaQNum").textContent = `Question ${index + 1} of ${questions.length}`;
  document.getElementById("triviaQType").textContent = q.type;
  document.getElementById("triviaPrompt").textContent = q.prompt;
  document.getElementById("triviaProgress").style.width = `${Math.round(((index + 1) / questions.length) * 100)}%`;
  document.getElementById("triviaFeedback").classList.add("hidden");
  document.getElementById("triviaNextBtn").classList.add("hidden");

  const optsEl = document.getElementById("triviaOptions");
  optsEl.innerHTML = q.options.map((opt, i) => `
    <button type="button" data-opt="${escapeHtml(opt)}" class="trivia-opt btn-secondary text-left px-4 py-3 rounded-xl text-sm font-semibold flex items-center gap-2.5">
      <span class="font-mono-tech text-xs px-1.5 py-0.5 rounded" style="background-color: var(--bg-page); color: var(--ink-muted);">${String.fromCharCode(65 + i)}</span>
      <span>${escapeHtml(opt)}</span>
    </button>
  `).join("");
  optsEl.querySelectorAll(".trivia-opt").forEach(btn => btn.addEventListener("click", () => handleTriviaAnswer(btn, q)));
}

function handleTriviaAnswer(btn, q) {
  if (state.trivia.answered) return;
  state.trivia.answered = true;
  const isRight = btn.getAttribute("data-opt") === q.answer;
  document.querySelectorAll(".trivia-opt").forEach(b => {
    b.disabled = true;
    const val = b.getAttribute("data-opt");
    if (val === q.answer) { b.style.borderColor = "var(--accent-primary)"; b.style.backgroundColor = "var(--accent-soft)"; }
    else if (b === btn && !isRight) { b.style.borderColor = "var(--accent-secondary)"; b.style.backgroundColor = "var(--accent-warm-soft)"; }
  });

  const fb = document.getElementById("triviaFeedback");
  fb.classList.remove("hidden");
  if (isRight) {
    state.trivia.score += 10 + state.trivia.streak * 2;
    state.trivia.streak += 1;
    if (state.trivia.score > state.trivia.best) {
      state.trivia.best = state.trivia.score;
      safeStorageSet(STORAGE_KEYS.triviaBest, state.trivia.best);
    }
    fb.style.backgroundColor = "var(--accent-soft)";
    fb.style.color = "var(--accent-primary)";
    fb.textContent = `✓ Spot on! ${q.fact}`;
  } else {
    state.trivia.streak = 0;
    fb.style.backgroundColor = "var(--accent-warm-soft)";
    fb.style.color = "var(--accent-secondary)";
    fb.textContent = `✗ Correct answer: ${q.answer}. ${q.fact}`;
  }
  document.getElementById("triviaScore").textContent = String(state.trivia.score);
  document.getElementById("triviaStreak").textContent = String(state.trivia.streak);
  document.getElementById("triviaBest").textContent = String(state.trivia.best);
  document.getElementById("triviaNextBtn").classList.remove("hidden");
}

function advanceTrivia() {
  if (state.trivia.index < state.trivia.questions.length - 1) {
    state.trivia.index += 1;
    state.trivia.answered = false;
    renderTriviaQuestion();
  } else {
    document.getElementById("triviaQuestionBox").classList.add("hidden");
    document.getElementById("triviaSummaryBox").classList.remove("hidden");
    document.getElementById("triviaFinalHeadline").textContent = `You scored ${state.trivia.score} points!`;
    document.getElementById("triviaFinalSub").textContent = "Generated dynamically from your live Sportpedia corpus.";
    if (state.trivia.score >= 50 && typeof confetti === "function") confetti({ particleCount: 70, spread: 65, origin: { y: 0.6 } });
  }
}

// ==================== BOOKMARKS & LOCKER ====================
async function toggleBookmark(id) {
  const sport = findSportById(id);
  const idx = state.bookmarks.indexOf(id);
  if (idx === -1) {
    state.bookmarks.push(id);
    if (state.user) {
      await fetch("/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sport_id: id, sport_title: sport ? sport.title : `Sport #${id}` })
      }).catch(() => {});
    }
    showToast(`Saved ${sport ? sport.title : "sport"} to Locker`);
  } else {
    state.bookmarks.splice(idx, 1);
    if (state.user) {
      await fetch(`/api/bookmarks/${id}`, { method: "DELETE" }).catch(() => {});
    }
    showToast(`Removed ${sport ? sport.title : "sport"} from Locker`);
  }
  safeStorageSet(STORAGE_KEYS.bookmarks, state.bookmarks);
  updateLockerBadge();
  renderResults();
  renderLockerDrawer();
}

function updateLockerBadge() {
  document.getElementById("lockerCount").textContent = String(state.bookmarks.length);
}

function renderLockerDrawer() {
  const bmContainer = document.getElementById("lockerBookmarksList");
  if (!state.bookmarks.length) {
    bmContainer.innerHTML = `<p class="text-xs p-3 rounded-lg" style="background-color: var(--bg-surface-alt); color: var(--ink-muted);">No sports saved yet. Click the bookmark icon on any card to build your Locker.</p>`;
  } else {
    bmContainer.innerHTML = state.bookmarks.map(id => {
      const s = findSportById(id);
      if (!s) return "";
      return `
        <div class="p-3 rounded-xl border flex items-center justify-between gap-2" style="background-color: var(--bg-page); border-color: var(--border-hairline);">
          <button type="button" data-bm-open="${s.id}" class="bm-open-btn text-left min-w-0 flex-1">
            <div class="font-bold text-sm truncate">${escapeHtml(s.title)}</div>
            <div class="font-mono-tech text-[10px]" style="color: var(--ink-muted);">${escapeHtml(s.category)}</div>
          </button>
          <button type="button" data-bm-del="${s.id}" class="bm-del-btn p-1.5 rounded hover:opacity-70" style="color: var(--accent-secondary);" aria-label="Remove bookmark">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>
      `;
    }).join("");
    bmContainer.querySelectorAll(".bm-open-btn").forEach(btn => btn.addEventListener("click", () => { document.getElementById("lockerOverlay").classList.add("hidden"); openDossier(Number(btn.getAttribute("data-bm-open"))); }));
    bmContainer.querySelectorAll(".bm-del-btn").forEach(btn => btn.addEventListener("click", () => toggleBookmark(Number(btn.getAttribute("data-bm-del")))));
  }

  const histContainer = document.getElementById("lockerHistoryList");
  histContainer.innerHTML = state.history.length
    ? state.history.map(h => `<button type="button" data-lhist="${escapeHtml(h)}" class="lhist-btn px-2.5 py-1 rounded-md text-xs font-semibold border" style="background-color: var(--bg-surface-alt); border-color: var(--border-hairline);">${escapeHtml(h)}</button>`).join("")
    : `<span class="text-xs" style="color: var(--ink-muted);">No recent searches.</span>`;

  histContainer.querySelectorAll(".lhist-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const term = btn.getAttribute("data-lhist");
      state.query = term;
      document.getElementById("searchInput").value = term;
      document.getElementById("lockerOverlay").classList.add("hidden");
      switchView("explore");
      await runLiveSearch();
    });
  });
  lucide.createIcons();
}

function exportLockerJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    user: state.user || "guest",
    savedSports: state.bookmarks.map(findSportById).filter(Boolean),
    recentSearches: state.history
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sportpedia-locker.json";
  a.click();
  URL.revokeObjectURL(url);
  showToast("Exported sportpedia-locker.json");
}

// ==================== NEURAL TTS (/api/tts) + BROWSER FALLBACK ====================
async function speakSport(sport) {
  stopAudio();
  const text = `${sport.title}. Category: ${sport.category}. ${sport.snippet}`;
  state.audio.title = sport.title;
  state.audio.text = text;
  state.audio.active = true;
  state.audio.paused = false;

  document.getElementById("audioTitle").textContent = `${sport.title} — Neural Commentary`;
  document.getElementById("audioBar").classList.remove("hidden");
  document.getElementById("audioEq").classList.remove("eq-paused");
  document.getElementById("audioPauseIcon").setAttribute("data-lucide", "pause");
  lucide.createIcons();

  try {
    let audioUrl = ttsBlobCache.get(text);
    if (!audioUrl) {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      if (!res.ok) throw new Error("TTS unavailable");
      const blob = await res.blob();
      audioUrl = URL.createObjectURL(blob);
      ttsBlobCache.set(text, audioUrl);
    }
    const audio = new Audio(audioUrl);
    audio.playbackRate = state.audio.rate;
    audio.onended = () => stopAudio();
    state.audio.htmlAudio = audio;
    await audio.play();
  } catch (e) {
    // Fallback to browser Web Speech API
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = state.audio.rate;
      utter.lang = "en-IN";
      utter.onend = () => stopAudio();
      window.speechSynthesis.speak(utter);
    } else {
      showToast("Audio playback unavailable.");
      stopAudio();
    }
  }
}

function togglePauseAudio() {
  if (state.audio.htmlAudio) {
    if (state.audio.paused) { state.audio.htmlAudio.play(); state.audio.paused = false; }
    else { state.audio.htmlAudio.pause(); state.audio.paused = true; }
  } else if ("speechSynthesis" in window) {
    if (state.audio.paused) { window.speechSynthesis.resume(); state.audio.paused = false; }
    else { window.speechSynthesis.pause(); state.audio.paused = true; }
  }
  document.getElementById("audioEq").classList.toggle("eq-paused", state.audio.paused);
  document.getElementById("audioPauseIcon").setAttribute("data-lucide", state.audio.paused ? "play" : "pause");
  lucide.createIcons();
}

function stopAudio() {
  if (state.audio.htmlAudio) {
    state.audio.htmlAudio.pause();
    state.audio.htmlAudio = null;
  }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  state.audio.active = false;
  state.audio.paused = false;
  document.getElementById("audioBar").classList.add("hidden");
}

function cycleAudioSpeed() {
  const speeds = [0.85, 1.0, 1.25];
  state.audio.rate = speeds[(speeds.indexOf(state.audio.rate) + 1) % speeds.length];
  document.getElementById("audioSpeedBtn").textContent = `${state.audio.rate}x`;
  if (state.audio.htmlAudio) state.audio.htmlAudio.playbackRate = state.audio.rate;
}

function startVoiceSearch() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const statusBox = document.getElementById("voiceStatus");
  if (!SR) { showToast("Voice search requires Chrome or Edge."); return; }
  if (speechRecognition) speechRecognition.stop();
  speechRecognition = new SR();
  speechRecognition.lang = "en-IN";
  speechRecognition.interimResults = false;
  statusBox.classList.remove("hidden");

  speechRecognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript;
    document.getElementById("searchInput").value = transcript;
    state.query = transcript;
    document.getElementById("clearSearchBtn").classList.remove("hidden");
    statusBox.classList.add("hidden");
    await runLiveSearch();
    showToast(`Voice query: "${transcript}"`);
  };
  speechRecognition.onerror = () => { statusBox.classList.add("hidden"); showToast("Could not hear voice input."); };
  speechRecognition.onend = () => statusBox.classList.add("hidden");
  speechRecognition.start();
}

// ==================== AUTH ====================
function renderAuthUI() {
  const label = document.getElementById("accountBtnLabel");
  const signedOut = document.getElementById("authSignedOutView");
  const signedIn = document.getElementById("authSignedInView");
  if (state.user) {
    label.textContent = state.user;
    signedOut.classList.add("hidden");
    signedIn.classList.remove("hidden");
    document.getElementById("profileUsername").textContent = state.user;
    document.getElementById("profileAvatar").textContent = state.user.charAt(0).toUpperCase();
  } else {
    label.textContent = "Sign In";
    signedOut.classList.remove("hidden");
    signedIn.classList.add("hidden");
  }
}

function switchView(viewName) {
  state.view = viewName;
  ["explore", "versus", "matchmaker", "trivia"].forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle("hidden", v !== viewName);
  });
  document.querySelectorAll("[data-view]").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === viewName);
  });
  if (viewName === "versus") renderVersusView();
  if (viewName === "matchmaker") renderMatchmaker();
  if (viewName === "trivia" && !state.trivia.questions.length) buildTriviaRound();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ==================== INIT ====================
async function init() {
  state.theme = safeStorageGet(STORAGE_KEYS.theme, "editorial");
  state.trivia.best = safeStorageGet(STORAGE_KEYS.triviaBest, 0);
  applyTheme(state.theme);
  lucide.createIcons();

  // Load full corpus from live Flask + C backend
  try {
    state.allSports = await fetchSportsFromBackend("", "All");
    state.currentResults = [...state.allSports];
    if (state.allSports.length >= 2) {
      state.spotlightId = state.allSports[0].id;
      state.versusA = state.allSports[0].id;
      state.versusB = state.allSports[1].id;
    }
  } catch (e) {
    showToast("Backend /search unreachable. Check Flask server.");
  }

  await syncAuthState();
  renderSpotlight();
  renderCategoryRibbon();
  renderResults();

  document.querySelectorAll("[data-view]").forEach(btn => btn.addEventListener("click", () => switchView(btn.getAttribute("data-view"))));
  document.getElementById("brandHomeBtn").addEventListener("click", () => switchView("explore"));
  document.getElementById("themeToggleBtn").addEventListener("click", () => applyTheme(state.theme === "editorial" ? "floodlight" : "editorial"));

  const searchInput = document.getElementById("searchInput");
  const clearBtn = document.getElementById("clearSearchBtn");
  searchInput.addEventListener("input", () => {
    state.query = searchInput.value;
    clearBtn.classList.toggle("hidden", !state.query);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(runLiveSearch, 180);
  });
  document.getElementById("searchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    state.query = searchInput.value;
    await runLiveSearch();
  });
  clearBtn.addEventListener("click", async () => {
    searchInput.value = "";
    state.query = "";
    clearBtn.classList.add("hidden");
    await runLiveSearch();
    searchInput.focus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
      e.preventDefault();
      switchView("explore");
      searchInput.focus();
    } else if (e.key === "Escape") {
      document.getElementById("dossierModal").classList.add("hidden");
      document.getElementById("lockerOverlay").classList.add("hidden");
      document.getElementById("authModal").classList.add("hidden");
    }
  });

  document.querySelectorAll(".quick-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.quickFilter = btn.getAttribute("data-quick-filter");
      document.querySelectorAll(".quick-filter-btn").forEach(b => b.classList.toggle("active", b === btn));
      renderResults();
    });
  });

  document.getElementById("sortSelect").addEventListener("change", (e) => { state.sort = e.target.value; renderResults(); });
  const resetAll = async () => {
    state.query = "";
    state.category = "All";
    state.quickFilter = "all";
    searchInput.value = "";
    clearBtn.classList.add("hidden");
    document.querySelectorAll(".quick-filter-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-quick-filter") === "all"));
    renderCategoryRibbon();
    await runLiveSearch();
  };
  document.getElementById("resetAllFiltersBtn").addEventListener("click", resetAll);
  document.getElementById("emptyResetBtn").addEventListener("click", resetAll);

  document.getElementById("clearHistoryBtn").addEventListener("click", async () => {
    if (state.user) await fetch("/api/history", { method: "DELETE" }).catch(() => {});
    state.history = [];
    safeStorageSet(STORAGE_KEYS.history, []);
    renderHistoryChips();
    renderLockerDrawer();
    showToast("Search history cleared");
  });

  document.getElementById("surpriseBtn").addEventListener("click", async () => {
    try {
      const res = await fetch("/api/random");
      const r = await res.json();
      if (r && r.id) { state.spotlightId = Number(r.id); renderSpotlight(); return; }
    } catch (e) {}
    if (state.allSports.length) {
      state.spotlightId = state.allSports[Math.floor(Math.random() * state.allSports.length)].id;
      renderSpotlight();
    }
  });
  document.getElementById("spotlightReadBtn").addEventListener("click", () => openDossier(state.spotlightId));
  document.getElementById("spotlightListenBtn").addEventListener("click", () => { const s = findSportById(state.spotlightId); if (s) speakSport(s); });
  document.getElementById("spotlightCompareBtn").addEventListener("click", () => { pinToVersus(state.spotlightId); switchView("versus"); });

  document.getElementById("versusSelectA").addEventListener("change", (e) => { state.versusA = Number(e.target.value); renderVersusView(); });
  document.getElementById("versusSelectB").addEventListener("change", (e) => { state.versusB = Number(e.target.value); renderVersusView(); });
  document.getElementById("swapVersusBtn").addEventListener("click", () => { [state.versusA, state.versusB] = [state.versusB, state.versusA]; renderVersusView(); });

  document.querySelectorAll("[data-mm-group]").forEach(groupEl => {
    const group = groupEl.getAttribute("data-mm-group");
    groupEl.querySelectorAll(".mm-opt").forEach(btn => {
      btn.addEventListener("click", () => {
        state.mm[group] = btn.getAttribute("data-mm-val");
        groupEl.querySelectorAll(".mm-opt").forEach(b => b.classList.toggle("active", b === btn));
        renderMatchmaker();
      });
    });
  });

  document.getElementById("triviaNextBtn").addEventListener("click", advanceTrivia);
  document.getElementById("triviaRestartBtn").addEventListener("click", buildTriviaRound);
  document.getElementById("triviaPlayAgainBtn").addEventListener("click", buildTriviaRound);

  document.getElementById("voiceBtn").addEventListener("click", startVoiceSearch);
  document.getElementById("audioPauseBtn").addEventListener("click", togglePauseAudio);
  document.getElementById("audioStopBtn").addEventListener("click", stopAudio);
  document.getElementById("audioSpeedBtn").addEventListener("click", cycleAudioSpeed);

  document.getElementById("closeDossierBtn").addEventListener("click", () => document.getElementById("dossierModal").classList.add("hidden"));
  document.getElementById("dossierModal").addEventListener("click", (e) => { if (e.target.id === "dossierModal") document.getElementById("dossierModal").classList.add("hidden"); });

  document.getElementById("openLockerBtn").addEventListener("click", () => { renderLockerDrawer(); document.getElementById("lockerOverlay").classList.remove("hidden"); });
  document.getElementById("closeLockerBtn").addEventListener("click", () => document.getElementById("lockerOverlay").classList.add("hidden"));
  document.getElementById("lockerOverlay").addEventListener("click", (e) => { if (e.target.id === "lockerOverlay") document.getElementById("lockerOverlay").classList.add("hidden"); });
  document.getElementById("exportLockerBtn").addEventListener("click", exportLockerJson);

  document.getElementById("accountBtn").addEventListener("click", () => { renderAuthUI(); document.getElementById("authModal").classList.remove("hidden"); });
  document.getElementById("closeAuthBtn").addEventListener("click", () => document.getElementById("authModal").classList.add("hidden"));
  document.getElementById("authModal").addEventListener("click", (e) => { if (e.target.id === "authModal") document.getElementById("authModal").classList.add("hidden"); });

  const setAuthMode = (mode) => {
    state.authMode = mode;
    const isLogin = mode === "login";
    document.getElementById("authModalTitle").textContent = isLogin ? "Sign In" : "Create Account";
    document.getElementById("authSubmitBtn").textContent = isLogin ? "Log In" : "Create Account";
    document.getElementById("authTabLogin").className = isLogin ? "flex-1 py-1.5 rounded-md text-xs font-bold btn-primary" : "flex-1 py-1.5 rounded-md text-xs font-bold";
    document.getElementById("authTabRegister").className = !isLogin ? "flex-1 py-1.5 rounded-md text-xs font-bold btn-primary" : "flex-1 py-1.5 rounded-md text-xs font-bold";
  };
  document.getElementById("authTabLogin").addEventListener("click", () => setAuthMode("login"));
  document.getElementById("authTabRegister").addEventListener("click", () => setAuthMode("register"));

  document.getElementById("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("authUsername").value.trim();
    const password = document.getElementById("authPassword").value;
    const err = document.getElementById("authError");
    err.classList.add("hidden");
    try {
      const endpoint = state.authMode === "login" ? "/api/login" : "/api/register";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) {
        err.textContent = data.error || "Authentication failed.";
        err.classList.remove("hidden");
        return;
      }
      await syncAuthState();
      document.getElementById("authModal").classList.add("hidden");
      showToast(state.authMode === "login" ? `Welcome back, ${data.username}!` : `Account created for ${data.username}!`);
    } catch (ex) {
      err.textContent = "Server error. Try again.";
      err.classList.remove("hidden");
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    await syncAuthState();
    document.getElementById("authModal").classList.add("hidden");
    showToast("Signed out");
  });
}

window.addEventListener("DOMContentLoaded", init);
