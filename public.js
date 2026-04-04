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
    window.open(it.url, "_blank", "noopener");
    return;
  }
  const qs = new URLSearchParams({
    u: it.url,
    t: it.title || "",
    p: it.image || ""
  });
  location.href = `player.html?${qs.toString()}`;
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
