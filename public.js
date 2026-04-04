const $ = id => document.getElementById(id);

const state = {
  currentType: "live",
  activeCat: "Tous",
  data: { live: [], vod: [], series: [] },
  sourceUsed: { live: "", vod: "", series: "" }
};

const uiMeta = {
  live:{ title:"Live", pageSub:"Chaînes en direct", hero:"Télévision en direct" },
  vod:{ title:"VOD", pageSub:"Films à la demande", hero:"Catalogue VOD" },
  series:{ title:"Séries", pageSub:"Séries, saisons et épisodes", hero:"Bibliothèque de séries" }
};

function sanitize(s){ return (s || "").toString().trim(); }
function isUrl(u){ try { new URL(u); return true; } catch { return false; } }
function safeLower(s){ return sanitize(s).toLowerCase(); }

function normalizeItems(items, type){
  return (items || []).filter(x => x && typeof x === "object").map(e => ({
    title: sanitize(e.title || e.name) || "Sans titre",
    category: sanitize(e.category_name || e.category) || "Sans catégorie",
    url: sanitize(e.stream_url || e.url),
    image: sanitize(e.stream_icon || e.cover || e.movie_image || e.image || ""),
    plot: sanitize(e.plot || e.overview || e.description || (e.info && (e.info.plot || e.info.overview || e.info.description || e.info.synopsis)) || ""),
    meta: sanitize(e.meta || ""),
    type,
    seasons: Array.isArray(e.seasons) ? e.seasons : [],
    episodes: e.episodes && typeof e.episodes === "object" ? e.episodes : {}
  }));
}

function parseM3U(text, type){
  const lines = text.split(/\r?\n/);
  const items = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const group = (line.match(/group-title="([^"]+)"/i) || [,"Sans catégorie"])[1];
      const logo = (line.match(/tvg-logo="([^"]+)"/i) || [,""])[1];
      const title = line.includes(",") ? line.split(",").slice(1).join(",").trim() : "Sans titre";
      cur = { title, category: group, image: logo, url: "", plot:"", meta:"", type, seasons:[], episodes:{} };
    } else if (!line.startsWith("#") && cur) {
      cur.url = line;
      if (isUrl(cur.url)) items.push(cur);
      cur = null;
    }
  }
  return items;
}

function strictFilter(items, type){
  const arr = (items || []).slice();
  if (type === "live") return arr.filter(x => sanitize(x.url).includes("/live/"));
  if (type === "vod") return arr.filter(x => sanitize(x.url).includes("/movie/"));
  if (type === "series") return arr.filter(x => {
    const u = sanitize(x.url);
    return u.includes("get_series_info") || u.includes("/series/");
  });
  return arr;
}

async function loadType(type){
  const targets = [
    `${type}_catalog.json`,
    `${type}.json`,
    `${type}.m3u`
  ];
  for (const file of targets) {
    try {
      const res = await fetch(`./${file}?v=${Date.now()}`, { cache:"no-store" });
      if (!res.ok) continue;
      const text = await res.text();
      let items = [];
      if (file.endsWith(".m3u")) items = parseM3U(text, type);
      else {
        const data = JSON.parse(text);
        items = Array.isArray(data) ? normalizeItems(data, type)
          : Array.isArray(data.items) ? normalizeItems(data.items, type)
          : [];
      }
      items = strictFilter(items, type);
      if (items.length) {
        state.sourceUsed[type] = file;
        return items;
      }
    } catch(e) {}
  }
  state.sourceUsed[type] = "aucune";
  return [];
}

function uniqCats(items){
  const map = new Map();
  items.forEach(e => {
    const c = sanitize(e.category) || "Sans catégorie";
    if (!map.has(c.toLowerCase())) map.set(c.toLowerCase(), c);
  });
  return Array.from(map.values()).sort((a,b)=>a.localeCompare(b));
}

function currentItems(){
  let arr = (state.data[state.currentType] || []).slice();
  if (state.activeCat !== "Tous") arr = arr.filter(x => safeLower(x.category) === state.activeCat.toLowerCase());
  const q = safeLower($("search").value);
  if (q) arr = arr.filter(x => safeLower(x.title).includes(q) || safeLower(x.category).includes(q));
  if ($("sort").value === "title") arr.sort((a,b)=>sanitize(a.title).localeCompare(sanitize(b.title)));
  else arr.sort((a,b)=>sanitize(a.category).localeCompare(sanitize(b.category)) || sanitize(a.title).localeCompare(sanitize(b.title)));
  return arr;
}

