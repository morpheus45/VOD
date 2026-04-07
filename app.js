const STORAGE_KEYS = {
  favorites: "iptv_v2_favorites",
  history: "iptv_v2_history",
  progress: "iptv_v2_progress",
  seriesCache: "iptv_series_episodes_cache"
};

const TYPE_LABELS = {
  vod: "Films",
  series: "Series"
};

const PAGINATION_CONFIG = {
  itemsPerPage: 50,
  preloadThreshold: 200
};

const state = {
  type: "vod",
  items: { vod: [], series: [] },
  sourceUsed: { vod: "", series: "" },
  filters: { category: "", search: "", quality: "", sort: "title" },
  bootStatus: "Chargement...",
  selectedSeries: null,
  displayedItems: { vod: 0, series: 0 },
  isLoadingMore: false,
  seriesEpisodesCache: {}
};

function $(id){ return document.getElementById(id); }

function readStore(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch{
    return fallback;
  }
}

function writeStore(key, value){
  localStorage.setItem(key, JSON.stringify(value));
}

function getFavorites(){ return readStore(STORAGE_KEYS.favorites, []); }
function getHistory(){ return readStore(STORAGE_KEYS.history, []); }
function getProgress(){ return readStore(STORAGE_KEYS.progress, []); }

function itemKey(item){
  return [item.type || state.type, item.title || "", item.url || item.stream_url || ""].join("||");
}

function cleanTitle(title){
  if(!title) return "";
  let cleaned = String(title);
  cleaned = cleaned.replace(/^(FR\s*[-|:]|SRS\s*[-|:]|EN\s*[-|:]|VOD\s*[-|:]|SERIE\s*[-|:])\s*/i, "");
  cleaned = cleaned.replace(/\s*group-title\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\s*tvg-logo\s*=\s*"[^"]*"/gi, "");
  cleaned = cleaned.replace(/\.(mkv|mp4|ts|m3u8|avi|mov)$/i, "");
  cleaned = cleaned.replace(/\s*\(\d+\)\s*$/g, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

function toggleFavorite(item){
  const favs = getFavorites();
  const key = itemKey(item);
  const idx = favs.findIndex(x => x.key === key);
  if(idx >= 0) favs.splice(idx, 1);
  else favs.unshift({ key, item, savedAt: Date.now() });
  writeStore(STORAGE_KEYS.favorites, favs.slice(0, 500));
  render();
}

function pushHistory(item){
  const hist = getHistory().filter(x => x.key !== itemKey(item));
  hist.unshift({ key: itemKey(item), item, watchedAt: Date.now() });
  writeStore(STORAGE_KEYS.history, hist.slice(0, 300));
}

function isFavorite(item){
  const key = itemKey(item);
  return getFavorites().some(x => x.key === key);
}

function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[s]));
}

function inferQuality(source){
  const text = String(source || "").toLowerCase();
  if(/\b(4k|uhd|2160p?)\b/.test(text)) return "4K";
  if(/\b(fhd|full[\s-]?hd|1080p?|hd|720p?)\b/.test(text)) return "HD";
  if(/\b(sd|480p?|360p?)\b/.test(text)) return "SD";
  return "Autres";
}

function normalizeItems(arr, type){
  return (Array.isArray(arr) ? arr : []).map((x, idx) => ({
    id: x.id || x.stream_id || x.series_id || idx,
    title: cleanTitle(x.title || x.name || "Sans titre"),
    category_id: x.category_id || "",
    category_name: cleanTitle(x.category_name || x.category || "Autre"),
    stream_icon: x.stream_icon || x.image || x.cover || x.poster || "",
    stream_url: x.url || x.stream_url || "",
    url: x.url || x.stream_url || "",
    plot: x.plot || x.description || x.overview || "",
    type,
    quality: inferQuality([x.title, x.name, x.category_name, x.category, x.plot, x.description].join(" ")),
    seasons: Array.isArray(x.seasons) ? x.seasons : [],
    episodes: x.episodes && typeof x.episodes === "object" ? x.episodes : {}
  }));
}

