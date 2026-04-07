function $(id){ return document.getElementById(id); }

const item = (() => {
  try{
    const raw = sessionStorage.getItem("iptv_current_item");
    return raw ? JSON.parse(raw) : null;
  }catch{
    return null;
  }
})();

const video = $("video");
let hls = null;
let mpegtsPlayer = null;
let progressTick = -1;
let activePlaybackItem = null;

function readStore(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch{
    return fallback;
  }
}

function writeStore(key, value){
  localStorage.setItem(key, JSON.stringify(value));
}

function itemKey(entry){
  return [entry.type || "", entry.title || "", entry.url || entry.stream_url || ""].join("||");
}

function getFavorites(){ return readStore("iptv_v2_favorites", []); }
function setFavorites(value){ writeStore("iptv_v2_favorites", value); }
function getProgress(){ return readStore("iptv_v2_progress", []); }
function setProgress(value){ writeStore("iptv_v2_progress", value); }

function updateFavoriteUI(){
  if(!item) return;
  const exists = getFavorites().some(x => x.key === itemKey(item));
  $("favBtn").textContent = exists ? "Retirer favori" : "Ajouter favori";
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
  const current = activePlaybackItem || item;
  if(!current || !video || !isFinite(video.currentTime)) return;
  const progress = getProgress().filter(x => x.key !== itemKey(current));
  progress.unshift({ key: itemKey(current), item: current, currentTime: video.currentTime, savedAt: Date.now() });
  setProgress(progress.slice(0, 300));
}

function restoreProgress(){
  const current = activePlaybackItem || item;
  if(!current) return;
  const hit = getProgress().find(x => x.key === itemKey(current));
  if(hit && Number(hit.currentTime) > 5){
    try{
      video.currentTime = Number(hit.currentTime);
    }catch{}
  }
}

async function copyLink(){
  const url = activePlaybackItem?.stream_url || activePlaybackItem?.url || item?.stream_url || item?.url || "";
  try{
    await navigator.clipboard.writeText(url);
    setStatus("Lien copié dans le presse-papiers.");
    setTimeout(() => setStatus(""), 2000);
  }catch{
    setStatus("Impossible de copier le lien.");
  }
}

/**
 * CORRECTION : Ouvrir les liens externes dans un nouvel onglet au lieu de remplacer la page courante
 * Cela préserve l'application et permet à l'utilisateur de revenir au catalogue.
 */
function openExternal(){
  const url = activePlaybackItem?.stream_url || activePlaybackItem?.url || item?.stream_url || item?.url || "";
  if(url) window.open(url, "_blank");
}

async function enterFullscreen(){
  try{
    if(video.requestFullscreen) await video.requestFullscreen();
  }catch{}
}

function clearPlayers(){
  if(hls){
    hls.destroy();
    hls = null;
  }
  if(mpegtsPlayer){
    mpegtsPlayer.destroy();
    mpegtsPlayer = null;
  }
  video.removeAttribute("src");
  video.load();
}

function setStatus(message){
  const node = $("playbackStatus");
  if(!node) return;
  node.hidden = !message;
  node.textContent = message || "";
}

function firstSeriesEpisode(){
  if(!item || item.type !== "series" || !item.episodes || typeof item.episodes !== "object") return null;
  const seasons = Object.keys(item.episodes).sort((a, b) => Number(a) - Number(b));
  for(const season of seasons){
    const episodes = Array.isArray(item.episodes[season]) ? item.episodes[season] : [];
    if(episodes.length) return episodes[0];
  }
  return null;
}

function buildSeriesEpisodeUrl(episode){
  if(episode?.url || episode?.stream_url) return episode.url || episode.stream_url;
  const raw = item?.stream_url || item?.url || "";
  if(!raw || !episode?.id) return "";

  try{
    const parsed = new URL(raw);
    const username = parsed.searchParams.get("username");
    const password = parsed.searchParams.get("password");
    const extension = episode.container_extension || "mp4";
    if(!username || !password) return "";
    return `${parsed.origin}/series/${username}/${password}/${episode.id}.${extension}`;
  }catch{
    return "";
  }
}

function selectedEpisode(){
  if(!item || item.type !== "series") return null;
  if(item.selected_episode) return item.selected_episode;
  return null;
}

function resolvePlaybackItem(){
  if(!item) return null;

  const manualEpisode = selectedEpisode();
  if(manualEpisode){
    const manualUrl = manualEpisode.url || manualEpisode.stream_url || buildSeriesEpisodeUrl(manualEpisode);
    return {
      type: "series",
      title: manualEpisode.title || item.title || "Episode",
      category_name: item.category_name || item.category || "",
      plot: manualEpisode.info?.plot || manualEpisode.plot || item.plot || "",
      stream_icon: manualEpisode.info?.movie_image || item.stream_icon || "",
      stream_url: manualUrl,
      url: manualUrl
    };
  }

  if(item.type === "series"){
    const episode = firstSeriesEpisode();
    const episodeUrl = buildSeriesEpisodeUrl(episode);
    if(episode && episodeUrl){
      return {
        type: "series",
        title: episode.title || item.title || "Episode",
        category_name: item.category_name || item.category || "",
        plot: episode.info?.plot || item.plot || "",
        stream_icon: episode.info?.movie_image || item.stream_icon || "",
        stream_url: episodeUrl,
        url: episodeUrl
      };
    }
  }

  return item;
}

/**
 * CORRECTION MAJEURE : Amélioration de la détection des formats et de la gestion des erreurs
 * - Détection plus robuste des formats HLS et MPEG-TS
 * - Fallback automatique après erreur HLS
 * - Meilleure gestion des formats non supportés
 */
