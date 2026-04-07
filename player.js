const item = JSON.parse(sessionStorage.getItem("iptv_current_item") || "null");

function $(id){ return document.getElementById(id); }

function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[s]));
}

function getExtension(url){
  if(!url) return "mp4";
  try {
    const path = new URL(url).pathname;
    const ext = path.split(".").pop().toLowerCase();
    return ["mp4", "mkv", "ts", "m3u8"].includes(ext) ? ext : "mp4";
  } catch(e) {
    const parts = url.split("?")[0].split(".");
    const ext = parts.length > 1 ? parts.pop().toLowerCase() : "mp4";
    return ["mp4", "mkv", "ts", "m3u8"].includes(ext) ? ext : "mp4";
  }
}

function isHls(url){
  return getExtension(url) === "m3u8" || url.includes(".m3u8") || url.includes("type=m3u8");
}

function isMpegTs(url){
  return getExtension(url) === "ts" || url.includes(".ts") || url.includes("type=ts");
}

let hlsInstance = null;
let mpegtsInstance = null;

function destroyPlayers(){
  if(hlsInstance){
    hlsInstance.destroy();
    hlsInstance = null;
  }
  if(mpegtsInstance){
    mpegtsInstance.destroy();
    mpegtsInstance = null;
  }
  const video = $("mainVideo");
  video.pause();
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
  if(!episode) return "";
  
  // CORRECTION : Priorité absolue à l'URL directe si elle existe
  if(episode.url && !episode.url.includes("get_series_info")) return episode.url;
  if(episode.stream_url && !episode.stream_url.includes("get_series_info")) return episode.stream_url;
  
  const raw = item?.stream_url || item?.url || "";
  if(!raw || !episode.id) return "";

  try{
    const parsed = new URL(raw);
    const username = parsed.searchParams.get("username");
    const password = parsed.searchParams.get("password");
    const extension = episode.container_extension || "mkv";
    
    if(!username || !password) return "";
    
    // CORRECTION : S'assurer que l'URL pointe vers /series/ et non /player_api.php
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
    const manualUrl = buildSeriesEpisodeUrl(manualEpisode);
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

function initPlayer(){
  if(!item){
    setStatus("Aucun média sélectionné.");
    return;
  }

  const playItem = resolvePlaybackItem();
  const url = playItem.stream_url || playItem.url;
  
  if(!url){
    setStatus("URL de lecture introuvable.");
    return;
  }

  $("playerTitle").textContent = playItem.title || "Lecture";
  $("playerMeta").textContent = playItem.category_name || "";
  $("playerPlot").textContent = playItem.plot || "";
  $("externalLink").href = url;

  const video = $("mainVideo");
  destroyPlayers();
  setStatus("Chargement du flux...");

  if(isHls(url)){
    if(Hls.isSupported()){
      hlsInstance = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 60
      });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        setStatus("");
        video.play().catch(() => setStatus("Cliquez sur Play pour démarrer"));
      });
      hlsInstance.on(Hls.Events.ERROR, (event, data) => {
        if(data.fatal){
          switch(data.type){
            case Hls.ErrorTypes.NETWORK_ERROR:
              setStatus("Erreur réseau HLS. Tentative de lecture native...");
              video.src = url;
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hlsInstance.recoverMediaError();
              break;
            default:
              destroyPlayers();
              setStatus("Erreur fatale HLS.");
              break;
          }
        }
      });
    }else if(video.canPlayType("application/vnd.apple.mpegurl")){
      video.src = url;
      video.addEventListener("loadedmetadata", () => {
        setStatus("");
        video.play();
      });
    }else{
      setStatus("HLS non supporté par votre navigateur.");
    }
  }else if(isMpegTs(url)){
    if(mpegts.getFeatureList().mseLivePlayback){
      mpegtsInstance = mpegts.createPlayer({ type: "mse", url: url, isLive: item.type === "live" });
      mpegtsInstance.attachMediaElement(video);
      mpegtsInstance.load();
      mpegtsInstance.play().then(() => setStatus("")).catch(() => setStatus("Erreur de lecture MPEG-TS."));
    }else{
      setStatus("MPEG-TS non supporté (MSE manquant).");
      video.src = url;
    }
  }else{
    // MP4, MKV, etc.
    video.src = url;
    video.play()
      .then(() => setStatus(""))
      .catch(e => {
        console.error("Native play error:", e);
        setStatus("Format vidéo non supporté nativement. Essayez le lien direct.");
      });
  }
}

$("backBtn").addEventListener("click", () => {
  history.back();
});

$("externalLink").addEventListener("click", (e) => {
  // Le lien s'ouvre déjà dans un nouvel onglet via target="_blank" dans le HTML
});

window.addEventListener("load", initPlayer);