function parseM3U(text, type){
  const lines = text.split(/\r?\n/);
  const out = [];
  let current = null;

  for(const raw of lines){
    const line = raw.trim();
    if(!line) continue;

    if(line.startsWith("#EXTINF:")){
      const group = (line.match(/group-title="([^"]+)"/i) || [,"Autre"])[1];
      const logo = (line.match(/tvg-logo="([^"]+)"/i) || [,""])[1];
      const title = line.includes(",") ? line.split(",").slice(1).join(",").trim() : "Sans titre";
      current = { title: cleanTitle(title), category_name: cleanTitle(group), stream_icon: logo, stream_url: "", url: "", type, quality: inferQuality(`${title} ${group}`) };
    }else if(!line.startsWith("#") && current){
      current.stream_url = line;
      current.url = line;
      out.push(current);
      current = null;
    }
  }

  return out;
}

function extractJsonItems(rawJson){
  if(Array.isArray(rawJson)) return rawJson;
  if(!rawJson || typeof rawJson !== "object") return [];

  const candidates = [
    rawJson.items,
    rawJson.streams,
    rawJson.channels,
    rawJson.movies,
    rawJson.series,
    rawJson.vod
  ];

  for(const c of candidates){
    if(Array.isArray(c)) return c;
  }

  return [];
}

async function safeFetchJson(path){
  try{
    const r = await fetch(path);
    if(!r.ok) return null;
    return await r.json();
  }catch{
    return null;
  }
}

async function safeFetchText(path){
  try{
    const r = await fetch(path);
    if(!r.ok) return null;
    return await r.text();
  }catch{
    return null;
  }
}

async function fetchSeriesEpisodes(series){
  if(!series || !series.stream_url) return {};
  
  // Si c'est une URL directe, on ne peut pas charger dynamiquement
  if(!series.stream_url.includes("action=get_series_info")) return {};

  try {
    const data = await safeFetchJson(series.stream_url);
    if(data && data.episodes) return data.episodes;
    return {};
  } catch(e) {
    console.error("Erreur fetchSeriesEpisodes:", e);
    return {};
  }
}

function currentCollection(){
  const base = state.items[state.type] || [];
  let filtered = base;

  if(state.filters.category){
    filtered = filtered.filter(x => x.category_name === state.filters.category);
  }

  if(state.filters.search){
    const q = state.filters.search.toLowerCase();
    filtered = filtered.filter(x => x.title.toLowerCase().includes(q) || x.plot.toLowerCase().includes(q));
  }

  if(state.filters.quality){
    filtered = filtered.filter(x => x.quality === state.filters.quality);
  }

  if(state.filters.sort === "recent"){
    // No real date, but keep original order
  } else if(state.filters.sort === "category"){
    filtered.sort((a,b) => a.category_name.localeCompare(b.category_name));
  } else {
    filtered.sort((a,b) => a.title.localeCompare(b.title));
  }

  return filtered;
}

function closeSeriesPanel(){
  state.selectedSeries = null;
  renderSeriesPanel();
}

function openSeriesEpisode(series, episode, seasonLabel){
  if(!series || !episode) return;
  const episodeItem = {
    id: episode.id,
    title: episode.title,
    episode_num: episode.episode_num,
    season: seasonLabel || episode.season || "",
    url: episode.url || episode.stream_url || "",
    stream_url: episode.url || episode.stream_url || "",
    container_extension: episode.container_extension,
    info: episode.info || {}
  };
  playNativeDirectly(episodeItem);
}

