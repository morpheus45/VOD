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

const state = {
  type: "live",
  items: { live: [], vod: [], series: [] },
  sourceUsed: { live: "", vod: "", series: "" },
  filters: { category: "", search: "", quality: "", mode: "all", sort: "title" },
  bootStatus: "Chargement des flux live, films et series..."
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
    type: x.type || type,
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

async function safeFetchText(path){
  try{
    const response = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
    if(!response.ok) return "";
    return await response.text();
  }catch{
    return "";
  }
}

async function safeFetchJson(path){
  try{
    const response = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
    if(!response.ok) return null;
    return await response.json();
  }catch{
    return null;
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

  if(merged.length) state.sourceUsed[type] = indexName;
  return normalizeItems(merged, type);
}

async function loadType(type){
  const sharded = await loadShardedCatalog(type);
  if(sharded.length) return sharded;

  const catalogJson = await safeFetchJson(`${type}_catalog.json`);
  const catalogItems = extractJsonItems(catalogJson);
  if(catalogItems.length){
    state.sourceUsed[type] = `${type}_catalog.json`;
    return normalizeItems(catalogItems, type);
  }
  if(Array.isArray(catalogJson)){
    state.sourceUsed[type] = `${type}_catalog.json`;
    return normalizeItems(catalogJson, type);
  }

  const rawJson = await safeFetchJson(`${type}.json`);
  const extracted = extractJsonItems(rawJson);
  if(extracted.length){
    state.sourceUsed[type] = `${type}.json`;
    return normalizeItems(extracted, type);
  }
  if(Array.isArray(rawJson)){
    state.sourceUsed[type] = `${type}.json`;
    return normalizeItems(rawJson, type);
  }

  const m3uText = await safeFetchText(`${type}.m3u`);
  if(m3uText){
    state.sourceUsed[type] = `${type}.m3u`;
    return normalizeItems(parseM3U(m3uText, type), type);
  }

  state.sourceUsed[type] = "aucune";
  return [];
}

function setActiveNav(type){
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.type === type);
  });
}

function setMode(mode){
  state.filters.mode = mode;
  document.querySelectorAll(".chip").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  render();
}

function buildCategorySelect(){
  const select = $("categorySelect");
  const categories = [...new Set(state.items[state.type].map(x => x.category_name).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  select.innerHTML = '<option value="">Toutes les sections</option>' +
    categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
  select.value = state.filters.category;
}

function currentCollection(){
  const search = state.filters.search.trim().toLowerCase();
  let arr = [...state.items[state.type]];

  if(state.filters.mode === "favorites"){
    const favMap = new Set(getFavorites().map(x => x.key));
    arr = arr.filter(item => favMap.has(itemKey(item)));
  }else if(state.filters.mode === "history"){
    arr = getHistory().filter(x => x.item.type === state.type).map(x => x.item);
  }else if(state.filters.mode === "continue"){
    arr = getProgress().filter(x => x.item.type === state.type && Number(x.currentTime) > 0).map(x => x.item);
  }

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
      openItem(item);
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

function renderAuxBlocks(){
  const progress = getProgress().filter(x => Number(x.currentTime) > 0).slice(0, 18);
  const history = getHistory().slice(0, 18);
  const continueBlock = $("continueBlock");
  const historyBlock = $("historyBlock");
  const continueGrid = $("continueGrid");
  const historyGrid = $("historyGrid");

  if(progress.length){
    continueBlock.hidden = false;
    continueGrid.innerHTML = progress.map(x => cardTemplate(x.item, true)).join("");
  }else{
    continueBlock.hidden = true;
    continueGrid.innerHTML = "";
  }

  if(history.length){
    historyBlock.hidden = false;
    historyGrid.innerHTML = history.map(x => cardTemplate(x.item, true)).join("");
  }else{
    historyBlock.hidden = true;
    historyGrid.innerHTML = "";
  }
}

function render(){
  setActiveNav(state.type);
  buildCategorySelect();

  const featured = state.items[state.type][0] || null;
  $("heroTitle").textContent = TYPE_LABELS[state.type];
  $("heroSubtitle").textContent = featured
    ? [featured.category_name || "", featured.plot || "", state.bootStatus].filter(Boolean).join(" • ").slice(0, 220)
    : state.bootStatus;
  $("statType").textContent = TYPE_LABELS[state.type];
  $("statCount").textContent = `${state.items[state.type].length} elements`;
  $("statSource").textContent = `source : ${state.sourceUsed[state.type] || "aucune"}`;
  $("catalogTitle").textContent = `Catalogue ${TYPE_LABELS[state.type]}`;

  const collection = currentCollection();
  const compactMode = state.filters.mode === "favorites" || state.filters.mode === "history" || state.filters.mode === "continue";
  $("catalogCount").textContent = `${collection.length} elements`;

  const grid = $("grid");
  const empty = $("emptyState");
  if(collection.length){
    const qualityGroups = groupedByQuality(collection);
    grid.innerHTML = qualityGroups.map(group => `
      <section class="quality-block">
        <div class="quality-head">
          <h3 class="quality-title">${escapeHtml(group.label)}</h3>
          <span class="quality-count">${group.items.length} flux</span>
        </div>
        <div class="quality-grid">
          ${group.items.map(item => cardTemplate(item, compactMode)).join("")}
        </div>
      </section>
    `).join("");
    empty.hidden = true;
  }else{
    grid.innerHTML = "";
    empty.hidden = false;
  }

  renderAuxBlocks();
  bindCardEvents(grid);
  bindCardEvents($("continueGrid"));
  bindCardEvents($("historyGrid"));
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
  }else if(location.protocol === "file:"){
    state.bootStatus = "Ouverture locale detectee. Le navigateur peut bloquer l'acces automatique aux fichiers via file://. Sur GitHub ou un hebergement web, les 3 flux se chargeront a l'ouverture.";
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
    $("searchInput").value = "";
    render();
  });
});

$("categorySelect").addEventListener("change", e => {
  state.filters.category = e.target.value;
  render();
});

$("searchInput").addEventListener("input", e => {
  state.filters.search = e.target.value;
  render();
});

$("qualitySelect").addEventListener("change", e => {
  state.filters.quality = e.target.value;
  render();
});

$("sortSelect").addEventListener("change", e => {
  state.filters.sort = e.target.value;
  render();
});

$("chipAll").dataset.mode = "all";
$("chipFavorites").dataset.mode = "favorites";
$("chipContinue").dataset.mode = "continue";
$("chipHistory").dataset.mode = "history";
document.querySelectorAll(".chip").forEach(chip => {
  chip.addEventListener("click", () => setMode(chip.dataset.mode));
});

boot();
