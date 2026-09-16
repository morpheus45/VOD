"use strict";
const item = JSON.parse(sessionStorage.getItem("iptv_current_item") || "null");
function $(id) {
  return document.getElementById(id);
}
function escapeHtml(s) {
  return String(s != null ? s : "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
const UA = navigator.userAgent;
const isAndroid = /Android/i.test(UA);
const isTV = /TV|GoogleTV|SmartTV|AndroidTV/i.test(UA) || isAndroid && !UA.includes("Mobile") || window.PIPSILY_NATIVE === "android_tv";
const isIOS = /iP(hone|ad|od)/i.test(UA);
const isNative = typeof window.AndroidBridge !== "undefined";
const PROGRESS_KEY = "pf_progress_v4";
function getProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
  } catch (e) {
    return {};
  }
}
function saveProgress(key, pct) {
  const p = getProgress();
  p[key] = { pct, ts: Date.now() };
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch (e) {
  }
}
function currentEpKey() {
  if (!item || item.type !== "series") return null;
  return item.progress_key || null;
}
const FAV_KEY = "pf_favorites_v4";
function getFavs() {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
  } catch (e) {
    return [];
  }
}
function itemKey(it) {
  return `${it.type || "vod"}||${it.id || ""}||${it.title || ""}`;
}
function isFav(it) {
  return getFavs().some((x) => x.key === itemKey(it));
}
function toggleFav(it) {
  if (!it) return;
  const favs = getFavs();
  const key = itemKey(it);
  const idx = favs.findIndex((x) => x.key === key);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.unshift({ key, item: it, at: Date.now() });
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(favs.slice(0, 500)));
  } catch (e) {
  }
  updateFavBtn();
}
function updateFavBtn() {
  const btn = $("favBtn");
  if (!btn || !item) return;
  const fav = isFav(item);
  btn.classList.toggle("is-fav", fav);
  btn.title = fav ? "Retirer des favoris" : "Ajouter aux favoris";
  btn.setAttribute("aria-pressed", String(fav));
}
function getExtension(url) {
  if (!url) return "";
  try {
    const path = new URL(url).pathname;
    return path.split(".").pop().toLowerCase().split("?")[0];
  } catch (e) {
    return url.split("?")[0].split(".").pop().toLowerCase();
  }
}
function isHls(url) {
  return url.includes(".m3u8") || url.includes("type=m3u8") || url.includes("/hls/");
}
function isMpegTs(url) {
  return getExtension(url) === "ts" || url.includes(".ts?");
}
function isBrowserUnfriendly(url) {
  return ["mkv", "avi", "wmv", "flv", "mov"].includes(getExtension(url));
}
function isHttpUrl(url) {
  return /^http:/i.test(url);
}
let hlsInst = null, mpegtsInst = null;
function destroyPlayers() {
  if (hlsInst) {
    try {
      hlsInst.destroy();
    } catch (e) {
    }
    hlsInst = null;
  }
  if (mpegtsInst) {
    try {
      mpegtsInst.destroy();
    } catch (e) {
    }
    mpegtsInst = null;
  }
  const v = $("video");
  if (v) {
    v.pause();
    v.removeAttribute("src");
    v.load();
  }
}
function setStatus(msg, type) {
  const n = $("playbackStatus");
  if (!n) return;
  n.hidden = !msg;
  n.textContent = msg || "";
  n.className = "playback-status" + (type === "error" ? " playback-status--error" : "");
}
function showOverlay() {
  const o = $("overlay");
  if (o) o.style.display = "";
}
function hideOverlay() {
  const o = $("overlay");
  if (o) o.style.display = "none";
}
function parseCredsFromUrl(streamUrl) {
  if (!streamUrl) return null;
  try {
    const u = new URL(streamUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "movie" && parts.length >= 3)
      return { base: u.origin, username: parts[1], password: parts[2] };
    const usr = u.searchParams.get("username");
    const pwd = u.searchParams.get("password");
    if (usr && pwd) return { base: u.origin, username: usr, password: pwd };
  } catch (e) {
  }
  return null;
}
async function loadPlotFromApi(it) {
  var _a, _b, _c;
  const streamUrl = it.stream_url || it.url || "";
  const creds = parseCredsFromUrl(streamUrl);
  if (!creds) return null;
  let apiUrl;
  const isSeries = it.type === "series" || !!it.series_id;
  if (isSeries) {
    const sid = it.series_id || it.id || "";
    if (!sid) return null;
    apiUrl = `${creds.base}/player_api.php?username=${creds.username}&password=${creds.password}&action=get_series_info&series_id=${sid}`;
  } else {
    const vodId = it.id || it.stream_id || "";
    if (!vodId) return null;
    apiUrl = `${creds.base}/player_api.php?username=${creds.username}&password=${creds.password}&action=get_vod_info&vod_id=${vodId}`;
  }
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8e3);
    const r = await fetch(apiUrl.replace(/^https?:\/\//i, "http://"), { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) return null;
    const d = await r.json();
    return ((_a = d == null ? void 0 : d.info) == null ? void 0 : _a.plot) || ((_b = d == null ? void 0 : d.info) == null ? void 0 : _b.description) || ((_c = d == null ? void 0 : d.movie_data) == null ? void 0 : _c.plot) || null;
  } catch (e) {
    return null;
  }
}
function resolveUrl() {
  if (!item) return null;
  if (item.selected_episode) {
    const ep = item.selected_episode;
    return ep.url || ep.stream_url || null;
  }
  return item.stream_url || item.url || null;
}
function openExternalPlayer(rawUrl) {
  var _a;
  const httpUrl = rawUrl.replace(/^https?:\/\//i, "http://");
  const title = (item == null ? void 0 : item.title) || "";
  const video = $("video");
  if (video) {
    video.style.display = "none";
  }
  hideOverlay();
  setStatus("");
  const old = document.getElementById("intentScreen");
  if (old) old.remove();
  const shell = document.querySelector(".player-shell");
  if (isNative && ((_a = window.AndroidBridge) == null ? void 0 : _a.openVideo)) {
    try {
      window.AndroidBridge.openVideo(httpUrl, title);
    } catch (e) {
    }
    setTimeout(() => history.back(), 1200);
    return;
  }
  const encodedTitle = encodeURIComponent(title);
  window.location.href = `intent:${httpUrl}#Intent;action=android.intent.action.VIEW;type=video/*;S.title=${encodedTitle};package=org.videolan.vlc;S.browser_fallback_url=https%3A%2F%2Fgithub.com%2Fmorpheus45%2FVOD%2Freleases%2Flatest;end`;
  if (shell) {
    shell.insertAdjacentHTML("beforeend", `
      <div id="intentScreen" style="
        position:fixed;inset:0;z-index:999;
        background:linear-gradient(160deg,#05101f,#08182e);
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        gap:16px;color:#fff;padding:32px;text-align:center;">
        <div style="font-size:52px">📺</div>
        <div style="font-size:18px;font-weight:700;max-width:320px">${escapeHtml(title)}</div>
        <div style="font-size:13px;color:#8ca8cc;max-width:300px;line-height:1.5">
          Ouverture dans VLC…<br>
          <span style="opacity:.7">Si rien ne s'ouvre, utilisez l'application PIPSILY :</span>
        </div>
        <a href="https://github.com/morpheus45/VOD/releases/latest" target="_blank"
          style="display:inline-block;margin-top:4px;padding:13px 28px;border-radius:13px;border:none;
          background:linear-gradient(135deg,#7B5FE8,#38A8E8);
          color:#fff;font-size:15px;font-weight:700;text-decoration:none">
          📥 Installer PIPSILY
        </a>
        <button onclick="history.back()" style="
          padding:11px 28px;border-radius:12px;border:1px solid rgba(255,255,255,.15);
          background:transparent;color:#8ca8cc;font-size:14px;cursor:pointer">
          ← Retour au catalogue
        </button>
      </div>`);
  }
  setTimeout(() => {
    if (document.getElementById("intentScreen")) history.back();
  }, 4e3);
}
function handleVideoError(url, rawUrl) {
  const video = $("video");
  const err = video == null ? void 0 : video.error;
  if (isAndroid || isTV) {
    openExternalPlayer(rawUrl || url);
    return;
  }
  let msg = "Erreur de lecture.";
  if (err) {
    switch (err.code) {
      case 1:
        msg = "Lecture interrompue.";
        break;
      case 2:
        msg = "Erreur réseau — vérifiez votre connexion.";
        break;
      case 3:
        msg = "Erreur de décodage vidéo.";
        break;
      case 4:
        msg = isBrowserUnfriendly(url) ? `Format ${getExtension(url).toUpperCase()} non supporté. Utilisez ▶ Lecture native.` : "Format non supporté. Utilisez ▶ Lecture native.";
        break;
    }
  }
  setStatus(msg, "error");
  showOverlay();
}
function playHls(video, url, storedPct) {
  if (typeof Hls !== "undefined" && Hls.isSupported()) {
    hlsInst = new Hls({ enableWorker: true, lowLatencyMode: true });
    hlsInst.loadSource(url);
    hlsInst.attachMedia(video);
    hlsInst.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      setStatus("");
      const tracks = hlsInst.audioTracks || [];
      const frIdx = tracks.findIndex(
        (t) => /^fr/i.test(t.lang || "") || /fran[cç]/i.test(t.name || "") || t.lang === "fre"
      );
      if (frIdx >= 0) hlsInst.audioTrack = frIdx;
      if (storedPct > 2 && video.duration)
        video.currentTime = video.duration * storedPct / 100;
      video.play().catch(() => setStatus("Appuyez sur ▶ pour démarrer"));
    });
    hlsInst.on(Hls.Events.ERROR, (_, d) => {
      if (d.fatal) {
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hlsInst.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hlsInst.recoverMediaError();
        else {
          setStatus("Erreur HLS. Essayez ▶ Lecture native.", "error");
          showOverlay();
        }
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.play().catch(() => setStatus("Appuyez sur ▶ pour démarrer"));
  } else {
    setStatus("HLS non supporté. Essayez ▶ Lecture native.", "error");
    showOverlay();
  }
}
function playMpegTs(video, url) {
  if (typeof mpegts !== "undefined" && mpegts.getFeatureList().mseLivePlayback) {
    mpegtsInst = mpegts.createPlayer({ type: "mse", url, enableWorker: true });
    mpegtsInst.attachMediaElement(video);
    mpegtsInst.load();
    mpegtsInst.play().catch(() => {
      video.src = url;
      video.play().catch(() => {
      });
    });
  } else {
    video.src = url;
    video.play().catch(() => setStatus("Format TS non supporté.", "error"));
  }
}
function playNative(video, url, storedPct) {
  video.src = url;
  video.addEventListener("canplay", () => {
    if (storedPct > 2 && video.duration)
      video.currentTime = video.duration * storedPct / 100;
  }, { once: true });
  video.play().catch(() => {
    setStatus(
      isBrowserUnfriendly(url) ? `Format ${getExtension(url).toUpperCase()} non supporté. Utilisez ▶ Lecture native.` : "Impossible de lire ce flux. Utilisez ▶ Lecture native.",
      "error"
    );
  });
}
function initPlayer() {
  var _a;
  if (!item) {
    setStatus("Aucun média sélectionné.", "error");
    return;
  }
  const rawUrl = resolveUrl();
  if (!rawUrl) {
    setStatus("URL de lecture introuvable.", "error");
    return;
  }
  const label = item.episode_label ? `${item.title} — ${item.episode_label}` : item.title || "Lecture";
  const sub = item.episode_title || item.category_name || "";
  if ($("playerTitle")) $("playerTitle").textContent = label;
  if ($("playerSub")) $("playerSub").textContent = sub;
  document.title = label + " — PIPSILY";
  if ($("plotText")) $("plotText").textContent = item.plot || "Chargement du synopsis…";
  if (!item.plot) {
    loadPlotFromApi(item).then((plot) => {
      if ($("plotText")) {
        $("plotText").textContent = plot || "Aucune description disponible.";
      }
    });
  }
  updateNavButtons();
  updateFavBtn();
  if ((isAndroid || isTV) && isHttpUrl(rawUrl)) {
    setStatus("Ouverture dans le lecteur vidéo…");
    setTimeout(() => openExternalPlayer(rawUrl), 300);
    return;
  }
  const url = rawUrl;
  const video = $("video");
  if (!video) return;
  destroyPlayers();
  showOverlay();
  setStatus("Chargement du flux…");
  video.onplaying = () => {
    hideOverlay();
    setStatus("");
  };
  video.onpause = () => {
    if (!video.ended) showOverlay();
  };
  video.onended = () => showOverlay();
  video.onerror = () => handleVideoError(url, rawUrl);
  const epK = currentEpKey();
  const storedPct = epK ? ((_a = getProgress()[epK]) == null ? void 0 : _a.pct) || 0 : 0;
  setTimeout(() => {
    if (isHls(url)) {
      playHls(video, url, storedPct);
    } else if (isMpegTs(url)) {
      playMpegTs(video, url);
    } else {
      playNative(video, url, storedPct);
    }
  }, 150);
  if (epK) {
    const tracker = setInterval(() => {
      if (!video || video.ended || video.paused || !video.duration) return;
      const pct = video.currentTime / video.duration * 100;
      if (pct > 1) saveProgress(epK, pct);
    }, 5e3);
    video.addEventListener("ended", () => {
      clearInterval(tracker);
      saveProgress(epK, 100);
      setTimeout(() => goNext(), 3e3);
    }, { once: true });
  }
}
function getEpList() {
  return Array.isArray(item == null ? void 0 : item.all_episodes) ? item.all_episodes : [];
}
function getCurIdx() {
  return typeof (item == null ? void 0 : item.current_ep_index) === "number" ? item.current_ep_index : -1;
}
function updateNavButtons() {
  const list = getEpList();
  const idx = getCurIdx();
  const p = $("prevEpBtn");
  const n = $("nextEpBtn");
  if (p) p.disabled = idx <= 0 || !list.length;
  if (n) n.disabled = idx < 0 || idx >= list.length - 1;
}
function goEpisode(newIdx) {
  const list = getEpList();
  if (newIdx < 0 || newIdx >= list.length) return;
  const ep = list[newIdx];
  if (!ep || !ep.url) return;
  const updated = {
    ...item,
    episode_label: `S${String(ep.season).padStart(2, "0")}E${String(ep.episode_num).padStart(2, "0")}`,
    episode_title: ep.title,
    stream_url: ep.url,
    url: ep.url,
    progress_key: ep.progress_key,
    plot: ep.plot || item.plot || "",
    selected_episode: { ...ep, stream_url: ep.url },
    current_ep_index: newIdx
  };
  sessionStorage.setItem("iptv_current_item", JSON.stringify(updated));
  location.reload();
}
function goPrev() {
  goEpisode(getCurIdx() - 1);
}
function goNext() {
  goEpisode(getCurIdx() + 1);
}
function openNative() {
  const rawUrl = resolveUrl();
  if (!rawUrl) return;
  const httpUrl = rawUrl.replace(/^https?:\/\//i, "http://");
  if (isAndroid || isTV) {
    openExternalPlayer(httpUrl);
  } else if (isIOS) {
    window.open(rawUrl, "_blank", "noopener");
  } else {
    window.location.href = "vlc://" + httpUrl;
  }
}
function goBackToApp() {
  window.location.href = "index.html";
}
if ($("backBtn")) $("backBtn").onclick = goBackToApp;
if ($("prevEpBtn")) $("prevEpBtn").onclick = goPrev;
if ($("nextEpBtn")) $("nextEpBtn").onclick = goNext;
if ($("fullscreenBtn")) $("fullscreenBtn").onclick = () => {
  var _a, _b;
  const v = $("video");
  if (!v) return;
  if (document.fullscreenElement) (_a = document.exitFullscreen) == null ? void 0 : _a.call(document);
  else (_b = v.requestFullscreen || v.webkitRequestFullscreen || v.mozRequestFullScreen) == null ? void 0 : _b.call(v);
};
if ($("nativeBtn")) $("nativeBtn").onclick = openNative;
if ($("favBtn")) $("favBtn").onclick = () => {
  if (item) toggleFav(item);
};
if ($("copyBtn")) $("copyBtn").onclick = () => {
  var _a;
  const url = resolveUrl();
  if (!url) return;
  const btn = $("copyBtn");
  (_a = navigator.clipboard) == null ? void 0 : _a.writeText(url).then(() => {
    btn.textContent = "✓ Copié !";
    setTimeout(() => btn.textContent = "⎘ Copier le lien", 2e3);
  }).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    btn.textContent = "✓ Copié !";
    setTimeout(() => btn.textContent = "⎘ Copier le lien", 2e3);
  });
};
if ($("externalBtn")) $("externalBtn").onclick = () => {
  const u = resolveUrl();
  if (!u) return;
  if (isAndroid || isTV) openExternalPlayer(u.replace(/^https?:\/\//i, "http://"));
  else window.open(u, "_blank", "noopener,noreferrer");
};
if ($("vlcBtn")) $("vlcBtn").onclick = () => {
  const u = resolveUrl();
  if (!u) return;
  const http = u.replace(/^https?:\/\//i, "http://");
  if (isAndroid || isTV)
    window.location.href = `intent:${http}#Intent;action=android.intent.action.VIEW;type=video/*;package=org.videolan.vlc;end`;
  else window.location.href = "vlc://" + http;
};
if ($("playOverlayBtn")) $("playOverlayBtn").onclick = () => {
  const v = $("video");
  if (v) v.paused ? v.play() : v.pause();
};
document.addEventListener("keydown", (e) => {
  var _a;
  const k = e.key;
  const video = $("video");
  if (["Escape", "GoBack", "BrowserBack", "Back"].includes(k)) {
    e.preventDefault();
    goBackToApp();
  } else if (["Enter", " ", "MediaPlayPause"].includes(k)) {
    e.preventDefault();
    if (video) video.paused ? video.play() : video.pause();
  } else if (k === "ArrowRight" || k === "FastForward") {
    if (video) {
      e.preventDefault();
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
    }
  } else if (k === "ArrowLeft" || k === "Rewind") {
    if (video) {
      e.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 10);
    }
  } else if (k === "ArrowUp") {
    if (video) {
      e.preventDefault();
      video.volume = Math.min(1, video.volume + 0.1);
    }
  } else if (k === "ArrowDown") {
    if (video) {
      e.preventDefault();
      video.volume = Math.max(0, video.volume - 0.1);
    }
  } else if (k === "f" || k === "F") {
    (_a = document.getElementById("fullscreenBtn")) == null ? void 0 : _a.click();
  } else if (k === "n" || k === "N" || k === "ChannelUp") {
    goNext();
  } else if (k === "p" || k === "P" || k === "ChannelDown") {
    goPrev();
  }
});
initPlayer();
