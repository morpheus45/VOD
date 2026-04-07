const STORAGE_KEYS = {
  favorites: "iptv_v2_favorites",
  history: "iptv_v2_history",
  progress: "iptv_v2_progress",
  seriesCache: "iptv_series_episodes_cache"
};

const TYPE_LABELS = {
  live: "Live",
  vod: "Films",
  series: "Series"
};

const PAGINATION_CONFIG = {
  itemsPerPage: 50,
  preloadThreshold: 200
};

const state = {
  type: "live",
  items: { live: [], vod: [], series: [] },
  sourceUsed: { live: "", vod: "", series: "" },
  filters: { category: "", search: "", quality: "", sort: "title" },
  bootStatus: "Chargement...",
  selectedSeries: null,
  displayedItems: { live: 0, vod: 0, series: 0 },
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
    rawJson.results,
    rawJson.data
  ];

  for(const value of candidates){
    if(Array.isArray(value)) return value;
  }

  return [];
}

async function safeFetchText(path){
  try{
    const response = await fetch(path, { cache: "no-store" });
    if(!response.ok) return "";
    return await response.text();
  }catch{
    return "";
  }
}

async function safeFetchJson(path){
  try{
    const response = await fetch(path, { cache: "no-store" });
    if(!response.ok) return null;
    return await response.json();
  }catch{
    return null;
  }
}

/**
 * CORRECTION : Récupérer dynamiquement les épisodes d'une série via l'API Xtream Codes
 */
async function fetchSeriesEpisodes(series){
  if(!series || !series.stream_url) return {};
  
  // Vérifier le cache local d'abord
  if(state.seriesEpisodesCache[series.id]){
    return state.seriesEpisodesCache[series.id];
  }

  try{
    const response = await fetch(series.stream_url, { cache: "no-store" });
    if(!response.ok) return {};
    
    const data = await response.json();
    let episodes = {};

    // Xtream Codes retourne une structure avec 'seasons' contenant les épisodes
    if(data.seasons && typeof data.seasons === "object"){
      for(const seasonKey in data.seasons){
        const seasonData = data.seasons[seasonKey];
        if(Array.isArray(seasonData)){
          episodes[seasonKey] = seasonData.map(ep => ({
            id: ep.id || ep.episode_id,
            title: ep.title || ep.name || `Episode ${ep.episode_num || ""}`,
            episode_num: ep.episode_num || 0,
            season: seasonKey,
            url: ep.url || ep.stream_url || "",
            stream_url: ep.url || ep.stream_url || "",
            container_extension: ep.container_extension || "mkv",
            info: ep.info || {}
          }));
        }
      }
    }

    // Mettre en cache
    state.seriesEpisodesCache[series.id] = episodes;
    return episodes;
  }catch(e){
    console.warn("Erreur lors du chargement des épisodes:", e);
    return {};
  }
}

async function loadType(type){
  let finalItems = [];

  const rawJson = await safeFetchJson(`${type}.json`);
  const extracted = extractJsonItems(rawJson);
  if(extracted.length){
    state.sourceUsed[type] = `${type}.json`;
    finalItems = normalizeItems(extracted, type);
  }

  if(!finalItems.length){
    const m3uText = await safeFetchText(`${type}.m3u`);
    if(m3uText){
      const parsedM3u = parseM3U(m3uText, type);
      if(parsedM3u.length){
        state.sourceUsed[type] = `${type}.m3u`;
        finalItems = normalizeItems(parsedM3u, type);
      }
    }
  }

  if(finalItems.length) return finalItems;

  state.sourceUsed[type] = "aucune";
  return [];
}

function setActiveNav(type){
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.type === type);
  });
}

