const STORAGE_KEYS = {
  favorites: "iptv_v2_favorites",
  history: "iptv_v2_history",
  progress: "iptv_v2_progress"
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
  bootStatus: "Chargement des flux live, films et series...",
  localFiles: {},
  sourceFolderName: "",
  selectedSeries: null,
  displayedItems: { live: 0, vod: 0, series: 0 },
  isLoadingMore: false
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
    title: x.title || x.name || "Sans titre",
    category_id: x.category_id || "",
    category_name: x.category_name || x.category || "Autre",
    stream_icon: x.stream_icon || x.image || x.cover || x.poster || "",
    stream_url: x.stream_url || x.url || "",
    url: x.url || x.stream_url || "",
    plot: x.plot || x.description || x.overview || "",
    type,
    quality: inferQuality([x.title, x.name, x.category_name, x.category, x.plot, x.description].join(" ")),
    seasons: Array.isArray(x.seasons) ? x.seasons : [],
    episodes: x.episodes && typeof x.episodes === "object" ? x.episodes : {}
  }));
}

function mergeSeriesDetails(baseItems, detailItems){
  if(!baseItems.length || !detailItems.length) return baseItems;

  const byId = new Map();
  const byTitle = new Map();

  for(const item of detailItems){
    if(item.id !== undefined && item.id !== null) byId.set(String(item.id), item);
    if(item.title) byTitle.set(String(item.title).toLowerCase(), item);
  }

  return baseItems.map(item => {
    const match = byId.get(String(item.id)) || byTitle.get(String(item.title || "").toLowerCase());
    if(!match) return item;
    
    // CORRECTION : Ne pas écraser les épisodes réels par des placeholders vides
    const hasRealEpisodes = match.episodes && Object.keys(match.episodes).length > 0;
    const currentHasEpisodes = item.episodes && Object.keys(item.episodes).length > 0;

    return {
      ...item,
      stream_icon: match.stream_icon || item.stream_icon,
      plot: match.plot || item.plot,
      seasons: (Array.isArray(match.seasons) && match.seasons.length) ? match.seasons : item.seasons,
      episodes: hasRealEpisodes ? match.episodes : item.episodes
    };
  });
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
      current = { title, category_name: group, stream_icon: logo, stream_url: "", url: "", type, quality: inferQuality(`${title} ${group}`) };
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

function baseFileName(path){
  return String(path || "").split("/").pop().toLowerCase();
}

async function readLocalConfiguredText(path){
  const file = state.localFiles[baseFileName(path)];
  if(!file) return "";
  try{
    return await file.text();
  }catch{
    return "";
  }
}

function updateSourceFolderLabel(){
  const label = $("sourceFolderLabel");
  if(!label) return;
  label.textContent = state.sourceFolderName
    ? `Source active : ${state.sourceFolderName}`
    : "Source active : racine du projet";
}

async function setLocalFolderFiles(fileList){
  const files = Array.from(fileList || []);
  const next = {};
  for(const file of files){
    next[file.name.toLowerCase()] = file;
  }
  state.localFiles = next;

  if(files.length){
    const firstPath = files[0].webkitRelativePath || "";
    const folderName = firstPath ? firstPath.split("/")[0] : "dossier local";
    state.sourceFolderName = folderName;
    state.bootStatus = `Dossier local selectionne : ${folderName}.`;
  }else{
    state.sourceFolderName = "";
  }

  updateSourceFolderLabel();
  await boot();
}

async function pickSourceFolder(){
  if(window.showDirectoryPicker){
    try{
      const handle = await window.showDirectoryPicker();
      const files = [];
      for await (const entry of handle.values()){
        if(entry.kind !== "file") continue;
        const file = await entry.getFile();
        files.push(file);
      }
      await setLocalFolderFiles(files);
      return;
    }catch{
      return;
    }
  }

  const input = $("folderFilesInput");
  if(input) input.click();
}

async function resetSourceFolder(){
  state.localFiles = {};
  state.sourceFolderName = "";
  updateSourceFolderLabel();
  await boot();
}

async function safeFetchText(path){
  try{
    const response = await fetch(path, { cache: "no-store" });
    if(!response.ok) return "";
    return await response.text();
  }catch{
    return await readLocalConfiguredText(path);
  }
}

async function safeFetchJson(path){
  try{
    const response = await fetch(path, { cache: "no-store" });
    if(!response.ok) return null;
    return await response.json();
  }catch{
    const text = await readLocalConfiguredText(path);
    if(!text) return null;
    try{
      return JSON.parse(text);
    }catch{
      return null;
    }
  }
}

async function loadShardedCatalog(type){
  const indexName = `${type}_catalog_index.json`;
  const indexJson = await safeFetchJson(indexName);
  const parts = indexJson && Array.isArray(indexJson.parts) ? indexJson.parts : [];
  if(!parts.length) return [];

  const merged = [];
  for(const part of parts){
    const json = await safeFetchJson(part);
    const extracted = extractJsonItems(json);
    if(extracted.length) merged.push(...extracted);
    else if(Array.isArray(json)) merged.push(...json);
  }

  return merged;
}

async function loadType(type){
  const preferM3u = type !== "series";
  let finalItems = [];

  // CORRECTION : Pour les séries, on veut charger les données les plus complètes (catalog) en priorité
  if(type === "series"){
    const catalogJson = await safeFetchJson("series_catalog.json");
    const catalogItems = extractJsonItems(catalogJson);
    if(catalogItems.length){
      state.sourceUsed[type] = "series_catalog.json";
      finalItems = normalizeItems(catalogItems, type);
    } else {
      const sharded = await loadShardedCatalog("series");
      if(sharded.length){
        state.sourceUsed[type] = "series_catalog_index.json";
        finalItems = normalizeItems(sharded, type);
      }
    }
    
    // Fusionner avec series.json pour avoir les IDs Xtream si manquants
    const baseJson = await safeFetchJson("series.json");
    const baseItems = extractJsonItems(baseJson);
    if(baseItems.length){
      if(!finalItems.length){
        state.sourceUsed[type] = "series.json";
        finalItems = normalizeItems(baseItems, type);
      } else {
        finalItems = mergeSeriesDetails(finalItems, normalizeItems(baseItems, type));
      }
    }
    
    if(finalItems.length) return finalItems;
  }

  if(preferM3u){
    const m3uText = await safeFetchText(`${type}.m3u`);
    if(m3uText){
      const parsedM3u = parseM3U(m3uText, type);
      if(parsedM3u.length){
        state.sourceUsed[type] = `${type}.m3u`;
        return normalizeItems(parsedM3u, type);
      }
    }
  }

  const rawJson = await safeFetchJson(`${type}.json`);
  const extracted = extractJsonItems(rawJson);
  if(extracted.length){
    state.sourceUsed[type] = `${type}.json`;
    return normalizeItems(extracted, type);
  }

  const catalogJson = await safeFetchJson(`${type}_catalog.json`);
  const catalogItems = extractJsonItems(catalogJson);
  if(catalogItems.length){
    state.sourceUsed[type] = `${type}_catalog.json`;
    return normalizeItems(catalogItems, type);
  }

  const sharded = await loadShardedCatalog(type);
  if(sharded.length){
    state.sourceUsed[type] = `${type}_catalog_index.json`;
    return normalizeItems(sharded, type);
  }

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
    const quality = item.quality || inferQuality(`${item.title || ""} ${item.category_name || ""}`);
    if(!groups.has(quality)) groups.set(quality, []);
    groups.get(quality).push(item);
  }

  return order
    .map(label => ({ label, items: groups.get(label) || [] }))
    .filter(group => group.items.length);
}