async function renderSeriesPanel(){
  const panel = $("seriesPanel");
  if(!panel) return;

  const series = state.selectedSeries;
  if(!series){
    panel.hidden = true;
    return;
  }

  let seasonsMap = series.episodes && typeof series.episodes === "object" ? series.episodes : {};
  
  if(!Object.keys(seasonsMap).length && series.stream_url && series.stream_url.includes("action=")){
    panel.innerHTML = `
      <div class="series-panel__header">
        <div class="series-panel__titleblock">
          <div class="series-kicker">Series</div>
          <h3>${escapeHtml(series.title)}</h3>
        </div>
        <button id="seriesCloseBtn" class="series-close" type="button">Fermer</button>
      </div>
      <div class="series-panel__body">
        <div class="series-hero">
          <p class="series-plot">Chargement des saisons...</p>
        </div>
      </div>
    `;
    panel.hidden = false;
    if($("seriesCloseBtn")) $("seriesCloseBtn").onclick = closeSeriesPanel;
    
    seasonsMap = await fetchSeriesEpisodes(series);
    series.episodes = seasonsMap;
    renderSeriesPanel();
    return;
  }

  const seasonKeys = Object.keys(seasonsMap).sort((a, b) => Number(a) - Number(b));
  const poster = escapeHtml(series.stream_icon || "");
  const metaBits = [
    series.category_name || "",
    seasonKeys.length ? `${seasonKeys.length} saison${seasonKeys.length > 1 ? "s" : ""}` : ""
  ].filter(Boolean).join(" • ");

  const seasonsHtml = seasonKeys.map(season => {
    const episodes = Array.isArray(seasonsMap[season]) ? seasonsMap[season] : [];
    const epsHtml = episodes.map((ep, idx) => `
      <button class="episode-btn" data-season="${escapeHtml(season)}" data-idx="${idx}" type="button">
        <span class="episode-code">S${String(season).padStart(2, "0")}E${String(ep.episode_num || idx+1).padStart(2, "0")}</span>
        <span class="episode-title">${escapeHtml(ep.title || "Episode")}</span>
      </button>
    `).join("");
    return `
      <div class="season-block">
        <div class="season-title">Saison ${escapeHtml(season)}</div>
        <div class="episode-list">${epsHtml || "<div class='episode-empty'>Aucun episode.</div>"}</div>
      </div>
    `;
  }).join("");

  const directUrl = series.stream_url || series.url || "";

  panel.innerHTML = `
    <div class="series-panel__header">
      <div class="series-panel__titleblock">
        <div class="series-kicker">Series</div>
        <h3>${escapeHtml(series.title)}</h3>
        <div class="series-meta">${escapeHtml(metaBits)}</div>
      </div>
      <button id="seriesCloseBtn" class="series-close" type="button">Fermer</button>
    </div>
    <div class="series-panel__body">
      <div class="series-hero">
        ${poster ? `<img class="series-cover" src="${poster}" alt="${escapeHtml(series.title)}" loading="lazy">` : ""}
        <p class="series-plot">${escapeHtml(series.plot || "Aucun synopsis disponible.")}</p>
      </div>
      ${seasonsHtml || (directUrl ? `<button id="seriesPlayDirect" class="episode-btn" type="button"><span class="episode-code">Lire</span><span class="episode-title">Lire le flux direct</span></button>` : "<div class='episode-empty'>Aucune saison trouvee.</div>")}
    </div>
  `;

  panel.hidden = false;
  panel.querySelectorAll(".episode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const season = btn.dataset.season;
      const idx = Number(btn.dataset.idx);
      const episode = (seasonsMap[season] || [])[idx];
      if(episode) openSeriesEpisode(series, episode, season);
      else if(btn.id === "seriesPlayDirect") playNativeDirectly(series);
    });
  });
  if($("seriesCloseBtn")) $("seriesCloseBtn").onclick = closeSeriesPanel;
}

function loadMoreItems(){
  if(state.isLoadingMore) return;
  state.isLoadingMore = true;
  const collection = currentCollection();
  const currentCount = state.displayedItems[state.type];
  const nextCount = Math.min(currentCount + PAGINATION_CONFIG.itemsPerPage, collection.length);
  if(nextCount > currentCount){
    state.displayedItems[state.type] = nextCount;
    renderGrid();
  }
  state.isLoadingMore = false;
}

function renderGrid(){
  const grid = $("grid");
  const empty = $("emptyState");
  if(!grid) return;

  const collection = currentCollection();
  const limit = state.displayedItems[state.type];
  const items = collection.slice(0, limit);

  if(items.length === 0){
    grid.innerHTML = "";
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  
  if(limit === PAGINATION_CONFIG.itemsPerPage) grid.innerHTML = "";

  const fragment = document.createDocumentFragment();
  items.slice(grid.children.length).forEach(item => {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.key = itemKey(item);
    
    const poster = escapeHtml(item.stream_icon || "");
    const favClass = isFavorite(item) ? "is-favorite" : "";

    card.innerHTML = `
      <div class="card-media">
        ${poster ? `<img src="${poster}" alt="${escapeHtml(item.title)}" loading="lazy">` : `<div class="poster-placeholder"></div>`}
        <div class="card-badge">${escapeHtml(item.type === "series" ? "Series" : "Film")}</div>
        ${item.quality ? `<div class="card-quality">${escapeHtml(item.quality)}</div>` : ""}
        <button class="fav-btn ${favClass}" type="button">Favori</button>
      </div>
      <div class="card-info">
        <div class="card-title">${escapeHtml(item.title)}</div>
        <div class="card-meta">${escapeHtml(item.category_name)}</div>
      </div>
    `;

    bindCardEvents(card, item);
    fragment.appendChild(card);
  });

  grid.appendChild(fragment);
  $("catalogCount").textContent = `${collection.length} elements (${grid.children.length} affiches)`;
}

function bindCardEvents(card, item){
  const favBtn = card.querySelector(".fav-btn");
  if(favBtn){
    favBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFavorite(item);
    };
  }

  card.onclick = () => {
    if(item.type === "series"){
      state.selectedSeries = item;
      renderSeriesPanel();
    } else {
      playNativeDirectly(item);
    }
  };
}

