const $ = id => document.getElementById(id);

const state = {
  currentType: "vod",
  activeCat: "Tous",
  entriesByType: { live: [], series: [], vod: [] }
};

function sanitize(s){ return (s || "").toString().trim(); }
function isUrl(u){ try { new URL(u); return true; } catch { return false; } }
function safeLower(s){ return sanitize(s).toLowerCase(); }

function extractPlot(e){
  if (!e || typeof e !== "object") return "";
  return sanitize(
    e.plot ||
    e.overview ||
    (e.info && typeof e.info === "object" ? (e.info.plot || e.info.overview) : "") ||
    (e.raw && e.raw.info && typeof e.raw.info === "object" ? (e.raw.info.plot || e.raw.info.overview) : "") ||
    ""
  );
}

function extractMeta(e){
  const bits = [];
  const year = sanitize(e.year || (e.info && e.info.releaseDate) || (e.raw && e.raw.info && e.raw.info.releasedate) || "");
  const rating = sanitize(e.rating || (e.info && e.info.rating) || (e.raw && e.raw.rating) || "");
  if (year) bits.push(year);
  if (rating) bits.push(`Note ${rating}`);
  return bits.join(" • ");
}

function normalizeJsonData(obj, forcedType){
  let items = [];
  if (Array.isArray(obj)) items = obj;
  else if (obj && Array.isArray(obj.items)) items = obj.items;
  else if (obj && Array.isArray(obj.entries)) items = obj.entries;

  return items
    .filter(e => e && typeof e === "object")
    .map(e => ({
      title: sanitize(e.title || e.name) || "Sans titre",
      category: sanitize(e.category_name || e.category) || "Sans catégorie",
      url: sanitize(e.stream_url || e.url),
      image: sanitize(e.stream_icon || e.cover || e.movie_image || e.image || (e.raw && (e.raw.stream_icon || e.raw.cover || e.raw.movie_image))),
      added_at: sanitize(e.added || e.added_at || ""),
      plot: extractPlot(e),
      meta: extractMeta(e),
      type: forcedType
    }))
    .filter(e => isUrl(e.url));
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
      const logo = (line.match(/tvg-logo="([^"]+)"/i) || line.match(/logo="([^"]+)"/i) || [,""])[1];
      const title = line.includes(",") ? line.split(",").slice(1).join(",").trim() : "Sans titre";
      current = { title, category: group, image: logo, url: "", added_at: "", plot: "", meta: "", type: forcedType };
    } else if (!line.startsWith("#") && current) {
      current.url = line;
      if (isUrl(current.url)) items.push(current);
      current = null;
    }
  }
  return items;
}

async function tryLoadType(type){
  const targets = [`${type}.json`, `${type}.m3u`];
  for (const file of targets) {
    try {
      const res = await fetch(`./${file}?v=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      if (file.endsWith(".json")) {
        const data = JSON.parse(text);
        const items = normalizeJsonData(data, type);
        if (items.length) return items;
      } else {
        const items = parseM3U(text, type);
        if (items.length) return items;
      }
    } catch (e) {}
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

  if (state.activeCat !== "Tous") {
    arr = arr.filter(e => safeLower(e.category) === state.activeCat.toLowerCase());
  }
  if (q) {
    arr = arr.filter(e => safeLower(e.title).includes(q) || safeLower(e.category).includes(q));
  }

  const sort = $("sort").value;
  if (sort === "title") arr.sort((a,b)=>sanitize(a.title).localeCompare(sanitize(b.title)));
  else if (sort === "added_desc") arr.sort((a,b)=>sanitize(b.added_at).localeCompare(sanitize(a.added_at)));
  else arr.sort((a,b)=>sanitize(a.category).localeCompare(sanitize(b.category)) || sanitize(a.title).localeCompare(sanitize(b.title)));
  return arr;
}

function renderTypeTabs(){
  const wrap = $("typeTabs");
  wrap.innerHTML = "";
  [["live","Live"],["series","Séries"],["vod","VOD"]].forEach(([key,label]) => {
    const count = (state.entriesByType[key] || []).length;
    if (!count) return;
    const b = document.createElement("button");
    b.className = "tab" + (key === state.currentType ? " active" : "");
    b.textContent = `${label} (${count})`;
    b.onclick = () => {
      state.currentType = key;
      state.activeCat = "Tous";
      renderAll();
    };
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
  if (!it || !it.url) return;
  if (it.type === "live") {
    location.href = it.url;
    return;
  }
  location.href = `details.html?item=${encodeItem(it)}`;
}

function renderGallery(){
  const gallery = $("gallery");
  gallery.innerHTML = "";
  const arr = getVisibleEntries();
  $("count").textContent = String(arr.length);

  if (!arr.length) {
    $("status").textContent = "Aucune donnée trouvée pour cet onglet.";
    return;
  }
  $("status").textContent = "";

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

async function reloadData(){
  $("status").textContent = "Chargement…";
  state.entriesByType.live = await tryLoadType("live");
  state.entriesByType.series = await tryLoadType("series");
  state.entriesByType.vod = await tryLoadType("vod");

  const preferred = ["vod", "series", "live"].find(k => state.entriesByType[k].length) || "vod";
  if (!state.entriesByType[state.currentType].length) state.currentType = preferred;
  state.activeCat = "Tous";

  const total = Object.values(state.entriesByType).reduce((n, arr) => n + arr.length, 0);
  $("status").textContent = total ? "" : "Ajoute tes fichiers live / series / vod à la racine du site.";
  renderAll();
}

$("filter").addEventListener("input", renderAll);
$("sort").addEventListener("change", renderAll);
reloadData();
