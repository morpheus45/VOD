/* global window, document, navigator */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  });
}

let deferredInstallPrompt = null;
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function showInstallHelp() {
  const msg =
    "Installation PWA indisponible sur ce navigateur/appareil.\n\n" +
    "Android Chrome : menu ⋮ → Installer l'application / Ajouter à l'écran d'accueil.";
  alert(msg);
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById("installBtn");
  if (btn) btn.style.display = "none";
});
window.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("installBtn");
  if (!btn) return;
  if (isStandalone()) {
    btn.style.display = "none";
    return;
  }
  btn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      showInstallHelp();
      return;
    }
    deferredInstallPrompt.prompt();
    try { await deferredInstallPrompt.userChoice; } finally { deferredInstallPrompt = null; }
  });
});

const $ = id => document.getElementById(id);
const state = {
  currentType: "vod",
  activeCat: "Tous",
  entriesByType: {
    live: [],
    series: [],
    vod: []
  }
};

function sanitize(s){ return (s||"").toString().trim(); }
function isUrl(u){ try{ new URL(u); return true; }catch{return false;} }

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
      image: sanitize(e.stream_icon || e.cover || e.image),
      added_at: sanitize(e.added || e.added_at || ""),
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
      current = { title, category: group, image: logo, url: "", added_at: "", type: forcedType };
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
  const set = new Map();
  for (const e of items) {
    const c = sanitize(e.category) || "Sans catégorie";
    if (!set.has(c.toLowerCase())) set.set(c.toLowerCase(), c);
  }
  return Array.from(set.values()).sort((a,b)=>a.localeCompare(b));
}

function getVisibleEntries(){
  const q = sanitize($("filter").value).toLowerCase();
  let arr = (state.entriesByType[state.currentType] || []).slice();
  if (state.activeCat !== "Tous") {
    arr = arr.filter(e => sanitize(e.category).toLowerCase() === state.activeCat.toLowerCase());
  }
  if (q) {
    arr = arr.filter(e => sanitize(e.title).toLowerCase().includes(q) || sanitize(e.category).toLowerCase().includes(q));
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
  const defs = [
    ["live","Live"],
    ["series","Séries"],
    ["vod","VOD"]
  ];
  defs.forEach(([key,label]) => {
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
  const all = ["Tous", ...uniqCats(items)];
  all.forEach(c => {
    const b = document.createElement("button");
    b.className = "tab" + (c === state.activeCat ? " active" : "");
    b.textContent = c;
    b.onclick = () => { state.activeCat = c; renderAll(); };
    wrap.appendChild(b);
  });
}

function openItem(it){
  if (!it || !it.url) return;

  if (state.currentType === "series") {
    openSeriesItem(it);
    return;
  }

  // Live et VOD : ouverture directe systématique
  window.open(it.url, "_blank", "noopener");
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
    const img = document.createElement("img");
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = sanitize(it.image) || "";
    img.alt = sanitize(it.title) || "poster";
    img.onerror = ()=>{ img.removeAttribute("src"); };
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = sanitize(it.title) || "Sans titre";
    d.appendChild(img);
    d.appendChild(cap);
    d.onclick = ()=>openItem(it);
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
  if (!total) $("status").textContent = "Ajoute tes fichiers live / series / vod à la racine du site.";
  else $("status").textContent = "";
  renderAll();
}

$("filter").addEventListener("input", renderAll);
$("sort").addEventListener("change", renderAll);
reloadData();

// header auto-hide
(function(){
  const header = document.querySelector('.header');
  if(!header) return;
  let lastY = window.scrollY || 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY || 0;
    const goingDown = y > lastY + 6;
    const goingUp = y < lastY - 6;
    if (y > 80 && goingDown) header.classList.add('is-hidden');
    if (goingUp) header.classList.remove('is-hidden');
    if (y < 20) header.classList.remove('is-hidden');
    lastY = y;
  }, { passive:true });
})();



const seriesState = { raw: null, item: null, activeSeason: null };

function sanitizeSeriesUrl(s){
  return (s || "").toString().replace(/\\\//g, "/").trim();
}

function parseSeriesApiUrl(apiUrl){
  try{
    const u = new URL(apiUrl);
    return {
      base: u.origin,
      username: u.searchParams.get("username") || "",
      password: u.searchParams.get("password") || ""
    };
  }catch(e){
    return null;
  }
}

function buildEpisodeUrl(seriesApiUrl, episode){
  const info = parseSeriesApiUrl(seriesApiUrl);
  if (!info || !info.base || !info.username || !info.password) return "";
  const episodeId = episode && (episode.id || episode.episode_id || episode.stream_id);
  const ext = ((episode && (episode.container_extension || episode.extension)) || "mp4").toString();
  if (!episodeId) return "";
  return `${info.base}/series/${encodeURIComponent(info.username)}/${encodeURIComponent(info.password)}/${encodeURIComponent(episodeId)}.${ext}`;
}

function openSeriesModal(){
  const o = $("seriesOverlay");
  if (!o) return;
  o.classList.add("open");
  o.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}
function closeSeriesModal(){
  const o = $("seriesOverlay");
  if (!o) return;
  o.classList.remove("open");
  o.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "seriesCloseBtn") closeSeriesModal();
  if (e.target && e.target.id === "seriesOverlay") closeSeriesModal();
});

