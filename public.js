const $ = id => document.getElementById(id);

const state = {
  currentType: "vod",
  activeCat: "Tous",
  entriesByType: { series: [], vod: [] }
};

function sanitize(s){ return (s || "").toString().trim(); }
function isUrl(u){ try { new URL(u); return true; } catch { return false; } }
function safeLower(s){ return sanitize(s).toLowerCase(); }

function normalizeCatalogItems(items, forcedType){
  return (items || []).filter(x => x && typeof x === "object").map(e => ({
    title: sanitize(e.title || e.name) || "Sans titre",
    category: sanitize(e.category_name || e.category) || "Sans catégorie",
    url: sanitize(e.stream_url || e.url),
    image: sanitize(e.stream_icon || e.cover || e.movie_image || e.image || ""),
    plot: sanitize(e.plot || e.overview || e.description || (e.info && (e.info.plot || e.info.overview || e.info.description)) || ""),
    meta: sanitize(e.meta || ""),
    type: forcedType,
    seasons: Array.isArray(e.seasons) ? e.seasons : [],
    episodes: e.episodes && typeof e.episodes === "object" ? e.episodes : {}
  })).filter(e => e.url || forcedType === "series");
}

function parseM3U(text, forcedType){
  const lines = text.split(/\r?\n/);
  const items = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const group = (line.match(/group-title="([^"]+)"/i) || [,"Sans catégorie"])[1];
      const logo = (line.match(/tvg-logo="([^"]+)"/i) || [,""])[1];
      const title = line.includes(",") ? line.split(",").slice(1).join(",").trim() : "Sans titre";
      current = { title, category: group, image: logo, url: "", plot: "", meta: "", type: forcedType, seasons: [], episodes: {} };
    } else if (!line.startsWith("#") && current) {
      current.url = line;
      if (isUrl(current.url)) items.push(current);
      current = null;
    }
  }
  return items;
}

async function loadCatalog(type){
  const catalogTargets = [`${type}_catalog.json`, `${type}.json`, `${type}.m3u`];
  for (const file of catalogTargets) {
    try{
      const res = await fetch(`./${file}?v=${Date.now()}`, { cache:"no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      if (file.endsWith(".m3u")) {
        const items = parseM3U(text, type);
        if (items.length) return items;
      } else {
        const data = JSON.parse(text);
        const items = Array.isArray(data) ? normalizeCatalogItems(data, type)
          : Array.isArray(data.items) ? normalizeCatalogItems(data.items, type)
          : [];
        if (items.length) return items;
      }
    }catch(e){}
  }
  return [];
}

function uniqCats(items){
  const map = new Map();
  for (const e of items) {
    const cat = sanitize(e.category) || "Sans catégorie";
    if (!map.has(cat.toLowerCase())) map.set(cat.toLowerCase(), cat);
  }
  return Array.from(map.values()).sort((a,b) => a.localeCompare(b));
}

function getVisibleEntries(){
  const q = safeLower($("filter").value);
  let arr = (state.entriesByType[state.currentType] || []).slice();
  if (state.activeCat !== "Tous") arr = arr.filter(e => safeLower(e.category) === state.activeCat.toLowerCase());
  if (q) arr = arr.filter(e => safeLower(e.title).includes(q) || safeLower(e.category).includes(q));
  if ($("sort").value === "title") arr.sort((a,b)=>sanitize(a.title).localeCompare(sanitize(b.title)));
  else arr.sort((a,b)=>sanitize(a.category).localeCompare(sanitize(b.category)) || sanitize(a.title).localeCompare(sanitize(b.title)));
  return arr;
}

function renderTypeTabs(){
  const wrap = $("typeTabs");
  wrap.innerHTML = "";
  [["series","Séries"],["vod","VOD"]].forEach(([key,label]) => {
    const count = (state.entriesByType[key] || []).length;
    if (!count) return;
    const b = document.createElement("button");
    b.className = "tab" + (key === state.currentType ? " active" : "");
    b.textContent = `${label} (${count})`;
    b.onclick = () => { state.currentType = key; state.activeCat = "Tous"; renderAll(); };
    wrap.appendChild(b);
  });
}

function renderCategoryTabs(){
  const wrap = $("tabs");
  wrap.innerHTML = "";
  const items = state.entriesByType[state.currentType] || [];
  ["Tous", ...uniqCats(items)].forEach(cat => {
    const b = document.createElement("button");
    b.className = "tab" + (cat === state.activeCat ? " active" : "");
    b.textContent = cat;
    b.onclick = () => { state.activeCat = cat; renderAll(); };
    wrap.appendChild(b);
  });
}

function encodeItem(it){
  return encodeURIComponent(JSON.stringify(it));
}

function openItem(it){
  location.href = `details.html?item=${encodeItem(it)}`;
}

function renderGallery(){
  const gallery = $("gallery");
  gallery.innerHTML = "";
  const arr = getVisibleEntries();
  $("count").textContent = String(arr.length);
  $("status").textContent = arr.length ? "" : "Aucune donnée trouvée.";
  for (const it of arr) {
    const d = document.createElement("div");
    d.className = "poster";
    d.onclick = () => openItem(it);

    const img = document.createElement("img");
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = sanitize(it.image) || "";
    img.alt = sanitize(it.title) || "poster";
    img.onerror = () => { img.removeAttribute("src"); };

    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = sanitize(it.title) || "Sans titre";

    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = sanitize(it.category) || "";

    d.appendChild(img);
    d.appendChild(cap);
    d.appendChild(sub);
    gallery.appendChild(d);
  }
}

function renderAll(){
  renderTypeTabs();
  renderCategoryTabs();
  renderGallery();
}

async function init(){
  $("status").textContent = "Chargement…";
  state.entriesByType.series = await loadCatalog("series");
  state.entriesByType.vod = await loadCatalog("vod");
  const preferred = ["vod","series"].find(k => state.entriesByType[k].length) || "vod";
  if (!state.entriesByType[state.currentType].length) state.currentType = preferred;
  state.activeCat = "Tous";
  const total = Object.values(state.entriesByType).reduce((n, arr) => n + arr.length, 0);
  $("status").textContent = total ? "" : "Ajoute vod_catalog.json / series_catalog.json ou les fichiers .json / .m3u.";
  renderAll();
}

$("filter").addEventListener("input", renderAll);
$("sort").addEventListener("change", renderAll);
init();
