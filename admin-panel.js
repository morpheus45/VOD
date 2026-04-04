const K='morph_admin_ok_v4';
try{ if(sessionStorage.getItem(K)!=='1'){ location.href='./admin.html'; } }catch(e){ location.href='./admin.html'; }

const $ = id => document.getElementById(id);
const state = {
  live: [], vod: [], series: [],
  vodCatalog: [], seriesCatalog: []
};

function setStatus(t){ $("status").textContent = t; }
function sanitize(s){ return (s || "").toString().trim(); }
function isUrl(u){ try { new URL(u); return true; } catch { return false; } }
function updateCounts(){ $("liveCount").textContent = state.live.length; $("vodCount").textContent = state.vod.length; $("seriesCount").textContent = state.series.length; }

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
  }catch(e){ return null; }
}

async function fetchJson(url){
  const res = await fetch(url, { method:"GET", cache:"no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

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

function itemsToM3U(items){
  const lines = ["#EXTM3U"];
  (items || []).forEach(it => {
    const logo = sanitize(it.image) ? ` tvg-logo="${sanitize(it.image).replace(/"/g,"'")}"` : "";
    const group = sanitize(it.category) ? ` group-title="${sanitize(it.category).replace(/"/g,"'")}"` : "";
    lines.push(`#EXTINF:-1${logo}${group},${sanitize(it.title)}`);
    lines.push(sanitize(it.url));
  });
  return lines.join("\\n");
}

async function loadFile(input, type){
  const file = input.files && input.files[0];
  if (!file) return [];
  const text = await file.text();
  if (file.name.toLowerCase().endsWith(".m3u") || file.name.toLowerCase().endsWith(".m3u8")) return parseM3U(text, type);
  const data = JSON.parse(text);
  return Array.isArray(data) ? normalizeItems(data, type) : normalizeItems(data.items || [], type);
}

function downloadText(filename, text, mime){
  const blob = new Blob([text], { type:mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1200);
}
function downloadJson(filename, data){ downloadText(filename, JSON.stringify(data, null, 2), "application/json;charset=utf-8"); }

function safePlot(obj){
  return sanitize(obj?.plot || obj?.overview || obj?.description || obj?.synopsis || obj?.info?.plot || obj?.info?.overview || obj?.info?.description || obj?.info?.synopsis || "");
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
  return `${base}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(streamId)}.${ext || "mp4"}`;
}
function buildEpisodeUrl(base, username, password, ep){
  const episodeId = ep?.id || ep?.episode_id || ep?.stream_id || "";
  const ext = ep?.container_extension || ep?.extension || "mp4";
  if (!episodeId) return "";
  return `${base}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(episodeId)}.${ext}`;
}
function buildLiveUrl(base, username, password, streamId, ext){
  return `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(streamId)}.${ext || "ts"}`;
}

async function generateLiveRaw(){
  const cfg = parseXtreamUrl($("apiUrl").value);
  if (!cfg || !cfg.username || !cfg.password) { setStatus("URL Xtream invalide."); return; }
  setStatus("Chargement du live…");
  let streams = [];
  try { streams = await fetchJson(cfg.api("get_live_streams")); } catch(e) { streams = []; }
  state.live = (streams || []).map(s => ({
    title: sanitize(s.name) || `Live ${s.stream_id}`,
    category: sanitize(s.category_name || s.category_id) || "Sans catégorie",
    url: buildLiveUrl(cfg.base, cfg.username, cfg.password, s.stream_id, s.container_extension || "ts"),
    image: sanitize(s.stream_icon || ""),
    plot: "",
    meta: "",
    type: "live",
    seasons: [],
    episodes: {}
  }));
  updateCounts();
  setStatus(`live.json prêt : ${state.live.length} entrées.`);
}

async function generateVodRaw(){
  const cfg = parseXtreamUrl($("apiUrl").value);
  if (!cfg || !cfg.username || !cfg.password) { setStatus("URL Xtream invalide."); return; }
  setStatus("Chargement VOD…");
  const categories = await fetchJson(cfg.api("get_vod_categories"));
  const raw = [];
  for (const cat of categories) {
    let streams = [];
    try { streams = await fetchJson(cfg.api("get_vod_streams", `&category_id=${encodeURIComponent(cat.category_id)}`)); } catch(e){}
    (streams || []).forEach(s => raw.push({
      title: sanitize(s.name) || `VOD ${s.stream_id}`,
      category: sanitize(cat.category_name) || "Sans catégorie",
      url: buildVodUrl(cfg.base, cfg.username, cfg.password, s.stream_id, s.container_extension || "mp4"),
      image: sanitize(s.stream_icon || ""),
      plot: "",
      meta: "",
      type: "vod",
      seasons: [],
      episodes: {}
    }));
  }
  state.vod = raw;
  updateCounts();
  setStatus(`vod.json prêt : ${state.vod.length} entrées.`);
}

async function generateSeriesRaw(){
  const cfg = parseXtreamUrl($("apiUrl").value);
  if (!cfg || !cfg.username || !cfg.password) { setStatus("URL Xtream invalide."); return; }
  setStatus("Chargement séries…");
  const cats = await fetchJson(cfg.api("get_series_categories"));
  let seriesList = [];
  try { seriesList = await fetchJson(cfg.api("get_series")); } catch(e){}
  const catMap = new Map((cats || []).map(c => [String(c.category_id), sanitize(c.category_name) || "Sans catégorie"]));
  state.series = (seriesList || []).map(s => ({
    title: sanitize(s.name) || `Série ${s.series_id || s.stream_id}`,
    category: catMap.get(String(s.category_id)) || sanitize(s.category_name) || "Sans catégorie",
    url: cfg.api("get_series_info", `&series_id=${encodeURIComponent(s.series_id || s.stream_id)}`),
    image: sanitize(s.cover || s.stream_icon || ""),
    plot: "",
    meta: "",
    type: "series",
    seasons: [],
    episodes: {}
  }));
  updateCounts();
  setStatus(`series.json prêt : ${state.series.length} entrées.`);
}

async function generateVodCatalog(){
  const cfg = parseXtreamUrl($("apiUrl").value);
  if (!cfg || !cfg.username || !cfg.password) { setStatus("URL Xtream invalide."); return; }
  setStatus("Chargement du catalogue VOD enrichi…");
  const categories = await fetchJson(cfg.api("get_vod_categories"));
  const catalog = [];
  for (let i=0;i<categories.length;i++){
    const cat = categories[i];
    setStatus(`VOD ${i+1}/${categories.length} : ${cat.category_name || cat.category_id}`);
    let streams = [];
    try { streams = await fetchJson(cfg.api("get_vod_streams", `&category_id=${encodeURIComponent(cat.category_id)}`)); } catch(e){}
    for (const s of (streams || [])) {
      let info = {};
      try { info = await fetchJson(cfg.api("get_vod_info", `&vod_id=${encodeURIComponent(s.stream_id)}`)); } catch(e){}
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
  state.vodCatalog = catalog;
  if (!state.vod.length) state.vod = catalog.map(x => ({...x, plot:"", meta:""}));
  updateCounts();
  setStatus(`vod_catalog.json prêt : ${catalog.length} entrées.`);
}

async function generateSeriesCatalog(){
  const cfg = parseXtreamUrl($("apiUrl").value);
  if (!cfg || !cfg.username || !cfg.password) { setStatus("URL Xtream invalide."); return; }
  setStatus("Chargement du catalogue séries enrichi…");
  const cats = await fetchJson(cfg.api("get_series_categories"));
  let seriesList = [];
  try { seriesList = await fetchJson(cfg.api("get_series")); } catch(e){}
  const catMap = new Map((cats || []).map(c => [String(c.category_id), sanitize(c.category_name) || "Sans catégorie"]));
  const catalog = [];
  for (let i=0;i<seriesList.length;i++){
    const s = seriesList[i];
    const sid = s.series_id || s.stream_id;
    setStatus(`Séries ${i+1}/${seriesList.length} : ${s.name || sid}`);
    let info = {};
    try { info = await fetchJson(cfg.api("get_series_info", `&series_id=${encodeURIComponent(sid)}`)); } catch(e){}
    const seasons = Array.isArray(info?.seasons) ? info.seasons : [];
    const episodesObj = info?.episodes && typeof info.episodes === "object" ? info.episodes : {};
    Object.keys(episodesObj).forEach(k => {
      const eps = Array.isArray(episodesObj[k]) ? episodesObj[k] : [];
      eps.forEach(ep => { ep.url = buildEpisodeUrl(cfg.base, cfg.username, cfg.password, ep); });
    });
    catalog.push({
      title: sanitize(s.name || info?.info?.name) || `Série ${sid}`,
      category: catMap.get(String(s.category_id)) || sanitize(s.category_name) || "Sans catégorie",
      url: cfg.api("get_series_info", `&series_id=${encodeURIComponent(sid)}`),
      image: sanitize(s.cover || s.stream_icon || info?.info?.cover || ""),
      plot: safePlot(info?.info || s),
      meta: safeMeta(info?.info || s),
      type: "series",
      seasons,
      episodes: episodesObj
    });
  }
  state.seriesCatalog = catalog;
  if (!state.series.length) state.series = catalog.map(x => ({...x, plot:"", meta:"", seasons:[], episodes:{}}));
  updateCounts();
  setStatus(`series_catalog.json prêt : ${catalog.length} entrées.`);
}

$("parseBtn").addEventListener("click", () => {
  const cfg = parseXtreamUrl($("apiUrl").value);
  setStatus(cfg ? `URL reconnue : ${cfg.base}` : "URL Xtream invalide.");
});
$("genLiveBtn").addEventListener("click", async () => { try { await generateLiveRaw(); } catch(e){ setStatus(`Échec live : ${e.message}`); } });
$("genVodBtn").addEventListener("click", async () => { try { await generateVodRaw(); } catch(e){ setStatus(`Échec VOD : ${e.message}`); } });
$("genSeriesBtn").addEventListener("click", async () => { try { await generateSeriesRaw(); } catch(e){ setStatus(`Échec séries : ${e.message}`); } });
$("genVodCatBtn").addEventListener("click", async () => { try { await generateVodCatalog(); } catch(e){ setStatus(`Échec vod_catalog : ${e.message}`); } });
$("genSeriesCatBtn").addEventListener("click", async () => { try { await generateSeriesCatalog(); } catch(e){ setStatus(`Échec series_catalog : ${e.message}`); } });

$("liveFile").addEventListener("change", async () => { try { state.live = await loadFile($("liveFile"), "live"); updateCounts(); setStatus(`Live chargé : ${state.live.length} entrées.`); } catch(e){ setStatus("Erreur chargement live."); } });
$("vodFile").addEventListener("change", async () => { try { state.vod = await loadFile($("vodFile"), "vod"); updateCounts(); setStatus(`VOD chargé : ${state.vod.length} entrées.`); } catch(e){ setStatus("Erreur chargement VOD."); } });
$("seriesFile").addEventListener("change", async () => { try { state.series = await loadFile($("seriesFile"), "series"); updateCounts(); setStatus(`Séries chargé : ${state.series.length} entrées.`); } catch(e){ setStatus("Erreur chargement séries."); } });

$("dlLiveM3u").addEventListener("click", () => downloadText("live.m3u", itemsToM3U(state.live), "audio/x-mpegurl;charset=utf-8"));
$("dlVodM3u").addEventListener("click", () => downloadText("vod.m3u", itemsToM3U(state.vod), "audio/x-mpegurl;charset=utf-8"));
$("dlSeriesM3u").addEventListener("click", () => downloadText("series.m3u", itemsToM3U(state.series), "audio/x-mpegurl;charset=utf-8"));
$("dlLiveJson").addEventListener("click", () => downloadJson("live.json", state.live));
$("dlVodJson").addEventListener("click", () => downloadJson("vod.json", state.vod));
$("dlSeriesJson").addEventListener("click", () => downloadJson("series.json", state.series));
$("dlVodCatalog").addEventListener("click", () => downloadJson("vod_catalog.json", state.vodCatalog.length ? state.vodCatalog : state.vod));
$("dlSeriesCatalog").addEventListener("click", () => downloadJson("series_catalog.json", state.seriesCatalog.length ? state.seriesCatalog : state.series));

$("logoutBtn").addEventListener("click", () => { try{ sessionStorage.removeItem(K); }catch(e){} location.href="./admin.html"; });
updateCounts();
