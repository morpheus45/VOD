/**
 * PIPSIFLIX PLAYER — v3.0
 * HLS / MPEG-TS / MP4 — Navigation prev/next épisode — Android TV
 */

const item = JSON.parse(sessionStorage.getItem("iptv_current_item") || "null");

function $(id){ return document.getElementById(id); }

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g,
    c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ─── Progress tracking ─────────────────────────────────────────────────────────

function getProgress(){ try{ return JSON.parse(localStorage.getItem("iptv_v3_progress") || "{}"); } catch{ return {}; } }
function saveProgress(key, pct){
  const p = getProgress();
  p[key] = { pct, ts: Date.now() };
  localStorage.setItem("iptv_v3_progress", JSON.stringify(p));
}

function currentEpKey(){
  if(!item || item.type !== "series") return null;
  if(item.selected_episode && item.season && item.selected_episode.episode_num){
    return `${item.title}||S${item.season}E${item.selected_episode.episode_num}`;
  }
  return null;
}

// ─── URL helpers ───────────────────────────────────────────────────────────────

function getExtension(url){
  if(!url) return "mp4";
  try{
    const path = new URL(url).pathname;
    const ext  = path.split(".").pop().toLowerCase();
    return ["mp4","mkv","ts","m3u8"].includes(ext) ? ext : "mp4";
  } catch{
    const ext = url.split("?")[0].split(".").pop().toLowerCase();
    return ["mp4","mkv","ts","m3u8"].includes(ext) ? ext : "mp4";
  }
}
function isHls(url){ return url.includes(".m3u8") || url.includes("type=m3u8") || getExtension(url) === "m3u8"; }
function isMpegTs(url){ return getExtension(url) === "ts" || url.includes(".ts?") || url.includes("type=ts"); }

// ─── Player instances ──────────────────────────────────────────────────────────

let hlsInst = null, mpegtsInst = null;

function destroyPlayers(){
  if(hlsInst)   { try{ hlsInst.destroy(); }    catch(e){} hlsInst    = null; }
  if(mpegtsInst){ try{ mpegtsInst.destroy(); }  catch(e){} mpegtsInst = null; }
  const v = $("video");
  if(v){ v.pause(); v.removeAttribute("src"); v.load(); }
}

function setStatus(msg){
  const n = $("playbackStatus");
  if(!n) return;
  n.hidden = !msg;
  n.textContent = msg || "";
}

// ─── Resolve playback URL ──────────────────────────────────────────────────────

function resolveUrl(){
  if(!item) return null;
  // Épisode sélectionné dans la session
  if(item.selected_episode){
    const ep = item.selected_episode;
    return ep.url || ep.stream_url || null;
  }
  return item.stream_url || item.url || null;
}

// ─── Init player ──────────────────────────────────────────────────────────────

function initPlayer(){
  if(!item){ setStatus("Aucun média sélectionné."); return; }

  const url = resolveUrl();
  if(!url){ setStatus("URL de lecture introuvable."); return; }

  // UI infos
  const label = item.episode_label
    ? `${item.title} — ${item.episode_label}`
    : item.title || "Lecture";
  const sub = item.episode_title || item.category_name || "";

  if($("playerTitle")) $("playerTitle").textContent = label;
  if($("playerSub"))   $("playerSub").textContent   = sub;
  if($("plotText"))    $("plotText").textContent     = item.plot || "Aucune description.";

  // Nav prev/next
  updateNavButtons();

  const video = $("video");
  if(!video) return;

  destroyPlayers();
  setStatus("Chargement du flux…");

  // Reprise de progression
  const epK = currentEpKey();
  const storedPct = epK ? (getProgress()[epK]?.pct || 0) : 0;

  setTimeout(() => {
    if(isHls(url)){
      if(typeof Hls !== "undefined" && Hls.isSupported()){
        hlsInst = new Hls({ enableWorker:true, lowLatencyMode:true });
        hlsInst.loadSource(url);
        hlsInst.attachMedia(video);
        hlsInst.on(Hls.Events.MANIFEST_PARSED, () => {
          setStatus("");
          if(storedPct > 2 && video.duration){
            video.currentTime = video.duration * storedPct / 100;
          }
          video.play().catch(() => setStatus("Cliquez ▶ pour démarrer"));
        });
        hlsInst.on(Hls.Events.ERROR, (_, d) => {
          if(d.fatal) hlsInst.recoverMediaError();
        });
      } else if(video.canPlayType("application/vnd.apple.mpegurl")){
        video.src = url;
        video.play().then(() => setStatus("")).catch(() => {});
      } else {
        setStatus("HLS non supporté sur cet appareil.");
      }

    } else if(isMpegTs(url)){
      if(typeof mpegts !== "undefined" && mpegts.getFeatureList().mseLivePlayback){
        mpegtsInst = mpegts.createPlayer({ type:"mse", url, isLive: item.type === "live" });
        mpegtsInst.attachMediaElement(video);
        mpegtsInst.load();
        mpegtsInst.play().then(() => setStatus("")).catch(() => {
          video.src = url;
          video.play().catch(() => setStatus("Erreur MPEG-TS."));
        });
      } else {
        video.src = url;
        video.play().then(() => setStatus("")).catch(() => setStatus("Format non supporté."));
      }

    } else {
      video.src = url;
      video.play().then(() => {
        setStatus("");
        if(storedPct > 2 && video.duration)
          video.currentTime = video.duration * storedPct / 100;
      }).catch(() => setStatus("Format non supporté nativement."));
    }
  }, 200);

  // Sauvegarde de progression toutes les 5s
  if(epK){
    const tracker = setInterval(() => {
      if(!video || video.ended || video.paused) return;
      const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
      if(pct > 1) saveProgress(epK, pct);
    }, 5000);
    video.addEventListener("ended", () => {
      clearInterval(tracker);
      saveProgress(epK, 100);
      // Auto-play épisode suivant après 3s
      setTimeout(() => goNext(), 3000);
    });
  }
}

