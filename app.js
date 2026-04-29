// ╔══════════════════════════════════════════════════════════════╗
// ║  PIPSILY — app.js v5.0 — epDb statique                     ║
// ║  Films + Séries (Saisons / Épisodes) — M3U / JSON            ║
// ║  Xtream Codes API — Google TV / Android                      ║
// ╚══════════════════════════════════════════════════════════════╝

"use strict";

// ─────────────────────────────────────────────────────────────────
//  CONSTANTES
// ─────────────────────────────────────────────────────────────────

const STORE = {
  favorites : "pf_favorites_v4",
  history   : "pf_history_v4",
  progress  : "pf_progress_v4"
};

const PER_PAGE   = 48;
const SENTINEL_M = "300px";

// ─────────────────────────────────────────────────────────────────
//  ÉTAT GLOBAL
// ─────────────────────────────────────────────────────────────────

const S = {
  type      : "vod",
  vod       : [],
  series    : [],
  live      : [],
  srcVod    : "",
  srcSeries : "",
  srcLive   : "",
  cat       : "",
  search    : "",
  quality   : "",
  sort      : "title",
  shown     : { vod: 0, series: 0, live: 0 },
  loading   : false,
  // Panneau séries
  panel     : {
    open       : false,
    series     : null,
    seasonsMap : {},   // { "1": [ep,...], "2": [...] }
    seasonsMeta: [],   // [ { num, name, cover, count } ]
    selSeason  : null
  },
  // Cache en mémoire des épisodes chargés
  epCache   : {},
  // Base pré-générée (episodes_part*.json) — chargée en lazy au 1er clic série
  epDb      : {}
};

// ─────────────────────────────────────────────────────────────────
//  UTILITAIRES
// ─────────────────────────────────────────────────────────────────

const $  = id => document.getElementById(id);
const esc = s  => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

function storeGet(k, fb){
  try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; }
}
function storeSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function getFavs()  { return storeGet(STORE.favorites, []); }
function getHist()  { return storeGet(STORE.history, []); }
function getProg()  { return storeGet(STORE.progress, {}); }
function saveProg(key, pct){
  const p = getProg(); p[key] = { pct, ts: Date.now() };
  storeSet(STORE.progress, p);
}

function itemKey(item){
  return `${item.type || S.type}||${item.id || ""}||${item.title || ""}`;
}