function render(){
  const collection = currentCollection();
  
  // Update Hero
  $("heroTitle").textContent = TYPE_LABELS[state.type] || "PIPSIFLIX";
  $("statType").textContent = TYPE_LABELS[state.type];
  $("statCount").textContent = `${collection.length} elements`;
  $("statSource").textContent = `source : ${state.sourceUsed[state.type] || "locale"}`;

  // Update Filters
  const cats = [...new Set(state.items[state.type].map(x => x.category_name))].sort();
  const catSelect = $("categorySelect");
  const currentCat = state.filters.category;
  catSelect.innerHTML = `<option value="">Toutes les sections</option>` + cats.map(c => `<option value="${escapeHtml(c)}" ${c === currentCat ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");

  renderGrid();
}

function playNativeDirectly(item){
  if(!(item.stream_url || item.url)){
    alert("Aucune URL de lecture.");
    return;
  }
  pushHistory(item);
  const url = item.stream_url || item.url;
  const isAndroid = /Android/i.test(navigator.userAgent);
  if(isAndroid){
    window.location.href = url;
  } else {
    window.location.href = "vlc://" + url.replace(/^(https?:\/\/)/, "");
  }
}

async function boot(){
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.type = btn.dataset.type;
      state.filters.category = "";
      state.displayedItems[state.type] = PAGINATION_CONFIG.itemsPerPage;
      render();
    };
  });

  $("categorySelect").onchange = (e) => {
    state.filters.category = e.target.value;
    state.displayedItems[state.type] = PAGINATION_CONFIG.itemsPerPage;
    render();
  };

  $("searchInput").oninput = (e) => {
    state.filters.search = e.target.value;
    state.displayedItems[state.type] = PAGINATION_CONFIG.itemsPerPage;
    render();
  };

  $("qualitySelect").onchange = (e) => {
    state.filters.quality = e.target.value;
    state.displayedItems[state.type] = PAGINATION_CONFIG.itemsPerPage;
    render();
  };

  $("sortSelect").onchange = (e) => {
    state.filters.sort = e.target.value;
    state.displayedItems[state.type] = PAGINATION_CONFIG.itemsPerPage;
    render();
  };

  // Intersection Observer pour le chargement infini
  const observer = new IntersectionObserver((entries) => {
    if(entries[0].isIntersecting) loadMoreItems();
  }, { rootMargin: "200px" });
  
  const sentinel = $("gridSentinel");
  if(sentinel) observer.observe(sentinel);

  // Chargement des données
  const vodData = await safeFetchJson("vod.json");
  if(vodData){
    state.items.vod = normalizeItems(extractJsonItems(vodData), "vod");
    state.sourceUsed.vod = "vod.json";
  } else {
    const vodM3u = await safeFetchText("vod.m3u");
    if(vodM3u){
      state.items.vod = parseM3U(vodM3u, "vod");
      state.sourceUsed.vod = "vod.m3u";
    }
  }

  const seriesData = await safeFetchJson("series.json");
  if(seriesData){
    state.items.series = normalizeItems(extractJsonItems(seriesData), "series");
    state.sourceUsed.series = "series.json";
    
    // Enrichir avec series_catalog si présent
    const catalog = await safeFetchJson("series_catalog.json");
    if(catalog){
      const catItems = normalizeItems(extractJsonItems(catalog), "series");
      catItems.forEach(c => {
        const target = state.items.series.find(s => s.title === c.title);
        if(target){
          if(Object.keys(c.episodes || {}).length > Object.keys(target.episodes || {}).length){
            target.episodes = c.episodes;
          }
          if(c.plot && !target.plot) target.plot = c.plot;
        }
      });
    }
  }

  state.displayedItems.vod = PAGINATION_CONFIG.itemsPerPage;
  state.displayedItems.series = PAGINATION_CONFIG.itemsPerPage;
  render();
}

window.onload = boot;