function buildCategorySelect(){
  const select = $("categorySelect");
  if(!select) return;
  
  const categories = [...new Set(state.items[state.type].map(x => x.category_name).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  select.innerHTML = '<option value="">Toutes les sections</option>' +
    categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
  
  if(state.filters.category && !categories.includes(state.filters.category)){
    state.filters.category = "";
  }
  select.value = state.filters.category;
}

function currentCollection(){
  const search = state.filters.search.trim().toLowerCase();
  let arr = [...state.items[state.type]];

  if(state.filters.category){
    arr = arr.filter(x => x.category_name === state.filters.category);
  }

  if(state.filters.quality){
    arr = arr.filter(x => (x.quality || "Autres") === state.filters.quality);
  }

  if(search){
    arr = arr.filter(x =>
      (x.title || "").toLowerCase().includes(search) ||
      (x.category_name || "").toLowerCase().includes(search)
    );
  }

  if(state.filters.sort === "category"){
    arr.sort((a, b) => (a.category_name || "").localeCompare(b.category_name || "") || (a.title || "").localeCompare(b.title || ""));
  }else if(state.filters.sort === "recent"){
    const historyMap = new Map(getHistory().map(x => [x.key, x.watchedAt]));
    arr.sort((a, b) => (historyMap.get(itemKey(b)) || 0) - (historyMap.get(itemKey(a)) || 0));
  }else{
    arr.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }

  return arr;
}

function groupedByQuality(items){
  const order = ["4K", "HD", "SD", "Autres"];
  const groups = new Map(order.map(label => [label, []]));

  for(const item of items){
    const quality = item.quality || "Autres";
    if(!groups.has(quality)) groups.set(quality, []);
    groups.get(quality).push(item);
  }

  return order
    .map(label => ({ label, items: groups.get(label) || [] }))
    .filter(group => group.items.length);
}

function cardTemplate(item){
  const fav = isFavorite(item);
  const poster = escapeHtml(item.stream_icon || "");
  const typeLabel = item.type === "vod" ? "Film" : item.type === "series" ? "Series" : "Live";
  const posterClass = item.type === "live" ? "poster poster--logo" : "poster";

  return `
    <article class="card" data-key="${escapeHtml(itemKey(item))}">
      <div class="poster-wrap">
        <img class="${posterClass}" src="${poster}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="badges">
          <span class="badge">${escapeHtml(typeLabel)}</span>
          <span class="badge">${escapeHtml(item.quality || "Autres")}</span>
        </div>
        <button class="fav-btn" data-fav="${escapeHtml(itemKey(item))}" type="button">${fav ? "Retirer" : "Favori"}</button>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(item.title)}</div>
        <div class="card-meta">${escapeHtml(item.category_name)}</div>
      </div>
    </article>
  `;
}

function bindCardEvents(scope){
  if(!scope) return;
  scope.querySelectorAll(".card").forEach(el => {
    el.addEventListener("click", e => {
      if(e.target.closest(".fav-btn")) return;
      const item = findItemByKey(el.dataset.key);
      if(!item) return;
      if(item.type === "series") openSeriesPanel(item);
      else playNativeDirectly(item);
    });
  });

  scope.querySelectorAll(".fav-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const item = findItemByKey(btn.dataset.fav);
      if(item) toggleFavorite(item);
    });
  });
}

function openSeriesPanel(item){
  state.selectedSeries = item;
  renderSeriesPanel();
}

function closeSeriesPanel(){
  state.selectedSeries = null;
  renderSeriesPanel();
}

function openSeriesEpisode(series, episode, seasonLabel){
  if(!series || !episode) return;
  const { episodes, ...rest } = series;
  const slim = { ...rest, seasons: series.seasons || [], episodes: {} };
  const payloadEpisode = {
    id: episode.id,
    title: episode.title,
    episode_num: episode.episode_num,
    season: seasonLabel || episode.season || "",
    url: episode.url || episode.stream_url || "",
    stream_url: episode.url || episode.stream_url || "",
    container_extension: episode.container_extension,
    info: episode.info || {}
  };
  slim.selected_episode = payloadEpisode;
  sessionStorage.setItem("iptv_current_item", JSON.stringify(slim));
  location.href = "player.html";
}

async function renderSeriesPanel(){
  const panel = $("seriesPanel");
  if(!panel) return;

  const series = state.selectedSeries;
  if(!series){
    panel.hidden = true;
    return;
  }

  // CORRECTION : Charger les épisodes dynamiquement depuis l'API
  let seasonsMap = series.episodes && typeof series.episodes === "object" ? series.episodes : {};
  
  if(!Object.keys(seasonsMap).length && series.stream_url){
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
    
    // Charger les épisodes
    seasonsMap = await fetchSeriesEpisodes(series);
    series.episodes = seasonsMap;
    
    // Re-render après chargement
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
    });
  });
  if($("seriesCloseBtn")) $("seriesCloseBtn").onclick = closeSeriesPanel;
  if($("seriesPlayDirect")) $("seriesPlayDirect").onclick = () => openItem(series);
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
  const displayCount = state.displayedItems[state.type];
  const visibleItems = collection.slice(0, displayCount);
  
  if(visibleItems.length){
    const qualityGroups = groupedByQuality(visibleItems);
    grid.innerHTML = qualityGroups.map(group => `
      <section class="quality-block">
        <div class="quality-head">
          <h3 class="quality-title">${escapeHtml(group.label)}</h3>
          <span class="quality-count">${group.items.length} flux</span>
        </div>
        <div class="quality-grid">${group.items.map(item => cardTemplate(item)).join("")}</div>
      </section>
    `).join("");
    if(empty) empty.hidden = true;
    bindCardEvents(grid);
    setupInfiniteScroll();
  }else{
    grid.innerHTML = "";
    if(empty) empty.hidden = false;
  }
}