// Upgrade HTTP → HTTPS si la page est servie en HTTPS (évite mixed content sur Android)
function secureUrl(url){
  if(!url) return url;
  if(location.protocol === "https:" && /^http:\/\//i.test(url))
    return url.replace(/^http:\/\//i, "https://");
  return url;
}
function isFav(item){ return getFavs().some(x => x.key === itemKey(item)); }

function toggleFav(item){
  const favs = getFavs();
  const key  = itemKey(item);
  const idx  = favs.findIndex(x => x.key === key);
  if(idx >= 0) favs.splice(idx, 1);
  else favs.unshift({ key, item, at: Date.now() });
  storeSet(STORE.favorites, favs.slice(0, 500));
  const fav = isFav(item);
  document.querySelectorAll(`.card[data-key="${CSS.escape(key)}"] .fav-btn`).forEach(b => {
    b.classList.toggle("is-fav", fav);
  });
}

function pushHist(item){
  const h = getHist().filter(x => x.key !== itemKey(item));
  h.unshift({ key: itemKey(item), item, at: Date.now() });
  storeSet(STORE.history, h.slice(0, 300));
}

// ─────────────────────────────────────────────────────────────────
//  NETTOYAGE TITRES
// ─────────────────────────────────────────────────────────────────

function cleanTitle(t){
  if(!t) return "";
  let s = String(t);
  s = s.replace(/^(FR|SRS|EN|VOD|SERIE)\s*[-|:]\s*/i, "");
  s = s.replace(/\s*(?:group-title|tvg-\w+)\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\.(mkv|mp4|ts|m3u8|avi|mov)$/i, "");
  s = s.replace(/\s*\(\d{4}\)\s*$/, "");
  return s.replace(/\s+/g, " ").trim();
}

// "NomSérie - S01E01 - Titre épisode"  →  "Titre épisode"
function cleanEpTitle(raw, seriesTitle){
  if(!raw) return "";
  let s = String(raw);
  // Supprimer préfixe "NomSérie - S01E01 - "
  const re = new RegExp("^" + seriesTitle.replace(/[.*+?^${}()|[\]\\]/g,"\\$&") + "\\s*[-–]\\s*S\\d+E\\d+\\s*[-–]\\s*", "i");
  s = s.replace(re, "");
  // Supprimer juste "S01E01 - " en tête
  s = s.replace(/^S\d+E\d+\s*[-–]\s*/i, "");
  s = cleanTitle(s);
  return s || "";
}

function inferQuality(src){
  const t = String(src || "").toLowerCase();
  if(/\b(4k|uhd|2160p?)\b/.test(t)) return "4K";
  if(/\b(fhd|full[\s-]?hd|1080p?|hd|720p?)\b/.test(t)) return "HD";
  if(/\b(sd|480p?|360p?)\b/.test(t)) return "SD";
  return "";
}

// ─────────────────────────────────────────────────────────────────
//  PARSING M3U
// ─────────────────────────────────────────────────────────────────

function parseM3U(text, type){
  const lines = text.split(/\r?\n/);
  const out   = [];
  let cur     = null;

  for(const raw of lines){
    const line = raw.trim();
    if(!line) continue;

    if(line.startsWith("#EXTINF:")){
      const group = (line.match(/group-title="([^"]+)"/i) || [,"Autre"])[1];
      const logo  = (line.match(/tvg-logo="([^"]+)"/i)    || [,""])[1];
      const title = line.includes(",") ? line.split(",").slice(1).join(",").trim() : "Sans titre";
      cur = { title: cleanTitle(title), category_name: cleanTitle(group),
              stream_icon: logo, quality: inferQuality(`${title} ${group}`) };

    } else if(!line.startsWith("#") && cur){
      out.push({
        id            : out.length,
        title         : cur.title,
        category_name : cur.category_name,
        stream_icon   : cur.stream_icon,
        stream_url    : line,
        url           : line,
        plot          : "",
        type,
        quality       : cur.quality,
        _xtream       : type === "series" && line.includes("get_series_info"),
        episodes      : {},
        seasons       : []
      });
      cur = null;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
//  NORMALISATION JSON
// ─────────────────────────────────────────────────────────────────

function normalizeItems(arr, type){
  return (Array.isArray(arr) ? arr : []).map((x, i) => ({
    id            : x.id || x.stream_id || x.series_id || String(i),
    title         : cleanTitle(x.title || x.name || "Sans titre"),
    category_id   : x.category_id || "",
    category_name : cleanTitle(x.category_name || x.category || "Autre"),
    stream_icon   : x.stream_icon || x.image || x.cover || x.poster || "",
    stream_url    : x.url || x.stream_url || "",
    url           : x.url || x.stream_url || "",
    plot          : x.plot || x.description || x.overview || "",
    type,
    quality       : inferQuality([x.title, x.name, x.category_name, x.plot].join(" ")),
    added         : x.added || 0,
    _xtream       : type === "series" && !!(x.url || x.stream_url || "").includes("get_series_info"),
    episodes      : {},
    seasons       : []
  }));
}

function extractArr(raw){
  if(Array.isArray(raw)) return raw;
  if(!raw || typeof raw !== "object") return [];
  for(const k of ["items","streams","channels","movies","series","vod"]){
    if(Array.isArray(raw[k])) return raw[k];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────
//  FETCH HELPERS
// ─────────────────────────────────────────────────────────────────

async function fetchJson(url){
  try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; }
}
async function fetchText(url){
  try { const r = await fetch(url); return r.ok ? r.text() : null; } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────
//  BASE ÉPISODES PRÉ-GÉNÉRÉE (episodes_part*.json)
// ─────────────────────────────────────────────────────────────────

// Map series_id → numéro de chunk (téléchargé une seule fois)
let _epMap = null;         // { "51596": 3, "18": 1, ... }
let _epMapPromise = null;
// Cache des chunks déjà téléchargés
const _loadedChunks = {};  // { 1: Promise, 3: Promise, ... }

async function getEpMap(){
  if(_epMap) return _epMap;
  if(_epMapPromise) return _epMapPromise;
  _epMapPromise = fetchJson("episodes_map.json").then(m => {
    _epMap = m || {};
    console.log(`[PIPSILY] epMap : ${Object.keys(_epMap).length} séries indexées`);
    return _epMap;
  });
  return _epMapPromise;
}

async function ensureEpDb(seriesId){
  const map = await getEpMap();
  const chunkNum = seriesId ? map[String(seriesId)] : null;
  if(!chunkNum) return false; // série absente de l'index

  if(!_loadedChunks[chunkNum]){
    _loadedChunks[chunkNum] = fetchJson(`episodes_part${chunkNum}.json`).then(chunk => {
      if(chunk && typeof chunk === "object") Object.assign(S.epDb, chunk);
      console.log(`[PIPSILY] chunk ${chunkNum} chargé (${Object.keys(chunk||{}).length} séries)`);
    });
  }
  await _loadedChunks[chunkNum];
  return true;
}

// ─────────────────────────────────────────────────────────────────
//  XTREAM CODES — CHARGEMENT ÉPISODES
// ─────────────────────────────────────────────────────────────────
//
//  URL de la série : http://host/player_api.php?username=X&password=Y&action=get_series_info&series_id=Z
//
//  Réponse API :
//  {
//    info    : { plot, cover, ... }
//    seasons : [ { season_number, name, cover, episode_count } ]
//    episodes: {
//      "1" : [ { id, episode_num, title, url, container_extension, info:{plot,movie_image} } ]
//    }
//  }
//
//  URL d'un épisode :
//    - ep.url directement (si présente et valide)
//    - sinon : base/series/username/password/ep.id.ext

function parseXtreamCreds(apiUrl){
  try {
    const p = new URL(apiUrl);
    return {
      base     : p.origin,
      username : p.searchParams.get("username") || "",
      password : p.searchParams.get("password") || "",
    };
  } catch { return null; }
}

function buildEpUrl(apiUrl, ep){
  // URL directe dans l'épisode (source la plus fiable)
  if(ep.url && !ep.url.includes("player_api") && !ep.url.includes("get_series_info")){
    return secureUrl(ep.url);
  }
  // Reconstruction Xtream
  const x = parseXtreamCreds(apiUrl);
  if(x && x.username && x.password && ep.id && !String(ep.id).includes("-")){
    const ext = ep.container_extension || "mkv";
    return secureUrl(`${x.base}/series/${x.username}/${x.password}/${ep.id}.${ext}`);
  }
  return "";
}

async function loadEpisodes(series){
  const cacheKey = `s_${series.id}_${series.title}`;
  if(S.epCache[cacheKey]) return S.epCache[cacheKey];

  // ── 1. Base pré-générée (charge uniquement le chunk nécessaire) ──
  const sid = String(series.id || "");
  await ensureEpDb(sid); // télécharge 1 fichier ~4MB au lieu de 21MB
  if(sid && S.epDb[sid]){
    const db = S.epDb[sid];
    const seasonsMap = {};
    Object.entries(db.seasons || {}).forEach(([sk, epList]) => {
      seasonsMap[String(sk)] = epList.map(ep => ({
        id                 : ep.id,
        episode_num        : ep.episode_num,
        season             : ep.season,
        title              : cleanEpTitle(ep.title || "", series.title) || `Épisode ${ep.episode_num}`,
        url                : ep.url,        // URL HTTP goldenlink.live — intent Android
        stream_url         : ep.url,
        container_extension: ep.ext || "mkv",
        duration           : ep.duration || "",
        plot               : ep.plot || "",
        thumb              : ep.thumb || ""
      }));
    });
    const seasonsMeta = (db.seasonsMeta || []).map(s => ({
      num  : s.num,
      name : s.name || `Saison ${s.num}`,
      cover: s.cover || "",
      count: s.count || 0
    }));
    // Enrichir les métadonnées de la série
    if(db.meta){
      if(!series.plot        && db.meta.plot)  series.plot        = db.meta.plot;
      if(!series.stream_icon && db.meta.cover) series.stream_icon = db.meta.cover;
    }
    const result = { seasonsMap, seasonsMeta };
    S.epCache[cacheKey] = result;
    return result;
  }

  // ── 2. Fallback : API Xtream en direct ──
  const rawApiUrl = series.stream_url || series.url || "";
  if(!rawApiUrl) return { seasonsMap: {}, seasonsMeta: [] };

  // Toujours utiliser HTTP (goldenlink.live n'a pas HTTPS)
  const isNativeApk = typeof window.AndroidBridge !== "undefined";
  const apiUrl = rawApiUrl.replace(/^https?:\/\//i, "http://");

  // Timeout 12s + gestion CORS/réseau
  let data = null;

  // APK : AndroidBridge.fetchJson() depuis Java (pas de restriction mixed content)
  if(isNativeApk && typeof window.AndroidBridge?.fetchJson === "function"){
    try {
      const raw = window.AndroidBridge.fetchJson(apiUrl);
      if(raw) data = JSON.parse(raw);
    } catch {}
  }

  // Fallback navigateur fetch() (fonctionne si MIXED_CONTENT_ALWAYS_ALLOW)
  if(!data){
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 12000);
      const r = await fetch(apiUrl, { signal: controller.signal });
      clearTimeout(tid);
      data = r.ok ? await r.json() : null;
    } catch(e) { data = null; }
  }

  if(!data) return { seasonsMap: {}, seasonsMeta: [], directOnly: true };

  const seasonsMap = {};

  // ── Épisodes ──
  // La réponse Xtream a : data.episodes = { "1": [...], "2": [...] }
  const rawEps = data.episodes;
  if(rawEps && typeof rawEps === "object"){
    Object.entries(rawEps).forEach(([sk, epList]) => {
      if(!Array.isArray(epList)) return;
      const key = String(sk);
      seasonsMap[key] = epList
        .filter(ep => ep && (ep.id || ep.episode_num))
        .map(ep => {
          const url = buildEpUrl(apiUrl, ep);
          return {
            id                 : ep.id,
            episode_num        : Number(ep.episode_num) || 1,
            season             : Number(ep.season || sk),
            title              : cleanEpTitle(ep.title || ep.name || "", series.title) || `Épisode ${ep.episode_num}`,
            url,
            stream_url         : url,
            container_extension: ep.container_extension || "mkv",
            duration           : ep.info?.duration || "",
            plot               : ep.info?.plot || "",
            thumb              : ep.info?.movie_image || ""
          };
        })
        .sort((a, b) => a.episode_num - b.episode_num);
    });
  }

  // ── Métadonnées saisons ──
  let seasonsMeta = [];
  if(Array.isArray(data.seasons)){
    seasonsMeta = data.seasons
      .filter(s => s.season_number > 0)
      .sort((a, b) => a.season_number - b.season_number)
      .map(s => ({
        num   : s.season_number,
        name  : s.name || `Saison ${s.season_number}`,
        cover : s.cover_big || s.cover || "",
        count : s.episode_count || 0
      }));
  }

  // Enrichir les métadonnées de la série depuis l'API
  if(data.info){
    if(!series.plot)        series.plot         = data.info.plot || data.info.description || "";
    if(!series.stream_icon) series.stream_icon  = data.info.cover || data.info.movie_image || "";
  }

  const result = { seasonsMap, seasonsMeta };
  S.epCache[cacheKey] = result;
  return result;
}

// ─────────────────────────────────────────────────────────────────
//  PANNEAU VOD (film — synopsis + bouton lecture)
// ─────────────────────────────────────────────────────────────────

function getExt(url){
  if(!url) return "";
  return (url.split("?")[0].split(".").pop() || "").toLowerCase();
}

function openVodPanel(item){
  S.panel.open     = true;
  S.panel.series   = item;
  S.panel.isVod    = true;

  document.body.style.overflow = "hidden";
  const panel = $("seriesPanel");
  panel.hidden = false;

  const ext    = getExt(item.stream_url || item.url || "");
  const meta   = [item.category_name, item.quality, ext ? ext.toUpperCase() : ""].filter(Boolean).join(" · ");
  const cover  = item.stream_icon || "";
  const plot   = item.plot || "";

  panel.innerHTML = `
    <div class="sp-header">
      <div class="sp-hinfo">
        <div class="sp-kicker">🎬 Film</div>
        <h3 class="sp-title">${esc(item.title)}</h3>
        ${meta ? `<div class="sp-meta">${esc(meta)}</div>` : ""}
      </div>
      <button id="vodCloseBtn" class="sp-close" aria-label="Fermer">✕</button>
    </div>

    <div class="sp-body">
      <div class="sp-hero">
        ${cover
          ? `<img class="sp-cover" src="${esc(cover)}" alt="" loading="lazy" onerror="this.style.display='none'">`
          : `<div class="sp-cover sp-nocover">🎬</div>`}
        <div class="sp-hero-txt">
          <p class="sp-plot" id="vodPlot">${esc(plot || "Chargement du synopsis…")}</p>
        </div>
      </div>

      <div class="vod-actions">
        <button id="vodPlayBtn" class="vod-play-btn">
          <span class="vod-play-icon">▶</span>
          <span>Lire le film</span>
        </button>
        <button class="fav-btn-large ${isFav(item) ? "is-fav" : ""}" id="vodFavBtn" type="button">
          <span class="fav-heart">♥</span>
          <span id="vodFavLabel">${isFav(item) ? "Favori" : "Ajouter aux favoris"}</span>
        </button>
      </div>
    </div>`;

  // ── Bind events ──
  $("vodCloseBtn").addEventListener("click", closeVodPanel);
  panel.addEventListener("click", e => { if(e.target === panel) closeVodPanel(); }, { once: true });

  $("vodPlayBtn").addEventListener("click", () => {
    closeVodPanel();
    playItem(item);
  });

  $("vodFavBtn").addEventListener("click", () => {
    toggleFav(item);
    const fav = isFav(item);
    $("vodFavBtn").classList.toggle("is-fav", fav);
    const lbl = $("vodFavLabel");
    if(lbl) lbl.textContent = fav ? "Favori" : "Ajouter aux favoris";
  });

  // ── Lazy-load synopsis depuis l'API si absent ──
  if(!plot){
    fetchVodPlot(item).then(p => {
      const el = $("vodPlot");
      if(el) el.textContent = p || "Aucun synopsis disponible.";
      if(p) item.plot = p; // cache dans l'item pour ne pas re-fetcher
    });
  }
}

async function fetchVodPlot(item){
  const streamUrl = item.stream_url || item.url || "";
  if(!streamUrl) return null;
  try {
    const u     = new URL(streamUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    let base = u.origin, username = "", password = "";
    if(parts[0] === "movie" && parts.length >= 3){
      username = parts[1]; password = parts[2];
    } else {
      username = u.searchParams.get("username") || "";
      password = u.searchParams.get("password") || "";
    }
    if(!username || !password) return null;
    const vodId = item.id || item.stream_id || String(item.num || "");
    if(!vodId) return null;
    // Toujours HTTP (goldenlink.live n'a pas HTTPS)
    const apiUrl = `http://${new URL(base).hostname}/player_api.php?username=${username}&password=${password}&action=get_vod_info&vod_id=${vodId}`;

    let json = null;

    // APK : utiliser AndroidBridge.fetchJson() qui fait la requête depuis Java
    // (pas de restriction mixed-content côté Java)
    if(typeof window.AndroidBridge?.fetchJson === "function"){
      try {
        const raw = window.AndroidBridge.fetchJson(apiUrl);
        if(raw) json = JSON.parse(raw);
      } catch {}
    }

    // Fallback : fetch() navigateur (fonctionne si MIXED_CONTENT_ALWAYS_ALLOW ou HTTP page)
    if(!json){
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch(apiUrl, { signal: ctrl.signal });
        clearTimeout(tid);
        if(r.ok) json = await r.json();
      } catch { clearTimeout(tid); }
    }

    if(!json) return null;
    return json?.info?.plot || json?.info?.description || null;
  } catch { return null; }
}

function closeVodPanel(){
  S.panel.open  = false;
  S.panel.isVod = false;
  const panel = $("seriesPanel");
  panel.hidden = true;
  document.body.style.overflow = "";
}

// ─────────────────────────────────────────────────────────────────
//  PANNEAU SÉRIES
// ─────────────────────────────────────────────────────────────────

function openPanel(series){
  S.panel.open       = true;
  S.panel.series     = series;
  S.panel.seasonsMap = {};
  S.panel.seasonsMeta= [];
  S.panel.selSeason  = null;

  document.body.style.overflow = "hidden";

  const panel = $("seriesPanel");
  panel.hidden = false;
  panel.innerHTML = buildPanelLoading(series);
  bindClose();

  loadEpisodes(series).then(({ seasonsMap, seasonsMeta, directOnly }) => {
    S.panel.seasonsMap  = seasonsMap;
    S.panel.seasonsMeta = seasonsMeta;
    S.panel.directOnly  = directOnly || false;
    const keys = Object.keys(seasonsMap).sort((a,b) => Number(a)-Number(b));
    S.panel.selSeason = keys[0] || null;
    renderPanel();
  });
}

function closePanel(){
  S.panel.open = false;
  $("seriesPanel").hidden = true;
  document.body.style.overflow = "";
}

function bindClose(){
  $("seriesCloseBtn")?.addEventListener("click", closePanel);
}

function buildPanelLoading(s){
  const cover = s.stream_icon || "";
  return `
    <div class="sp-header">
      <div class="sp-hinfo">
        <div class="sp-kicker">Série</div>
        <h3 class="sp-title">${esc(s.title)}</h3>
      </div>
      <button id="seriesCloseBtn" class="sp-close">✕</button>
    </div>
    <div class="sp-body">
      <div class="sp-hero">
        ${cover
          ? `<img class="sp-cover" src="${esc(cover)}" alt="" loading="lazy">`
          : `<div class="sp-cover sp-nocover">🎬</div>`}
        <div class="sp-hero-txt">
          <p class="sp-plot">${esc(s.plot || "Chargement…")}</p>
          <div class="sp-loading"><span class="sp-spin"></span> Chargement des saisons…</div>
        </div>
      </div>
    </div>`;
}

function renderPanel(){
  const panel = $("seriesPanel");
  if(!panel || !S.panel.series) return;

  const s          = S.panel.series;
  const smap       = S.panel.seasonsMap;
  const smeta      = S.panel.seasonsMeta;
  const sel        = S.panel.selSeason;
  const keys       = Object.keys(smap).sort((a,b) => Number(a)-Number(b));
  const totalEps   = Object.values(smap).reduce((n,a) => n+a.length, 0);

  const metaLine = [
    s.category_name,
    keys.length  ? `${keys.length} saison${keys.length>1?"s":""}` : "",
    totalEps     ? `${totalEps} épisode${totalEps>1?"s":""}` : ""
  ].filter(Boolean).join(" · ");

  // ── Onglets saisons ──
  let tabsHtml = "";
  if(keys.length > 1){
    tabsHtml = `<div class="sp-tabs">` +
      keys.map(sk => {
        const m     = smeta.find(x => String(x.num)===sk);
        const label = m ? m.name : `Saison ${sk}`;
        const cnt   = smap[sk]?.length || 0;
        return `<button class="sp-tab${sk===sel?" sp-tab--active":""}"
                  data-season="${esc(sk)}" type="button">
                  ${esc(label)}
                  <span class="sp-tab-cnt">${cnt} ép.</span>
                </button>`;
      }).join("") +
    `</div>`;
  } else if(keys.length === 1){
    const m     = smeta.find(x => String(x.num)===keys[0]);
    const label = m ? m.name : `Saison ${keys[0]}`;
    tabsHtml = `<div class="sp-onesaison">${esc(label)}</div>`;
  }

  // ── Épisodes de la saison sélectionnée ──
  let epsHtml = "";

  if(!sel || keys.length === 0){
    // Pas d'épisodes chargés
    if(S.panel.directOnly){
      // Série non trouvée dans la base locale et API non joignable
      epsHtml = `
        <div class="sp-noep-block">
          <div style="font-size:36px;margin-bottom:12px">📭</div>
          <div style="font-weight:700;font-size:16px;margin-bottom:8px">Épisodes non disponibles</div>
          <div style="font-size:13px;color:#8ca8cc;line-height:1.5">
            Cette série n'est pas encore dans notre base de données locale.<br>
            Relancez <code>node fetch_episodes.js</code> pour mettre à jour.
          </div>
        </div>`;
    } else {
      epsHtml = `<div class="sp-noep">Aucune saison disponible pour cette série.</div>`;
    }
  } else {
    const eps  = smap[sel] || [];
    const m    = smeta.find(x => String(x.num)===sel);
    const covr = m?.cover && m.cover.length > 40 ? m.cover : "";

    if(covr) epsHtml += `<div class="sp-scov"><img src="${esc(covr)}" alt="" loading="lazy"></div>`;

    if(!eps.length){
      epsHtml += `<div class="sp-noep">Aucun épisode dans cette saison.</div>`;
    } else {
      epsHtml += `<div class="sp-eplist">`;
      eps.forEach((ep, idx) => {
        const code  = `S${String(sel).padStart(2,"0")}E${String(ep.episode_num).padStart(2,"0")}`;
        const progK = `${s.id}||${code}`;
        const pct   = getProg()[progK]?.pct || 0;
        const done  = pct >= 90;
        const hasUrl= !!ep.url;

        epsHtml += `
          <button class="sp-ep${done?" sp-ep--done":""}${!hasUrl?" sp-ep--locked":""}"
            data-season="${esc(sel)}" data-idx="${idx}" type="button"
            ${!hasUrl?"disabled":""}
            title="${hasUrl ? esc(ep.title) : "URL non disponible"}">

            ${ep.thumb
              ? `<img class="sp-ep-img" src="${esc(ep.thumb)}" alt="" loading="lazy">`
              : `<div class="sp-ep-img sp-ep-img--blank"></div>`}

            <div class="sp-ep-info">
              <span class="sp-ep-code">${esc(code)}</span>
              <span class="sp-ep-title">${esc(ep.title || "Sans titre")}</span>
              ${ep.duration ? `<span class="sp-ep-dur">${esc(ep.duration)}</span>` : ""}
              ${ep.plot     ? `<span class="sp-ep-plot">${esc(ep.plot.substring(0,120))}${ep.plot.length>120?"…":""}</span>` : ""}
            </div>

            <div class="sp-ep-status">
              ${done        ? `<span class="sp-check">✓</span>`                  : ""}
              ${!done&&pct>2? `<span class="sp-pct">${Math.round(pct)}%</span>` : ""}
              ${hasUrl      ? `<span class="sp-play">▶</span>`
                            : `<span class="sp-lock">–</span>`}
            </div>
          </button>
          ${pct>2 ? `<div class="sp-prog"><div class="sp-prog-fill" style="width:${Math.min(pct,100)}%"></div></div>` : ""}`;
      });
      epsHtml += `</div>`;
    }
  }

  // ── Rendu HTML complet ──
  panel.innerHTML = `
    <div class="sp-header">
      <div class="sp-hinfo">
        <div class="sp-kicker">Série</div>
        <h3 class="sp-title">${esc(s.title)}</h3>
        ${metaLine ? `<div class="sp-meta">${esc(metaLine)}</div>` : ""}
      </div>
      <button id="seriesCloseBtn" class="sp-close">✕</button>
    </div>

    <div class="sp-body">
      <div class="sp-hero">
        ${s.stream_icon
          ? `<img class="sp-cover" src="${esc(s.stream_icon)}" alt="" loading="lazy">`
          : `<div class="sp-cover sp-nocover">🎬</div>`}
        <div class="sp-hero-txt">
          <p class="sp-plot">${esc(s.plot || "Aucun synopsis disponible.")}</p>
        </div>
      </div>

      ${tabsHtml}

      <div id="spEps">${epsHtml}</div>
    </div>`;

  bindClose();

  // Lecture directe
  $("spDirectBtn")?.addEventListener("click", () => playItem(s));

  // Onglets
  panel.querySelectorAll(".sp-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      S.panel.selSeason = btn.dataset.season;
      renderPanel();
      $("spEps")?.scrollIntoView({ behavior:"smooth", block:"nearest" });
    });
  });

  // Boutons épisodes
  panel.querySelectorAll(".sp-ep:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => {
      const sk  = btn.dataset.season;
      const idx = Number(btn.dataset.idx);
      const ep  = (smap[sk] || [])[idx];
      if(ep && ep.url) playEpisode(s, ep, sk);
    });
  });

  // Focus initial (TV)
  setTimeout(() => panel.querySelector(".sp-ep:not([disabled])")?.focus(), 80);
}

