/**
 * PIPSIFLIX PLAYER — v4.1
 * Fixes : progress tracking, overlay, MKV/AVI Android, mixed content, favori
 */

"use strict";

const item = JSON.parse(sessionStorage.getItem("iptv_current_item") || "null");

function $(id){ return document.getElementById(id); }

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g,
    c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ─── Détection appareil ────────────────────────────────────────────────────────

const UA        = navigator.userAgent;
const isAndroid = /Android/i.test(UA);
const isTV      = /TV|GoogleTV|SmartTV/i.test(UA) ||
                  (isAndroid && !UA.includes("Mobile"));
const isIOS     = /iP(hone|ad|od)/i.test(UA);

// ─── Progress tracking ─────────────────────────────────────────────────────────
// Clé IDENTIQUE à app.js pour que la progression soit visible dans le catalogue
const PROGRESS_KEY = "pf_progress_v4";

function getProgress(){
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}"); }
  catch { return {}; }
}

function saveProgress(key, pct){
  const p = getProgress();
  p[key] = { pct, ts: Date.now() };
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch {}
}

function currentEpKey(){
  if(!item || item.type !== "series") return null;
  // progress_key est fourni directement par playEpisode() dans app.js
  return item.progress_key || null;
}

// ─── Favoris ──────────────────────────────────────────────────────────────────

const FAV_KEY = "pf_favorites_v4";

function getFavs(){
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); }
  catch { return []; }
}

function itemKey(it){
  return `${it.type || "vod"}||${it.id || ""}||${it.title || ""}`;
}

function isFav(it){ return getFavs().some(x => x.key === itemKey(it)); }

function toggleFav(it){
  if(!it) return;
  const favs = getFavs();
  const key  = itemKey(it);
  const idx  = favs.findIndex(x => x.key === key);
  if(idx >= 0) favs.splice(idx, 1);
  else favs.unshift({ key, item: it, at: Date.now() });
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favs.slice(0, 500))); } catch {}
  updateFavBtn();
}

function updateFavBtn(){
  const btn = $("favBtn");
  if(!btn || !item) return;
  const fav = isFav(item);
  btn.classList.toggle("is-fav", fav);
  btn.title = fav ? "Retirer des favoris" : "Ajouter aux favoris";
  btn.setAttribute("aria-pressed", String(fav));
}

// ─── URL helpers ───────────────────────────────────────────────────────────────

function getExtension(url){
  if(!url) return "";
  try {
    const path = new URL(url).pathname;
    const ext  = path.split(".").pop().toLowerCase();
    return ext.split("?")[0];
  } catch {
    return url.split("?")[0].split(".").pop().toLowerCase();
  }
}

function isHls(url){
  return url.includes(".m3u8") || url.includes("type=m3u8") ||
         url.includes("/hls/") || getExtension(url) === "m3u8";
}

function isMpegTs(url){
  return getExtension(url) === "ts" || url.includes(".ts?") ||
         url.includes("type=ts");
}

// Formats non supportés nativement par la plupart des navigateurs
function isBrowserUnfriendly(url){
  return ["mkv", "avi", "wmv", "flv", "mov"].includes(getExtension(url));
}