function encodeItem(it){ return encodeURIComponent(JSON.stringify(it)); }

function openItem(it){
  if (!it) return;
  if (it.type === "live" || it.type === "vod") {
    location.href = it.url;
    return;
  }
  location.href = `./details.html?item=${encodeItem(it)}`;
}

function renderTypes(){
  document.querySelectorAll(".navBtn[data-type]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.type === state.currentType);
    btn.onclick = () => {
      state.currentType = btn.dataset.type;
      state.activeCat = "Tous";
      renderAll();
    };
  });
  const wrap = $("typeChips");
  wrap.innerHTML = "";
  [["live","Live"],["vod","VOD"],["series","Séries"]].forEach(([type,label]) => {
    const count = state.data[type].length;
    if (!count) return;
    const b = document.createElement("button");
    b.className = "chip" + (type === state.currentType ? " active" : "");
    b.textContent = `${label} (${count})`;
    b.onclick = () => { state.currentType = type; state.activeCat = "Tous"; renderAll(); };
    wrap.appendChild(b);
  });
}

function renderCategories(){
  const wrap = $("categories");
  wrap.innerHTML = "";
  ["Tous", ...uniqCats(state.data[state.currentType] || [])].forEach(cat => {
    const b = document.createElement("button");
    b.className = "cat" + (cat === state.activeCat ? " active" : "");
    b.textContent = cat;
    b.onclick = () => { state.activeCat = cat; renderAll(); };
    wrap.appendChild(b);
  });
}

function renderMeta(){
  $("statLive").textContent = state.data.live.length;
  $("statVod").textContent = state.data.vod.length;
  $("statSeries").textContent = state.data.series.length;
  const meta = uiMeta[state.currentType];
  $("pageTitle").textContent = meta.title;
  $("pageSub").textContent = meta.pageSub;
  $("heroTitle").textContent = meta.hero;
  $("heroText").textContent = state.currentType === "series"
    ? "Cet onglet lit uniquement series.json / series.m3u / series_catalog.json."
    : state.currentType === "vod"
      ? "Cet onglet lit uniquement vod.json / vod.m3u / vod_catalog.json."
      : "Cet onglet lit uniquement live.json / live.m3u / live_catalog.json.";
  $("sourceNotice").textContent = `Source utilisée pour ${meta.title.toLowerCase()} : ${state.sourceUsed[state.currentType] || "aucune"}`;
}

function renderGrid(){
  const grid = $("grid");
  grid.innerHTML = "";
  const items = currentItems();
  $("count").textContent = items.length;
  $("status").textContent = items.length ? "" : "Aucune donnée trouvée.";
  items.forEach(it => {
    const d = document.createElement("div");
    d.className = "tile";
    d.onclick = () => openItem(it);

    const img = document.createElement("img");
    img.className = "thumb";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = sanitize(it.image) || "";
    img.alt = sanitize(it.title) || "image";
    img.onerror = () => img.removeAttribute("src");

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = sanitize(it.title) || "Sans titre";
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = sanitize(it.category) || "";
    meta.appendChild(name);
    meta.appendChild(sub);
    d.appendChild(img);
    d.appendChild(meta);
    grid.appendChild(d);
  });
}

function renderAll(){
  renderTypes();
  renderCategories();
  renderMeta();
  renderGrid();
}

async function boot(){
  $("status").textContent = "Chargement…";
  state.data.live = await loadType("live");
  state.data.vod = await loadType("vod");
  state.data.series = await loadType("series");
  const preferred = ["live","vod","series"].find(k => state.data[k].length) || "live";
  if (!state.data[state.currentType].length) state.currentType = preferred;
  state.activeCat = "Tous";
  const total = Object.values(state.data).reduce((n, arr) => n + arr.length, 0);
  $("status").textContent = total ? "" : "Ajoute les fichiers live / vod / series à la racine.";
  renderAll();
}

$("search").addEventListener("input", renderAll);
$("sort").addEventListener("change", renderAll);
boot();