let intersectionObserver = null;
function setupInfiniteScroll(){
  if(!intersectionObserver){
    intersectionObserver = new IntersectionObserver((entries) => {
      if(entries[0].isIntersecting) loadMoreItems();
    }, { rootMargin: `${PAGINATION_CONFIG.preloadThreshold}px` });
  }
  const sentinel = $("gridSentinel");
  if(sentinel) intersectionObserver.observe(sentinel);
}

function render(){
  setActiveNav(state.type);
  buildCategorySelect();
  if($("qualitySelect")) $("qualitySelect").value = state.filters.quality;
  if($("sortSelect")) $("sortSelect").value = state.filters.sort;

  const collection = currentCollection();
  if($("catalogCount")) $("catalogCount").textContent = `${collection.length} elements (${state.displayedItems[state.type]} affichés)`;
  if($("statCount")) $("statCount").textContent = `${state.items[state.type].length} elements`;
  if($("statSource")) $("statSource").textContent = `source : ${state.sourceUsed[state.type]}`;

  state.displayedItems[state.type] = PAGINATION_CONFIG.itemsPerPage;
  renderGrid();
  renderSeriesPanel();
}

function findItemByKey(key){
  const all = [...state.items.live, ...state.items.vod, ...state.items.series];
  return all.find(x => itemKey(x) === key);
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
    try {
      const intentUrl = "intent://" + encodeURIComponent(url) + "#Intent;action=android.intent.action.VIEW;type=video/*;package=org.videolan.vlc;end";
      window.location.href = intentUrl;
    } catch(e) {
      console.error("Erreur intent VLC:", e);
      const vlcUrl = encodeURI("vlc://" + url);
      window.location.href = vlcUrl;
    }
  } else {
    const vlcUrl = encodeURI("vlc://" + url);
    window.location.href = vlcUrl;
  }
}

function openItem(item){
  pushHistory(item);
  if(!(item.stream_url || item.url)){
    alert("Aucune URL de lecture.");
    return;
  }
  sessionStorage.setItem("iptv_current_item", JSON.stringify(item));
  location.href = "player.html";
}

async function boot(){
  state.bootStatus = "Chargement...";
  const [live, vod, series] = await Promise.all([loadType("live"), loadType("vod"), loadType("series")]);
  state.items.live = live;
  state.items.vod = vod;
  state.items.series = series;
  state.bootStatus = "Pret.";
  render();
}

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    state.type = btn.dataset.type;
    state.filters.category = "";
    state.filters.search = "";
    if($("searchInput")) $("searchInput").value = "";
    render();
  });
});

if($("categorySelect")) $("categorySelect").onchange = e => { state.filters.category = e.target.value; render(); };
if($("searchInput")) $("searchInput").oninput = e => { state.filters.search = e.target.value; render(); };
if($("qualitySelect")) $("qualitySelect").onchange = e => { state.filters.quality = e.target.value; render(); };
if($("sortSelect")) $("sortSelect").onchange = e => { state.filters.sort = e.target.value; render(); };

// NOUVEAU : Navigation au clavier pour Google TV et Android
let focusedCardIndex = 0;
function focusCard(index){
  const cards = document.querySelectorAll(".card");
  if(cards.length === 0) return;
  if(index < 0) index = 0;
  if(index >= cards.length) index = cards.length - 1;
  focusedCardIndex = index;
  cards[index].focus();
  cards[index].scrollIntoView({ behavior: "smooth", block: "center" });
}

document.addEventListener("keydown", e => {
  const key = e.key.toLowerCase();
  if(key === "arrowright") focusCard(focusedCardIndex + 1);
  else if(key === "arrowleft") focusCard(focusedCardIndex - 1);
  else if(key === "arrowdown") focusCard(focusedCardIndex + 4);
  else if(key === "arrowup") focusCard(focusedCardIndex - 4);
  else if(key === "enter") {
    const focused = document.activeElement;
    if(focused && focused.classList.contains("card")) focused.click();
  }
});

boot();