function cardTemplate(item, compact=false){
  const fav = isFavorite(item);
  const meta = item.category_name || "";
  const poster = escapeHtml(item.stream_icon || "");
  const typeLabel = item.type === "vod" ? "Film" : item.type === "series" ? "Series" : "Live";
  const posterClass = item.type === "live" ? "poster poster--logo" : "poster";
  const cardClass = compact ? "card card--compact" : "card";
  const wrapClass = compact ? "poster-wrap poster-wrap--compact" : "poster-wrap";
  const badgesClass = compact ? "badges badges--compact" : "badges";
  const badgeClass = compact ? "badge badge--compact" : "badge";
  const favClass = compact ? "fav-btn fav-btn--compact" : "fav-btn";
  const bodyClass = compact ? "card-body card-body--compact" : "card-body";
  const titleClass = compact ? "card-title card-title--compact" : "card-title";
  const metaClass = compact ? "card-meta card-meta--compact" : "card-meta";

  return `
    <article class="${cardClass}" data-key="${escapeHtml(itemKey(item))}">
      <div class="${wrapClass}">
        <img class="${posterClass}" src="${poster}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="${badgesClass}">
          <span class="${badgeClass}">${escapeHtml(typeLabel)}</span>
          <span class="${badgeClass}">${escapeHtml(item.quality || "Autres")}</span>
        </div>
        <button class="${favClass}" data-fav="${escapeHtml(itemKey(item))}" type="button">${fav ? "Retirer" : "Favori"}</button>
      </div>
      <div class="${bodyClass}">
        <div class="${titleClass}">${escapeHtml(item.title)}</div>
        <div class="${metaClass}">${escapeHtml(meta)}</div>
      </div>
    </article>
  `;
}