// ─── Navigation prev / next épisode ───────────────────────────────────────────

function getEpList(){ return Array.isArray(item?.all_episodes) ? item.all_episodes : []; }
function getCurIdx() { return typeof item?.current_ep_index === "number" ? item.current_ep_index : -1; }

function updateNavButtons(){
  const list  = getEpList();
  const idx   = getCurIdx();
  const prevBtn = $("prevEpBtn");
  const nextBtn = $("nextEpBtn");
  if(prevBtn) prevBtn.disabled = (idx <= 0 || list.length === 0);
  if(nextBtn) nextBtn.disabled = (idx < 0 || idx >= list.length - 1);
}

function goEpisode(newIdx){
  const list = getEpList();
  if(newIdx < 0 || newIdx >= list.length) return;

  const ep = list[newIdx];
  if(!ep || !ep.url) return;

  const updated = {
    ...item,
    episode_label:    `S${String(ep.season).padStart(2,"0")}E${String(ep.episode_num).padStart(2,"0")}`,
    episode_title:    ep.title,
    stream_url:       ep.url,
    url:              ep.url,
    selected_episode: { ...ep, stream_url: ep.url },
    current_ep_index: newIdx
  };

  sessionStorage.setItem("iptv_current_item", JSON.stringify(updated));
  location.reload();
}

function goPrev(){ goEpisode(getCurIdx() - 1); }
function goNext(){ goEpisode(getCurIdx() + 1); }

// ─── Lecture native / externe ──────────────────────────────────────────────────

function openNative(){
  const url = resolveUrl();
  if(!url) return;

  const isAndroid = /Android/i.test(navigator.userAgent);
  const isTV      = /TV|GoogleTV|SmartTV/i.test(navigator.userAgent) ||
                    (navigator.userAgent.includes("Android") && !navigator.userAgent.includes("Mobile"));

  if(isAndroid || isTV){
    // Intent Android — ouvre dans le lecteur vidéo système
    const intent = `intent:${url}#Intent;action=android.intent.action.VIEW;type=video/*;S.title=${encodeURIComponent(item.title || "")};end`;
    window.location.href = intent;
  } else {
    window.location.href = "vlc://" + url;
  }
}

// ─── Plein écran ───────────────────────────────────────────────────────────────

function toggleFullscreen(){
  const video = $("video");
  if(!video) return;
  if(document.fullscreenElement){
    document.exitFullscreen?.();
  } else {
    (video.requestFullscreen || video.webkitRequestFullscreen)?.call(video);
  }
}

// ─── Bindings UI ───────────────────────────────────────────────────────────────

if($("backBtn"))       $("backBtn").onclick      = () => history.back();
if($("prevEpBtn"))     $("prevEpBtn").onclick     = goPrev;
if($("nextEpBtn"))     $("nextEpBtn").onclick     = goNext;
if($("fullscreenBtn")) $("fullscreenBtn").onclick = toggleFullscreen;
if($("nativeBtn"))     $("nativeBtn").onclick     = openNative;
if($("copyBtn"))       $("copyBtn").onclick       = () => {
  const url = resolveUrl();
  if(url) navigator.clipboard.writeText(url).then(() => alert("Lien copié !"));
};
if($("externalBtn"))   $("externalBtn").onclick   = () => {
  const url = resolveUrl();
  if(url) window.open(url, "_blank");
};
if($("vlcBtn"))        $("vlcBtn").onclick        = () => {
  const url = resolveUrl();
  if(url) window.location.href = "vlc://" + url;
};
if($("playOverlayBtn")) $("playOverlayBtn").onclick = () => $("video")?.play();

// ─── Clavier / télécommande ────────────────────────────────────────────────────

document.addEventListener("keydown", e => {
  const k = e.key;
  const video = $("video");

  if(k === "Escape" || k === "GoBack" || k === "BrowserBack" || k === "Back"){
    history.back();
  } else if(k === "Enter" || k === " " || k === "MediaPlayPause"){
    e.preventDefault();
    if(video) video.paused ? video.play() : video.pause();
  } else if(k === "ArrowRight" || k === "FastForward"){
    if(video){ e.preventDefault(); video.currentTime += 10; }
  } else if(k === "ArrowLeft" || k === "Rewind"){
    if(video){ e.preventDefault(); video.currentTime -= 10; }
  } else if(k === "ArrowUp"){
    if(video){ e.preventDefault(); video.volume = Math.min(1, video.volume + .1); }
  } else if(k === "ArrowDown"){
    if(video){ e.preventDefault(); video.volume = Math.max(0, video.volume - .1); }
  } else if(k === "f" || k === "F"){
    toggleFullscreen();
  } else if(k === "n" || k === "N" || k === "ChannelUp"){
    goNext();
  } else if(k === "p" || k === "P" || k === "ChannelDown"){
    goPrev();
  }
});

// ─── Init ──────────────────────────────────────────────────────────────────────

initPlayer();