async function openSeriesItem(it){
  seriesState.item = it;
  seriesState.raw = null;
  seriesState.activeSeason = null;

  $("seriesModalTitle").textContent = it.title || "Série";
  $("seriesModalMeta").textContent = it.category || "";
  $("seriesModalStatus").textContent = "Chargement des saisons et épisodes…";
  $("seasonTabs").innerHTML = "";
  $("episodeGrid").innerHTML = "";
  openSeriesModal();

  try{
    const res = await fetch(it.url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    seriesState.raw = data || {};

    const seasons = Array.isArray(data.seasons) ? data.seasons : [];
    const episodesObj = data.episodes && typeof data.episodes === "object" ? data.episodes : {};
    let seasonKeys = seasons.map(s => String(s.season_number || s.season || s.id || "")).filter(Boolean);
    if (!seasonKeys.length) seasonKeys = Object.keys(episodesObj);

    if (!seasonKeys.length){
      $("seriesModalStatus").textContent = "Aucune saison ou épisode trouvé pour cette série.";
      return;
    }

    seriesState.activeSeason = seasonKeys[0];
    renderSeasonTabs(seasons, seasonKeys);
    renderEpisodesForSeason(seriesState.activeSeason);
    $("seriesModalStatus").textContent = "";
  }catch(err){
    $("seriesModalStatus").textContent = "Impossible de charger les détails de la série.";
  }
}

function renderSeasonTabs(seasons, seasonKeys){
  const wrap = $("seasonTabs");
  wrap.innerHTML = "";
  seasonKeys.forEach(key => {
    const s = seasons.find(x => String(x.season_number || x.season || x.id || "") === String(key));
    const label = (s && s.name) ? s.name : `Saison ${key}`;
    const b = document.createElement("button");
    b.className = "tab seasonTab" + (String(key) === String(seriesState.activeSeason) ? " active" : "");
    b.textContent = label;
    b.onclick = () => {
      seriesState.activeSeason = String(key);
      renderSeasonTabs(seasons, seasonKeys);
      renderEpisodesForSeason(String(key));
    };
    wrap.appendChild(b);
  });
}

function renderEpisodesForSeason(seasonKey){
  const grid = $("episodeGrid");
  grid.innerHTML = "";
  const data = seriesState.raw || {};
  const eps = (data.episodes && data.episodes[String(seasonKey)]) ? data.episodes[String(seasonKey)] : [];

  if (!eps.length){
    $("seriesModalStatus").textContent = "Aucun épisode trouvé dans cette saison.";
    return;
  }
  $("seriesModalStatus").textContent = "";

  eps.forEach(ep => {
    const title = (ep.title || ep.name || `Episode ${ep.episode_num || ""}`).toString();
    const poster = sanitizeSeriesUrl(ep.movie_image || ep.cover_big || ep.image || seriesState.item?.image || "");
    const plot = (ep.info && ep.info.plot ? ep.info.plot : ep.plot || "").toString();
    const runtime = ((ep.info && ep.info.duration) ? ep.info.duration : ep.duration || "").toString();
    const epNum = (ep.episode_num || ep.ep_num || "").toString();
    const url = buildEpisodeUrl(seriesState.item?.url || "", ep);

    const card = document.createElement("div");
    card.className = "epCard";

    const img = document.createElement("img");
    img.className = "epPoster";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = poster || "";
    img.alt = title;
    img.onerror = () => { img.removeAttribute("src"); };

    const body = document.createElement("div");
    body.className = "epBody";

    const ttl = document.createElement("div");
    ttl.className = "title";
    ttl.style.minHeight = "unset";
    ttl.textContent = epNum ? `E${epNum} — ${title}` : title;

    const meta = document.createElement("div");
    meta.className = "epMeta";
    meta.textContent = runtime || "";

    const desc = document.createElement("div");
    desc.className = "epMeta";
    desc.textContent = plot || "";

    const actions = document.createElement("div");
    actions.className = "epActions";

    const playBtn = document.createElement("button");
    playBtn.className = "btn btn-primary";
    playBtn.textContent = "Ouvrir";
    playBtn.onclick = () => {
      if (!url) return;
      window.open(url, "_blank", "noopener");
    };

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn";
    copyBtn.textContent = "Copier le lien";
    copyBtn.onclick = async () => {
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
      } catch(e) {}
    };

    actions.appendChild(playBtn);
    actions.appendChild(copyBtn);

    body.appendChild(ttl);
    if (runtime) body.appendChild(meta);
    if (plot) body.appendChild(desc);
    body.appendChild(actions);

    card.appendChild(img);
    card.appendChild(body);
    grid.appendChild(card);
  });
}
