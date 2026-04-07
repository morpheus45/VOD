/**
 * PIPSIFLIX PLAYER - Version 2.3
 * Résolution définitive des problèmes de lecture
 */

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
    try { hlsInstance.destroy(); } catch(e) {}
    hlsInstance = null;
  }
  if(mpegtsInstance){
    try { mpegtsInstance.destroy(); } catch(e) {}
    mpegtsInstance = null;
  }
  const video = $("video");
  if(video){
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
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
  if(episode.url && !episode.url.includes("get_series_info") && !episode.url.includes("player_api")) return episode.url;
  if(episode.stream_url && !episode.stream_url.includes("get_series_info") && !episode.stream_url.includes("player_api")) return episode.stream_url;
  
  const raw = item?.stream_url || item?.url || "";
  if(!raw || !episode.id) return "";

  try{
    const parsed = new URL(raw);
    const username = parsed.searchParams.get("username");
    const password = parsed.searchParams.get("password");
    const extension = episode.container_extension || "mkv";
    if(!username || !password) return "";
    return `${parsed.origin}/series/${username}/${password}/${episode.id}.${extension}`;
  }catch(e){
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
  if($("playerTitle")) $("playerTitle").textContent = playItem.title || "Lecture";
  if($("playerMeta")) $("playerMeta").textContent = playItem.category_name || "";
  if($("plotText")) $("plotText").textContent = playItem.plot || "Aucune description.";
  const video = $("video");
  if(!video) return;
  destroyPlayers();
  setStatus("Chargement du flux...");

  const tryLoad = () => {
    if(isHls(url)){
      if(typeof Hls !== "undefined" && Hls.isSupported()){
        hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: true });
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          setStatus("");
          video.play().catch(() => setStatus("Cliquez sur Play pour démarrer"));
        });
        hlsInstance.on(Hls.Events.ERROR, (event, data) => {
          if(data.fatal) hlsInstance.recoverMediaError();
        });
      } else if(video.canPlayType("application/vnd.apple.mpegurl")){
        video.src = url;
        video.play().then(() => setStatus("")).catch(() => {});
      } else {
        video.src = url;
        video.play().catch(() => setStatus("HLS non supporté."));
      }
    } else if(isMpegTs(url)){
      if(typeof mpegts !== "undefined" && mpegts.getFeatureList().mseLivePlayback){
        mpegtsInstance = mpegts.createPlayer({ type: "mse", url: url, isLive: item.type === "live" });
        mpegtsInstance.attachMediaElement(video);
        mpegtsInstance.load();
        mpegtsInstance.play().then(() => setStatus("")).catch(() => {
          video.src = url;
          video.play().catch(() => setStatus("Erreur MPEG-TS."));
        });
      } else {
        video.src = url;
        video.play().then(() => setStatus("")).catch(() => setStatus("Format non supporté."));
      }
    } else {
      video.src = url;
      video.play().then(() => setStatus("")).catch(() => setStatus("Format non supporté nativement."));
    }
  };
  setTimeout(tryLoad, 200);
}

if($("backBtn")) $("backBtn").onclick = () => history.back();
if($("externalBtn")) $("externalBtn").onclick = () => {
  const playItem = resolvePlaybackItem();
  const url = playItem.stream_url || playItem.url;
  if(url) window.open(url, "_blank");
};
if($("copyBtn")) $("copyBtn").onclick = () => {
  const playItem = resolvePlaybackItem();
  const url = playItem.stream_url || playItem.url;
  if(url){ navigator.clipboard.writeText(url).then(() => alert("Lien copié !")); }
};

initPlayer();
window.addEventListener("load", initPlayer);