// ─────────────────────────────────────────────────────────────────
//  LECTURE
// ─────────────────────────────────────────────────────────────────

function playEpisode(series, ep, season){
  pushHist(series);

  // Index global pour prev/next
  const smap   = S.panel.seasonsMap;
  const keys   = Object.keys(smap).sort((a,b)=>Number(a)-Number(b));
  const allEps = [];
  keys.forEach(sk => (smap[sk]||[]).forEach(e => allEps.push({ season:sk, ep:e })));
  const curIdx = allEps.findIndex(x => x.season===season && x.ep.episode_num===ep.episode_num);

  const code   = `S${String(season).padStart(2,"0")}E${String(ep.episode_num).padStart(2,"0")}`;
  const progKey= `${series.id}||${code}`;

  const playerItem = {
    type             : "series",
    series_id        : series.id,
    title            : series.title,
    episode_label    : code,
    episode_title    : ep.title,
    category_name    : series.category_name || "",
    stream_icon      : ep.thumb || series.stream_icon || "",
    stream_url       : ep.url,
    url              : ep.url,
    plot             : ep.plot || series.plot || "",
    progress_key     : progKey,
    all_episodes     : allEps.map(x => ({
      season       : x.season,
      episode_num  : x.ep.episode_num,
      title        : x.ep.title,
      url          : x.ep.url,
      thumb        : x.ep.thumb,
      plot         : x.ep.plot,
      progress_key : `${series.id}||S${String(x.season).padStart(2,"0")}E${String(x.ep.episode_num).padStart(2,"0")}`
    })),
    current_ep_index : curIdx
  };

  // APK Android v4+ : lecteur VLC embarqué pour les épisodes (sauf TV → player.html)
  const _isTV = /TV|GoogleTV|SmartTV|AndroidTV/i.test(navigator.userAgent) ||
                (/Android/i.test(navigator.userAgent) && !navigator.userAgent.includes("Mobile"));
  if(!_isTV && typeof window.AndroidBridge !== "undefined"
     && typeof window.AndroidBridge.openInVlc === "function"){
    const epTitle = `${series.title} — ${code}${ep.title ? " " + ep.title : ""}`;
    try {
      window.AndroidBridge.openInVlc(ep.url, epTitle, false);
      return;
    } catch(e) {
      console.warn("VLC bridge error:", e);
    }
  }

  sessionStorage.setItem("iptv_current_item", JSON.stringify(playerItem));
  window.location.href = "player.html";
}