function bindCardEvents(scope){
  if(!scope) return;

  scope.querySelectorAll(".card").forEach(el => {
    const item = findItemByKey(el.dataset.key);
    if(!item) return;
    el.addEventListener("click", e => {
      if(e.target.closest(".fav-btn")) return;
      if(item.type === "series"){
        openSeriesPanel(item);
      }else{
        openItem(item);
      }
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

function renderSeriesPanel(){
  const panel = $("seriesPanel");
  if(!panel) return;

  const series = state.selectedSeries;
  if(!series){
    panel.hidden = true;
    return;
  }

  const seasonsMap = series.episodes && typeof series.episodes === "object" ? series.episodes : {};
  const seasonKeys = Object.keys(seasonsMap).sort((a, b) => Number(a) - Number(b));
  const poster = escapeHtml(series.stream_icon || series.image || "");
  const metaBits = [
    series.category_name || series.category || "",
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
        <div class="episode-list">
          ${epsHtml || "<div class='episode-empty'>Aucun episode detecte pour cette saison.</div>"}
        </div>
      </div>
    `;
  }).join("");

  const noEpisodes = !seasonKeys.length;
  const directUrl = series.stream_url || series.url || "";

  panel.innerHTML = `
    <div class="series-panel__header">
      <div class="series-panel__titleblock">
        <div class="series-kicker">Series</div>
        <h3>${escapeHtml(series.title || "Sans titre")}</h3>
        <div class="series-meta">${escapeHtml(metaBits)}</div>
      </div>
      <button id="seriesCloseBtn" class="series-close" type="button">Fermer</button>
    </div>
    <div class="series-panel__body">
      <div class="series-hero">
        ${poster ? `<img class="series-cover" src="${poster}" alt="${escapeHtml(series.title || "")}" loading="lazy">` : ""}
        <p class="series-plot">${escapeHtml(series.plot || "Aucun synopsis disponible.")}</p>
      </div>
      ${seasonsHtml || "<div class='episode-empty'>Aucune saison trouvee dans cette serie.</div>"}
      ${noEpisodes && directUrl ? `<button id="seriesPlayDirect" class="episode-btn" type="button"><span class="episode-code">Lire</span><span class="episode-title">Lire le flux direct</span></button>` : ""}
    </div>
  `;

  panel.hidden = false;

  panel.querySelectorAll(".episode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const season = btn.dataset.season;
      const idx = Number(btn.dataset.idx);
      const episodes = Array.isArray(seasonsMap[season]) ? seasonsMap[season] : [];
      const episode = episodes[idx];
      if(episode) openSeriesEpisode(series, episode, season);
    });
  });

  const closeBtn = $("seriesCloseBtn");
  if(closeBtn){
    closeBtn.addEventListener("click", closeSeriesPanel);
  }

  const playDirect = $("seriesPlayDirect");
  if(playDirect){
    playDirect.addEventListener("click", () => openItem(series));
  }
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
        <div class="quality-grid">
          ${group.items.map(item => cardTemplate(item, false)).join("")}
        </div>
      </section>
    `).join("");
    
    if(empty) empty.hidden = true;
    bindCardEvents(grid);
    
    if(displayCount < collection.length){
      setupInfiniteScroll();
    }
  }else{
    grid.innerHTML = "";
    if(empty) empty.hidden = false;
  }
}

let intersectionObserver = null;

function setupInfiniteScroll(){
  if(!intersectionObserver){
    intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if(entry.isIntersecting){
          loadMoreItems();
        }
      });
    }, { rootMargin: `${PAGINATION_CONFIG.preloadThreshold}px` });
  }
  
  const sentinel = $("gridSentinel");
  if(sentinel){
    intersectionObserver.observe(sentinel);
  }
}

function render(){
  setActiveNav(state.type);
  buildCategorySelect();
  updateSourceFolderLabel();

  if(state.type !== "series"){
    state.selectedSeries = null;
  }

  const availableQualities = new Set(state.items[state.type].map(item => item.quality || "Autres"));
  if(state.filters.quality && !availableQualities.has(state.filters.quality)){
    state.filters.quality = "";
  }
  if($("qualitySelect")) $("qualitySelect").value = state.filters.quality;
  if($("sortSelect")) $("sortSelect").value = state.filters.sort;

  const featured = state.items[state.type][0] || null;
  const hTitle = $("heroTitle");
  if(hTitle) hTitle.textContent = TYPE_LABELS[state.type];
  
  const hSubtitle = $("heroSubtitle");
  if(hSubtitle) hSubtitle.textContent = featured
    ? [featured.category_name || "", featured.plot || "", state.bootStatus].filter(Boolean).join(" • ").slice(0, 220)
    : state.bootStatus;
    
  const sType = $("statType");
  if(sType) sType.textContent = TYPE_LABELS[state.type];
  
  const sCount = $("statCount");
  if(sCount) sCount.textContent = `${state.items[state.type].length} elements`;
  
  const sSource = $("statSource");
  if(sSource) sSource.textContent = `source : ${state.sourceUsed[state.type] || "aucune"}`;
  
  const cTitle = $("catalogTitle");
  if(cTitle) cTitle.textContent = `Catalogue ${TYPE_LABELS[state.type]}`;

  const collection = currentCollection();
  const cCount = $("catalogCount");
  if(cCount) cCount.textContent = `${collection.length} elements (${state.displayedItems[state.type]} affichés)`;

  state.displayedItems[state.type] = PAGINATION_CONFIG.itemsPerPage;
  renderGrid();
  renderSeriesPanel();
}

