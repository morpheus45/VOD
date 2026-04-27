// ╔══════════════════════════════════════════════════════════════╗
// ║  PIPSIFLIX — app.js v4.2 — epDb statique                     ║
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
  srcVod    : "",
  srcSeries : "",
  cat       : "",
  search    : "",
  quality   : "",
  sort      : "title",
  shown     : { vod: 0, series: 0 },
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
    console.log(`[PIPSIFLIX] epMap : ${Object.keys(_epMap).length} séries indexées`);
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
      console.log(`[PIPSIFLIX] chunk ${chunkNum} chargé (${Object.keys(chunk||{}).length} séries)`);
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

  // APK natif : HTTP autorisé via network_security_config.xml → utiliser URL directe
  // PWA/Chrome HTTPS : mixed content bloque HTTP → tenter HTTPS (goldenlink.live n'a pas HTTPS → echec attendu)
  const isNativeApk = typeof window.AndroidBridge !== "undefined";
  const apiUrl = isNativeApk ? rawApiUrl.replace(/^https?:\/\//i, "http://") : secureUrl(rawApiUrl);

  // Timeout 12s + gestion CORS/réseau
  let data = null;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 12000);
    const r = await fetch(apiUrl, { signal: controller.signal });
    clearTimeout(tid);
    data = r.ok ? await r.json() : null;
  } catch(e) { data = null; }
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
    const vodId = item.id || item.stream_id || "";
    if(!vodId) return null;
    const apiUrl = `${base}/player_api.php?username=${username}&password=${password}&action=get_vod_info&vod_id=${vodId}`;
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 8000);
    const r    = await fetch(apiUrl, { signal: ctrl.signal });
    clearTimeout(tid);
    if(!r.ok) return null;
    const d = await r.json();
    return d?.info?.plot || d?.info?.description || null;
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

  sessionStorage.setItem("iptv_current_item", JSON.stringify(playerItem));
  window.location.href = "player.html";
}

function playItem(item){
  pushHist(item);
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
  let items = [...(S.type === "vod" ? S.vod : S.series)];
  if(S.cat)    items = items.filter(x => x.category_name === S.cat);
  if(S.search){
    const q = S.search.toLowerCase();
    items = items.filter(x =>
      x.title.toLowerCase().includes(q) || (x.plot||"").toLowerCase().includes(q)
    );
  }
  if(S.quality) items = items.filter(x => x.quality === S.quality);
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
    const poster   = item.stream_icon || "";

    card.innerHTML = `
      <div class="card-media">
        ${poster
          ? `<img src="${esc(poster)}" alt="" loading="lazy">`
          : `<div class="card-placeholder">🎬</div>`}
        <span class="card-badge ${isSeries?"card-badge--s":"card-badge--f"}">${isSeries?"Série":"Film"}</span>
        ${item.quality ? `<span class="card-qual">${esc(item.quality)}</span>` : ""}
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
      else openVodPanel(item);
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", e => {
      if(e.key === "Enter" || e.key === " "){ e.preventDefault(); activate(); }
    });

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
//  RENDU PRINCIPAL
// ─────────────────────────────────────────────────────────────────

function render(){
  const col   = filtered();
  const label = S.type === "vod" ? "Films" : "Séries";
  $("heroTitle").textContent  = label;
  $("statType").textContent   = label;
  $("statCount").textContent  = `${col.length} éléments`;
  $("statSource").textContent = `source : ${(S.type==="vod"?S.srcVod:S.srcSeries)||"locale"}`;

  const all  = S.type === "vod" ? S.vod : S.series;
  const cats = [...new Set(all.map(x => x.category_name))].sort();
  $("categorySelect").innerHTML = `<option value="">Toutes les catégories</option>` +
    cats.map(c => `<option value="${esc(c)}"${c===S.cat?" selected":""}>${esc(c)}</option>`).join("");

  S.shown[S.type] = PER_PAGE;
  renderGrid(true);
}

// ─────────────────────────────────────────────────────────────────
//  NAVIGATION CLAVIER / D-PAD TV
// ─────────────────────────────────────────────────────────────────

function initTV(){
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

    const panelOpen = !$("seriesPanel")?.hidden;
    const focusables = panelOpen
      ? [...$("seriesPanel").querySelectorAll(".sp-tab, .sp-ep:not([disabled]), .sp-close, .sp-direct")]
      : [...document.querySelectorAll(".card, .nav-btn, .controls-grid select, .controls-grid input")];

    const idx = focusables.indexOf(document.activeElement);
    if(idx < 0) return;
    e.preventDefault();

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
//  BOOT
// ─────────────────────────────────────────────────────────────────

async function boot(){

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

    // APK Android : clearCache() vide le cache WebView natif + reload
    const isNativeApk = typeof window.AndroidBridge !== "undefined";
    if(isNativeApk && window.AndroidBridge?.clearCache){
      try { window.AndroidBridge.clearCache(); } catch(e){}
      return; // Java gère le reload
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

  // ── Chargement VOD + Séries + index en parallèle ──
  const [vodJson, seriesJson, epIndex] = await Promise.all([
    fetchJson("vod.json"),
    fetchJson("series.json"),
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

  render();

  // ── Écoute des mises à jour Service Worker ──
  if("serviceWorker" in navigator){
    navigator.serviceWorker.addEventListener("message", e => {
      if(e.data?.type === "UPDATE_AVAILABLE") showUpdateBanner();
    });
  }
}

function showUpdateBanner(){
  if($("updateBanner")) return; // déjà affiché
  const banner = document.createElement("div");
  banner.id = "updateBanner";
  banner.innerHTML = `
    <span>🔄 Mise à jour disponible !</span>
    <button id="updateNowBtn" type="button">Mettre à jour</button>
    <button id="updateDismissBtn" type="button" aria-label="Fermer">✕</button>`;
  banner.style.cssText = `
    position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
    z-index:9999;display:flex;align-items:center;gap:12px;
    background:linear-gradient(135deg,#1a2d50,#0f1e3a);
    border:1px solid rgba(255,159,44,.4);border-radius:16px;
    padding:14px 18px;color:#fff;font-size:14px;font-weight:600;
    box-shadow:0 8px 32px rgba(0,0,0,.5);white-space:nowrap;
    animation:slideUp .3s ease;`;
  document.body.appendChild(banner);
  $("updateNowBtn").onclick = () => {
    navigator.serviceWorker.ready.then(reg => {
      reg.waiting?.postMessage({ type: "SKIP_WAITING" });
      window.location.reload();
    });
  };
  $("updateDismissBtn").onclick = () => banner.remove();
}

window.addEventListener("load", boot);