async function playItem(item){
  // ── Code parental (catégories for adults) ──
  const isAdultCat = /adult|adulte|\+18|xxx|erot|for adult/i.test(item.category_name || "");
  if(isAdultCat && window.PIPSILY_AUTH && S._userId){
    const pin = await window.PIPSILY_AUTH.getParentalPin(S._userId);
    if(pin){
      const ok = await window.PIPSILY_AUTH.promptParentalPin(pin);
      if(!ok) return; // annulé ou mauvais PIN
    }
  }

  pushHist(item);
  const url    = item.url || item.stream_url || "";
  const title  = item.title || "";
  const isLive = item.type === "live";

  // APK Android v4+ : lecteur VLC embarqué
  // Sur Android TV : on garde le player.html car VLC bridge peut planter
  const isTV = /TV|GoogleTV|SmartTV|AndroidTV/i.test(navigator.userAgent) ||
               (/Android/i.test(navigator.userAgent) && !navigator.userAgent.includes("Mobile"));

  if(!isTV && typeof window.AndroidBridge !== "undefined"
     && typeof window.AndroidBridge.openInVlc === "function"){
    try {
      window.AndroidBridge.openInVlc(url, title, isLive);
      return;
    } catch(e) {
      console.warn("VLC bridge error:", e);
    }
  }

  // Fallback : player.html (TV / navigateur / APK < v4)
  sessionStorage.setItem("iptv_current_item", JSON.stringify({
    ...item,
    stream_url : item.stream_url || item.url,
    url        : item.url || item.stream_url
  }));
  window.location.href = "player.html";
}

