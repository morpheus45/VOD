
function $(id){ return document.getElementById(id); }

const item = (() => {
  try{
    const raw = sessionStorage.getItem("iptv_current_item");
    return raw ? JSON.parse(raw) : null;
  }catch{ return null; }
})();

const video = $("video");
let hls = null;

function readStore(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch{ return fallback; }
}
function writeStore(key, value){
  localStorage.setItem(key, JSON.stringify(value));
}
function itemKey(item){
  return [item.type || "", item.title || "", item.url || item.stream_url || ""].join("||");
}
function getFavorites(){ return readStore("iptv_v2_favorites", []); }
function setFavorites(v){ writeStore("iptv_v2_favorites", v); }
function getProgress(){ return readStore("iptv_v2_progress", []); }
function setProgress(v){ writeStore("iptv_v2_progress", v); }

function updateFavoriteUI(){
  if(!item) return;
  const favs = getFavorites();
  const exists = favs.some(x => x.key === itemKey(item));
  $("favBtn").textContent = exists ? "★ Favori" : "☆ Favori";
}

function toggleFavorite(){
  if(!item) return;
  const favs = getFavorites();
  const key = itemKey(item);
  const idx = favs.findIndex(x => x.key === key);
  if(idx >= 0) favs.splice(idx, 1);
  else favs.unshift({ key, item, savedAt: Date.now() });
  setFavorites(favs.slice(0, 500));
  updateFavoriteUI();
}

function saveProgress(){
  if(!item || !video || !isFinite(video.currentTime)) return;
  const prog = getProgress().filter(x => x.key !== itemKey(item));
  prog.unshift({ key: itemKey(item), item, currentTime: video.currentTime, savedAt: Date.now() });
  setProgress(prog.slice(0, 300));
}

function restoreProgress(){
  if(!item) return;
  const hit = getProgress().find(x => x.key === itemKey(item));
  if(hit && Number(hit.currentTime) > 5){
    video.currentTime = Number(hit.currentTime);
  }
}

async function copyLink(){
  const url = item?.stream_url || item?.url || "";
  try{ await navigator.clipboard.writeText(url); }catch{}
}

function openExternal(){
  const url = item?.stream_url || item?.url || "";
  if(url) location.href = url;
}

async function enterFullscreen(){
  try{
    if(video.requestFullscreen) await video.requestFullscreen();
  }catch{}
}

function initPlayer(){
  if(!item){
    $("playerTitle").textContent = "Aucune vidéo";
    return;
  }

  $("playerTitle").textContent = item.title || "Lecture";
  $("playerMeta").textContent = [item.type === "vod" ? "Film" : item.type === "series" ? "Série" : "Live", item.category_name || item.category || ""].filter(Boolean).join(" • ");
  $("plotText").textContent = item.plot || "Aucune description.";
  updateFavoriteUI();

  const url = item.stream_url || item.url || "";
  if(!url) return;

  const looksHls = /\.m3u8(\?|$)/i.test(url);
  if(window.Hls && window.Hls.isSupported() && looksHls){
    hls = new Hls({ enableWorker:true, lowLatencyMode:true });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(()=>{});
      setTimeout(enterFullscreen, 250);
    });
  }else{
    video.src = url;
    video.addEventListener("loadedmetadata", () => {
      restoreProgress();
      video.play().catch(()=>{});
      setTimeout(enterFullscreen, 250);
    }, { once:true });
  }

  video.addEventListener("loadedmetadata", restoreProgress);
  video.addEventListener("timeupdate", () => {
    if(Math.floor(video.currentTime) % 10 === 0) saveProgress();
  });
  video.addEventListener("pause", saveProgress);
  video.addEventListener("ended", saveProgress);
}

$("backBtn").addEventListener("click", () => history.back());
$("copyBtn").addEventListener("click", copyLink);
$("externalBtn").addEventListener("click", openExternal);
$("fullscreenBtn").addEventListener("click", enterFullscreen);
$("favBtn").addEventListener("click", toggleFavorite);
$("playOverlayBtn").addEventListener("click", async () => {
  await video.play().catch(()=>{});
  enterFullscreen();
  $("overlay").style.display = "none";
});

video.addEventListener("play", () => { $("overlay").style.display = "none"; });
video.addEventListener("pause", () => { $("overlay").style.display = "flex"; });

initPlayer();