function loadSource(playbackItem){
  clearPlayers();
  progressTick = -1;
  setStatus("");
  activePlaybackItem = playbackItem;

  const url = playbackItem?.stream_url || playbackItem?.url || "";
  if(!url){
    setStatus("Aucune URL de lecture disponible.");
    return;
  }

  // Détection améliorée des formats
  const isHls = /\.m3u8(\?|$)/i.test(url) || /hls|m3u8/i.test(url);
  const isTransportStream = /\.ts(\?|$)/i.test(url) || /mpegts|transport/i.test(url);
  const isMpeg2Ts = /\.ts(\?|$)/i.test(url);
  
  // Détection des formats non supportés nativement
  const unsupportedFormats = /\.(mkv|avi|flv|wmv|webm)(\?|$)/i;
  const isUnsupported = unsupportedFormats.test(url);

  // Tentative HLS si détecté
  if(isHls && window.Hls && window.Hls.isSupported()){
    hls = new Hls({ 
      enableWorker: true, 
      lowLatencyMode: true,
      maxBufferLength: 30,
      maxMaxBufferLength: 600
    });
    
    hls.loadSource(url);
    hls.attachMedia(video);
    
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      restoreProgress();
      video.play().catch(() => {});
      setTimeout(enterFullscreen, 250);
    });
    
    hls.on(Hls.Events.ERROR, (event, data) => {
      // Fallback automatique en cas d'erreur HLS
      if(data.fatal){
        console.warn("Erreur HLS fatale, tentative de lecture native...", data);
        clearPlayers();
        // Fallback : essayer la lecture native
        video.src = url;
        video.addEventListener("loadedmetadata", () => {
          restoreProgress();
          video.play().catch(() => {});
        }, { once: true });
      }
    });
    return;
  }

  // Tentative MPEG-TS si détecté
  if(isTransportStream && window.mpegts && window.mpegts.isSupported()){
    try{
      mpegtsPlayer = window.mpegts.createPlayer({
        type: "mpegts",
        isLive: playbackItem?.type === "live",
        url
      });
      mpegtsPlayer.attachMediaElement(video);
      mpegtsPlayer.load();
      video.play().catch(() => {});
      setTimeout(enterFullscreen, 250);
      return;
    }catch(e){
      console.warn("Erreur MPEG-TS, fallback à lecture native...", e);
      clearPlayers();
    }
  }

  // Avertissement pour formats non supportés
  if(isUnsupported){
    setStatus("Format non supporté nativement par le navigateur. Essayez le lien direct ou un lecteur externe.");
  }

  // Lecture native HTML5 (fallback par défaut)
  video.src = url;
  video.addEventListener("loadedmetadata", () => {
    restoreProgress();
    video.play().catch(() => {});
    setTimeout(enterFullscreen, 250);
  }, { once: true });

  if(isTransportStream && !window.mpegts){
    setStatus("Flux live détecté. Chargement du moteur MPEG-TS...");
  }
}

function initPlayer(){
  if(!item){
    $("playerTitle").textContent = "Aucune video";
    $("plotText").textContent = "Aucune description.";
    return;
  }

  const playbackItem = resolvePlaybackItem();

  $("playerTitle").textContent = playbackItem?.title || item.title || "Lecture";
  $("playerMeta").textContent = [
    item.type === "vod" ? "Film" : item.type === "series" ? "Series" : "Live",
    item.category_name || item.category || ""
  ].filter(Boolean).join(" • ");
  $("plotText").textContent = playbackItem?.plot || item.plot || "Aucune description.";
  updateFavoriteUI();

  if(item.type === "series" && playbackItem !== item){
    setStatus("Lecture du premier episode disponible.");
  }

  loadSource(playbackItem);
}

$("backBtn").addEventListener("click", () => history.back());
$("copyBtn").addEventListener("click", copyLink);
$("externalBtn").addEventListener("click", openExternal);
$("fullscreenBtn").addEventListener("click", enterFullscreen);
$("favBtn").addEventListener("click", toggleFavorite);
$("playOverlayBtn").addEventListener("click", async () => {
  await video.play().catch(() => {});
  enterFullscreen();
  $("overlay").style.display = "none";
});

video.addEventListener("loadedmetadata", restoreProgress);
video.addEventListener("timeupdate", () => {
  const currentSecond = Math.floor(video.currentTime || 0);
  if(currentSecond > 0 && currentSecond % 10 === 0 && currentSecond !== progressTick){
    progressTick = currentSecond;
    saveProgress();
  }
});
video.addEventListener("pause", saveProgress);
video.addEventListener("ended", saveProgress);
video.addEventListener("play", () => {
  $("overlay").style.display = "none";
  if($("playbackStatus")?.textContent === "Lecture du premier episode disponible.") return;
  setStatus("");
});
video.addEventListener("pause", () => {
  $("overlay").style.display = "flex";
});
video.addEventListener("error", (e) => {
  const errorCode = video.error?.code;
  let errorMsg = "Lecture impossible dans ce navigateur pour ce flux.";
  
  if(errorCode === 1) errorMsg = "Lecture annulée.";
  else if(errorCode === 2) errorMsg = "Erreur réseau lors du chargement.";
  else if(errorCode === 3) errorMsg = "Décodage échoué. Format non supporté ou fichier corrompu.";
  else if(errorCode === 4) errorMsg = "Format vidéo non supporté.";
  
  setStatus(errorMsg + " Essayez le lien direct.");
});

initPlayer();