// ─────────────────────────────────────────────────────────────────
//  FILTRES / TRI
// ─────────────────────────────────────────────────────────────────

function filtered(){
  let items = S.type === "vod" ? [...S.vod] : S.type === "series" ? [...S.series] : [...S.live];
  if(S.cat)    items = items.filter(x => x.category_name === S.cat);
  if(S.search){
    const q = S.search.toLowerCase();
    items = items.filter(x =>
      x.title.toLowerCase().includes(q) || (x.plot||"").toLowerCase().includes(q)
    );
  }
  // Qualité non applicable au live
  if(S.quality && S.type !== "live") items = items.filter(x => x.quality === S.quality);
  if(S.sort === "category")
    items.sort((a,b) => a.category_name.localeCompare(b.category_name)||a.title.localeCompare(b.title));
  else if(S.sort !== "recent")
    items.sort((a,b) => a.title.localeCompare(b.title));
  return items;
}

// ─────────────────────────────────────────────────────────────────
//  GRILLE
// ─────────────────────────────────────────────────────────────────

function renderGrid(reset = false){
  const grid  = $("grid");
  const empty = $("emptyState");
  if(!grid) return;

  const col   = filtered();
  const limit = S.shown[S.type];
  const items = col.slice(0, limit);

  if(!items.length){ grid.innerHTML = ""; empty.hidden = false; return; }
  empty.hidden = true;
  if(reset) grid.innerHTML = "";

  const frag = document.createDocumentFragment();
  items.slice(grid.children.length).forEach(item => {
    const card = document.createElement("div");
    const key  = itemKey(item);
    card.className   = "card";
    card.tabIndex    = 0;
    card.dataset.key  = key;

    const isSeries = item.type === "series";
    const isLive   = item.type === "live";
    const poster   = item.stream_icon || "";
    const badgeCls = isLive ? "card-badge--live" : isSeries ? "card-badge--s" : "card-badge--f";
    const badgeTxt = isLive ? "📡 Live" : isSeries ? "Série" : "Film";

    card.innerHTML = `
      <div class="card-media">
        ${poster
          ? `<img src="${esc(poster)}" alt="" loading="lazy">`
          : `<div class="card-placeholder">${isLive?"📡":"🎬"}</div>`}
        <span class="card-badge ${badgeCls}">${badgeTxt}</span>
        ${item.quality && !isLive ? `<span class="card-qual">${esc(item.quality)}</span>` : ""}
        <button class="fav-btn ${isFav(item)?"is-fav":""}" type="button" aria-label="Favori">♥</button>
      </div>
      <div class="card-info">
        <div class="card-title">${esc(item.title)}</div>
        <div class="card-cat">${esc(item.category_name)}</div>
      </div>`;

    card.querySelector(".fav-btn").addEventListener("click", e => {
      e.stopPropagation(); toggleFav(item);
    });

    const activate = () => {
      if(item.type === "series") openPanel(item);
      else if(item.type === "live") playItem(item);   // lecture directe pour live
      else openVodPanel(item);
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", e => {
      if(e.key === "Enter" || e.key === " "){ e.preventDefault(); activate(); }
    });
    // Classe JS pour focus visible (TV D-pad / iframe)
    card.addEventListener("focus", () => card.classList.add("is-tv-focused"));
    card.addEventListener("blur",  () => card.classList.remove("is-tv-focused"));

    frag.appendChild(card);
  });

  grid.appendChild(frag);
  $("catalogCount").textContent = `${col.length} éléments · ${grid.children.length} affichés`;
}

function loadMore(){
  if(S.loading) return;
  S.loading = true;
  const col  = filtered();
  const next = Math.min(S.shown[S.type] + PER_PAGE, col.length);
  if(next > S.shown[S.type]){ S.shown[S.type] = next; renderGrid(); }
  S.loading = false;
}

// ─────────────────────────────────────────────────────────────────
//  RANGÉES NETFLIX — browse par catégorie (sans filtre actif)
// ─────────────────────────────────────────────────────────────────

const NROW_MAX = 24; // éléments max par rangée

function makeNrowCard(item){
  const card = document.createElement("div");
  card.className   = "nrow-card";
  card.tabIndex    = 0;
  card.dataset.key = itemKey(item);
  const poster   = item.stream_icon || "";
  const isSeries = item.type === "series";

  card.innerHTML = `
    <div class="nrow-media">
      ${poster
        ? `<img src="${esc(poster)}" alt="" loading="lazy">`
        : `<div class="nrow-placeholder">${isSeries ? "📺" : "🎬"}</div>`}
      ${item.quality ? `<span class="nrow-qual">${esc(item.quality)}</span>` : ""}
      <div class="nrow-overlay"><span class="nrow-play">▶</span></div>
      <button class="nrow-fav ${isFav(item) ? "is-fav" : ""}" type="button" aria-label="Favori">♥</button>
    </div>
    <div class="nrow-info">
      <div class="nrow-name">${esc(item.title)}</div>
    </div>`;

  card.querySelector(".nrow-fav").addEventListener("click", e => {
    e.stopPropagation();
    toggleFav(item);
    e.currentTarget.classList.toggle("is-fav", isFav(item));
  });

  const activate = () => {
    if(item.type === "series") openPanel(item);
    else if(item.type === "live") playItem(item);
    else openVodPanel(item);
  };
  card.addEventListener("click", e => { if(!e.target.closest(".nrow-fav")) activate(); });
  card.addEventListener("keydown", e => {
    if(e.key === "Enter" || e.key === " "){ e.preventDefault(); activate(); }
  });
  card.addEventListener("focus", () => card.classList.add("is-tv-focused"));
  card.addEventListener("blur",  () => card.classList.remove("is-tv-focused"));
  return card;
}

