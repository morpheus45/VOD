const K='morph_admin_ok_v2';
try{ if(sessionStorage.getItem(K)!=='1'){ location.href='./admin.html'; } }catch(e){ location.href='./admin.html'; }

const $ = id => document.getElementById(id);
const state = { vod: [], series: [] };

function setStatus(t){ $("status").textContent = t; }
function sanitize(s){ return (s || "").toString().trim(); }
function isUrl(u){ try { new URL(u); return true; } catch { return false; } }

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
    plot: sanitize(e.plot || e.overview || e.description || (e.info && (e.info.plot || e.info.overview || e.info.description)) || ""),
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

$("vodFile").addEventListener("change", async () => {
  try { state.vod = await loadFile($("vodFile"), 'vod'); setStatus(`VOD chargé : ${state.vod.length} entrées.`); }
  catch(e){ setStatus('Erreur chargement VOD.'); }
});

$("seriesFile").addEventListener("change", async () => {
  try { state.series = await loadFile($("seriesFile"), 'series'); setStatus(`Séries chargé : ${state.series.length} entrées.`); }
  catch(e){ setStatus('Erreur chargement séries.'); }
});

$("loadVodCatalogBtn").addEventListener("click", () => {
  try {
    const data = JSON.parse($("pasteBox").value);
    state.vod = Array.isArray(data) ? normalizeCatalogItems(data, 'vod') : normalizeCatalogItems(data.items || [], 'vod');
    setStatus(`vod_catalog chargé : ${state.vod.length} entrées.`);
  } catch(e){ setStatus('JSON vod_catalog invalide.'); }
});

$("loadSeriesCatalogBtn").addEventListener("click", () => {
  try {
    const data = JSON.parse($("pasteBox").value);
    state.series = Array.isArray(data) ? normalizeCatalogItems(data, 'series') : normalizeCatalogItems(data.items || [], 'series');
    setStatus(`series_catalog chargé : ${state.series.length} entrées.`);
  } catch(e){ setStatus('JSON series_catalog invalide.'); }
});

$("exportVodBtn").addEventListener("click", () => {
  downloadJson('vod_catalog.json', state.vod);
  setStatus('vod_catalog.json téléchargé.');
});

$("exportSeriesBtn").addEventListener("click", () => {
  downloadJson('series_catalog.json', state.series);
  setStatus('series_catalog.json téléchargé.');
});

$("logoutBtn").addEventListener("click", () => {
  try{ sessionStorage.removeItem(K); }catch(e){}
  location.href='./admin.html';
});
