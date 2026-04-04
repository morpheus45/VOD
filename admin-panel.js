const K='morph_admin_ok_v3';
try{ if(sessionStorage.getItem(K)!=='1'){ location.href='./admin.html'; } }catch(e){ location.href='./admin.html'; }

const $ = id => document.getElementById(id);
const state = { live: [], vod: [], series: [] };

function setStatus(t){ $("status").textContent = t; }
function sanitize(s){ return (s || "").toString().trim(); }
function isUrl(u){ try { new URL(u); return true; } catch { return false; } }
function updateCounts(){
  $("liveCount").textContent = state.live.length;
  $("vodCount").textContent = state.vod.length;
  $("seriesCount").textContent = state.series.length;
}

function parseXtreamUrl(raw){
  try{
    const u = new URL(raw.trim());
    const username = u.searchParams.get("username") || "";
    const password = u.searchParams.get("password") || "";
    return {
      base: u.origin,
      username,
      password,
      api(action, extra=""){
        return `${u.origin}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=${encodeURIComponent(action)}${extra}`;
      }
    };
  }catch(e){
    return null;
  }
}

async function fetchJson(url){
  const res = await fetch(url, { method:"GET", cache:"no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
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

function normalizeCatalogItems(items, forcedType){
  return (items || []).filter(x => x && typeof x === "object").map(e => ({
    title: sanitize(e.title || e.name) || "Sans titre",
    category: sanitize(e.category_name || e.category) || "Sans catégorie",
    url: sanitize(e.stream_url || e.url),
    image: sanitize(e.stream_icon || e.cover || e.movie_image || e.image || ""),
    plot: sanitize(e.plot || e.overview || e.description || (e.info && (e.info.plot || e.info.overview || e.info.description || e.info.synopsis)) || ""),
    meta: sanitize(e.meta || ""),
    type: forcedType,
    seasons: Array.isArray(e.seasons) ? e.seasons : [],
    episodes: e.episodes && typeof e.episodes === "object" ? e.episodes : {}
  }));
}

async function loadFile(input, forcedType){
  const file = input.files && input.files[0];
  if (!file) return [];
  const text = await file.text();
  if (file.name.toLowerCase().endsWith('.m3u') || file.name.toLowerCase().endsWith('.m3u8')) return parseM3U(text, forcedType);
  const data = JSON.parse(text);
  return Array.isArray(data) ? normalizeCatalogItems(data, forcedType) : normalizeCatalogItems(data.items || [], forcedType);
}

function downloadJson(filename, data){
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1200);
}

function safePlot(obj){
  return sanitize(
    obj?.plot || obj?.overview || obj?.description || obj?.synopsis ||
    obj?.info?.plot || obj?.info?.overview || obj?.info?.description || obj?.info?.synopsis || ""
  );
}

function safeMeta(obj){
  const bits = [];
  const year = sanitize(obj?.year || obj?.releaseDate || obj?.releasedate || obj?.info?.releaseDate || obj?.info?.releasedate || "");
  const rating = sanitize(obj?.rating || obj?.info?.rating || "");
  if (year) bits.push(year);
  if (rating) bits.push(`Note ${rating}`);
  return bits.join(" • ");
}

function buildVodUrl(base, username, password, streamId, ext){
  return `${base}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(streamId)}.${ext || 'mp4'}`;
}

function buildEpisodeUrl(base, username, password, ep){
  const episodeId = ep?.id || ep?.episode_id || ep?.stream_id || "";
  const ext = ep?.container_extension || ep?.extension || "mp4";
  if (!episodeId) return "";
  return `${base}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(episodeId)}.${ext}`;
}

async function generateVodCatalog(){
  const cfg = parseXtreamUrl($("apiUrl").value);
  if (!cfg || !cfg.username || !cfg.password) { setStatus("URL Xtream invalide."); return; }
  setStatus("Chargement des catégories VOD…");
  const categories = await fetchJson(cfg.api("get_vod_categories"));
  const catalog = [];
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    setStatus(`VOD ${i + 1}/${categories.length} : ${cat.category_name || cat.category_id}`);
    let streams = [];
    try { streams = await fetchJson(cfg.api("get_vod_streams", `&category_id=${encodeURIComponent(cat.category_id)}`)); } catch(e) { streams = []; }
    for (const s of streams) {
      let info = {};
      try { info = await fetchJson(cfg.api("get_vod_info", `&vod_id=${encodeURIComponent(s.stream_id)}`)); } catch(e) { info = {}; }
      catalog.push({
        title: sanitize(s.name || info?.info?.name) || `VOD ${s.stream_id}`,
        category: sanitize(cat.category_name) || "Sans catégorie",
        url: buildVodUrl(cfg.base, cfg.username, cfg.password, s.stream_id, s.container_extension || "mp4"),
        image: sanitize(s.stream_icon || info?.info?.movie_image || ""),
        plot: safePlot(info?.info || info?.movie_data || info),
        meta: safeMeta(info?.info || info?.movie_data || info),
        type: "vod",
        seasons: [],
        episodes: {}
      });
    }
  }
  state.vod = catalog; updateCounts(); setStatus(`vod_catalog.json prêt : ${catalog.length} entrées.`);
}

async function generateSeriesCatalog(){
  const cfg = parseXtreamUrl($("apiUrl").value);
  if (!cfg || !cfg.username || !cfg.password) { setStatus("URL Xtream invalide."); return; }
  setStatus("Chargement des catégories séries…");
  const categories = await fetchJson(cfg.api("get_series_categories"));
  let seriesList = [];
  try { seriesList = await fetchJson(cfg.api("get_series")); } catch(e) { seriesList = []; }
  const categoryMap = new Map((categories || []).map(c => [String(c.category_id), sanitize(c.category_name) || "Sans catégorie"]));
  const catalog = [];
  for (let i = 0; i < seriesList.length; i++) {
    const s = seriesList[i];
    const sid = s.series_id || s.stream_id;
    setStatus(`Séries ${i + 1}/${seriesList.length} : ${s.name || sid}`);
    let info = {};
    try { info = await fetchJson(cfg.api("get_series_info", `&series_id=${encodeURIComponent(sid)}`)); } catch(e) { info = {}; }
    const seasons = Array.isArray(info?.seasons) ? info.seasons : [];
    const episodesObj = info?.episodes && typeof info.episodes === "object" ? info.episodes : {};
    for (const seasonKey of Object.keys(episodesObj)) {
      const eps = Array.isArray(episodesObj[seasonKey]) ? episodesObj[seasonKey] : [];
      eps.forEach(ep => { ep.url = buildEpisodeUrl(cfg.base, cfg.username, cfg.password, ep); });
    }
    catalog.push({
      title: sanitize(s.name || info?.info?.name) || `Série ${sid}`,
      category: categoryMap.get(String(s.category_id)) || sanitize(s.category_name) || "Sans catégorie",
      url: cfg.api("get_series_info", `&series_id=${encodeURIComponent(sid)}`),
      image: sanitize(s.cover || s.stream_icon || info?.info?.cover || info?.info?.movie_image || ""),
      plot: safePlot(info?.info || s),
      meta: safeMeta(info?.info || s),
      type: "series",
      seasons,
      episodes: episodesObj
    });
  }
  state.series = catalog; updateCounts(); setStatus(`series_catalog.json prêt : ${catalog.length} entrées.`);
}

$("parseBtn").addEventListener("click", () => {
  const cfg = parseXtreamUrl($("apiUrl").value);
  setStatus(cfg ? `URL reconnue : ${cfg.base}` : "URL Xtream invalide.");
});

$("genVodBtn").addEventListener("click", async () => {
  try { await generateVodCatalog(); } catch(e) { setStatus(`Échec génération VOD : ${e.message}`); }
});

$("genSeriesBtn").addEventListener("click", async () => {
  try { await generateSeriesCatalog(); } catch(e) { setStatus(`Échec génération séries : ${e.message}`); }
});

$("liveFile").addEventListener("change", async () => {
  try { state.live = await loadFile($("liveFile"), 'live'); updateCounts(); setStatus(`Live chargé : ${state.live.length} entrées.`); }
  catch(e){ setStatus('Erreur chargement live.'); }
});
$("vodFile").addEventListener("change", async () => {
  try { state.vod = await loadFile($("vodFile"), 'vod'); updateCounts(); setStatus(`VOD chargé : ${state.vod.length} entrées.`); }
  catch(e){ setStatus('Erreur chargement VOD.'); }
});
$("seriesFile").addEventListener("change", async () => {
  try { state.series = await loadFile($("seriesFile"), 'series'); updateCounts(); setStatus(`Séries chargé : ${state.series.length} entrées.`); }
  catch(e){ setStatus('Erreur chargement séries.'); }
});

$("loadVodCatalogBtn").addEventListener("click", () => {
  try {
    const data = JSON.parse($("pasteBox").value);
    state.vod = Array.isArray(data) ? normalizeCatalogItems(data, 'vod') : normalizeCatalogItems(data.items || [], 'vod');
    updateCounts(); setStatus(`vod_catalog chargé : ${state.vod.length} entrées.`);
  } catch(e){ setStatus('JSON vod_catalog invalide.'); }
});
$("loadSeriesCatalogBtn").addEventListener("click", () => {
  try {
    const data = JSON.parse($("pasteBox").value);
    state.series = Array.isArray(data) ? normalizeCatalogItems(data, 'series') : normalizeCatalogItems(data.items || [], 'series');
    updateCounts(); setStatus(`series_catalog chargé : ${state.series.length} entrées.`);
  } catch(e){ setStatus('JSON series_catalog invalide.'); }
});

$("exportLiveBtn").addEventListener("click", () => { downloadJson('live_catalog.json', state.live); setStatus('live_catalog.json téléchargé.'); });
$("exportVodBtn").addEventListener("click", () => { downloadJson('vod_catalog.json', state.vod); setStatus('vod_catalog.json téléchargé.'); });
$("exportSeriesBtn").addEventListener("click", () => { downloadJson('series_catalog.json', state.series); setStatus('series_catalog.json téléchargé.'); });

$("logoutBtn").addEventListener("click", () => { try{ sessionStorage.removeItem(K); }catch(e){} location.href='./admin.html'; });

updateCounts();