function renderNetflixRows(){
  const grid  = $("grid");
  const empty = $("emptyState");
  if(!grid) return;

  const all = S.type === "vod" ? S.vod : S.series;

  // Grouper par catégorie (ordre d'apparition original)
  const catMap = new Map();
  for(const item of all){
    const cat = item.category_name || "Autre";
    if(!catMap.has(cat)) catMap.set(cat, []);
    catMap.get(cat).push(item);
  }

  if(!catMap.size){ grid.innerHTML = ""; empty.hidden = false; return; }
  empty.hidden = true;
  grid.innerHTML = "";

  const frag = document.createDocumentFragment();
  let total = 0;

  catMap.forEach((items, catName) => {
    total += items.length;

    const section = document.createElement("div");
    section.className = "nrow";

    // En-tête de rangée
    const hdr = document.createElement("div");
    hdr.className = "nrow-hdr";

    const titleEl = document.createElement("h3");
    titleEl.className = "nrow-title";
    titleEl.textContent = catName;

    const allBtn = document.createElement("button");
    allBtn.className = "nrow-all";
    allBtn.type      = "button";
    allBtn.textContent = `Voir tout (${items.length}) →`;
    allBtn.addEventListener("click", () => {
      S.cat = catName;
      const sel = $("categorySelect");
      if(sel) sel.value = catName;
      $("catPills")?.querySelectorAll(".cat-pill").forEach(b =>
        b.classList.toggle("cat-pill--active", b.dataset.cat === catName)
      );
      const g = $("grid");
      if(g) g.className = "grid";
      S.shown[S.type] = PER_PAGE;
      renderGrid(true);
    });

    hdr.appendChild(titleEl);
    hdr.appendChild(allBtn);
    section.appendChild(hdr);

    // Bande horizontale
    const strip = document.createElement("div");
    strip.className = "nrow-strip";

    items.slice(0, NROW_MAX).forEach(item => strip.appendChild(makeNrowCard(item)));

    // Navigation clavier gauche/droite dans la bande
    strip.addEventListener("keydown", e => {
      const cards = [...strip.querySelectorAll(".nrow-card")];
      const idx   = cards.indexOf(document.activeElement);
      if(idx < 0) return;
      if(e.key === "ArrowRight"){
        e.preventDefault();
        const next = cards[idx + 1];
        if(next){ next.focus(); next.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
      } else if(e.key === "ArrowLeft"){
        e.preventDefault();
        const prev = cards[idx - 1];
        if(prev){ prev.focus(); prev.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
      }
    });

    section.appendChild(strip);
    frag.appendChild(section);
  });

  grid.appendChild(frag);
  $("catalogCount").textContent = `${total} éléments · ${catMap.size} catégories`;
}

// ─────────────────────────────────────────────────────────────────
//  RENDU PRINCIPAL
// ─────────────────────────────────────────────────────────────────

function render(){
  const col   = filtered();
  const label = S.type === "vod" ? "Films" : S.type === "series" ? "Séries" : "TV en direct";

  // ── Visibilité hero + nouveautés ──
  // Films / Séries : pas de hero ni de nouveautés (design SmartersPro)
  // Live          : hero conservé tel quel (user: "laisse comme ça")
  const heroEl  = $("hero");
  const novSect = $("nouveautesSection");
  if(S.type === "live"){
    if(heroEl)  heroEl.hidden  = false;
    $("heroTitle").textContent  = label;
    $("statType").textContent   = label;
    $("statCount").textContent  = `${col.length} éléments`;
    $("statSource").textContent = `source : ${S.srcLive || "locale"}`;
  } else {
    if(heroEl)  heroEl.hidden  = true;
    if(novSect) novSect.hidden = true;
  }

  // Masquer le filtre qualité pour le live (non pertinent)
  if($("qualitySelect")) $("qualitySelect").style.display = S.type === "live" ? "none" : "";

  const all  = S.type === "vod" ? S.vod : S.type === "series" ? S.series : S.live;
  const cats = [...new Set(all.map(x => x.category_name).filter(Boolean))].sort();
  $("categorySelect").innerHTML = `<option value="">Toutes les catégories</option>` +
    cats.map(c => `<option value="${esc(c)}"${c===S.cat?" selected":""}>${esc(c)}</option>`).join("");

  // Pills catégories (Films / Séries)
  renderCatPills(cats);

  // Mode Netflix : rangées par catégorie si aucun filtre actif (Films / Séries)
  const useNetflix = S.type !== "live" && !S.search && !S.quality && !S.cat;

  // Grille adaptée au type
  const grid = $("grid");
  if(grid) grid.className = useNetflix ? "netflix-rows"
                          : S.type === "live" ? "grid grid--live" : "grid";

  S.shown[S.type] = PER_PAGE;
  if(useNetflix) renderNetflixRows();
  else           renderGrid(true);
}

// ─────────────────────────────────────────────────────────────────
//  PILLS CATÉGORIES
// ─────────────────────────────────────────────────────────────────

function renderCatPills(cats){
  const pills = $("catPills");
  if(!pills) return;
  if(S.type === "live"){ pills.hidden = true; return; }
  pills.hidden = false;
  pills.innerHTML =
    `<button class="cat-pill ${!S.cat ? "cat-pill--active" : ""}" data-cat="">Tout</button>` +
    cats.map(c =>
      `<button class="cat-pill ${c===S.cat ? "cat-pill--active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`
    ).join("");
  pills.querySelectorAll(".cat-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      S.cat = btn.dataset.cat;
      const sel = $("categorySelect");
      if(sel) sel.value = S.cat;
      S.shown[S.type] = PER_PAGE;
      pills.querySelectorAll(".cat-pill").forEach(b =>
        b.classList.toggle("cat-pill--active", b.dataset.cat === S.cat)
      );
      // Revenir aux rangées Netflix si "Tout" est sélectionné et aucun filtre actif
      const useNetflix = !S.cat && !S.search && !S.quality;
      const g = $("grid");
      if(g) g.className = useNetflix ? "netflix-rows" : "grid";
      if(useNetflix) renderNetflixRows();
      else           renderGrid(true);
    });
  });
}

// ─────────────────────────────────────────────────────────────────
//  NAVIGATION CLAVIER / D-PAD TV
// ─────────────────────────────────────────────────────────────────