// Tente de forcer HTTPS pour éviter le mixed content
function secureUrl(url){
  if(!url) return url;
  if(location.protocol === "https:" && /^http:\/\//i.test(url))
    return url.replace(/^http:\/\//i, "https://");
  return url;
}

// ─── Player instances ──────────────────────────────────────────────────────────

let hlsInst = null, mpegtsInst = null;

function destroyPlayers(){
  if(hlsInst)   { try { hlsInst.destroy(); }   catch {} hlsInst    = null; }
  if(mpegtsInst){ try { mpegtsInst.destroy(); } catch {} mpegtsInst = null; }
  const v = $("video");
  if(v){ v.pause(); v.removeAttribute("src"); v.load(); }
}

// ─── Status / overlay ─────────────────────────────────────────────────────────

function setStatus(msg, type){
  const n = $("playbackStatus");
  if(!n) return;
  n.hidden  = !msg;
  n.textContent = msg || "";
  n.className = "playback-status" + (type === "error" ? " playback-status--error" : "");
}

function showOverlay(){ const o = $("overlay"); if(o) o.style.display = ""; }
function hideOverlay(){ const o = $("overlay"); if(o) o.style.display = "none"; }

// ─── Resolve playback URL ──────────────────────────────────────────────────────

function resolveUrl(){
  if(!item) return null;
  // Après goEpisode(), selected_episode est présent
  if(item.selected_episode){
    const ep = item.selected_episode;
    return ep.url || ep.stream_url || null;
  }
  return item.stream_url || item.url || null;
}

// ─── Intent Android : ouvre l'URL dans le lecteur vidéo système ───────────────

function triggerAndroidIntent(url){
  const title  = encodeURIComponent(item?.title || "");
  const intent = `intent:${url}#Intent;action=android.intent.action.VIEW;type=video/*;S.title=${title};end`;

  // Cacher immédiatement le carré noir de la vidéo
  const video = $("video");
  if(video){ video.style.display = "none"; }
  hideOverlay();

  // Afficher un écran "Lecture lancée" propre à la place du carré noir
  const shell = document.querySelector(".player-shell");
  if(shell){
    shell.insertAdjacentHTML("beforeend", `
      <div id="intentScreen" style="
        position:fixed;inset:0;z-index:999;
        background:linear-gradient(160deg,#05101f,#08182e);
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;
        color:#fff;padding:32px;text-align:center;">
        <div style="font-size:52px">▶</div>
        <div style="font-size:20px;font-weight:700">${item?.title || "Lecture"}</div>
        <div style="font-size:14px;color:#8ca8cc">Ouverture dans le lecteur vidéo…</div>
        <button onclick="history.back()" style="
          margin-top:16px;padding:14px 28px;border-radius:14px;border:none;
          background:linear-gradient(135deg,#ff3d5e,#ff9f2c);
          color:#fff;font-size:16px;font-weight:700;cursor:pointer;">
          ← Retour au catalogue
        </button>
      </div>`);
  }

  // Déclencher l'intent Android
  window.location.href = intent;

  // Retour automatique au catalogue après 2,5 s
  // (si l'utilisateur revient dans Chrome, il ne voit plus le carré noir)
  setTimeout(() => history.back(), 2500);
}

// ─── Lecture native / externe ─────────────────────────────────────────────────

function openNative(){
  // Toujours utiliser l'URL HTTP originale pour le lecteur natif
  // (le lecteur système Android n'a pas de restriction mixed content)
  const url = resolveUrl();
  if(!url) return;
  // Forcer HTTP pour l'Intent (le serveur goldenlink.live est HTTP uniquement)
  const httpUrl = url.replace(/^https:\/\//i, "http://");
  if(isAndroid || isTV){
    triggerAndroidIntent(httpUrl);
  } else if(isIOS){
    window.open(url, "_blank", "noopener");
  } else {
    window.location.href = "vlc://" + httpUrl;
  }
}

// ─── Plein écran ───────────────────────────────────────────────────────────────

function toggleFullscreen(){
  const video = $("video");
  if(!video) return;
  if(document.fullscreenElement){
    document.exitFullscreen?.();
  } else {
    (video.requestFullscreen || video.webkitRequestFullscreen ||
     video.mozRequestFullScreen || video.msRequestFullscreen)?.call(video);
  }
}

// ─── Gestion d'erreur vidéo ────────────────────────────────────────────────────
// rawUrl = URL HTTP originale (sans upgrade HTTPS), utilisée pour l'Intent Android

function handleVideoError(url, rawUrl){
  const video = $("video");
  const err   = video?.error;

  // Sur Android/TV : fallback automatique vers le lecteur vidéo système
  // (pas de restriction mixed content dans les apps natives)
  if(isAndroid || isTV){
    setStatus("Ouverture dans le lecteur vidéo natif…");
    triggerAndroidIntent(rawUrl || url);
    return;
  }

  let msg = "Erreur de lecture.";
  if(err){
    switch(err.code){
      case 1: msg = "Lecture interrompue."; break;
      case 2: msg = "Erreur réseau — vérifiez votre connexion."; break;
      case 3: msg = "Erreur de décodage vidéo."; break;
      case 4:
        msg = isBrowserUnfriendly(url)
          ? `Format ${getExtension(url).toUpperCase()} non supporté. Utilisez ▶ Lecture native.`
          : "Format non supporté. Utilisez ▶ Lecture native.";
        break;
    }
  }
  setStatus(msg, "error");
  showOverlay();
}

// ─── Stratégies de lecture ────────────────────────────────────────────────────

function playHls(video, url, storedPct){
  if(typeof Hls !== "undefined" && Hls.isSupported()){
    hlsInst = new Hls({ enableWorker: true, lowLatencyMode: true });
    hlsInst.loadSource(url);
    hlsInst.attachMedia(video);
    hlsInst.on(Hls.Events.MANIFEST_PARSED, () => {
      setStatus("");
      if(storedPct > 2 && video.duration)
        video.currentTime = video.duration * storedPct / 100;
      video.play().catch(() => setStatus("Appuyez sur ▶ pour démarrer"));
    });
    hlsInst.on(Hls.Events.ERROR, (_, d) => {
      if(d.fatal){
        if(d.type === Hls.ErrorTypes.NETWORK_ERROR){
          hlsInst.startLoad();
        } else if(d.type === Hls.ErrorTypes.MEDIA_ERROR){
          hlsInst.recoverMediaError();
        } else {
          setStatus("Erreur HLS fatale. Essayez ▶ Lecture native.", "error");
          showOverlay();
        }
      }
    });
  } else if(video.canPlayType("application/vnd.apple.mpegurl")){
    // Safari / iOS : HLS natif
    video.src = url;
    video.play().catch(() => setStatus("Appuyez sur ▶ pour démarrer"));
  } else {
    setStatus("HLS non supporté. Essayez ▶ Lecture native.", "error");
    showOverlay();
  }
}

function playMpegTs(video, url){
  if(typeof mpegts !== "undefined" && mpegts.getFeatureList().mseLivePlayback){
    mpegtsInst = mpegts.createPlayer({
      type: "mse", url,
      isLive: item?.type === "live",
      enableWorker: true
    });
    mpegtsInst.attachMediaElement(video);
    mpegtsInst.load();
    mpegtsInst.play().catch(() => {
      video.src = url;
      video.play().catch(() => setStatus("Erreur MPEG-TS.", "error"));
    });
  } else {
    video.src = url;
    video.play().catch(() => setStatus("Format TS non supporté.", "error"));
  }
}

function playNative(video, url, storedPct){
  video.src = url;
  video.addEventListener("canplay", () => {
    if(storedPct > 2 && video.duration)
      video.currentTime = video.duration * storedPct / 100;
  }, { once: true });
  video.play().catch(() => {
    const ext = getExtension(url).toUpperCase();
    setStatus(
      isBrowserUnfriendly(url)
        ? `Format ${ext} non supporté. Utilisez ▶ Lecture native.`
        : "Impossible de lire ce flux. Utilisez ▶ Lecture native.",
      "error"
    );
  });
}

// ─── Init player ──────────────────────────────────────────────────────────────

function initPlayer(){
  if(!item){ setStatus("Aucun média sélectionné.", "error"); return; }

  const rawUrl = resolveUrl();
  if(!rawUrl){ setStatus("URL de lecture introuvable.", "error"); return; }

  // Tente HTTPS si la page est en HTTPS (évite mixed content)
  const url = secureUrl(rawUrl);

  // UI : titre, sous-titre, synopsis
  const label = item.episode_label
    ? `${item.title} — ${item.episode_label}`
    : item.title || "Lecture";
  const sub = item.episode_title || item.category_name || "";

  if($("playerTitle")) $("playerTitle").textContent = label;
  if($("playerSub"))   $("playerSub").textContent   = sub;
  if($("plotText"))    $("plotText").textContent     = item.plot || "Aucune description.";

  updateNavButtons();
  updateFavBtn();

  const video = $("video");
  if(!video) return;

  destroyPlayers();
  showOverlay();
  setStatus("Chargement du flux…");

  // Événements vidéo → overlay + statut
  // onerror reçoit les deux URLs : url (HTTPS tenté) et rawUrl (HTTP original pour Intent)
  video.onplaying = () => { hideOverlay(); setStatus(""); };
  video.onpause   = () => { if(!video.ended) showOverlay(); };
  video.onended   = () => showOverlay();
  video.onerror   = () => handleVideoError(url, rawUrl);

  // Reprise de progression
  const epK       = currentEpKey();
  const storedPct = epK ? (getProgress()[epK]?.pct || 0) : 0;

  // MKV / AVI sur Android/TV : ouvrir directement dans le lecteur système (HTTP natif ok)
  if(isBrowserUnfriendly(rawUrl) && (isAndroid || isTV)){
    setStatus("Ouverture dans le lecteur vidéo système…");
    setTimeout(() => triggerAndroidIntent(rawUrl), 400);
    return;
  }

  setTimeout(() => {
    if(isHls(url)){
      playHls(video, url, storedPct);
    } else if(isMpegTs(url)){
      playMpegTs(video, url);
    } else {
      playNative(video, url, storedPct);
    }
  }, 150);

  // Suivi de progression toutes les 5 s
  if(epK){
    const tracker = setInterval(() => {
      if(!video || video.ended || video.paused || !video.duration) return;
      const pct = (video.currentTime / video.duration) * 100;
      if(pct > 1) saveProgress(epK, pct);
    }, 5000);

    video.addEventListener("ended", () => {
      clearInterval(tracker);
      saveProgress(epK, 100);
      // Auto-lecture épisode suivant après 3 s
      setTimeout(() => goNext(), 3000);
    }, { once: true });
  }
}

// ─── Navigation prev / next épisode ───────────────────────────────────────────

function getEpList(){ return Array.isArray(item?.all_episodes) ? item.all_episodes : []; }
function getCurIdx(){ return typeof item?.current_ep_index === "number" ? item.current_ep_index : -1; }

function updateNavButtons(){
  const list    = getEpList();
  const idx     = getCurIdx();
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
    progress_key:     ep.progress_key,
    plot:             ep.plot || item.plot || "",
    selected_episode: { ...ep, stream_url: ep.url },
    current_ep_index: newIdx
  };

  sessionStorage.setItem("iptv_current_item", JSON.stringify(updated));
  location.reload();
}

function goPrev(){ goEpisode(getCurIdx() - 1); }
function goNext(){ goEpisode(getCurIdx() + 1); }

// ─── Bindings UI ───────────────────────────────────────────────────────────────

if($("backBtn"))       $("backBtn").onclick      = () => history.back();
if($("prevEpBtn"))     $("prevEpBtn").onclick     = goPrev;
if($("nextEpBtn"))     $("nextEpBtn").onclick     = goNext;
if($("fullscreenBtn")) $("fullscreenBtn").onclick = toggleFullscreen;
if($("nativeBtn"))     $("nativeBtn").onclick     = openNative;

if($("favBtn")) $("favBtn").onclick = () => { if(item) toggleFav(item); };

if($("copyBtn")) $("copyBtn").onclick = () => {
  const url = resolveUrl();
  if(!url) return;
  const btn = $("copyBtn");
  navigator.clipboard?.writeText(url)
    .then(() => {
      if(btn){ btn.textContent = "✓ Copié !"; setTimeout(() => btn.textContent = "⎘ Copier le lien", 2000); }
    })
    .catch(() => {
      // Fallback sans clipboard API (iOS, contextes non-sécurisés)
      const ta = document.createElement("textarea");
      ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      if(btn){ btn.textContent = "✓ Copié !"; setTimeout(() => btn.textContent = "⎘ Copier le lien", 2000); }
    });
};

if($("externalBtn")) $("externalBtn").onclick = () => {
  const url  = resolveUrl();
  if(!url) return;
  const http = url.replace(/^https?:\/\//i, "http://");
  if(isAndroid || isTV) triggerAndroidIntent(http);
  else window.open(url, "_blank", "noopener,noreferrer");
};

if($("vlcBtn")) $("vlcBtn").onclick = () => {
  const url  = resolveUrl();
  if(!url) return;
  const http = url.replace(/^https?:\/\//i, "http://");
  if(isAndroid || isTV){
    // Intent ciblant VLC spécifiquement
    window.location.href =
      `intent:${http}#Intent;action=android.intent.action.VIEW;type=video/*;package=org.videolan.vlc;S.title=${encodeURIComponent(item?.title||"")};end`;
  } else {
    window.location.href = "vlc://" + http;
  }
};

if($("playOverlayBtn")) $("playOverlayBtn").onclick = () => {
  const v = $("video");
  if(v) v.paused ? v.play() : v.pause();
};

// ─── Clavier / télécommande TV ─────────────────────────────────────────────────

document.addEventListener("keydown", e => {
  const k     = e.key;
  const video = $("video");

  if(["Escape","GoBack","BrowserBack","Back"].includes(k)){
    e.preventDefault(); history.back();

  } else if(["Enter"," ","MediaPlayPause"].includes(k)){
    e.preventDefault();
    if(video) video.paused ? video.play() : video.pause();

  } else if(k === "ArrowRight" || k === "FastForward"){
    if(video){ e.preventDefault(); video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); }

  } else if(k === "ArrowLeft" || k === "Rewind"){
    if(video){ e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 10); }

  } else if(k === "ArrowUp"){
    if(video){ e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); }

  } else if(k === "ArrowDown"){
    if(video){ e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); }

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