function findItemByKey(key){
  const all = [
    ...state.items.live,
    ...state.items.vod,
    ...state.items.series,
    ...getHistory().map(x => x.item),
    ...getProgress().map(x => x.item),
    ...getFavorites().map(x => x.item)
  ];

  return all.find(x => itemKey(x) === key);
}

function openItem(item){
  pushHistory(item);

  const directUrl = item.stream_url || item.url || "";
  if(!directUrl){
    alert("Aucune URL de lecture disponible pour cet élément.");
    return;
  }

  sessionStorage.setItem("iptv_current_item", JSON.stringify(item));
  location.href = "player.html";
}

async function boot(){
  state.bootStatus = "Chargement des flux live, films et series...";
  render();

  const [liveItems, vodItems, seriesItems] = await Promise.all([
    loadType("live"),
    loadType("vod"),
    loadType("series")
  ]);

  state.items.live = liveItems;
  state.items.vod = vodItems;
  state.items.series = seriesItems;

  const loadedCount = ["live", "vod", "series"].filter(type => state.items[type].length > 0).length;
  if(loadedCount === 3){
    state.bootStatus = "Les trois flux ont ete charges automatiquement a l'ouverture.";
  }else if(loadedCount > 0){
    state.bootStatus = "Une partie des flux a ete chargee. Verifiez les fichiers live.json, vod.json, series.json ou leurs .m3u a la racine.";
  }else{
    state.bootStatus = "Aucun flux charge. Placez live.json ou live.m3u, vod.json ou vod.m3u, et series.json, series_catalog.json ou series.m3u a la racine.";
  }

  render();
}

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    state.type = btn.dataset.type;
    state.filters.category = "";
    state.filters.search = "";
    state.filters.quality = "";
    const sInput = $("searchInput");
    if(sInput) sInput.value = "";
    const qSelect = $("qualitySelect");
    if(qSelect) qSelect.value = "";
    render();
  });
});

const catSelect = $("categorySelect");
if(catSelect) {
  catSelect.addEventListener("change", e => {
    state.filters.category = e.target.value;
    render();
  });
}

const sInput = $("searchInput");
if(sInput) {
  sInput.addEventListener("input", e => {
    state.filters.search = e.target.value;
    render();
  });
}

const qSelect = $("qualitySelect");
if(qSelect) {
  qSelect.addEventListener("change", e => {
    state.filters.quality = e.target.value;
    render();
  });
}

const sSelect = $("sortSelect");
if(sSelect) {
  sSelect.addEventListener("change", e => {
    state.filters.sort = e.target.value;
    render();
  });
}

const pickBtn = $("pickFolderBtn");
if(pickBtn) pickBtn.addEventListener("click", pickSourceFolder);

const resetBtn = $("resetFolderBtn");
if(resetBtn) resetBtn.addEventListener("click", resetSourceFolder);

const folderInput = $("folderFilesInput");
if(folderInput) {
  folderInput.addEventListener("change", async e => {
    await setLocalFolderFiles(e.target.files);
    e.target.value = "";
  });
}

const filtersToggle = $("filtersToggle");
const filtersPanel = $("filtersPanel");
if(filtersToggle && filtersPanel){
  const updateToggleLabel = () => {
    filtersToggle.textContent = filtersPanel.classList.contains("open") ? "Filtres ▴" : "Filtres ▾";
  };
  const isMobile = () => window.innerWidth <= 700;
  if(!isMobile()) filtersPanel.classList.add("open");
  filtersToggle.addEventListener("click", () => {
    filtersPanel.classList.toggle("open");
    updateToggleLabel();
  });
  window.addEventListener("resize", () => {
    if(!isMobile()){
      filtersPanel.classList.add("open");
    }else{
      filtersPanel.classList.remove("open");
    }
    updateToggleLabel();
  });
  updateToggleLabel();
}

updateSourceFolderLabel();
boot();