function initTV(){
  // ── Navigation D-pad TV ──
  document.addEventListener("keydown", e => {
    const k = e.key;

    if(["Escape","GoBack","Back","BrowserBack"].includes(k)){
      if(!$("seriesPanel")?.hidden){
        e.preventDefault();
        if(S.panel.isVod) closeVodPanel(); else closePanel();
      }
      return;
    }

    if(!["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(k)) return;
    e.preventDefault();

    const panelOpen  = !$("seriesPanel")?.hidden;
    const useNetflix = $("grid")?.className === "netflix-rows";

    // ── Mode Netflix rows : navigation spéciale ──
    if(!panelOpen && useNetflix){
      const active = document.activeElement;

      if(k === "ArrowRight" || k === "ArrowLeft"){
        // Géré par le keydown du strip — laisser passer
        return;
      }

      if(k === "ArrowDown" || k === "ArrowUp"){
        // Trouver la rangée courante et sauter à la suivante/précédente
        const currentRow = active?.closest(".nrow");
        const allRows    = [...document.querySelectorAll(".nrow")];
        const rowIdx     = allRows.indexOf(currentRow);

        let targetRow;
        if(k === "ArrowDown") targetRow = allRows[rowIdx + 1] || allRows[rowIdx];
        else                  targetRow = rowIdx > 0 ? allRows[rowIdx - 1] : null;

        if(targetRow){
          const firstCard = targetRow.querySelector(".nrow-card");
          if(firstCard){
            firstCard.focus();
            firstCard.scrollIntoView({ behavior:"smooth", block:"nearest" });
          }
        } else if(rowIdx < 0){
          // Rien de focalisé → aller au premier
          document.querySelector(".nrow-card, .nav-btn")?.focus();
        }
        return;
      }
      return;
    }

    // ── Mode grille normale ──
    const bannerBtns = [...document.querySelectorAll(
      "#updateNowBtn, #updateDismissBtn, #apkDownloadBtn, #apkDismissBtn"
    )].filter(b => b.offsetParent !== null);

    const focusables = panelOpen
      ? [...$("seriesPanel").querySelectorAll(".sp-tab, .sp-ep:not([disabled]), .sp-close, .sp-direct")]
      : [
          ...bannerBtns,
          ...document.querySelectorAll(".card, .nrow-card, .nav-btn, .controls-grid select, .controls-grid input")
        ];

    let idx = focusables.indexOf(document.activeElement);

    if(idx < 0){
      focusables[0]?.focus();
      return;
    }

    let cols = 1;
    if(!panelOpen){
      const g = $("grid");
      if(g) cols = Math.max(1, Math.round(g.offsetWidth / 165));
    }

    let next = idx;
    if(k === "ArrowRight") next = idx + 1;
    else if(k === "ArrowLeft") next = Math.max(0, idx - 1);
    else if(k === "ArrowDown") next = idx + cols;
    else if(k === "ArrowUp")   next = idx - cols;

    focusables[Math.min(Math.max(0, next), focusables.length - 1)]?.focus();
  });
}

// ─────────────────────────────────────────────────────────────────
//  SECTION NOUVEAUTÉS
// ─────────────────────────────────────────────────────────────────

function renderNouveautes(){
  const sect = $("nouveautesSection");
  const row  = $("nouveautesRow");
  if(!sect || !row) return;

  // Top 20 VOD récents (added desc) avec poster
  const recent = [...S.vod]
    .filter(x => x.added > 0 && x.stream_icon)
    .sort((a, b) => b.added - a.added)
    .slice(0, 20);

  if(!recent.length){ sect.hidden = true; return; }
  sect.hidden = false;

  row.innerHTML = "";
  const frag = document.createDocumentFragment();
  recent.forEach(item => {
    const card = document.createElement("div");
    card.className = "nou-card";
    card.tabIndex  = 0;
    const d = item.added ? new Date(item.added * 1000) : null;
    const dateStr = d
      ? d.toLocaleDateString("fr-FR", { day:"2-digit", month:"short" })
      : "";
    card.innerHTML = `
      <div class="nou-media">
        <img src="${esc(item.stream_icon)}" alt="" loading="lazy"
             onerror="this.parentElement.parentElement.style.display='none'">
        ${item.quality ? `<span class="nou-qual">${esc(item.quality)}</span>` : ""}
        <div class="nou-overlay">
          <span class="nou-play">▶</span>
        </div>
      </div>
      <div class="nou-info">
        <div class="nou-title">${esc(item.title)}</div>
        ${dateStr ? `<div class="nou-date">${dateStr}</div>` : ""}
      </div>`;
    card.addEventListener("click", () => openVodPanel(item));
    card.addEventListener("keydown", e => {
      if(e.key === "Enter" || e.key === " "){ e.preventDefault(); openVodPanel(item); }
    });
    // Classe JS pour focus visible même dans iframe (preview / webview)
    card.addEventListener("focus", () => {
      document.querySelectorAll(".nou-card.is-tv-focused").forEach(c => c.classList.remove("is-tv-focused"));
      card.classList.add("is-tv-focused");
    });
    card.addEventListener("blur", () => card.classList.remove("is-tv-focused"));
    frag.appendChild(card);
  });
  row.appendChild(frag);

  // ── Navigation D-pad TV : flèches gauche/droite dans la rangée ──
  row.addEventListener("keydown", e => {
    const cards = [...row.querySelectorAll(".nou-card")];
    const idx   = cards.indexOf(document.activeElement);
    if(idx < 0) return;
    if(e.key === "ArrowRight"){
      e.preventDefault();
      const next = cards[idx + 1];
      if(next){ next.focus(); next.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
    } else if(e.key === "ArrowLeft"){
      e.preventDefault();
      const prev = cards[idx - 1];
      if(prev){ prev.focus(); prev.scrollIntoView({ behavior:"smooth", block:"nearest", inline:"center" }); }
    }
    // ArrowUp / ArrowDown : navigation spatiale naturelle du navigateur
  });

  // Hero : mettre en avant le 1er item avec une belle image
  renderHero(recent[0]);
}

function renderHero(item){
  const hero = $("hero");
  if(!hero || !item) return;
  if(item.stream_icon){
    hero.style.backgroundImage = `url('${item.stream_icon}')`;
    hero.classList.add("hero--img");
  }
  $("heroTitle").textContent    = item.title || "PIPSILY";
  $("heroSubtitle").textContent = item.category_name || "";
}

// ─────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────

async function boot(){

  // ── Auth gate (APK + PWA) ──
  if(window.PIPSILY_AUTH){
    const auth = await window.PIPSILY_AUTH.authGate();
    if(!auth) return; // redirigé vers login.html ou paywall

    S._userId  = auth.session.user.id;
    S._isAdmin = auth.sub.plan === "admin" || auth.session.user.email === window.PIPSILY_AUTH.ADMIN_EMAIL;
    S._unlim   = auth.sub.unlimited;

    const userBtns = $("topbarUserBtns");
    if(userBtns) userBtns.style.display = "flex";
    if(S._isAdmin){
      const adminBtn = $("adminBtn");
      if(adminBtn) adminBtn.style.display = "inline-flex";
    }

    // Surveillance session : déconnexion forcée si autre appareil se connecte (Standard/Test)
    window.PIPSILY_AUTH.startSessionWatcher?.(S._userId);
  }

  // Navigation type
  document.querySelectorAll(".nav-btn[data-type]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn[data-type]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      S.type = btn.dataset.type;
      S.cat = ""; S.search = "";
      $("searchInput").value = "";
      render();
    });
  });

  // Barre fixe "Mettre à jour"
  $("refreshCacheBtn")?.addEventListener("click", async () => {
    const btn  = $("refreshCacheBtn");
    const date = $("lastUpdateDate");
    btn.disabled    = true;
    btn.textContent = "⏳ Mise à jour…";
    if(date) date.textContent = "Actualisation en cours…";

    // APK Android : activer le nouveau SW s'il est en attente, puis vider le cache WebView
    const isNativeApk = typeof window.AndroidBridge !== "undefined";
    if(isNativeApk){
      try {
        const reg = await navigator.serviceWorker?.ready;
        if(reg?.waiting){
          // Nouveau SW disponible → l'activer. Il enverra RELOAD à toutes les fenêtres.
          reg.waiting.postMessage({ type:"SKIP_WAITING" });
          // Laisser le RELOAD du SW s'en charger (évite race condition avec clearCache)
          return;
        }
      } catch {}
      // Pas de SW en attente → juste vider le cache WebView (données fraîches)
      if(window.AndroidBridge?.clearCache){
        try { window.AndroidBridge.clearCache(); } catch(e){}
      } else {
        window.location.reload();
      }
      return;
    }

    // PWA / navigateur : vider le cache Service Worker
    try {
      if("caches" in window){
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      const reg = await navigator.serviceWorker?.ready;
      if(reg?.waiting) reg.waiting.postMessage({ type:"SKIP_WAITING" });
    } catch {}
    // Reload forcé avec timestamp pour bypasser le SW
    window.location.href = window.location.href.split("?")[0] + "?nocache=" + Date.now();
  });

  $("categorySelect").addEventListener("change", e => { S.cat = e.target.value; render(); });
  $("searchInput").addEventListener("input",  e => { S.search = e.target.value; render(); });
  $("qualitySelect").addEventListener("change",e => { S.quality = e.target.value; render(); });
  $("sortSelect").addEventListener("change",  e => { S.sort = e.target.value; render(); });

  // Clic backdrop
  $("seriesPanel")?.addEventListener("click", e => {
    if(e.target === $("seriesPanel")) closePanel();
  });

  // Infinite scroll
  new IntersectionObserver(
    entries => { if(entries[0].isIntersecting) loadMore(); },
    { rootMargin: SENTINEL_M }
  ).observe($("gridSentinel"));

  initTV();

  // ── Pré-chargement de l'index épisodes (1 Ko, non bloquant) ──
  getEpMap();  // charge episodes_map.json en avance (1 Ko seulement)

  // ── Chargement VOD + Séries + Live + index en parallèle ──
  const [vodJson, seriesJson, liveJson, epIndex] = await Promise.all([
    fetchJson("vod.json"),
    fetchJson("series.json"),
    fetchJson("live.json"),
    fetchJson("episodes_index.json")
  ]);

  if(vodJson){ S.vod = normalizeItems(extractArr(vodJson), "vod"); S.srcVod = "vod.json"; }
  else {
    const vodM3u = await fetchText("vod.m3u");
    if(vodM3u){ S.vod = parseM3U(vodM3u, "vod"); S.srcVod = "vod.m3u"; }
  }

  if(seriesJson){ S.series = normalizeItems(extractArr(seriesJson), "series"); S.srcSeries = "series.json"; }
  else {
    const seriesM3u = await fetchText("series.m3u");
    if(seriesM3u){ S.series = parseM3U(seriesM3u, "series"); S.srcSeries = "series.m3u"; }
  }

  if(liveJson){
    // Les items live ont déjà type:"live" dans le JSON — normalisation légère
    const liveItems = extractArr(liveJson);
    S.live = liveItems.map((x, i) => ({
      id           : x.id || x.stream_id || String(i),
      stream_id    : x.stream_id || x.id || String(i),
      title        : x.title || x.name || "Sans titre",
      category_id  : x.category_id || "",
      category_name: x.category_name || "Autre",
      stream_icon  : x.stream_icon || x.image || "",
      stream_url   : x.stream_url || x.url || "",
      url          : x.stream_url || x.url || "",
      plot         : "",
      type         : "live",
      quality      : ""
    }));
    S.srcLive = "live.json";
  }

  // ── Afficher date dernière mise à jour dans la barre fixe ──
  {
    const el = document.getElementById("lastUpdateDate");
    if(el){
      if(epIndex?.generated){
        const d   = new Date(epIndex.generated);
        const fmt = d.toLocaleDateString("fr-FR", { day:"2-digit", month:"short", year:"numeric" });
        const nb  = epIndex.total ? ` · ${epIndex.total.toLocaleString("fr-FR")} séries` : "";
        el.textContent = `Mise à jour le ${fmt}${nb}`;
      } else {
        el.textContent = "Données en cache";
      }
    }
  }

  renderNouveautes();
  render();

  // ── Écoute des mises à jour Service Worker ──
  if("serviceWorker" in navigator){
    navigator.serviceWorker.addEventListener("message", e => {
      if(e.data?.type === "UPDATE_AVAILABLE") showUpdateBanner();
    });
    // Cas APK : SW déjà en "waiting" depuis une session précédente
    // → updatefound ne se re-déclenche pas, il faut le détecter manuellement
    navigator.serviceWorker.ready.then(reg => {
      if(reg.waiting) showUpdateBanner();
    }).catch(() => {});
  }

  // ── Bannière installation APK pour Android (navigateur, hors APK) ──
  checkApkInstallBanner();

  // ── Vérification auto-update APK (non bloquant, inside APK only) ──
  checkApkUpdate();
}

function showUpdateBanner(){
  if($("updateBanner")) return;
  const isTV = /TV|GoogleTV|SmartTV|AndroidTV/i.test(navigator.userAgent) ||
               (/Android/i.test(navigator.userAgent) && !navigator.userAgent.includes("Mobile"));
  const banner = document.createElement("div");
  banner.id = "updateBanner";
  banner.innerHTML = `
    <span>🔄 Mise à jour disponible !</span>
    <button id="updateNowBtn" type="button" tabindex="0"
      style="background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;border:none;
             border-radius:10px;padding:10px 20px;font-weight:700;font-size:14px;cursor:pointer">
      Mettre à jour
    </button>
    <button id="updateDismissBtn" type="button" tabindex="0" aria-label="Fermer"
      style="background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:10px;
             padding:10px 14px;font-size:14px;cursor:pointer">✕</button>`;
  // Sur TV : bannière en HAUT pour être accessible par D-pad (pas en bas hors écran)
  banner.style.cssText = isTV
    ? `position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;
       justify-content:center;gap:16px;padding:14px 20px;color:#fff;font-size:14px;font-weight:600;
       background:linear-gradient(135deg,#1a2d50,#0f1e3a);border-bottom:2px solid rgba(255,159,44,.5);
       box-shadow:0 4px 24px rgba(0,0,0,.6);`
    : `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;
       display:flex;align-items:center;gap:12px;padding:14px 18px;color:#fff;font-size:14px;font-weight:600;
       background:linear-gradient(135deg,#1a2d50,#0f1e3a);border:1px solid rgba(255,159,44,.4);
       border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.5);white-space:nowrap;`;
  document.body.appendChild(banner);
  $("updateNowBtn").addEventListener("click", () => {
    navigator.serviceWorker?.ready.then(reg => {
      reg.waiting?.postMessage({ type: "SKIP_WAITING" });
      window.location.reload();
    }).catch(() => window.location.reload());
  });
  $("updateDismissBtn").addEventListener("click", () => banner.remove());
  // Auto-focus sur TV pour que le D-pad puisse sélectionner tout de suite
  if(isTV) setTimeout(() => $("updateNowBtn")?.focus(), 100);
}

// ─────────────────────────────────────────────────────────────────
//  APK AUTO-UPDATE — vérifie version.json et propose le téléchargement
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
//  BANNIÈRE INSTALLATION APK — pour les visiteurs Android (hors APK)
// ─────────────────────────────────────────────────────────────────
async function checkApkInstallBanner(){
  // Seulement si : Android + pas encore dans l'APK + pas ignoré récemment
  const isAndroid   = /Android/i.test(navigator.userAgent);
  const isNativeApk = typeof window.AndroidBridge !== "undefined";
  if(!isAndroid || isNativeApk) return;

  const dismissed = Number(localStorage.getItem("pf_apk_install_dismiss") || 0);
  if(Date.now() < dismissed) return; // ignoré pour 7 jours

  const vinfo = await fetchJson("version.json").catch(() => null);
  const url   = vinfo?.apk_url || "https://github.com/morpheus45/VOD/releases/latest";

  if($("apkInstallBanner")) return;
  const banner = document.createElement("div");
  banner.id = "apkInstallBanner";
  banner.style.cssText = [
    "position:fixed;top:0;left:0;right:0;z-index:9998",
    "display:flex;align-items:center;gap:12px;padding:12px 16px",
    "background:linear-gradient(135deg,#1a1060,#0e0a30)",
    "border-bottom:2px solid rgba(107,63,224,.6)",
    "color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.6)",
    "font-family:'Segoe UI',system-ui,sans-serif"
  ].join(";");
  banner.innerHTML = `
    <img src="./logo.svg" alt="" style="height:32px;width:auto;flex-shrink:0">
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:800;color:#eef4ff">Installer l'application</div>
      <div style="font-size:11px;color:#a89be0;margin-top:1px">
        Meilleure expérience · Lecture VLC · Hors ligne
      </div>
    </div>
    <a id="apkInstallBtn" href="${url}" target="_blank" rel="noopener"
      style="flex-shrink:0;padding:9px 16px;border-radius:10px;border:none;
             background:linear-gradient(135deg,#6B3FE0,#38A8E8);color:#fff;
             font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap">
      📥 Installer
    </a>
    <button id="apkInstallDismiss" aria-label="Fermer"
      style="flex-shrink:0;background:rgba(255,255,255,.1);border:none;color:#fff;
             border-radius:8px;padding:8px 10px;font-size:14px;cursor:pointer">✕</button>`;
  document.body.appendChild(banner);

  // Décaler le contenu vers le bas pour ne pas cacher la topbar
  document.body.style.paddingTop = (banner.offsetHeight || 64) + "px";

  $("apkInstallDismiss").onclick = () => {
    banner.remove();
    document.body.style.paddingTop = "";
    localStorage.setItem("pf_apk_install_dismiss", String(Date.now() + 7 * 86400000)); // 7 jours
  };
}

async function checkApkUpdate(){
  const isNativeApk = typeof window.AndroidBridge !== "undefined";
  if(!isNativeApk) return; // inutile hors APK

  try {
    const vinfo = await fetchJson("version.json");
    if(!vinfo || !vinfo.apk_version || !vinfo.apk_url) return;

    const remoteVer = Number(vinfo.apk_version);

    // getApkVersion() est présent dans les APK v2+
    // Les APK v1 (sans la méthode) sont traités comme version 1
    let localVer = 1;
    if(typeof window.AndroidBridge?.getApkVersion === "function"){
      try { localVer = Number(window.AndroidBridge.getApkVersion()) || 1; } catch {}
    }

    if(remoteVer <= localVer) return; // déjà à jour

    // Respecter "plus tard" (rappel dans 24h)
    const remindAt = Number(localStorage.getItem("pf_apk_remind") || 0);
    if(Date.now() < remindAt) return;

    showApkUpdateBanner(vinfo, remoteVer);
  } catch {}
}

function showApkUpdateBanner(vinfo, remoteVer){
  if($("apkUpdateBanner")) return;
  const banner = document.createElement("div");
  banner.id = "apkUpdateBanner";
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <span style="font-size:22px">📦</span>
      <div>
        <div style="font-weight:700;font-size:14px">PIPSILY v${remoteVer} disponible !</div>
        <div style="font-size:12px;opacity:.8;margin-top:2px">${vinfo.changes || "Améliorations & corrections"}</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button id="apkDownloadBtn" type="button"
        style="background:#4caf50;color:#fff;border:none;border-radius:10px;padding:8px 16px;font-weight:700;font-size:13px;cursor:pointer">
        Installer
      </button>
      <button id="apkDismissBtn" type="button" aria-label="Plus tard"
        style="background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:10px;padding:8px 12px;font-size:14px;cursor:pointer">
        ✕
      </button>
    </div>`;
  banner.style.cssText = `
    position:fixed;top:0;left:0;right:0;z-index:9999;
    display:flex;align-items:center;justify-content:space-between;gap:16px;
    background:linear-gradient(135deg,#1a3d1a,#0a2a0a);
    border-bottom:2px solid #4caf50;
    padding:12px 18px;color:#fff;
    box-shadow:0 4px 24px rgba(0,0,0,.6);`;
  document.body.appendChild(banner);

  $("apkDownloadBtn").onclick = () => {
    const url = vinfo.apk_url;
    // APK v3+ : téléchargement + installation directe sans navigateur
    if(typeof window.AndroidBridge?.downloadAndInstall === "function"){
      window.AndroidBridge.downloadAndInstall(url);
    // APK v2 (fallback) : ouvre le navigateur
    } else if(typeof window.AndroidBridge?.openDownloadUrl === "function"){
      window.AndroidBridge.openDownloadUrl(url);
    } else {
      window.open(url, "_blank");
    }
    banner.remove();
  };
  $("apkDismissBtn").onclick = () => {
    banner.remove();
    localStorage.setItem("pf_apk_remind", String(Date.now() + 86400000)); // +24h
  };
}

window.addEventListener("load", boot);
