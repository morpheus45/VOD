"use strict";
const STORE = {
  favorites: "pf_favorites_v4",
  history: "pf_history_v4",
  progress: "pf_progress_v4"
};
const PER_PAGE = 48;
const SENTINEL_M = "300px";
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
const isSafariIOS = isIOS && /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS|OPiOS|EdgiOS/i.test(navigator.userAgent);
const isIOSContext = isIOS;
const S = {
  type: "vod",
  vod: [],
  series: [],
  live: [],
  cat: "",
  search: "",
  quality: "",
  region: localStorage.getItem("pipsily_region") || "",
  _liveRegionIdx: null,
  // construit une fois, resetté si live recharge
  sort: "title",
  shown: { vod: 0, series: 0, live: 0 },
  favOnly: false,
  loading: false,
  // Panneau séries
  panel: {
    open: false,
    series: null,
    seasonsMap: {},
    // { "1": [ep,...], "2": [...] }
    seasonsMeta: [],
    // [ { num, name, cover, count } ]
    selSeason: null
  },
  // Cache en mémoire des épisodes chargés
  epCache: {},
  // Base pré-générée (episodes_part*.json) — chargée en lazy au 1er clic série
  epDb: {}
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s != null ? s : "").replace(
  /[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
);
function displayCat(name) {
  return String(name || "").replace(/^EU\s*\|\s*/i, "").trim();
}
const PipPlayer = {
  _hls: null,
  _item: null,
  _epList: [],
  _epIdx: -1,
  _progTimer: null,
  _lastFocus: null,
  // focus à restaurer après fermeture du lecteur natif (TV)
  // ── Ouvrir le lecteur avec un item ──────────────────────────────
  open(item) {
    var _a, _b;
    this._item = item;
    this._epList = item._epList || [];
    this._epIdx = (_a = item._epIdx) != null ? _a : -1;
    const url = preparePlutoUrl(item.url || item.stream_url || "");
    const label = item.episode_label ? `${item.title} — ${item.episode_label}` : item.title || "Lecture";
    const sub = item.episode_title || item.category_name || "";
    if (typeof ((_b = window.AndroidBridge) == null ? void 0 : _b.openPlayer) === "function") {
      _markNativePlayback();
      this._lastFocus = document.activeElement;
      pushHist(item);
      if (item.type === "series" && this._epList.length > 0) {
        const sid = String(item.series_id || item.id || "");
        if (sid) {
          if (!window._epUrlMap) window._epUrlMap = {};
          this._epList.forEach((ep) => {
            if (!ep.url) return;
            const s = String(ep.season || 1).padStart(2, "0");
            const e = String(ep.episode_num || 1).padStart(2, "0");
            window._epUrlMap[ep.url] = ep.progress_key || `${sid}||S${s}E${e}`;
          });
        }
      }
      const epsJson = this._epList.length > 1 ? JSON.stringify(this._epList.map((ep) => ({
        url: ep.url || ep.stream_url || "",
        title: ep.title || "",
        episode_label: ep.episode_label || ep.episode_num ? `S${String(ep.season || 1).padStart(2, "0")}E${String(ep.episode_num || 1).padStart(2, "0")}` : ""
      }))) : "[]";
      const savedMs = _getSavedProgressMs(item);
      if (savedMs > 0 && typeof window.AndroidBridge.openPlayerAt === "function") {
        window.AndroidBridge.openPlayerAt(url, item.title || label, sub, epsJson, this._epIdx, savedMs);
      } else {
        window.AndroidBridge.openPlayer(url, item.title || label, sub, epsJson, this._epIdx);
      }
      return;
    }
    if (isIOSContext) {
      pushHist(item);
      this._openAVPlayer(item);
      return;
    }
    const _isMixedContent = /^http:/i.test(url) && location.protocol === "https:";
    if (_isMixedContent) {
      pushHist(item);
      this._openOverlay(item);
      return;
    }
    const el = $("pip-player");
    el.classList.add("pip-open");
    document.body.style.overflow = "hidden";
    el.scrollTop = 0;
    $("pip-title").textContent = label;
    $("pip-sub").textContent = sub;
    document.title = label + " — PIPSILY";
    $("pip-plot").textContent = item.plot || "Chargement du synopsis…";
    if (!item.plot) this._loadPlot(item);
    this._updateEpNav();
    this._updateFavBtn();
    this._hideStatus();
    this._loadVideo(item);
  },
  // ── Fermer le lecteur ───────────────────────────────────────────
  close() {
    const video = $("pip-video");
    if (video) {
      this._saveProgress();
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }
    clearTimeout(this._progTimer);
    $("pip-player").classList.remove("pip-open");
    document.body.style.overflow = "";
    document.title = "PIPSILY";
    const closedItem = this._item;
    this._item = null;
    if (typeof renderContinueRow === "function") renderContinueRow();
    if (S.panel.open && !S.panel.isVod && typeof renderPanel === "function") renderPanel();
    if (closedItem) _refreshCardProgress(closedItem);
  },
  // ── Sélection automatique de la piste audio française ──────────
  _setFrenchAudio() {
    if (!this._hls) return;
    const tracks = this._hls.audioTracks;
    if (!tracks || tracks.length <= 1) return;
    const frIdx = tracks.findIndex(
      (t) => /^fr/i.test(t.lang || "") || /fran[çc]/i.test(t.name || "") || /french/i.test(t.name || "")
    );
    if (frIdx >= 0 && frIdx !== this._hls.audioTrack) {
      console.log(`[PipPlayer] Piste audio FR sélectionnée : ${tracks[frIdx].name} (lang=${tracks[frIdx].lang})`);
      this._hls.audioTrack = frIdx;
    }
  },
  // ── Chargement vidéo ────────────────────────────────────────────
  _loadVideo(item) {
    var _a;
    const video = $("pip-video");
    if (!video) return;
    video.removeAttribute("src");
    video.load();
    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }
    const rawUrl = preparePlutoUrl((item.url || item.stream_url || "").trim());
    const url = secureUrl(rawUrl);
    if (!url) {
      this._showStatus("❌ Aucune URL de lecture disponible.", true);
      return;
    }
    const isHLS = /\.m3u8/i.test(url) || item.type === "live";
    const isPcBrowser = !isIOSContext && typeof window.AndroidBridge === "undefined";
    const _openNativeFallback = () => {
      var _a2;
      if (typeof ((_a2 = window.AndroidBridge) == null ? void 0 : _a2.openInVlc) === "function") {
        _markNativePlayback();
        this._showStatus("⚠️ Ouverture du lecteur natif…", false);
        setTimeout(() => {
          var _a3;
          try {
            window.AndroidBridge.openInVlc(rawUrl, ((_a3 = this._item) == null ? void 0 : _a3.title) || "", false);
          } catch (e) {
            window.open(rawUrl, "_blank", "noopener");
          }
        }, 600);
      } else {
        this._showStatus(
          "❌ Ce flux ne peut pas être lu dans le navigateur. Utilisez « 🔗 Copier le lien » (à ouvrir dans VLC), ou l'application sur TV/mobile.",
          true
        );
      }
    };
    if (isHLS && ((_a = window.Hls) == null ? void 0 : _a.isSupported())) {
      const tryHls = (src, onFatal) => {
        this._hls = new Hls({ maxBufferLength: 30, enableWorker: false });
        this._hls.loadSource(src);
        this._hls.attachMedia(video);
        this._hls.on(Hls.Events.MANIFEST_PARSED, () => {
          this._setFrenchAudio();
          video.play().catch(() => {
          });
        });
        this._hls.on(Hls.Events.ERROR, (_, d) => {
          if (d.fatal) {
            this._hls.destroy();
            this._hls = null;
            onFatal();
          }
        });
      };
      if (isPcBrowser && rawUrl !== url) {
        tryHls(url, () => {
          this._showStatus("⚠️ Nouvel essai sur le flux HTTP d'origine…", false);
          tryHls(rawUrl, () => {
            this._showStatus(
              "❌ Le navigateur bloque les flux HTTP sur ce site HTTPS. Pour lire les vidéos sur PC : cliquez le cadenas 🔒 dans la barre d'adresse → « Paramètres du site » → « Contenu non sécurisé » → Autoriser, puis rechargez la page. Sinon, utilisez 🔗 Copier le lien et ouvrez-le dans VLC.",
              true
            );
          });
        });
      } else {
        tryHls(url, () => {
          if (isPcBrowser) {
            this._showStatus("⚠️ Basculement sur flux original…", false);
            video.src = rawUrl;
            video.play().catch(() => _openNativeFallback());
          } else {
            this._showStatus("⚠️ Basculement lecture native…", false);
            video.src = url;
            video.play().catch(() => _openNativeFallback());
          }
        });
      }
    } else if (isHLS && video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.play().catch(() => {
      });
    } else {
      video.src = url;
      video.play().catch(() => {
      });
    }
    video.onerror = () => {
      if (isPcBrowser && video.src !== rawUrl) {
        video.src = rawUrl;
        video.play().catch(() => _openNativeFallback());
      } else {
        this._showStatus("⚠️ Le flux ne peut pas être lu ici — ouverture du lecteur natif…", false);
        setTimeout(_openNativeFallback, 800);
      }
    };
    video.addEventListener("loadedmetadata", () => this._restoreProgress(), { once: true });
    video.ontimeupdate = () => {
      clearTimeout(this._progTimer);
      this._progTimer = setTimeout(() => this._saveProgress(), 5e3);
    };
  },
  // ── Progression ─────────────────────────────────────────────────
  _saveProgress() {
    const video = $("pip-video");
    if (!video || !this._item || video.currentTime < 5) return;
    const prog = getProg();
    const key = this._item.progress_key || String(this._item.id || this._item.stream_id || "");
    if (!key) return;
    const dur = video.duration && isFinite(video.duration) ? Math.floor(video.duration) : 0;
    prog[key] = { t: Math.floor(video.currentTime), d: dur, ts: Date.now() };
    storeSet(STORE.progress, prog);
  },
  _restoreProgress() {
    const video = $("pip-video");
    if (!video || !this._item) return;
    const prog = getProg();
    const key = this._item.progress_key || String(this._item.id || this._item.stream_id || "");
    const saved = prog[key];
    if (!saved) return;
    if (saved.t > 10 && saved.t < (video.duration || Infinity) - 30) {
      video.currentTime = saved.t;
    } else if (saved.pct > 0.01 && saved.pct < 0.97 && video.duration && isFinite(video.duration)) {
      video.currentTime = saved.pct * video.duration;
    }
  },
  // ── Synopsis lazy-load ──────────────────────────────────────────
  _loadPlot(item) {
    const streamUrl = item.stream_url || item.url || "";
    let creds = null;
    try {
      const u = new URL(streamUrl);
      const pts = u.pathname.split("/").filter(Boolean);
      if ((pts[0] === "movie" || pts[0] === "series" || pts[0] === "live") && pts.length >= 4)
        creds = { base: u.origin, username: pts[1], password: pts[2] };
      else {
        const usr = u.searchParams.get("username");
        const pwd = u.searchParams.get("password");
        if (usr && pwd) creds = { base: u.origin, username: usr, password: pwd };
      }
      if (!creds && pts.length >= 3 && !pts[0].includes("."))
        creds = { base: u.origin, username: pts[0], password: pts[1] };
    } catch (e) {
    }
    if (!creds && item.username && item.password && item.server)
      creds = { base: item.server, username: item.username, password: item.password };
    if (!creds) {
      if ($("pip-plot")) $("pip-plot").textContent = "Synopsis non disponible pour ce contenu.";
      return;
    }
    const isSeries = item.type === "series" || !!item.series_id;
    const id = isSeries ? item.series_id || item.id : item.id || item.stream_id;
    if (!id) {
      if ($("pip-plot")) $("pip-plot").textContent = "Synopsis non disponible pour ce contenu.";
      return;
    }
    const action = isSeries ? `get_series_info&series_id=${id}` : `get_vod_info&vod_id=${id}`;
    const apiUrl = `${creds.base}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}&action=${action}`;
    const ctrl = new AbortController();
    const _tid = setTimeout(() => ctrl.abort(), 1e4);
    fetch(apiUrl, { signal: ctrl.signal, credentials: "omit" }).then((r) => {
      clearTimeout(_tid);
      return r.ok ? r.json() : null;
    }).then((d) => {
      var _a, _b, _c, _d, _e;
      const plot = ((_a = d == null ? void 0 : d.info) == null ? void 0 : _a.plot) || ((_b = d == null ? void 0 : d.info) == null ? void 0 : _b.description) || ((_c = d == null ? void 0 : d.info) == null ? void 0 : _c.overview) || ((_d = d == null ? void 0 : d.movie_data) == null ? void 0 : _d.plot) || ((_e = d == null ? void 0 : d.movie_data) == null ? void 0 : _e.description) || null;
      if ($("pip-plot")) $("pip-plot").textContent = plot || "Synopsis non renseigné par le fournisseur.";
    }).catch(() => {
      clearTimeout(_tid);
      if ($("pip-plot")) $("pip-plot").textContent = "Synopsis non disponible (erreur réseau).";
    });
  },
  // ── Favoris — utilise le système global (format {key,item,at}) ──
  _updateFavBtn() {
    const btn = $("pip-fav");
    if (!btn || !this._item) return;
    const fav = isFav(this._item);
    btn.classList.toggle("pip-is-fav", fav);
    btn.textContent = fav ? "♥" : "♡";
  },
  toggleFav() {
    if (!this._item) return;
    toggleFav(this._item);
    this._updateFavBtn();
  },
  // ── Navigation épisodes ─────────────────────────────────────────
  _updateEpNav() {
    const nav = $("pip-ep-nav");
    const prev = $("pip-prev");
    const next = $("pip-next");
    if (!nav) return;
    const hasList = this._epList.length > 1;
    nav.hidden = !hasList;
    if (prev) prev.disabled = this._epIdx <= 0;
    if (next) next.disabled = this._epIdx < 0 || this._epIdx >= this._epList.length - 1;
  },
  goPrev() {
    if (this._epIdx > 0) this._goEp(this._epIdx - 1);
  },
  goNext() {
    if (this._epIdx < this._epList.length - 1) this._goEp(this._epIdx + 1);
  },
  _goEp(idx) {
    const ep = this._epList[idx];
    if (!ep) return;
    this._saveProgress();
    this._epIdx = idx;
    const s = String(ep.season || 1).padStart(2, "0");
    const e = String(ep.episode_num || idx + 1).padStart(2, "0");
    this.open({
      ...this._item,
      id: ep.id,
      url: ep.url,
      stream_url: ep.url,
      plot: ep.plot || this._item.plot || "",
      episode_label: `S${s}E${e}`,
      episode_title: ep.title || "",
      _epList: this._epList,
      _epIdx: idx
    });
  },
  // ── Statut ──────────────────────────────────────────────────────
  _showStatus(msg, isError = false) {
    const el = $("pip-status");
    if (!el) return;
    el.textContent = msg;
    el.className = "pip-status" + (isError ? " pip-status--error" : "");
    el.hidden = false;
    setTimeout(() => {
      if (el) el.hidden = true;
    }, 6e3);
  },
  _hideStatus() {
    const el = $("pip-status");
    if (el) el.hidden = true;
  },
  // ── Lecture native / externe ─────────────────────────────────────
  openNative() {
    if (!this._item) return;
    const rawUrl = (this._item.url || this._item.stream_url || "").trim();
    if (!rawUrl) return;
    if (!isIOSContext && typeof window.AndroidBridge === "undefined") {
      window.open(rawUrl, "_blank", "noopener");
      return;
    }
    if (typeof window.AndroidBridge !== "undefined") {
      _markNativePlayback();
      try {
        window.AndroidBridge.openInVlc(rawUrl, this._item.title || "", false);
        return;
      } catch (e) {
      }
    }
    window.open(secureUrl(rawUrl), "_blank", "noopener");
  },
  // ── iOS : ouvrir dans VLC (scheme vlc://) ───────────────────────
  openVLC() {
    if (!this._item) return;
    const raw = (this._item.url || this._item.stream_url || "").trim();
    if (!raw) return;
    window.location.href = "vlc://" + raw.replace(/^https?:\/\//i, "");
  },
  // ── iOS : ouvrir dans Infuse ────────────────────────────────────
  openInfuse() {
    if (!this._item) return;
    const url = (this._item.url || this._item.stream_url || "").trim();
    if (!url) return;
    window.location.href = "infuse://x-callback-url/play?url=" + encodeURIComponent(url);
  },
  // ── AVPlayer natif iOS via <video> + webkitEnterFullscreen() ────
  // Méthode dans PipPlayer pour être accessible depuis open() (portée globale)
  _openAVPlayer(item) {
    var _a;
    const url = (item.url || item.stream_url || "").trim();
    if (!url) return;
    const isHttp = /^http:/i.test(url);
    const isHttps = location.protocol === "https:";
    if (isHttp && isHttps) {
      this._openOverlay(item);
      return;
    }
    (_a = document.getElementById("_avp")) == null ? void 0 : _a.remove();
    const vid = document.createElement("video");
    vid.id = "_avp";
    vid.controls = true;
    vid.setAttribute("x-webkit-airplay", "allow");
    vid.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.01;z-index:9998;pointer-events:none";
    vid.src = url;
    document.body.appendChild(vid);
    vid.play().catch(() => {
    });
    if (typeof vid.webkitEnterFullscreen === "function") {
      try {
        vid.webkitEnterFullscreen();
      } catch (e) {
        console.warn("[AVP]", e);
      }
    }
    let _pt;
    vid.addEventListener("timeupdate", () => {
      clearTimeout(_pt);
      _pt = setTimeout(() => {
        if (vid.currentTime < 5) return;
        const k = item.progress_key || itemKey(item);
        const t = Math.floor(vid.currentTime);
        const d = vid.duration && isFinite(vid.duration) ? Math.floor(vid.duration) : 0;
        const pct = d > 0 ? t / d : 0;
        if (pct > 0.01 && pct < 0.98) {
          const p = getProg();
          p[k] = { t, d, ts: Date.now() };
          storeSet(STORE.progress, p);
        }
      }, 5e3);
    });
    vid.addEventListener("loadedmetadata", () => {
      const k = item.progress_key || itemKey(item);
      const saved = getProg()[k];
      if (!saved) return;
      if (saved.t > 10 && saved.t < (vid.duration || Infinity) - 30)
        vid.currentTime = saved.t;
      else if (saved.pct > 0.01 && vid.duration && isFinite(vid.duration))
        vid.currentTime = saved.pct * vid.duration;
    }, { once: true });
    const cleanup = () => {
      clearTimeout(_pt);
      vid.pause();
      vid.src = "";
      vid.remove();
      if (typeof renderContinueRow === "function") renderContinueRow();
    };
    vid.addEventListener("webkitendfullscreen", cleanup, { once: true });
    vid.addEventListener("ended", cleanup, { once: true });
    const fbTimer = setTimeout(() => {
      if (document.getElementById("_avp")) {
        cleanup();
        this._openOverlay(item);
      }
    }, 3e3);
    vid.addEventListener("webkitbeginfullscreen", () => clearTimeout(fbTimer), { once: true });
    vid.addEventListener("webkitendfullscreen", () => clearTimeout(fbTimer), { once: true });
  },
  // ── Lecteur overlay (HLS.js) — utilisé comme fallback iOS et mode navigateur ──
  _openOverlay(item) {
    const url = item.url || item.stream_url || "";
    const label = item.episode_label ? `${item.title} — ${item.episode_label}` : item.title || "Lecture";
    const sub = item.episode_title || item.category_name || "";
    const el = $("pip-player");
    if (!el) return;
    el.classList.add("pip-open");
    document.body.style.overflow = "hidden";
    el.scrollTop = 0;
    $("pip-title").textContent = label;
    $("pip-sub").textContent = sub;
    document.title = label + " — PIPSILY";
    $("pip-plot").textContent = item.plot || "";
    this._updateEpNav();
    this._updateFavBtn();
    this._hideStatus();
    this._loadVideo(item);
  }
};
function storeGet(k, fb) {
  try {
    const r = localStorage.getItem(k);
    return r ? JSON.parse(r) : fb;
  } catch (e) {
    return fb;
  }
}
function storeSet(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch (e) {
  }
}
let _cacheP = null;
let _cacheF = null;
function getProg() {
  if (!_cacheP || typeof _cacheP !== "object" || Array.isArray(_cacheP)) {
    const raw = storeGet(STORE.progress, {});
    _cacheP = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }
  return _cacheP;
}
function getFavs() {
  if (!Array.isArray(_cacheF)) {
    const raw = storeGet(STORE.favorites, []);
    _cacheF = Array.isArray(raw) ? raw : [];
    if (!Array.isArray(raw)) {
      console.warn("[PIPSILY] Favoris corrompus en localStorage — réinitialisation.");
      storeSet(STORE.favorites, []);
    }
  }
  return _cacheF;
}
function _invalidateCache() {
  _cacheP = null;
  _cacheF = null;
}
function _getSeriesPctMap() {
  const prog = getProg();
  const map = {};
  const re = /^(.+)\|\|S\d+E\d+$/;
  for (const [k, e] of Object.entries(prog)) {
    const m = re.exec(k);
    if (!m || !(e == null ? void 0 : e.ts)) continue;
    const sid = m[1];
    const pct = e.t > 0 && e.d > 0 ? e.t / e.d : e.pct > 0 ? e.pct : e.t > 30 ? 0.5 : 0;
    if (pct <= 0) continue;
    if (!map[sid] || e.ts > map[sid].ts) map[sid] = { pct: Math.min(pct, 1), ts: e.ts };
  }
  return map;
}
function _getSavedProgressMs(item) {
  var _a;
  const prog = getProg();
  const key = item.progress_key || String(item.id || item.stream_id || "");
  if (key && ((_a = prog[key]) == null ? void 0 : _a.t) > 10) return prog[key].t * 1e3;
  return 0;
}
function _restoreTvFocus() {
  setTimeout(() => {
    var _a, _b;
    const f = PipPlayer._lastFocus;
    PipPlayer._lastFocus = null;
    if (f && f !== document.body && f.isConnected) {
      f.focus();
      (_a = f.scrollIntoView) == null ? void 0 : _a.call(f, { behavior: "smooth", block: "nearest" });
    } else {
      (_b = document.querySelector(".nrow-card, .card")) == null ? void 0 : _b.focus();
    }
  }, 200);
}
window.onAndroidPlayerClosed = function(url, posMs, durMs) {
  var _a;
  if (!url || !posMs || posMs < 3e4) {
    _restoreTvFocus();
    return;
  }
  const t = Math.floor(posMs / 1e3);
  const d = durMs > 0 && isFinite(durMs) ? Math.floor(durMs / 1e3) : 0;
  const pct = d > 0 ? posMs / durMs : 0;
  if (d > 0 && pct > 0.97) {
    _restoreTvFocus();
    return;
  }
  const prog = getProg();
  const epKey = (_a = window._epUrlMap) == null ? void 0 : _a[url];
  if (epKey) {
    const savePct = d > 0 ? pct : 0.5;
    prog[epKey] = { t, d, pct: savePct, ts: Date.now() };
    storeSet(STORE.progress, prog);
    _invalidateCache();
    if (typeof renderContinueRow === "function") renderContinueRow();
    const sid = epKey.split("||")[0];
    const seriesItem = (S.series || []).find((s) => String(s.id || s.stream_id || "") === sid);
    if (seriesItem) {
      if (typeof _refreshCardProgress === "function") _refreshCardProgress(seriesItem);
    }
    if (S.panel.open && !S.panel.isVod && typeof renderPanel === "function") renderPanel();
    _restoreTvFocus();
    return;
  }
  const all = [...S.vod || [], ...S.series || [], ...S.live || []];
  const item = all.find((x) => (x.url || x.stream_url || "") === url);
  if (item) {
    const id = String(item.id || item.stream_id || "");
    if (id) prog[id] = { t, d, ts: Date.now() };
    prog[itemKey(item)] = { pct, ts: Date.now() };
  } else {
    prog[url] = { pct, ts: Date.now() };
  }
  storeSet(STORE.progress, prog);
  _invalidateCache();
  if (typeof renderContinueRow === "function") renderContinueRow();
  if (item && typeof _refreshCardProgress === "function") _refreshCardProgress(item);
  _restoreTvFocus();
};
function getHist() {
  return storeGet(STORE.history, []);
}
function saveProg(key, pct) {
  const p = getProg();
  p[key] = { pct, ts: Date.now() };
  storeSet(STORE.progress, p);
}
function itemKey(item) {
  return `${item.type || S.type}||${item.id || ""}||${item.title || ""}`;
}
function _refreshCardProgress(playedItem) {
  const isSeries = playedItem.type === "series" || !!playedItem.series_id;
  let targetItem = null;
  if (isSeries) {
    const sid = String(playedItem.series_id || playedItem.id || "");
    targetItem = (S.series || []).find((s) => String(s.id || s.stream_id || "") === sid);
  } else {
    targetItem = playedItem;
  }
  if (!targetItem) return;
  const key = itemKey(targetItem);
  const pct = getWatchPct(targetItem);
  document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`).forEach((card) => {
    const media = card.querySelector(".card-media, .nrow-media, .nou-media");
    if (!media) return;
    let bar = media.querySelector(".card-prog-bar");
    if (pct > 0.03 && pct < 0.97) {
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "card-prog-bar";
        bar.innerHTML = `<div class="card-prog-fill"></div>`;
        media.appendChild(bar);
      }
      bar.querySelector(".card-prog-fill").style.width = Math.round(pct * 100) + "%";
    } else if (bar) {
      bar.remove();
    }
  });
}
function secureUrl(url) {
  if (!url) return url;
  if (location.protocol === "https:" && /^http:\/\//i.test(url))
    return url.replace(/^http:\/\//i, "https://");
  return url;
}
function preparePlutoUrl(url) {
  if (!url || !url.includes("pluto.tv/stitch/hls/channel/")) return url;
  const base = url.split("?")[0];
  return base + "?advertisingId=&appName=web&appVersion=unknown&clientTime=0&deviceDNT=0&deviceId=pipsily&deviceLat=0&deviceLon=0&deviceMake=web&deviceModel=web&deviceType=web&deviceVersion=unknown&includeExtendedEvents=false&marketingRegion=FR&sid=&userId=";
}
function isFav(item) {
  return getFavs().some((x) => x.key === itemKey(item));
}
function getWatchPct(item) {
  var _a, _b, _c, _d;
  const prog = getProg();
  const k1 = itemKey(item);
  if (((_a = prog[k1]) == null ? void 0 : _a.pct) > 0) return prog[k1].pct;
  const k2 = String(item.id || item.stream_id || "");
  if (k2 && ((_b = prog[k2]) == null ? void 0 : _b.t) > 0 && ((_c = prog[k2]) == null ? void 0 : _c.d) > 0) return prog[k2].t / prog[k2].d;
  if (item.type === "series" && k2) return ((_d = _getSeriesPctMap()[k2]) == null ? void 0 : _d.pct) || 0;
  return 0;
}
function getWatchTs(item) {
  var _a, _b;
  const prog = getProg();
  const k1 = itemKey(item);
  if ((_a = prog[k1]) == null ? void 0 : _a.ts) return prog[k1].ts;
  const k2 = String(item.id || item.stream_id || "");
  if (k2 && ((_b = prog[k2]) == null ? void 0 : _b.ts)) return prog[k2].ts;
  return 0;
}
function forgetItemX(item) {
  const prog = getProg();
  if (item.type === "series" || item.series_id) {
    const pre = String(item.series_id || item.id || "") + "||";
    Object.keys(prog).forEach((k) => {
      if (k.startsWith(pre)) delete prog[k];
    });
  }
  const id = String(item.id || item.stream_id || "");
  if (id) delete prog[id];
  delete prog[itemKey(item)];
  storeSet(STORE.progress, prog);
  _invalidateCache();
  if (isFav(item)) toggleFav(item);
  const h = getHist().filter((x) => x.key !== itemKey(item));
  storeSet(STORE.history, h);
  if (typeof renderPoursuivreRow === "function") renderPoursuivreRow();
}
function toggleFav(item) {
  const favs = getFavs();
  const key = itemKey(item);
  const idx = favs.findIndex((x) => x.key === key);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.unshift({ key, item, at: Date.now() });
  _cacheF = favs.slice(0, 500);
  storeSet(STORE.favorites, _cacheF);
  const fav = isFav(item);
  document.querySelectorAll(`.card[data-key="${CSS.escape(key)}"] .fav-btn`).forEach((b) => {
    b.classList.toggle("is-fav", fav);
  });
  if (typeof renderFavoritesRow === "function") renderFavoritesRow();
}
function pushHist(item) {
  const h = getHist().filter((x) => x.key !== itemKey(item));
  h.unshift({ key: itemKey(item), item, at: Date.now() });
  storeSet(STORE.history, h.slice(0, 300));
}
function cleanTitle(t) {
  if (!t) return "";
  let s = String(t);
  s = s.replace(/^(FR|SRS|EN|VOD|SERIE)\s*[-|:]\s*/i, "");
  s = s.replace(/\s*(?:group-title|tvg-\w+)\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\.(mkv|mp4|ts|m3u8|avi|mov)$/i, "");
  s = s.replace(/\s*\(\d{4}\)\s*$/, "");
  return s.replace(/\s+/g, " ").trim();
}
function cleanEpTitle(raw, seriesTitle) {
  if (!raw) return "";
  let s = String(raw);
  const re = new RegExp("^" + seriesTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*[-–]\\s*S\\d+E\\d+\\s*[-–]\\s*", "i");
  s = s.replace(re, "");
  s = s.replace(/^S\d+E\d+\s*[-–]\s*/i, "");
  s = cleanTitle(s);
  return s || "";
}
function inferQuality(src) {
  const t = String(src || "").toLowerCase();
  if (/\b(4k|uhd|2160p?)\b/.test(t)) return "4K";
  if (/\b(fhd|full[\s-]?hd|1080p?|hd|720p?)\b/.test(t)) return "HD";
  if (/\b(sd|480p?|360p?)\b/.test(t)) return "SD";
  return "";
}
function parseM3U(text, type) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const group = (line.match(/group-title="([^"]+)"/i) || [, "Autre"])[1];
      const logo = (line.match(/tvg-logo="([^"]+)"/i) || [, ""])[1];
      const title = line.includes(",") ? line.split(",").slice(1).join(",").trim() : "Sans titre";
      cur = {
        title: cleanTitle(title),
        category_name: cleanTitle(group),
        stream_icon: logo,
        quality: inferQuality(`${title} ${group}`)
      };
    } else if (!line.startsWith("#") && cur) {
      out.push({
        id: out.length,
        title: cur.title,
        category_name: cur.category_name,
        stream_icon: cur.stream_icon,
        stream_url: line,
        url: line,
        plot: "",
        type,
        quality: cur.quality,
        _xtream: type === "series" && line.includes("get_series_info"),
        episodes: {},
        seasons: []
      });
      cur = null;
    }
  }
  return out;
}
function normalizeItems(arr, type) {
  return (Array.isArray(arr) ? arr : []).map((x, i) => ({
    id: x.id || x.stream_id || x.series_id || String(i),
    title: cleanTitle(x.title || x.name || "Sans titre"),
    category_id: x.category_id || "",
    category_name: cleanTitle(x.category_name || x.category || "Autre"),
    stream_icon: x.stream_icon || x.image || x.cover || x.poster || "",
    stream_url: x.url || x.stream_url || "",
    url: x.url || x.stream_url || "",
    plot: x.plot || x.description || x.overview || "",
    type,
    quality: inferQuality([x.title, x.name, x.category_name, x.plot].join(" ")),
    added: x.added || 0,
    _xtream: type === "series" && !!(x.url || x.stream_url || "").includes("get_series_info"),
    episodes: {},
    seasons: []
  }));
}
function extractArr(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (const k of ["items", "streams", "channels", "movies", "series", "vod"]) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  return [];
}
async function fetchJson(url) {
  try {
    const r = await fetch(url);
    return r.ok ? r.json() : null;
  } catch (e) {
    return null;
  }
}
async function fetchText(url) {
  try {
    const r = await fetch(url);
    return r.ok ? r.text() : null;
  } catch (e) {
    return null;
  }
}
let _epMap = null;
let _epMapPromise = null;
const _loadedChunks = {};
async function getEpMap() {
  if (_epMap) return _epMap;
  if (_epMapPromise) return _epMapPromise;
  _epMapPromise = fetchJson("episodes_map.json").then((m) => {
    _epMap = m || {};
    console.log(`[PIPSILY] epMap : ${Object.keys(_epMap).length} séries indexées`);
    return _epMap;
  });
  return _epMapPromise;
}
async function ensureEpDb(seriesId) {
  const map = await getEpMap();
  const chunkNum = seriesId ? map[String(seriesId)] : null;
  if (!chunkNum) return false;
  if (!_loadedChunks[chunkNum]) {
    _loadedChunks[chunkNum] = fetchJson(`episodes_part${chunkNum}.json`).then((chunk) => {
      if (chunk && typeof chunk === "object") Object.assign(S.epDb, chunk);
      console.log(`[PIPSILY] chunk ${chunkNum} chargé (${Object.keys(chunk || {}).length} séries)`);
    });
  }
  await _loadedChunks[chunkNum];
  return true;
}
function parseXtreamCreds(apiUrl) {
  try {
    const p = new URL(apiUrl);
    return {
      base: p.origin,
      username: p.searchParams.get("username") || "",
      password: p.searchParams.get("password") || ""
    };
  } catch (e) {
    return null;
  }
}
function buildEpUrl(apiUrl, ep) {
  if (ep.url && !ep.url.includes("player_api") && !ep.url.includes("get_series_info")) {
    return secureUrl(ep.url);
  }
  const x = parseXtreamCreds(apiUrl);
  if (x && x.username && x.password && ep.id && !String(ep.id).includes("-")) {
    const ext = ep.container_extension || "mkv";
    return secureUrl(`${x.base}/series/${x.username}/${x.password}/${ep.id}.${ext}`);
  }
  return "";
}
async function loadEpisodes(series) {
  var _a;
  const cacheKey = `s_${series.id}_${series.title}`;
  if (S.epCache[cacheKey]) return S.epCache[cacheKey];
  const sid = String(series.id || "");
  await ensureEpDb(sid);
  if (sid && S.epDb[sid]) {
    const db = S.epDb[sid];
    const seasonsMap2 = {};
    Object.entries(db.seasons || {}).forEach(([sk, epList]) => {
      seasonsMap2[String(sk)] = epList.map((ep) => ({
        id: ep.id,
        episode_num: ep.episode_num,
        season: ep.season,
        title: cleanEpTitle(ep.title || "", series.title) || `Épisode ${ep.episode_num}`,
        url: ep.url,
        // URL HTTP goldenlink.live — intent Android
        stream_url: ep.url,
        container_extension: ep.ext || "mkv",
        duration: ep.duration || "",
        plot: ep.plot || "",
        thumb: ep.thumb || ""
      }));
    });
    const seasonsMeta2 = (db.seasonsMeta || []).map((s) => ({
      num: s.num,
      name: s.name || `Saison ${s.num}`,
      cover: s.cover || "",
      count: s.count || 0
    }));
    if (db.meta) {
      if (!series.plot && db.meta.plot) series.plot = db.meta.plot;
      if (!series.stream_icon && db.meta.cover) series.stream_icon = db.meta.cover;
    }
    const result2 = { seasonsMap: seasonsMap2, seasonsMeta: seasonsMeta2 };
    S.epCache[cacheKey] = result2;
    return result2;
  }
  const rawApiUrl = series.stream_url || series.url || "";
  if (!rawApiUrl) return { seasonsMap: {}, seasonsMeta: [] };
  const isNativeApk = typeof window.AndroidBridge !== "undefined";
  const apiUrl = rawApiUrl.replace(/^https?:\/\//i, "http://");
  let data = null;
  if (isNativeApk && typeof ((_a = window.AndroidBridge) == null ? void 0 : _a.fetchJson) === "function") {
    try {
      const raw = window.AndroidBridge.fetchJson(apiUrl);
      if (raw) data = JSON.parse(raw);
    } catch (e) {
    }
  }
  if (!data) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 12e3);
      const r = await fetch(apiUrl, { signal: controller.signal });
      clearTimeout(tid);
      data = r.ok ? await r.json() : null;
    } catch (e) {
      data = null;
    }
  }
  if (!data) return { seasonsMap: {}, seasonsMeta: [], directOnly: true };
  const seasonsMap = {};
  const rawEps = data.episodes;
  if (rawEps && typeof rawEps === "object") {
    Object.entries(rawEps).forEach(([sk, epList]) => {
      if (!Array.isArray(epList)) return;
      const key = String(sk);
      seasonsMap[key] = epList.filter((ep) => ep && (ep.id || ep.episode_num)).map((ep) => {
        var _a2, _b, _c;
        const url = buildEpUrl(apiUrl, ep);
        return {
          id: ep.id,
          episode_num: Number(ep.episode_num) || 1,
          season: Number(ep.season || sk),
          title: cleanEpTitle(ep.title || ep.name || "", series.title) || `Épisode ${ep.episode_num}`,
          url,
          stream_url: url,
          container_extension: ep.container_extension || "mkv",
          duration: ((_a2 = ep.info) == null ? void 0 : _a2.duration) || "",
          plot: ((_b = ep.info) == null ? void 0 : _b.plot) || "",
          thumb: ((_c = ep.info) == null ? void 0 : _c.movie_image) || ""
        };
      }).sort((a, b) => a.episode_num - b.episode_num);
    });
  }
  let seasonsMeta = [];
  if (Array.isArray(data.seasons)) {
    seasonsMeta = data.seasons.filter((s) => s.season_number > 0).sort((a, b) => a.season_number - b.season_number).map((s) => ({
      num: s.season_number,
      name: s.name || `Saison ${s.season_number}`,
      cover: s.cover_big || s.cover || "",
      count: s.episode_count || 0
    }));
  }
  if (data.info) {
    if (!series.plot) series.plot = data.info.plot || data.info.description || "";
    if (!series.stream_icon) series.stream_icon = data.info.cover || data.info.movie_image || "";
  }
  const result = { seasonsMap, seasonsMeta };
  S.epCache[cacheKey] = result;
  return result;
}
function getExt(url) {
  if (!url) return "";
  return (url.split("?")[0].split(".").pop() || "").toLowerCase();
}
function openVodPanel(item) {
  S.panel.lastFocus = document.activeElement;
  S.panel.open = true;
  S.panel.series = item;
  S.panel.isVod = true;
  document.body.style.overflow = "hidden";
  const panel = $("seriesPanel");
  panel.hidden = false;
  history.pushState({ pip: "vod" }, "");
  const ext = getExt(item.stream_url || item.url || "");
  const meta = [item.category_name, item.quality, ext ? ext.toUpperCase() : ""].filter(Boolean).join(" · ");
  const cover = item.stream_icon || "";
  const plot = item.plot || "";
  const savedMs = _getSavedProgressMs(item);
  const _fmtMs = (ms) => {
    const m = Math.floor(ms / 6e4);
    const s = String(Math.floor(ms % 6e4 / 1e3)).padStart(2, "0");
    return `${m}:${s}`;
  };
  const _pctSaved = (() => {
    var _a;
    const prog = getProg();
    const id = String(item.id || item.stream_id || "");
    return id && ((_a = prog[id]) == null ? void 0 : _a.d) > 0 ? Math.round(prog[id].t / prog[id].d * 100) : 0;
  })();
  panel.innerHTML = `
    <div class="sp-header">
      <div class="sp-hinfo">
        <div class="sp-kicker">🎬 Film</div>
        <h3 class="sp-title">${esc(item.title)}</h3>
        ${meta ? `<div class="sp-meta">${esc(meta)}</div>` : ""}
      </div>
      <button id="vodCloseBtn" class="sp-close" aria-label="Fermer">✕</button>
    </div>

    <div class="sp-body">
      <div class="sp-hero">
        ${cover ? `<img class="sp-cover" src="${esc(cover)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="sp-cover sp-nocover">🎬</div>`}
        <div class="sp-hero-txt">
          <p class="sp-plot" id="vodPlot">${esc(plot || "Chargement du synopsis…")}</p>
        </div>
      </div>

      <div class="vod-actions">
        ${savedMs > 0 ? `<button id="vodResumeBtn" class="vod-play-btn">
               <span class="vod-play-icon">▶</span>
               <span>Reprendre${_pctSaved ? ` — ${_pctSaved}%` : ` à ${_fmtMs(savedMs)}`}</span>
             </button>
             <button id="vodRestartBtn" class="vod-restart-btn">
               ↩ Début
             </button>` : `<button id="vodPlayBtn" class="vod-play-btn">
               <span class="vod-play-icon">▶</span>
               <span>Lire le film</span>
             </button>`}
        <button class="fav-btn-large ${isFav(item) ? "is-fav" : ""}" id="vodFavBtn" type="button">
          <span class="fav-heart">♥</span>
          <span id="vodFavLabel">${isFav(item) ? "Favori" : "Ajouter aux favoris"}</span>
        </button>
        ${savedMs > 0 || isFav(item) ? `<button id="vodForgetBtn" class="vod-restart-btn" type="button" style="color:#ff9a9a;border-color:rgba(229,75,75,.45)">✕ Ne plus suivre</button>` : ""}
      </div>
    </div>`;
  $("vodCloseBtn").addEventListener("click", closeVodPanel);
  panel.addEventListener("click", (e) => {
    if (e.target === panel) closeVodPanel();
  }, { once: true });
  if (savedMs > 0) {
    $("vodResumeBtn").addEventListener("click", () => {
      closeVodPanel(typeof window.AndroidBridge === "undefined");
      playItem(item);
    });
    $("vodRestartBtn").addEventListener("click", () => {
      const prog = getProg();
      const id = String(item.id || item.stream_id || "");
      if (id) delete prog[id];
      delete prog[itemKey(item)];
      storeSet(STORE.progress, prog);
      _invalidateCache();
      closeVodPanel(typeof window.AndroidBridge === "undefined");
      playItem(item);
    });
  } else {
    $("vodPlayBtn").addEventListener("click", () => {
      closeVodPanel(typeof window.AndroidBridge === "undefined");
      playItem(item);
    });
  }
  $("vodFavBtn").addEventListener("click", () => {
    toggleFav(item);
    const fav = isFav(item);
    $("vodFavBtn").classList.toggle("is-fav", fav);
    const lbl = $("vodFavLabel");
    if (lbl) lbl.textContent = fav ? "Favori" : "Ajouter aux favoris";
  });
  const _vodForget = $("vodForgetBtn");
  if (_vodForget) {
    let armed = false;
    _vodForget.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        _vodForget.textContent = "✕ Confirmer le retrait ?";
        setTimeout(() => {
          armed = false;
          const b = $("vodForgetBtn");
          if (b) b.textContent = "✕ Ne plus suivre";
        }, 4e3);
        return;
      }
      forgetItemX(item);
      closeVodPanel();
    });
  }
  setTimeout(() => {
    var _a;
    return (_a = $("vodResumeBtn") || $("vodPlayBtn")) == null ? void 0 : _a.focus();
  }, 80);
  if (!plot) {
    fetchVodPlot(item).then((p) => {
      const el = $("vodPlot");
      if (el) el.textContent = p || "Aucun synopsis disponible.";
      if (p) item.plot = p;
    });
  }
}
async function fetchVodPlot(item) {
  var _a, _b, _c, _d;
  const streamUrl = item.stream_url || item.url || "";
  if (!streamUrl) return null;
  let username = "", password = "", base = "";
  try {
    const u = new URL(streamUrl);
    base = u.origin;
    const pts = u.pathname.split("/").filter(Boolean);
    if ((pts[0] === "movie" || pts[0] === "series" || pts[0] === "live") && pts.length >= 4) {
      username = pts[1];
      password = pts[2];
    } else if (!u.search && pts.length >= 3 && !pts[0].includes(".")) {
      username = pts[0];
      password = pts[1];
    } else {
      username = u.searchParams.get("username") || "";
      password = u.searchParams.get("password") || "";
    }
  } catch (e) {
    return null;
  }
  if (!username || !password) return null;
  const vodId = item.id || item.stream_id || String(item.num || "");
  if (!vodId) return null;
  const apiUrl = base.replace(/^https?:/, "http:") + `/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_vod_info&vod_id=${vodId}`;
  let json = null;
  if (typeof ((_a = window.AndroidBridge) == null ? void 0 : _a.fetchUrlAsync) === "function") {
    json = await new Promise((resolve) => {
      const cbName = "_vodPlotCb" + Date.now();
      const timer = setTimeout(() => {
        delete window[cbName];
        resolve(null);
      }, 12e3);
      window[cbName] = (b64, ok) => {
        clearTimeout(timer);
        delete window[cbName];
        if (!ok) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(atob(b64)));
        } catch (e) {
          resolve(null);
        }
      };
      window.AndroidBridge.fetchUrlAsync(apiUrl, cbName);
    });
  } else {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 8e3);
      const r = await fetch(apiUrl, { signal: ctrl.signal });
      clearTimeout(tid);
      if (r.ok) json = await r.json();
    } catch (e) {
    }
  }
  if (!json) return null;
  return ((_b = json == null ? void 0 : json.info) == null ? void 0 : _b.plot) || ((_c = json == null ? void 0 : json.info) == null ? void 0 : _c.description) || ((_d = json == null ? void 0 : json.movie_data) == null ? void 0 : _d.plot) || null;
}
function closeVodPanel(_fromPopstate) {
  var _a;
  if (!S.panel.open && !S.panel.isVod) return;
  const needBack = !_fromPopstate && ((_a = history.state) == null ? void 0 : _a.pip) === "vod";
  S.panel.open = false;
  S.panel.isVod = false;
  $("seriesPanel").hidden = true;
  document.body.style.overflow = "";
  const prev = S.panel.lastFocus;
  S.panel.lastFocus = null;
  if (prev && prev.isConnected) {
    requestAnimationFrame(() => {
      prev.focus({ preventScroll: true });
      prev.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
  if (needBack) history.back();
}
function openPanel(series) {
  S.panel.lastFocus = document.activeElement;
  S.panel.open = true;
  S.panel.series = series;
  S.panel.seasonsMap = {};
  S.panel.seasonsMeta = [];
  S.panel.selSeason = null;
  document.body.style.overflow = "hidden";
  history.pushState({ pip: "series" }, "");
  const panel = $("seriesPanel");
  panel.hidden = false;
  panel.innerHTML = buildPanelLoading(series);
  bindClose();
  loadEpisodes(series).then(({ seasonsMap, seasonsMeta, directOnly }) => {
    S.panel.seasonsMap = seasonsMap;
    S.panel.seasonsMeta = seasonsMeta;
    S.panel.directOnly = directOnly || false;
    const keys = Object.keys(seasonsMap).sort((a, b) => Number(a) - Number(b));
    S.panel.selSeason = keys[0] || null;
    renderPanel();
  });
}
function closePanel(_fromPopstate) {
  var _a;
  if (!S.panel.open) return;
  const needBack = !_fromPopstate && ((_a = history.state) == null ? void 0 : _a.pip) === "series";
  S.panel.open = false;
  $("seriesPanel").hidden = true;
  document.body.style.overflow = "";
  const prev = S.panel.lastFocus;
  S.panel.lastFocus = null;
  if (prev && prev.isConnected) {
    requestAnimationFrame(() => {
      prev.focus({ preventScroll: true });
      prev.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
  if (needBack) history.back();
}
function bindClose() {
  var _a;
  (_a = $("seriesCloseBtn")) == null ? void 0 : _a.addEventListener("click", closePanel);
}
function buildPanelLoading(s) {
  const cover = s.stream_icon || "";
  return `
    <div class="sp-header">
      <div class="sp-hinfo">
        <div class="sp-kicker">Série</div>
        <h3 class="sp-title">${esc(s.title)}</h3>
      </div>
      <button id="seriesCloseBtn" class="sp-close">✕</button>
    </div>
    <div class="sp-body">
      <div class="sp-hero">
        ${cover ? `<img class="sp-cover" src="${esc(cover)}" alt="" loading="lazy">` : `<div class="sp-cover sp-nocover">🎬</div>`}
        <div class="sp-hero-txt">
          <p class="sp-plot">${esc(s.plot || "Chargement…")}</p>
          <div class="sp-loading"><span class="sp-spin"></span> Chargement des saisons…</div>
        </div>
      </div>
    </div>`;
}
function renderPanel() {
  var _a, _b, _c, _d, _e, _f;
  const panel = $("seriesPanel");
  if (!panel || !S.panel.series) return;
  const s = S.panel.series;
  const smap = S.panel.seasonsMap;
  const smeta = S.panel.seasonsMeta;
  const sel = S.panel.selSeason;
  const keys = Object.keys(smap).sort((a, b) => Number(a) - Number(b));
  const totalEps = Object.values(smap).reduce((n, a) => n + a.length, 0);
  const metaLine = [
    s.category_name,
    keys.length ? `${keys.length} saison${keys.length > 1 ? "s" : ""}` : "",
    totalEps ? `${totalEps} épisode${totalEps > 1 ? "s" : ""}` : ""
  ].filter(Boolean).join(" · ");
  let tabsHtml = "";
  if (keys.length > 1) {
    tabsHtml = `<div class="sp-tabs">` + keys.map((sk) => {
      var _a2;
      const m = smeta.find((x) => String(x.num) === sk);
      const label = m ? m.name : `Saison ${sk}`;
      const cnt = ((_a2 = smap[sk]) == null ? void 0 : _a2.length) || 0;
      return `<button class="sp-tab${sk === sel ? " sp-tab--active" : ""}"
                  data-season="${esc(sk)}" type="button">
                  ${esc(label)}
                  <span class="sp-tab-cnt">${cnt} ép.</span>
                </button>`;
    }).join("") + `</div>`;
  } else if (keys.length === 1) {
    const m = smeta.find((x) => String(x.num) === keys[0]);
    const label = m ? m.name : `Saison ${keys[0]}`;
    tabsHtml = `<div class="sp-onesaison">${esc(label)}</div>`;
  }
  let epsHtml = "";
  if (!sel || keys.length === 0) {
    if (S.panel.directOnly) {
      epsHtml = `
        <div class="sp-noep-block">
          <div style="font-size:36px;margin-bottom:12px">📭</div>
          <div style="font-weight:700;font-size:16px;margin-bottom:8px">Épisodes non disponibles</div>
          <div style="font-size:13px;color:#8ca8cc;line-height:1.5">
            Cette série n'est pas encore dans notre base de données locale.<br>
            Relancez <code>node fetch_episodes.js</code> pour mettre à jour.
          </div>
        </div>`;
    } else {
      epsHtml = `<div class="sp-noep">Aucune saison disponible pour cette série.</div>`;
    }
  } else {
    const eps = smap[sel] || [];
    const m = smeta.find((x) => String(x.num) === sel);
    const covr = (m == null ? void 0 : m.cover) && m.cover.length > 40 ? m.cover : "";
    if (covr) epsHtml += `<div class="sp-scov"><img src="${esc(covr)}" alt="" loading="lazy"></div>`;
    if (!eps.length) {
      epsHtml += `<div class="sp-noep">Aucun épisode dans cette saison.</div>`;
    } else {
      epsHtml += `<div class="sp-eplist">`;
      eps.forEach((ep, idx) => {
        const code = `S${String(sel).padStart(2, "0")}E${String(ep.episode_num).padStart(2, "0")}`;
        const progK = `${s.id}||${code}`;
        const _pe = getProg()[progK] || {};
        const pct = _pe.t > 0 && _pe.d > 0 ? Math.round(_pe.t / _pe.d * 100) : _pe.pct > 0 ? Math.round(_pe.pct * 100) : _pe.t > 30 ? 50 : 0;
        const done = pct >= 90;
        const hasUrl = !!ep.url;
        epsHtml += `
          <button class="sp-ep${done ? " sp-ep--done" : ""}${!hasUrl ? " sp-ep--locked" : ""}"
            data-season="${esc(sel)}" data-idx="${idx}" type="button"
            ${!hasUrl ? "disabled" : ""}
            title="${hasUrl ? esc(ep.title) : "URL non disponible"}">

            ${ep.thumb ? `<img class="sp-ep-img" src="${esc(ep.thumb)}" alt="" loading="lazy">` : `<div class="sp-ep-img sp-ep-img--blank"></div>`}

            <div class="sp-ep-info">
              <span class="sp-ep-code">${esc(code)}</span>
              <span class="sp-ep-title">${esc(ep.title || "Sans titre")}</span>
              ${ep.duration ? `<span class="sp-ep-dur">${esc(ep.duration)}</span>` : ""}
              ${ep.plot ? `<span class="sp-ep-plot">${esc(ep.plot.substring(0, 120))}${ep.plot.length > 120 ? "…" : ""}</span>` : ""}
            </div>

            <div class="sp-ep-status">
              ${done ? `<span class="sp-check">✓</span>` : ""}
              ${!done && pct > 2 ? `<span class="sp-pct">${Math.round(pct)}%</span>` : ""}
              ${hasUrl ? `<span class="sp-play">▶</span>` : `<span class="sp-lock">–</span>`}
            </div>
          </button>
          ${pct > 2 ? `<div class="sp-prog"><div class="sp-prog-fill" style="width:${Math.min(pct, 100)}%"></div></div>` : ""}`;
      });
      epsHtml += `</div>`;
    }
  }
  let lastWatched = null;
  {
    const prog = getProg();
    const sIdEsc = String(s.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const epKeyRe = new RegExp(`^${sIdEsc}\\|\\|(S(\\d+)E(\\d+))$`);
    let lastTs = 0;
    const progKeys = Object.keys(prog).filter((k) => epKeyRe.test(k));
    console.log(`[PIPSILY] Série "${s.title}" (id=${s.id}) — clés progression:`, progKeys.length ? progKeys : "(aucune)");
    progKeys.forEach((k) => {
      const m = epKeyRe.exec(k);
      if (!m) return;
      const en = prog[k];
      if (!(en == null ? void 0 : en.ts) || en.ts <= lastTs) return;
      const tSec = en.t || 0;
      const dSec = en.d && isFinite(en.d) ? en.d : 0;
      const pct = dSec > 0 ? tSec / dSec : en.pct || 0;
      console.log(`  ${k} →`, { t: tSec, d: dSec, pct: Math.round(pct * 100) + "%" });
      if (tSec > 10 || pct > 0.01) {
        lastWatched = { code: m[1], sn: String(Number(m[2])), en: m[3], pct, tSec, progK: k };
        lastTs = en.ts;
      }
    });
    console.log(`[PIPSILY] lastWatched:`, lastWatched || "(aucun)");
  }
  let firstEp = null, firstSk = null;
  {
    const firstSeason = keys[0];
    if (firstSeason && ((_a = smap[firstSeason]) == null ? void 0 : _a.length)) {
      firstEp = smap[firstSeason].find((e) => !!e.url) || null;
      firstSk = firstSeason;
    }
  }
  let nextEpCode = null;
  if ((lastWatched == null ? void 0 : lastWatched.pct) >= 0.95) {
    const _orderedAll = [];
    keys.forEach((sk) => (smap[sk] || []).forEach((ep) => _orderedAll.push({ sk, ep })));
    const _curI = _orderedAll.findIndex(({ sk, ep }) => Number(sk) === Number(lastWatched.sn) && Number(ep.episode_num) === Number(lastWatched.en));
    if (_curI >= 0 && _curI + 1 < _orderedAll.length) {
      const nxt = _orderedAll[_curI + 1];
      nextEpCode = `S${String(nxt.sk).padStart(2, "0")}E${String(nxt.ep.episode_num).padStart(2, "0")}`;
    }
  }
  panel.innerHTML = `
    <div class="sp-header">
      <div class="sp-hinfo">
        <div class="sp-kicker">Série</div>
        <h3 class="sp-title">${esc(s.title)}</h3>
        ${metaLine ? `<div class="sp-meta">${esc(metaLine)}</div>` : ""}
      </div>
      <button id="seriesCloseBtn" class="sp-close">✕</button>
    </div>

    <div class="sp-body">
      <div class="sp-hero">
        ${s.stream_icon ? `<img class="sp-cover" src="${esc(s.stream_icon)}" alt="" loading="lazy">` : `<div class="sp-cover sp-nocover">🎬</div>`}
        <div class="sp-hero-txt">
          <p class="sp-plot">${esc(s.plot || "Aucun synopsis disponible.")}</p>
        </div>
      </div>

      <!-- Actions série : Reprendre / Début / Regarder + Favoris -->
      <div class="sp-series-actions">
        ${lastWatched ? `<button id="seriesResumeBtn" class="vod-play-btn" type="button">
               <span class="vod-play-icon">▶</span>
               <span>${lastWatched.pct >= 0.95 ? "Épisode suivant · " + (nextEpCode || lastWatched.code) : "Reprendre · " + lastWatched.code + (lastWatched.pct > 0.01 ? " — " + Math.round(lastWatched.pct * 100) + "%" : "")}</span>
             </button>
             ${firstEp ? `<button id="seriesRestartBtn" class="vod-restart-btn" type="button">↩ Depuis le début</button>` : ""}` : firstEp ? `<button id="seriesPlayBtn" class="vod-play-btn" type="button">
                   <span class="vod-play-icon">▶</span>
                   <span>Regarder la série</span>
                 </button>` : ""}
        <button class="fav-btn-large ${isFav(s) ? "is-fav" : ""}" id="seriesFavBtn" type="button">
          <span class="fav-heart">♥</span>
          <span id="seriesFavLabel">${isFav(s) ? "Favori" : "Ajouter aux favoris"}</span>
        </button>
        ${lastWatched || isFav(s) ? `<button id="seriesForgetBtn" class="vod-restart-btn" type="button" style="color:#ff9a9a;border-color:rgba(229,75,75,.45)">✕ Ne plus suivre</button>` : ""}
      </div>

      ${tabsHtml}

      <div id="spEps">${epsHtml}</div>
    </div>

    `;
  bindClose();
  function _findEpBySE(targetSn, targetEn) {
    for (const [sk, epList] of Object.entries(smap)) {
      if (Number(sk) !== targetSn) continue;
      const ep = epList.find((e) => Number(e.episode_num) === targetEn);
      if (ep) return { ep, sk };
    }
    return null;
  }
  function _allEpsOrdered() {
    const arr = [];
    Object.keys(smap).sort((a, b) => Number(a) - Number(b)).forEach((sk) => (smap[sk] || []).forEach((ep) => arr.push({ sk, ep })));
    return arr;
  }
  (_b = $("seriesResumeBtn")) == null ? void 0 : _b.addEventListener("click", () => {
    if (!lastWatched) return;
    const targetSn = Number(lastWatched.sn);
    const targetEn = Number(lastWatched.en);
    if (lastWatched.pct >= 0.95) {
      const all = _allEpsOrdered();
      const curIdx = all.findIndex(({ sk, ep }) => Number(sk) === targetSn && Number(ep.episode_num) === targetEn);
      if (curIdx >= 0 && curIdx + 1 < all.length) {
        const next = all[curIdx + 1];
        if (next.ep.url) {
          playEpisode(s, next.ep, next.sk);
          return;
        }
      }
    }
    const found = _findEpBySE(targetSn, targetEn);
    if (found) playEpisode(s, found.ep, found.sk);
  });
  (_c = $("seriesRestartBtn")) == null ? void 0 : _c.addEventListener("click", () => {
    if (!firstEp || !firstSk) return;
    const prog = getProg();
    const prefix = String(s.id) + "||";
    Object.keys(prog).forEach((k) => {
      if (k.startsWith(prefix)) delete prog[k];
    });
    storeSet(STORE.progress, prog);
    _invalidateCache();
    playEpisode(s, firstEp, firstSk);
  });
  (_d = $("seriesPlayBtn")) == null ? void 0 : _d.addEventListener("click", () => {
    if (firstEp && firstSk) playEpisode(s, firstEp, firstSk);
  });
  (_e = $("spDirectBtn")) == null ? void 0 : _e.addEventListener("click", () => playItem(s));
  (_f = $("seriesFavBtn")) == null ? void 0 : _f.addEventListener("click", () => {
    var _a2;
    toggleFav(s);
    const fav = isFav(s);
    (_a2 = $("seriesFavBtn")) == null ? void 0 : _a2.classList.toggle("is-fav", fav);
    const lbl = $("seriesFavLabel");
    if (lbl) lbl.textContent = fav ? "Favori" : "Ajouter aux favoris";
  });
  const _serForget = $("seriesForgetBtn");
  if (_serForget) {
    let armed = false;
    _serForget.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        _serForget.textContent = "✕ Confirmer le retrait ?";
        setTimeout(() => {
          armed = false;
          const b = $("seriesForgetBtn");
          if (b) b.textContent = "✕ Ne plus suivre";
        }, 4e3);
        return;
      }
      forgetItemX(s);
      closePanel();
    });
  }
  panel.querySelectorAll(".sp-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      var _a2;
      S.panel.selSeason = btn.dataset.season;
      renderPanel();
      (_a2 = $("spEps")) == null ? void 0 : _a2.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });
  function openResumeModal(ep, sk, progK, pct, tSec) {
    var _a2;
    (_a2 = document.getElementById("spResumeModal")) == null ? void 0 : _a2.remove();
    const code = `S${String(sk).padStart(2, "0")}E${String(ep.episode_num).padStart(2, "0")}`;
    const resumeInfo = pct > 0.01 ? `${Math.round(pct * 100)}% visionné` : tSec > 0 ? `${Math.floor(tSec / 60)}min${tSec % 60 > 0 ? " " + String(tSec % 60) + "s" : ""} visionnés` : "Reprendre";
    const ov = document.createElement("div");
    ov.id = "spResumeModal";
    ov.className = "sp-resume-modal";
    ov.innerHTML = `
      <div class="sp-resume-modal__box">
        <div class="sp-resume-modal__title">${esc(code)}${ep.title ? " — " + esc(ep.title) : ""}</div>
        <div class="sp-resume-modal__pct">${resumeInfo}</div>
        <div class="sp-resume-modal__btns">
          <button id="spRmResume" class="sp-resume-modal__play">▶ Reprendre</button>
          <button id="spRmRestart" class="sp-resume-modal__restart">↩ Depuis le début</button>
        </div>
        <button id="spRmClose" class="sp-resume-modal__close">✕</button>
      </div>`;
    document.body.appendChild(ov);
    const closeModal = () => {
      document.removeEventListener("keydown", onModalKey, true);
      ov.remove();
    };
    function onModalKey(e) {
      var _a3, _b2, _c2, _d2;
      if (!document.getElementById("spResumeModal")) {
        document.removeEventListener("keydown", onModalKey, true);
        return;
      }
      if (["Escape", "GoBack", "Back"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        closeModal();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        const cur = document.activeElement;
        if ((cur == null ? void 0 : cur.id) === "spRmResume") (_a3 = $("spRmRestart")) == null ? void 0 : _a3.focus();
        else (_b2 = $("spRmResume")) == null ? void 0 : _b2.focus();
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        if (((_c2 = document.activeElement) == null ? void 0 : _c2.id) === "spRmRestart") document.activeElement.click();
        else (_d2 = $("spRmResume")) == null ? void 0 : _d2.click();
        return;
      }
    }
    document.addEventListener("keydown", onModalKey, true);
    $("spRmResume").addEventListener("click", () => {
      closeModal();
      playEpisode(s, ep, sk);
    });
    $("spRmRestart").addEventListener("click", () => {
      const prog = getProg();
      delete prog[progK];
      storeSet(STORE.progress, prog);
      _invalidateCache();
      closeModal();
      playEpisode(s, ep, sk);
    });
    $("spRmClose").addEventListener("click", closeModal);
    ov.addEventListener("click", (e) => {
      if (e.target === ov) closeModal();
    });
    setTimeout(() => {
      var _a3;
      return (_a3 = $("spRmResume")) == null ? void 0 : _a3.focus();
    }, 60);
  }
  panel.querySelectorAll(".sp-ep:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sk = btn.dataset.season;
      const idx = Number(btn.dataset.idx);
      const ep = (smap[sk] || [])[idx];
      if (!ep || !ep.url) return;
      const code = `S${String(sk).padStart(2, "0")}E${String(ep.episode_num).padStart(2, "0")}`;
      const progK = `${s.id}||${code}`;
      const saved = getProg()[progK];
      const tSec = (saved == null ? void 0 : saved.t) || 0;
      const dSec = (saved == null ? void 0 : saved.d) && isFinite(saved.d) ? saved.d : 0;
      const pctF = dSec > 0 ? tSec / dSec : (saved == null ? void 0 : saved.pct) || 0;
      if (tSec > 60 && pctF < 0.95) {
        openResumeModal(ep, sk, progK, pctF, tSec);
      } else {
        playEpisode(s, ep, sk);
      }
    });
  });
  setTimeout(() => {
    const primaryBtn = $("seriesResumeBtn") || $("seriesPlayBtn") || panel.querySelector(".sp-series-actions .vod-play-btn") || panel.querySelector(".sp-ep:not([disabled])");
    primaryBtn == null ? void 0 : primaryBtn.focus();
  }, 80);
}
function playEpisode(series, ep, season) {
  pushHist(series);
  const smap = S.panel.seasonsMap;
  const keys = Object.keys(smap).sort((a, b) => Number(a) - Number(b));
  const allEps = [];
  keys.forEach((sk) => (smap[sk] || []).forEach((e) => allEps.push({ season: sk, ep: e })));
  const curIdx = allEps.findIndex((x) => x.season === season && x.ep.episode_num === ep.episode_num);
  const code = `S${String(season).padStart(2, "0")}E${String(ep.episode_num).padStart(2, "0")}`;
  const progKey = `${series.id}||${code}`;
  const playerItem = {
    type: "series",
    series_id: series.id,
    title: series.title,
    episode_label: code,
    episode_title: ep.title,
    category_name: series.category_name || "",
    stream_icon: ep.thumb || series.stream_icon || "",
    stream_url: ep.url,
    url: ep.url,
    plot: ep.plot || series.plot || "",
    progress_key: progKey,
    all_episodes: allEps.map((x) => ({
      season: x.season,
      episode_num: x.ep.episode_num,
      title: x.ep.title,
      url: x.ep.url,
      thumb: x.ep.thumb,
      plot: x.ep.plot,
      progress_key: `${series.id}||S${String(x.season).padStart(2, "0")}E${String(x.ep.episode_num).padStart(2, "0")}`
    })),
    current_ep_index: curIdx
  };
  if (typeof window.AndroidBridge !== "undefined") {
    if (!window._epUrlMap) window._epUrlMap = {};
    playerItem.all_episodes.forEach((epItem) => {
      if (epItem.url) window._epUrlMap[epItem.url] = epItem.progress_key;
    });
  }
  const _isTV = /TV|GoogleTV|SmartTV|AndroidTV/i.test(navigator.userAgent) || /Android/i.test(navigator.userAgent) && !navigator.userAgent.includes("Mobile");
  if (!_isTV && typeof window.AndroidBridge !== "undefined") {
    _markNativePlayback();
    const epTitle = `${series.title} — ${code}${ep.title ? " " + ep.title : ""}`;
    const epsJson = JSON.stringify(playerItem.all_episodes);
    const savedMs = _getSavedProgressMs({ progress_key: progKey });
    if (typeof window.AndroidBridge.openPlayerAt === "function") {
      try {
        window.AndroidBridge.openPlayerAt(ep.url, series.title, epTitle, epsJson, curIdx, savedMs);
        return;
      } catch (e) {
        console.warn("openPlayerAt:", e);
      }
    }
    if (typeof window.AndroidBridge.openPlayer === "function") {
      try {
        window.AndroidBridge.openPlayer(ep.url, series.title, epTitle, epsJson, curIdx);
        return;
      } catch (e) {
        console.warn("openPlayer:", e);
      }
    }
    if (typeof window.AndroidBridge.openInVlc === "function") {
      try {
        window.AndroidBridge.openInVlc(ep.url, epTitle, false);
        return;
      } catch (e) {
        console.warn("openInVlc:", e);
      }
    }
  }
  pushHist({ ...playerItem, type: "series" });
  PipPlayer.open({
    ...playerItem,
    id: playerItem.series_id,
    _epList: allEps.map((x, i) => ({
      id: x.ep.id,
      url: x.ep.url,
      season: x.season,
      episode_num: x.ep.episode_num,
      title: x.ep.title || "",
      plot: x.ep.plot || "",
      thumb: x.ep.thumb || ""
    })),
    _epIdx: curIdx
  });
}
async function playItem(item) {
  stopPreview();
  const isAdultCat = /adult|adulte|\+18|xxx|erot|for adult/i.test(item.category_name || "");
  if (isAdultCat && window.PIPSILY_AUTH && S._userId) {
    const pin = await window.PIPSILY_AUTH.getParentalPin(S._userId);
    if (pin) {
      const ok = await window.PIPSILY_AUTH.promptParentalPin(pin);
      if (!ok) return;
    }
  }
  pushHist(item);
  const url = item.url || item.stream_url || "";
  PipPlayer.open({
    ...item,
    stream_url: url,
    url
  });
}
const _startsXXX = (c) => {
  if (!c) return false;
  const clean = c.replace(/^[\s°|•\-_←-⇿⌀-➿⬀-⯿️⃣\uD800-\uDFFF]+/, "").trim();
  if (!clean) return false;
  if (clean.startsWith("xXx")) return false;
  return /^xxx/i.test(clean);
};
const _isAdultCat = (c) => {
  if (!c) return false;
  if (/adult|adulte|\+18|18\+|erot|for adult/i.test(c)) return true;
  if (_startsXXX(c)) return true;
  if (/\bxxx\s*$/i.test(c)) return true;
  return false;
};
const _isVostfr = (x) => /vostfr/i.test(x.title || "") || /vostfr/i.test(x.category_name || "");
function filtered() {
  let items = S.type === "vod" ? [...S.vod] : S.type === "series" ? [...S.series] : [...S.live];
  items = items.filter((x) => !_isVostfr(x));
  if (S.cat === "__ADULT__") {
    if (sessionStorage.getItem("pipsily_adult_unlocked")) {
      items = items.filter((x) => _isAdultCat(x.category_name));
    } else {
      S.cat = "";
      items = items.filter((x) => !_isAdultCat(x.category_name));
    }
  } else if (S.cat) {
    items = items.filter((x) => x.category_name === S.cat);
  } else {
    items = items.filter((x) => !_isAdultCat(x.category_name));
  }
  if (S.search) {
    const q = S.search.toLowerCase();
    items = items.filter(
      (x) => x.title.toLowerCase().includes(q) || (x.plot || "").toLowerCase().includes(q)
    );
  }
  if (S.quality && S.type !== "live") items = items.filter((x) => x.quality === S.quality);
  if (S.sort === "category")
    items.sort((a, b) => a.category_name.localeCompare(b.category_name) || a.title.localeCompare(b.title));
  else if (S.sort !== "recent")
    items.sort((a, b) => a.title.localeCompare(b.title));
  if (S.type === "live" && S.region) {
    if (!S._liveRegionIdx) S._liveRegionIdx = _buildLiveRegionIdx(S.live);
    const { regionSet } = S._liveRegionIdx;
    const userReg = S.region.toLowerCase();
    const basesWithMatch = /* @__PURE__ */ new Set();
    const baseGeneral = /* @__PURE__ */ new Map();
    const baseFallback = /* @__PURE__ */ new Map();
    items.forEach((item) => {
      const clean = _baseLiveName(item.title);
      const r = _isChannelRegional(clean, regionSet);
      if (r) {
        const base = r.base.toLowerCase();
        if (r.region === userReg) basesWithMatch.add(base);
        if (!baseFallback.has(base) || r.region === "paris")
          baseFallback.set(base, item);
      } else {
        const key = clean.toLowerCase();
        if (!baseGeneral.has(key)) baseGeneral.set(key, item);
      }
    });
    const fallbackSet = /* @__PURE__ */ new Set();
    baseFallback.forEach((item, base) => {
      if (basesWithMatch.has(base)) return;
      const general = baseGeneral.get(base);
      if (general) {
        fallbackSet.add(general);
        return;
      }
      fallbackSet.add(item);
    });
    items = items.filter((item) => {
      const clean = _baseLiveName(item.title);
      const r = _isChannelRegional(clean, regionSet);
      if (!r) {
        return !basesWithMatch.has(clean.toLowerCase());
      }
      if (r.region === userReg) return true;
      return fallbackSet.has(item);
    });
    {
      const baseBest = /* @__PURE__ */ new Map();
      items.forEach((item) => {
        const clean = _baseLiveName(item.title);
        const r = _isChannelRegional(clean, regionSet);
        if (!r) return;
        const base = r.base.toLowerCase();
        const score = r.region === userReg ? 2 : 0;
        if (!baseBest.has(base) || score > baseBest.get(base).score)
          baseBest.set(base, { score, item });
      });
      if (baseBest.size) {
        const keepRegional = new Set([...baseBest.values()].map((v) => v.item));
        items = items.filter((item) => {
          const clean = _baseLiveName(item.title);
          const r = _isChannelRegional(clean, regionSet);
          if (!r) return true;
          return keepRegional.has(item);
        });
      }
    }
  }
  if (S.type === "live") {
    items = groupLiveItems(items);
    if (document.documentElement.classList.contains("is-tv")) {
      const _seenCat = /* @__PURE__ */ new Set();
      items = items.filter((g) => {
        const firstOfCat = !_seenCat.has(g.category_name);
        _seenCat.add(g.category_name);
        if (firstOfCat && /frlog\.png(\?|$)/i.test(g.stream_icon || "")) return false;
        return true;
      });
    }
  }
  if (S.type === "live" && !S.search) {
    const _TNT_LCN = {
      "TF1": 1,
      "FRANCE2": 2,
      "FRANCE3": 3,
      "CANAL+": 4,
      "FRANCE5": 5,
      "M6": 6,
      "ARTE": 7,
      "C8": 8,
      "W9": 9,
      "TMC": 10,
      "TFX": 11,
      "NRJ12": 12,
      "LCP": 13,
      "LCPAN": 13,
      "FRANCE4": 14,
      "BFMTV": 15,
      "CNEWS": 16,
      "CSTAR": 17,
      "GULLI": 18,
      "TF1SERIESFILMS": 20,
      "LEQUIPE": 21,
      "LEQUIPELIVE21": 21,
      "6TER": 22,
      "RMCSTORY": 23,
      "RMCDECOUVERTE": 24,
      "CHERIE25": 25,
      "LCI": 26,
      "FRANCEINFO": 27
    };
    const _tntNorm = (t) => (t || "").replace(_DECO_RE, " ").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9+]/g, "");
    const _lcn = (title) => {
      const n = _TNT_LCN[_tntNorm(title)];
      if (n) return n;
      if (S.region && S._liveRegionIdx) {
        const r = _isChannelRegional(title, S._liveRegionIdx.regionSet);
        if (r) {
          const nb = _TNT_LCN[_tntNorm(r.base)];
          if (nb) return nb;
        }
      }
      return 9999;
    };
    const _CAT_PRI = {
      "EU | FRANCE GENERAL": 0,
      "EU | FRANCE NEWS": 1,
      "EU | FRANCE ENTERTAINMENT": 2,
      "EU | FRANCE SPORTS": 3,
      "EU | FRANCE CINEMA": 4,
      "EU | FRANCE DOCUMENTAIRE": 5,
      "EU | FRANCE KIDS": 6,
      "EU | FRANCE DOM TOM": 7,
      "EU | 24/7 FRENCH": 8,
      "EU | FRANCE PLUTO TV": 9,
      "EU | FRANCE DAZN": 10,
      "EU | FRANCE LIGUE 1+": 11
    };
    items.sort((a, b) => {
      var _a, _b;
      const la = _lcn(a.title), lb = _lcn(b.title);
      if (la !== lb) return la - lb;
      if (la !== 9999) return a.title.localeCompare(b.title);
      const pa = (_a = _CAT_PRI[a.category_name]) != null ? _a : 99;
      const pb = (_b = _CAT_PRI[b.category_name]) != null ? _b : 99;
      if (pa !== pb) return pa - pb;
      return a.title.localeCompare(b.title);
    });
  }
  if (S.favOnly) {
    if (S.type === "live") items = items.filter((g) => isFav(g));
    else items = items.filter((x) => isFav(x));
  }
  return items;
}
const _QUAL_ORDER = ["4K", "UHD", "FHD", "HDR", "HDTV", "HD", "HEVC", "SD"];
const _QUAL_RE = /[\s\[\(]+(HDR\+?|HDTV|FHD|UHD|4K|8K|HEVC|H\.?265|H\.?264|1080p?|720p?|2160p?|HD|SD)\b\]?\)?/gi;
function _parseLiveQuality(title) {
  if (!title) return null;
  const re = new RegExp(_QUAL_RE.source, _QUAL_RE.flags);
  const matches = [];
  let m;
  while ((m = re.exec(title)) !== null) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    matches.push(m[1].toUpperCase());
  }
  for (const q of _QUAL_ORDER) if (matches.includes(q)) return q;
  return matches[0] || null;
}
const _DECO_RE = /[◉★►•·✦✧▶⬤●❶-❿①-⑳]+/g;
function _baseLiveName(title) {
  if (!title) return "";
  return title.replace(_DECO_RE, " ").replace(_QUAL_RE, "").replace(/^[\s\-–—|:]+/, "").replace(/\s+/g, " ").trim();
}
const _NON_GEO = /* @__PURE__ */ new Set([
  "séries",
  "series",
  "films",
  "cinéma",
  "cinema",
  "sport",
  "sports",
  "info",
  "kids",
  "jeunesse",
  "comedy",
  "action",
  "thriller",
  "music",
  "news",
  "live",
  "direct",
  "replay",
  "plus",
  "one",
  "two",
  "max",
  "go",
  "box",
  "play",
  "vod",
  "premium",
  "extra",
  "family",
  "classic",
  "vintage",
  "gold",
  "select",
  "club",
  "tv",
  "web",
  "mobile",
  "app",
  // Chiffres — empêchent France 2 / Canal 2 / RMC 2… d'être classés "régionaux"
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
  // Qualités vidéo — jamais des noms de régions
  "hd",
  "sd",
  "4k",
  "uhd",
  "fhd",
  "hdr",
  // Suffixes IPTV courants (pas des noms géographiques)
  "²",
  "2",
  "fr",
  "be",
  "ch",
  "lu",
  "ca",
  "us",
  "event",
  "event only",
  "only",
  "vip",
  "iptv",
  "adult",
  "adults",
  "rue",
  "ter",
  "bis",
  // Suffixes de chaînes thématiques (Canal+, L'Équipe, BeIN...)
  "action",
  "animation",
  "aventure",
  "cinema",
  "cinéma",
  "comedie",
  "comédie",
  "crime",
  "decouvertes",
  "découvertes",
  "drame",
  "enquetes",
  "enquêtes",
  "famille",
  "gaming",
  "horreur",
  "investigation",
  "jeunesse",
  "kids",
  "life",
  "nature",
  "polar",
  "romance",
  "sci-fi",
  "scifi",
  "serie",
  "séries",
  "thriller",
  "western",
  "event only",
  "event",
  "only",
  "a+",
  "+1",
  "+2",
  "+3",
  "+4",
  "+5",
  "max",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten"
]);
const _GEO_NAMES = /* @__PURE__ */ new Set([
  // Nouvelles régions administratives
  "auvergne-rhône-alpes",
  "bourgogne-franche-comté",
  "bretagne",
  "centre-val de loire",
  "corse",
  "grand est",
  "hauts-de-france",
  "île-de-france",
  "normandie",
  "nouvelle-aquitaine",
  "occitanie",
  "pays de la loire",
  "provence-alpes-côte d'azur",
  // Anciennes régions (encore très utilisées dans les flux IPTV)
  "alsace",
  "aquitaine",
  "auvergne",
  "bourgogne",
  "champagne",
  "champagne-ardenne",
  "franche-comté",
  "languedoc",
  "languedoc-roussillon",
  "limousin",
  "lorraine",
  "midi-pyrénées",
  "nord-pas-de-calais",
  "picardie",
  "poitou-charentes",
  "rhône-alpes",
  // Abréviations courantes
  "ara",
  "bfc",
  "cvl",
  "hdf",
  "idf",
  "na",
  "npc",
  "paca",
  "pdl",
  // Grandes villes (BFM régionales, etc.)
  "paris",
  "lyon",
  "marseille",
  "bordeaux",
  "toulouse",
  "lille",
  "rennes",
  "nantes",
  "strasbourg",
  "montpellier",
  "nice",
  "grenoble",
  "rouen",
  "toulon",
  "perpignan",
  "nancy",
  // DOM-TOM
  "guadeloupe",
  "martinique",
  "guyane",
  "la réunion",
  "réunion",
  "mayotte",
  // Variantes sans accents / avec espaces (orthographes alternatives dans les flux)
  "ile-de-france",
  "hauts de france",
  "ile de france",
  "rhone-alpes",
  "franche comte",
  "pays-de-la-loire",
  // Variantes SANS tirets (providers qui utilisent des espaces)
  "nord pas de calais",
  "nouvelle aquitaine",
  "auvergne rhone alpes",
  "bourgogne franche comte",
  "centre val de loire",
  "provence alpes cote d azur",
  "pays de loire",
  // Autres suffixes régionaux fréquents
  "grand littoral",
  "alsace-moselle",
  "nord picardie",
  // Sous-régions / bassins France 3 (apparaissent dans certains flux)
  "alpes",
  "alpes du sud",
  "côte d azur",
  "cote d azur",
  "poitou",
  "charentes",
  "berry",
  "limousin",
  "auvergne",
  "bourgogne",
  "franche-comte",
  "franche comté",
  "lorraine",
  "champagne ardenne",
  "picardie",
  "haute normandie",
  "basse normandie",
  "centre",
  "ardennes",
  "moselle",
  "alsace"
]);
function _buildLiveRegionIdx(items) {
  const baseSuffixes = /* @__PURE__ */ new Map();
  const suffixBases = /* @__PURE__ */ new Map();
  items.forEach((item) => {
    const clean = _baseLiveName(item.title).trim();
    const words = clean.split(/\s+/);
    if (words.length < 2) return;
    for (let n = 1; n <= Math.min(4, words.length - 1); n++) {
      const suf = words.slice(-n).join(" ").toLowerCase();
      const base = words.slice(0, -n).join(" ").toLowerCase();
      if (!suf || !base || _NON_GEO.has(suf) || suf.length < 2 || base.length < 2) continue;
      if (/\d|[²³¹$&@!%#^*]/.test(suf)) continue;
      if (/^[-–—]/.test(suf) || /[()[\]]/.test(suf)) continue;
      if (!baseSuffixes.has(base)) baseSuffixes.set(base, /* @__PURE__ */ new Set());
      baseSuffixes.get(base).add(suf);
      if (!suffixBases.has(suf)) suffixBases.set(suf, /* @__PURE__ */ new Set());
      suffixBases.get(suf).add(base);
    }
  });
  const regionSet = /* @__PURE__ */ new Set();
  suffixBases.forEach((bases, suf) => {
    if (bases.size >= 2) regionSet.add(suf);
  });
  baseSuffixes.forEach((suffixes, _base) => {
    if (suffixes.size >= 2) suffixes.forEach((suf) => regionSet.add(suf));
  });
  const displayNames = /* @__PURE__ */ new Map();
  items.forEach((item) => {
    const clean = _baseLiveName(item.title).trim();
    const words = clean.split(/\s+/);
    for (let n = 1; n <= Math.min(4, words.length - 1); n++) {
      const suf = words.slice(-n).join(" ");
      const lc = suf.toLowerCase();
      if (regionSet.has(lc) && !displayNames.has(lc)) displayNames.set(lc, suf);
    }
  });
  try {
    const names = [...displayNames.values()].sort((a, b) => a.localeCompare(b, "fr"));
    localStorage.setItem("pipsily_available_regions", JSON.stringify(names));
  } catch (e) {
  }
  return { regionSet, displayNames };
}
function _isChannelRegional(cleanTitle2, regionSet) {
  const words = cleanTitle2.replace(/\s+[-–—]\s+/g, " ").trim().split(/\s+/);
  if (words.length < 2) return null;
  for (let n = Math.min(4, words.length - 1); n >= 1; n--) {
    const suf = words.slice(-n).join(" ").toLowerCase();
    const base = words.slice(0, -n).join(" ");
    if ((regionSet.has(suf) || _GEO_NAMES.has(suf)) && base) return { base, region: suf };
  }
  for (let i = 1; i < words.length; i++) {
    const word = words[i].toLowerCase();
    if (_GEO_NAMES.has(word)) {
      const base = words.slice(0, i).join(" ");
      if (base) return { base, region: word };
    }
  }
  return null;
}
const _LW = "?width=160";
const _LB = "https://commons.wikimedia.org/wiki/Special:FilePath/";
const _LOGO_MAP = {
  // France Télévisions ───────────────────────────────────────────────────────
  "france 2": _LB + "France_2_logo.svg" + _LW,
  "france 3": _LB + "France_3.svg" + _LW,
  "france 4": _LB + "France_4_logo.svg" + _LW,
  "france 5": _LB + "France_5_logo.svg" + _LW,
  "franceinfo": _LB + "Franceinfo_logo.svg" + _LW,
  "france info": _LB + "Franceinfo_logo.svg" + _LW,
  // TF1 Groupe ──────────────────────────────────────────────────────────────
  "tf1": _LB + "TF1_logo.svg" + _LW,
  "tmc": _LB + "TMC_logo.svg" + _LW,
  "tfx": _LB + "TFX.svg" + _LW,
  "tf1 series films": _LB + "TF1_S%C3%A9ries_Films.svg" + _LW,
  "tf1 séries films": _LB + "TF1_S%C3%A9ries_Films.svg" + _LW,
  "tf1 series": _LB + "TF1_S%C3%A9ries_Films.svg" + _LW,
  "tf1 séries": _LB + "TF1_S%C3%A9ries_Films.svg" + _LW,
  "lci": _LB + "LCI_logo.svg" + _LW,
  // M6 Groupe ───────────────────────────────────────────────────────────────
  "m6": _LB + "M6_logo.svg" + _LW,
  "w9": _LB + "W9.svg" + _LW,
  "6ter": _LB + "6ter.svg" + _LW,
  // Arte / Canal+ ───────────────────────────────────────────────────────────
  "arte": _LB + "Arte_Logo.svg" + _LW,
  "canal+": _LB + "Canal%2B.svg" + _LW,
  "canal plus": _LB + "Canal%2B.svg" + _LW,
  // Info / News ─────────────────────────────────────────────────────────────
  "bfmtv": _LB + "BFMTV.svg" + _LW,
  "bfm tv": _LB + "BFMTV.svg" + _LW,
  "bfm": _LB + "BFMTV.svg" + _LW,
  // couvre BFM Paris, BFM Lyon…
  "cnews": _LB + "CNews.svg" + _LW,
  // Divertissement TNT ──────────────────────────────────────────────────────
  "c8": _LB + "C8.svg" + _LW,
  "cstar": _LB + "CStar.svg" + _LW,
  "c star": _LB + "CStar.svg" + _LW,
  "gulli": _LB + "Gulli.svg" + _LW,
  "nrj12": _LB + "NRJ_12.svg" + _LW,
  "nrj 12": _LB + "NRJ_12.svg" + _LW,
  "neon": _LB + "Neon_TV.svg" + _LW,
  "chérie 25": _LB + "Ch%C3%A9rie_25.svg" + _LW,
  "cherie 25": _LB + "Ch%C3%A9rie_25.svg" + _LW,
  "l'equipe": _LB + "L%27%C3%89quipe_TV.svg" + _LW,
  "l equipe": _LB + "L%27%C3%89quipe_TV.svg" + _LW,
  "rmc story": _LB + "RMC_Story.svg" + _LW,
  "rmc decouverte": _LB + "RMC_D%C3%A9couverte.svg" + _LW,
  "rmc découverte": _LB + "RMC_D%C3%A9couverte.svg" + _LW,
  "paramount": _LB + "Paramount_Network.svg" + _LW
};
const _LOGO_KEYS = Object.keys(_LOGO_MAP).sort((a, b) => b.length - a.length);
function _getLogoFallback(title) {
  if (!title) return "";
  const key = _baseLiveName(title).toLowerCase();
  for (const k of _LOGO_KEYS) {
    if (key === k || key.startsWith(k + " ")) return _LOGO_MAP[k];
  }
  return "";
}
function groupLiveItems(items) {
  const groups = /* @__PURE__ */ new Map();
  items.forEach((item) => {
    const base = _baseLiveName(item.title) || item.title;
    const qual = _parseLiveQuality(item.title);
    if (!groups.has(base)) {
      groups.set(base, {
        ...item,
        title: base,
        type: "live",
        _variants: [],
        _iconRank: 999
      });
    }
    const g = groups.get(base);
    g._variants.push({ quality: qual || "Auto", item });
    const rank = qual ? _QUAL_ORDER.indexOf(qual) : 99;
    if (rank >= 0 && rank < g._iconRank && item.stream_icon) {
      g.stream_icon = item.stream_icon;
      g._iconRank = rank;
    }
  });
  groups.forEach((g) => {
    g._variants.sort((a, b) => {
      const ra = _QUAL_ORDER.indexOf(a.quality);
      const rb = _QUAL_ORDER.indexOf(b.quality);
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
    });
  });
  return [...groups.values()];
}
function openLivePicker(group) {
  if (document.getElementById("livePicker")) return;
  if (typeof stopPreview === "function") stopPreview();
  history.pushState({ pip: "picker" }, "");
  const ov = document.createElement("div");
  ov.id = "livePicker";
  ov.className = "live-picker";
  const makeHint = (title, quality) => {
    let h = title.replace(new RegExp(`\\b${quality}\\b`, "i"), "").replace(/[\[\]\(\)\s]+$/, "").trim();
    return h || title;
  };
  const _isFavGroup = isFav(group);
  ov.innerHTML = `
    <div class="live-picker__box">
      <h2 class="live-picker__title">${esc(group.title)}</h2>
      <p class="live-picker__sub">Choisissez la qualité · utilisez ←→ + OK</p>
      <div class="live-picker__grid">
        ${group._variants.map((v, i) => `
          <button class="live-picker__btn${i === 0 ? " live-picker__btn--focus" : ""}"
                  data-idx="${i}" tabindex="${i === 0 ? 0 : -1}">
            <span class="live-picker__qual">${esc(v.quality)}</span>
            <span class="live-picker__hint">${esc(makeHint(v.item.title, v.quality))}</span>
          </button>`).join("")}
      </div>
      <div class="live-picker__actions">
        <button class="live-picker__fav ${_isFavGroup ? "is-fav" : ""}" id="livePickerFav" tabindex="-1">
          ${_isFavGroup ? "♥ Retirer" : "♡ Favori"}
        </button>
        <button class="live-picker__close" id="livePickerClose" tabindex="-1">✕ Fermer</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const allBtns = () => [...ov.querySelectorAll(".live-picker__btn")];
  const favEl = () => document.getElementById("livePickerFav");
  const closeEl = () => document.getElementById("livePickerClose");
  let focusIdx = 0;
  let actionFocus = -1;
  const clearQualFocus = () => {
    allBtns().forEach((b) => {
      b.classList.remove("live-picker__btn--focus");
      b.tabIndex = -1;
    });
  };
  const clearActionFocus = () => {
    const f = favEl();
    if (f) {
      f.classList.remove("live-picker__fav--focus");
      f.tabIndex = -1;
    }
    const c = closeEl();
    if (c) {
      c.classList.remove("live-picker__close--focus");
      c.tabIndex = -1;
    }
  };
  const focusBtn = (idx) => {
    const btns = allBtns();
    if (idx < 0 || idx >= btns.length) return;
    focusIdx = idx;
    actionFocus = -1;
    clearActionFocus();
    btns.forEach((b, i) => {
      b.classList.toggle("live-picker__btn--focus", i === idx);
      b.tabIndex = i === idx ? 0 : -1;
    });
    btns[idx].focus();
  };
  const focusAction = (which) => {
    actionFocus = which;
    clearQualFocus();
    const f = favEl();
    const c = closeEl();
    if (f) {
      f.classList.toggle("live-picker__fav--focus", which === 0);
      f.tabIndex = which === 0 ? 0 : -1;
    }
    if (c) {
      c.classList.toggle("live-picker__close--focus", which === 1);
      c.tabIndex = which === 1 ? 0 : -1;
    }
    if (which === 0 && f) f.focus();
    else if (which === 1 && c) c.focus();
  };
  const close = (fromPopstate = false) => {
    var _a;
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
    if (!fromPopstate && ((_a = history.state) == null ? void 0 : _a.pip) === "picker") history.back();
  };
  ov._closePicker = close;
  function onKey(e) {
    if (!document.getElementById("livePicker")) {
      document.removeEventListener("keydown", onKey, true);
      return;
    }
    const btns = allBtns();
    const inAction = actionFocus >= 0;
    switch (e.key) {
      case "Escape":
      case "GoBack":
      case "Back":
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case "ArrowRight":
        e.preventDefault();
        e.stopPropagation();
        if (inAction) focusAction(actionFocus === 0 ? 1 : 0);
        else focusBtn(Math.min(focusIdx + 1, btns.length - 1));
        return;
      case "ArrowLeft":
        e.preventDefault();
        e.stopPropagation();
        if (inAction) focusAction(actionFocus === 0 ? 1 : 0);
        else focusBtn(Math.max(focusIdx - 1, 0));
        return;
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        if (!inAction) focusAction(0);
        return;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        if (inAction) focusBtn(focusIdx);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        e.stopPropagation();
        if (inAction && actionFocus === 1) {
          close();
          return;
        }
        if (inAction && actionFocus === 0) {
          toggleFav(group);
          const f = favEl();
          if (f) {
            const nowFav = isFav(group);
            f.classList.toggle("is-fav", nowFav);
            f.textContent = nowFav ? "♥ Retirer" : "♡ Favori";
          }
          return;
        }
        if (btns[focusIdx]) {
          close();
          playItem(group._variants[focusIdx].item);
        }
        return;
    }
  }
  document.addEventListener("keydown", onKey, true);
  allBtns().forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      close();
      playItem(group._variants[idx].item);
    });
    btn.addEventListener("focus", () => {
      focusIdx = Number(btn.dataset.idx);
      actionFocus = -1;
      allBtns().forEach((b, i) => b.classList.toggle("live-picker__btn--focus", i === focusIdx));
    });
  });
  const favBtnEl = favEl();
  if (favBtnEl) favBtnEl.addEventListener("click", () => {
    toggleFav(group);
    const nowFav = isFav(group);
    favBtnEl.classList.toggle("is-fav", nowFav);
    favBtnEl.textContent = nowFav ? "♥ Retirer" : "♡ Favori";
  });
  const cBtnEl = closeEl();
  if (cBtnEl) cBtnEl.addEventListener("click", close);
  ov.addEventListener("click", (e) => {
    if (e.target === ov) close();
  });
  setTimeout(() => focusBtn(0), 80);
}
function renderGrid(reset = false) {
  var _a;
  const grid = $("grid");
  const empty = $("emptyState");
  if (!grid) return;
  const col = filtered();
  const limit = S.shown[S.type];
  const items = col.slice(0, limit);
  if (!items.length) {
    grid.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  if (reset) grid.innerHTML = "";
  const frag = document.createDocumentFragment();
  let _staggerIdx = 0;
  items.slice(grid.children.length).forEach((item) => {
    const card = document.createElement("div");
    const key = itemKey(item);
    card.className = "card";
    card.tabIndex = 0;
    card.dataset.key = key;
    card._pfItem = item;
    card.style.setProperty("--i", Math.min(_staggerIdx++, 18));
    const isSeries = item.type === "series";
    const isLive = item.type === "live";
    const poster = item.stream_icon || (isLive ? _getLogoFallback(item.title) : "");
    const badgeCls = isLive ? "card-badge--live" : isSeries ? "card-badge--s" : "card-badge--f";
    const badgeTxt = isLive ? "📡 Live" : isSeries ? "Série" : "Film";
    const pct = isLive ? 0 : getWatchPct(item);
    const progBar = pct > 0.03 && pct < 0.97 ? `<div class="card-prog-bar"><div class="card-prog-fill" style="width:${Math.round(pct * 100)}%"></div></div>` : "";
    card.innerHTML = `
      <div class="card-media">
        ${poster ? `<img src="${esc(poster)}" alt="" loading="lazy" onerror="this.style.display='none';var p=document.createElement('div');p.className='card-placeholder';p.textContent='${isLive ? "📡" : "🎬"}';this.parentNode.insertBefore(p,this);">` : `<div class="card-placeholder">${isLive ? "📡" : "🎬"}</div>`}
        <span class="card-badge ${badgeCls}">${badgeTxt}</span>
        ${item.quality && !isLive ? `<span class="card-qual">${esc(item.quality)}</span>` : ""}
        <button class="fav-btn ${isFav(item) ? "is-fav" : ""}" type="button" aria-label="Favori">♥</button>
        ${progBar}
      </div>
      <div class="card-info">
        <div class="card-title">${esc(item.title)}</div>
        <div class="card-cat">${esc(displayCat(item.category_name))}</div>
      </div>`;
    card.querySelector(".fav-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFav(item);
    });
    const activate = () => {
      var _a2, _b;
      if (item.type === "series") openPanel(item);
      else if (item.type === "live") {
        if (item._variants && item._variants.length > 1) openLivePicker(item);
        else playItem(((_b = (_a2 = item._variants) == null ? void 0 : _a2[0]) == null ? void 0 : _b.item) || item);
      } else openVodPanel(item);
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
    card.addEventListener("focus", () => card.classList.add("is-tv-focused"));
    card.addEventListener("blur", () => card.classList.remove("is-tv-focused"));
    frag.appendChild(card);
  });
  grid.appendChild(frag);
  $("catalogCount").textContent = `${col.length} éléments · ${grid.children.length} affichés`;
  if (reset && document.documentElement.classList.contains("is-tv") && document.activeElement === document.body) {
    (_a = grid.querySelector(".card")) == null ? void 0 : _a.focus();
  }
}
function loadMore() {
  if (S.loading) return;
  S.loading = true;
  const col = filtered();
  const next = Math.min(S.shown[S.type] + PER_PAGE, col.length);
  if (next > S.shown[S.type]) {
    S.shown[S.type] = next;
    renderGrid();
  }
  S.loading = false;
}
const NROW_MAX = 24;
function makeNrowCard(item) {
  const card = document.createElement("div");
  const isLive = item.type === "live";
  card.className = "nrow-card" + (isLive ? " nrow-card--live" : "");
  card.tabIndex = 0;
  card.dataset.key = itemKey(item);
  card._pfItem = item;
  const poster = item.stream_icon || (isLive ? _getLogoFallback(item.title) : "");
  const isSeries = item.type === "series";
  const pct = isLive ? 0 : getWatchPct(item);
  const progBar = pct > 0.03 && pct < 0.97 ? `<div class="card-prog-bar"><div class="card-prog-fill" style="width:${Math.round(pct * 100)}%"></div></div>` : "";
  card.innerHTML = `
    <div class="nrow-media">
      ${poster ? `<img src="${esc(poster)}" alt="">` : `<div class="nrow-placeholder">${isSeries ? "📺" : "🎬"}</div>`}
      ${item.quality ? `<span class="nrow-qual">${esc(item.quality)}</span>` : ""}
      <div class="nrow-overlay"><span class="nrow-play">▶</span></div>
      <button class="nrow-fav ${isFav(item) ? "is-fav" : ""}" type="button" aria-label="Favori">♥</button>
      ${progBar}
    </div>
    <div class="nrow-info">
      <div class="nrow-name">${esc(item.title)}</div>
    </div>`;
  if (poster) {
    const imgEl = card.querySelector(".nrow-media img");
    if (imgEl) imgEl.onerror = function() {
      this.style.display = "none";
      const ph = document.createElement("div");
      ph.className = "nrow-placeholder";
      ph.textContent = isSeries ? "📺" : "🎬";
      this.parentNode.insertBefore(ph, this);
    };
  }
  card.querySelector(".nrow-fav").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFav(item);
    e.currentTarget.classList.toggle("is-fav", isFav(item));
  });
  const activate = () => {
    if (item.type === "series") openPanel(item);
    else if (item.type === "live") playItem(item);
    else openVodPanel(item);
  };
  card.addEventListener("click", (e) => {
    if (!e.target.closest(".nrow-fav")) activate();
  });
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  });
  card.addEventListener("focus", () => card.classList.add("is-tv-focused"));
  card.addEventListener("blur", () => card.classList.remove("is-tv-focused"));
  return card;
}
function displayCatName(name) {
  const n = (name || "").toUpperCase();
  if (/LATEST\s+MOVIES?/.test(n)) return "DERNIERS AJOUTS";
  if (/LATEST\s+SERIES/.test(n)) return "DERNIERS AJOUTS";
  return name;
}
function renderNetflixRows() {
  const grid = $("grid");
  const empty = $("emptyState");
  if (!grid) return;
  const all = S.type === "vod" ? S.vod : S.series;
  const catMap = /* @__PURE__ */ new Map();
  for (const item of all) {
    const cat = item.category_name || "Autre";
    if (_isAdultCat(cat)) continue;
    if (_isVostfr(item)) continue;
    if (!catMap.has(cat)) catMap.set(cat, []);
    catMap.get(cat).push(item);
  }
  if (!catMap.size) {
    grid.innerHTML = "";
    empty.hidden = false;
    return;
  }
  const isLatest = (k) => /LATEST\s+(MOVIES?|SERIES)/i.test(k);
  const sorted = [...catMap.entries()].sort(([a], [b]) => {
    if (isLatest(a) && !isLatest(b)) return -1;
    if (!isLatest(a) && isLatest(b)) return 1;
    return 0;
  });
  const orderedMap = new Map(sorted);
  empty.hidden = true;
  grid.innerHTML = "";
  const rowsArr = [...orderedMap.entries()];
  let rowIdx = 0;
  let totalItems = 0;
  const RBATCH = 3;
  function _buildRow(catName, items) {
    totalItems += items.length;
    const section = document.createElement("div");
    section.className = "nrow";
    const hdr = document.createElement("div");
    hdr.className = "nrow-hdr";
    const titleEl = document.createElement("h3");
    titleEl.className = "nrow-title";
    titleEl.textContent = displayCatName(catName);
    hdr.appendChild(titleEl);
    section.appendChild(hdr);
    const strip = document.createElement("div");
    strip.className = "nrow-strip";
    items.slice(0, NROW_MAX).forEach((item) => strip.appendChild(makeNrowCard(item)));
    const allTile = document.createElement("button");
    allTile.className = "nrow-card nrow-all-tile";
    allTile.type = "button";
    allTile.tabIndex = 0;
    allTile.setAttribute("aria-label", `Voir tout ${catName} (${items.length})`);
    allTile.innerHTML = `<div class="nrow-media nrow-all-media"><span class="nrow-all-arrow">→</span><span class="nrow-all-label">Voir tout</span><span class="nrow-all-count">(${items.length})</span></div>`;
    allTile.addEventListener("click", () => {
      var _a;
      S.cat = catName;
      const sel = $("categorySelect");
      if (sel) sel.value = catName;
      (_a = $("catPills")) == null ? void 0 : _a.querySelectorAll(".cat-pill").forEach(
        (b) => b.classList.toggle("cat-pill--active", b.dataset.cat === catName)
      );
      const g = $("grid");
      if (g) g.className = "grid";
      S.shown[S.type] = PER_PAGE;
      renderGrid(true);
    });
    strip.appendChild(allTile);
    section.appendChild(strip);
    return section;
  }
  function _renderBatch() {
    const end = Math.min(rowIdx + RBATCH, rowsArr.length);
    for (; rowIdx < end; rowIdx++) {
      const [catName, items] = rowsArr[rowIdx];
      grid.appendChild(_buildRow(catName, items));
    }
    if (rowIdx < rowsArr.length) {
      requestAnimationFrame(_renderBatch);
    } else {
      $("catalogCount").textContent = `${totalItems} éléments · ${rowsArr.length} catégories`;
    }
  }
  _renderBatch();
}
function render() {
  const col = filtered();
  const label = S.type === "vod" ? "Films" : S.type === "series" ? "Séries" : "TV en direct";
  const heroEl = $("hero");
  const novSect = $("nouveautesSection");
  if (S.type === "live") {
    if (heroEl) heroEl.hidden = false;
    $("heroTitle").textContent = label;
    $("heroSubtitle").textContent = S.cat || "";
    $("statCount").textContent = `${col.length} éléments`;
  } else {
    if (heroEl) heroEl.hidden = true;
    if (novSect) novSect.hidden = true;
  }
  renderPoursuivreRow();
  const _qp = $("qualityPills");
  const _rp = $("regionPills");
  if (S.type === "live") {
    if (_qp) _qp.style.display = "none";
    _renderRegionPills(_rp);
  } else {
    if (_qp) _qp.style.display = "";
    if (_rp) _rp.hidden = true;
    document.querySelectorAll(".quality-pill").forEach(
      (p) => p.classList.toggle("quality-pill--active", p.dataset.q === S.quality)
    );
  }
  const all = S.type === "vod" ? S.vod : S.type === "series" ? S.series : S.live;
  const cats = [...new Set(all.map((x) => x.category_name).filter(Boolean))].sort();
  const catsForSelect = cats.filter((c) => !_isAdultCat(c) && !/vostfr/i.test(c));
  $("categorySelect").innerHTML = `<option value="">Toutes les catégories</option>` + catsForSelect.map((c) => `<option value="${esc(c)}"${c === S.cat ? " selected" : ""}>${esc(displayCat(c))}</option>`).join("");
  renderCatPills(cats);
  const useNetflix = S.type !== "live" && !S.search && !S.quality && !S.cat;
  const grid = $("grid");
  if (grid) grid.className = useNetflix ? "netflix-rows" : S.type === "live" ? "grid grid--live" : "grid";
  S.shown[S.type] = PER_PAGE;
  if (useNetflix) renderNetflixRows();
  else renderGrid(true);
}
function _renderRegionPills(container) {
  if (!container) return;
  container.hidden = false;
  let regions = [];
  try {
    regions = JSON.parse(localStorage.getItem("pipsily_available_regions") || "[]");
  } catch (e) {
  }
  const cur = S.region.toLowerCase();
  container.innerHTML = `<button class="quality-pill ${!S.region ? "quality-pill--active" : ""}" data-rgn="">🌍 Tout</button>` + regions.map((r) => {
    const lc = r.toLowerCase();
    return `<button class="quality-pill ${lc === cur ? "quality-pill--active" : ""}" data-rgn="${esc(lc)}">${esc(r.charAt(0).toUpperCase() + r.slice(1))}</button>`;
  }).join("");
  container.querySelectorAll("[data-rgn]").forEach((btn) => {
    btn.onclick = () => {
      const val = btn.dataset.rgn;
      S.region = val;
      S._liveRegionIdx = null;
      if (val) localStorage.setItem("pipsily_region", val);
      else localStorage.removeItem("pipsily_region");
      render();
    };
  });
}
function renderCatPills(cats) {
  var _a;
  const pills = $("catPills");
  if (!pills) return;
  pills.hidden = false;
  const normalCats = cats.filter((c) => !_isAdultCat(c) && !/vostfr/i.test(c));
  const hasAdult = cats.some((c) => _isAdultCat(c));
  const hasAdultPin = !!localStorage.getItem("pipsily_adult_pin");
  pills.innerHTML = `<button class="cat-pill cat-pill--search" data-search="1" aria-label="Rechercher">🔍</button><button class="cat-pill ${!S.cat ? "cat-pill--active" : ""}" data-cat="">Tout</button>` + normalCats.map(
    (c) => `<button class="cat-pill ${c === S.cat ? "cat-pill--active" : ""}" data-cat="${esc(c)}">${esc(displayCat(c))}</button>`
  ).join("") + (hasAdult && hasAdultPin ? `<button class="cat-pill ${S.cat === "__ADULT__" ? "cat-pill--active" : ""}" data-cat="__ADULT__" style="color:#ff8899">🔞 Adult</button>` : "");
  (_a = pills.querySelector(".cat-pill--search")) == null ? void 0 : _a.addEventListener("click", () => openSearchOverlay());
  pills.querySelectorAll(".cat-pill[data-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;
      if (cat === "__ADULT__" && !sessionStorage.getItem("pipsily_adult_unlocked")) {
        const stored = localStorage.getItem("pipsily_adult_pin");
        if (!stored) {
          return;
        }
        showAdultPinPrompt(pills);
        return;
      }
      S.cat = cat;
      const sel = $("categorySelect");
      if (sel) sel.value = S.cat;
      S.shown[S.type] = PER_PAGE;
      pills.querySelectorAll(".cat-pill[data-cat]").forEach(
        (b) => b.classList.toggle("cat-pill--active", b.dataset.cat === S.cat)
      );
      const useNetflix = !S.cat && !S.search && !S.quality;
      const g = $("grid");
      if (g) g.className = useNetflix ? "netflix-rows" : S.type === "live" ? "grid grid--live" : "grid";
      if (useNetflix) renderNetflixRows();
      else renderGrid(true);
    });
  });
}
function showAdultPinPrompt(pills) {
  if ($("adultPinOverlay")) return;
  const ov = document.createElement("div");
  ov.id = "adultPinOverlay";
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:flex;align-items:center;justify-content:center";
  ov.innerHTML = '<div style="background:#0c1422;border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:28px 24px;width:min(320px,90vw);text-align:center"><div style="font-size:28px;margin-bottom:10px">🔞</div><div style="font-size:16px;font-weight:800;color:#eef4ff;margin-bottom:6px">Contenu adulte</div><div style="font-size:13px;color:#7a9cc0;margin-bottom:18px">Entrez votre code PIN</div><input id="adultPinInput" type="password" inputmode="numeric" maxlength="6" placeholder="••••" style="width:100%;padding:12px;border-radius:11px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.07);color:#eef4ff;font-size:20px;text-align:center;outline:none;letter-spacing:6px;margin-bottom:12px;box-sizing:border-box" /><div id="adultPinErr" style="color:#ff8899;font-size:13px;margin-bottom:10px;min-height:18px"></div><div style="display:flex;gap:10px"><button id="adultPinCancel" style="flex:1;padding:11px;border-radius:11px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#7a9cc0;cursor:pointer;font-size:14px">Annuler</button><button id="adultPinOk" style="flex:1;padding:11px;border-radius:11px;border:none;background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;cursor:pointer;font-size:14px;font-weight:700">Valider</button></div></div>';
  document.body.appendChild(ov);
  const inp = $("adultPinInput");
  setTimeout(() => inp && inp.focus(), 60);
  const close = () => ov.remove();
  $("adultPinCancel").onclick = close;
  const validate = () => {
    const entered = inp ? inp.value.trim() : "";
    const stored = localStorage.getItem("pipsily_adult_pin");
    if (entered === stored) {
      sessionStorage.setItem("pipsily_adult_unlocked", "1");
      close();
      S.cat = "__ADULT__";
      if (pills) pills.querySelectorAll(".cat-pill[data-cat]").forEach(
        (b) => b.classList.toggle("cat-pill--active", b.dataset.cat === "__ADULT__")
      );
      S.shown[S.type] = PER_PAGE;
      const g = $("grid");
      if (g) g.className = "grid";
      renderGrid(true);
      if (typeof renderPoursuivreRow === "function") renderPoursuivreRow();
    } else {
      const err = $("adultPinErr");
      if (err) err.textContent = "Code incorrect";
      if (inp) {
        inp.value = "";
        inp.focus();
      }
    }
  };
  $("adultPinOk").onclick = validate;
  if (inp) inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") validate();
    if (e.key === "Escape") close();
  });
}
function openSearchOverlay() {
  if ($("searchOverlay")) return;
  const ov = document.createElement("div");
  ov.id = "searchOverlay";
  ov.className = "search-overlay";
  ov.innerHTML = `
    <div class="search-overlay__box">
      <h2 class="search-overlay__title">🔍 Rechercher</h2>
      <input id="searchOverlayInput" type="search" autocomplete="off"
             placeholder="Tapez un titre…" />
      <div class="search-overlay__hint">Entrée : valider · Échap : fermer</div>
    </div>`;
  document.body.appendChild(ov);
  const inp = $("searchOverlayInput");
  inp.value = S.search || "";
  setTimeout(() => inp.focus(), 50);
  const close = () => {
    var _a;
    ov.remove();
    (_a = document.querySelector(".cat-pill--search")) == null ? void 0 : _a.focus();
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      S.search = inp.value.trim();
      $("searchInput").value = S.search;
      S.shown[S.type] = PER_PAGE;
      const useNetflix = !S.cat && !S.search && !S.quality;
      const g = $("grid");
      if (g) g.className = useNetflix ? "netflix-rows" : S.type === "live" ? "grid grid--live" : "grid";
      if (useNetflix) renderNetflixRows();
      else renderGrid(true);
      close();
    }
  });
  ov.addEventListener("click", (e) => {
    if (e.target === ov) close();
  });
}
let _audioCtx = null;
function _playNavClick() {
  try {
    if (!window.AudioContext && !window.webkitAudioContext) return;
    if (!_audioCtx || _audioCtx.state === "closed") {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const ctx = _audioCtx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(720, now);
    osc.frequency.exponentialRampToValueAtTime(360, now + 0.055);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(1e-4, now + 0.07);
    osc.start(now);
    osc.stop(now + 0.07);
  } catch (e) {
  }
}
let _previewTimer = null;
let _previewKey = null;
let _previewUrls = [];
let _previewIdx = 0;
let _previewCard = null;
window._nativePlayerOpen = false;
function _markNativePlayback() {
  window._nativePlayerOpen = true;
  try {
    stopPreview();
  } catch (e) {
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    window._nativePlayerOpen = true;
    try {
      stopPreview();
    } catch (e) {
    }
  } else window._nativePlayerOpen = false;
});
function _previewSendRect() {
  var _a;
  if (typeof ((_a = window.AndroidBridge) == null ? void 0 : _a.startLivePreview) !== "function") return;
  if (window._nativePlayerOpen || document.hidden) {
    stopPreview();
    return;
  }
  const card = _previewCard;
  const url = _previewUrls[_previewIdx];
  if (!card || !card.isConnected || !url) return;
  const media = card.querySelector(".card-media, .nrow-media") || card;
  const r = media.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  try {
    window.AndroidBridge.startLivePreview(
      url,
      Math.round(r.left * dpr),
      Math.round(r.top * dpr),
      Math.round(r.width * dpr),
      Math.round(r.height * dpr)
    );
  } catch (e) {
  }
}
window.onLivePreviewError = function() {
  if (!_previewKey) return;
  _previewIdx++;
  if (_previewIdx >= _previewUrls.length) return;
  _previewSendRect();
};
function managePreview() {
  var _a, _b;
  if (window._nativePlayerOpen || document.hidden) {
    stopPreview();
    return;
  }
  const card = (_b = (_a = document.activeElement) == null ? void 0 : _a.closest) == null ? void 0 : _b.call(_a, ".card, .nrow-card");
  const item = card == null ? void 0 : card._pfItem;
  if (!item || item.type !== "live") {
    stopPreview();
    return;
  }
  const key = card.dataset.key;
  if (_previewKey === key) return;
  stopPreview();
  _previewKey = key;
  _previewCard = card;
  if (item._variants && item._variants.length) {
    _previewUrls = [...item._variants].reverse().map((v) => {
      var _a2, _b2;
      return ((_a2 = v.item) == null ? void 0 : _a2.url) || ((_b2 = v.item) == null ? void 0 : _b2.stream_url) || "";
    }).filter(Boolean);
  } else {
    _previewUrls = [item.url || item.stream_url || ""].filter(Boolean);
  }
  _previewIdx = 0;
  if (!_previewUrls.length) return;
  _previewTimer = setTimeout(() => {
    _previewSendRect();
    setTimeout(() => {
      if (_previewKey === key) _previewSendRect();
    }, 550);
  }, 850);
}
function stopPreview() {
  var _a, _b;
  if (_previewTimer) {
    clearTimeout(_previewTimer);
    _previewTimer = null;
  }
  _previewKey = null;
  _previewCard = null;
  _previewUrls = [];
  _previewIdx = 0;
  try {
    (_b = (_a = window.AndroidBridge) == null ? void 0 : _a.stopLivePreview) == null ? void 0 : _b.call(_a);
  } catch (e) {
  }
}
function initTV() {
  document.addEventListener("focusin", managePreview);
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      const ae = document.activeElement;
      if (!ae || ae === document.body) stopPreview();
    }, 0);
  });
  document.addEventListener("keydown", (e) => {
    var _a, _b, _c;
    const k = e.key;
    if (["Escape", "GoBack", "Back", "BrowserBack"].includes(k)) {
      e.preventDefault();
      if (!((_a = $("seriesPanel")) == null ? void 0 : _a.hidden)) {
        if (S.panel.isVod) closeVodPanel();
        else closePanel();
      }
      return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(k)) return;
    e.preventDefault();
    _playNavClick();
    const panelOpen = !((_b = $("seriesPanel")) == null ? void 0 : _b.hidden);
    const useNetflix = (_c = $("grid")) == null ? void 0 : _c.classList.contains("netflix-rows");
    if (panelOpen) {
      _navPanel(k);
      return;
    }
    if (useNetflix) {
      _navNetflix(k);
      return;
    }
    _navGrid(k);
  });
  function _navPanel(k) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
    const panel = $("seriesPanel");
    if (!panel) return;
    if (S.panel.isVod) {
      const items = [...panel.querySelectorAll(
        ".vod-play-btn, .vod-restart-btn, .fav-btn-large, .sp-close,.sp-resume-play, .sp-resume-restart, .sp-resume-dismiss"
      )].filter((el) => !el.closest("[hidden]"));
      const idx = items.indexOf(document.activeElement);
      if (idx < 0) {
        (_a = items[0]) == null ? void 0 : _a.focus();
        return;
      }
      if (k === "ArrowDown" || k === "ArrowRight") (_b = items[Math.min(idx + 1, items.length - 1)]) == null ? void 0 : _b.focus();
      else if (k === "ArrowUp" || k === "ArrowLeft") (_c = items[Math.max(idx - 1, 0)]) == null ? void 0 : _c.focus();
      return;
    }
    const active = document.activeElement;
    const closeBtn = panel.querySelector("#seriesCloseBtn");
    const actionBtns = [...panel.querySelectorAll(
      ".sp-series-actions .vod-play-btn,.sp-series-actions .vod-restart-btn,.sp-series-actions .fav-btn-large"
    )].filter((el) => !el.closest("[hidden]"));
    const tabs = [...panel.querySelectorAll(".sp-tab")].filter((el) => !el.closest("[hidden]"));
    const eps = [...panel.querySelectorAll(".sp-ep:not([disabled])")].filter((el) => !el.closest("[hidden]"));
    const isClose = active === closeBtn;
    const isAction = actionBtns.includes(active);
    const isTab = active == null ? void 0 : active.classList.contains("sp-tab");
    const isEp = active == null ? void 0 : active.classList.contains("sp-ep");
    if (!isClose && !isAction && !isTab && !isEp) {
      (_d = actionBtns[0] || tabs[0] || eps[0]) == null ? void 0 : _d.focus();
      return;
    }
    if (isClose) {
      if (k === "ArrowDown") {
        (_e = actionBtns[0] || tabs[0] || eps[0]) == null ? void 0 : _e.focus();
      }
      return;
    }
    if (isAction) {
      const ai = actionBtns.indexOf(active);
      if (k === "ArrowRight") {
        (_f = actionBtns[Math.min(ai + 1, actionBtns.length - 1)]) == null ? void 0 : _f.focus();
        return;
      }
      if (k === "ArrowLeft") {
        (_g = actionBtns[Math.max(ai - 1, 0)]) == null ? void 0 : _g.focus();
        return;
      }
      if (k === "ArrowUp") {
        closeBtn == null ? void 0 : closeBtn.focus();
        (_h = panel.scrollTo) == null ? void 0 : _h.call(panel, { top: 0, behavior: "smooth" });
        return;
      }
      if (k === "ArrowDown") {
        (_i = tabs[0] || eps[0]) == null ? void 0 : _i.focus();
        return;
      }
      return;
    }
    if (isTab) {
      const ti = tabs.indexOf(active);
      if (k === "ArrowRight" && ti < tabs.length - 1) {
        tabs[ti + 1].focus();
        return;
      }
      if (k === "ArrowLeft" && ti > 0) {
        tabs[ti - 1].focus();
        return;
      }
      if (k === "ArrowUp") {
        (_j = actionBtns[0] || closeBtn) == null ? void 0 : _j.focus();
        (_k = panel.scrollTo) == null ? void 0 : _k.call(panel, { top: 0, behavior: "smooth" });
        return;
      }
      if (k === "ArrowDown") {
        (_l = eps[0]) == null ? void 0 : _l.focus();
        return;
      }
      return;
    }
    if (isEp) {
      const ei = eps.indexOf(active);
      if (k === "ArrowDown") {
        if (ei < eps.length - 1) {
          eps[ei + 1].focus();
          eps[ei + 1].scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        return;
      }
      if (k === "ArrowUp") {
        if (ei > 0) {
          eps[ei - 1].focus();
          eps[ei - 1].scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
          (_m = tabs[0] || actionBtns[0]) == null ? void 0 : _m.focus();
          (_n = panel.scrollTo) == null ? void 0 : _n.call(panel, { top: 0, behavior: "smooth" });
        }
        return;
      }
      return;
    }
  }
  function _focusFirstPill() {
    const pills = $("catPills");
    if (!pills || pills.hidden) return false;
    const target = pills.querySelector(".cat-pill--active") || pills.querySelector(".cat-pill");
    if (target) {
      target.focus();
      target.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      window.scrollTo({ top: 0, behavior: "smooth" });
      return true;
    }
    return false;
  }
  function _navNetflix(k) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const active = document.activeElement;
    const isPill = active == null ? void 0 : active.classList.contains("cat-pill");
    const isNavBtn = active == null ? void 0 : active.classList.contains("nav-btn");
    const isNouCard = active == null ? void 0 : active.classList.contains("nou-card");
    const _firstNouCard = () => {
      for (const row of document.querySelectorAll(".nou-row")) {
        if (row.closest("[hidden]")) continue;
        const c = row.querySelector(".nou-card");
        if (c) return c;
      }
      return null;
    };
    if (isNouCard) {
      const row = active.closest(".nou-row");
      const cards = row ? [...row.querySelectorAll(".nou-card")] : [];
      const ci = cards.indexOf(active);
      if (k === "ArrowRight") {
        const next = cards[ci + 1];
        if (next) {
          next.focus();
          next.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        }
        return;
      }
      if (k === "ArrowLeft") {
        const prev = cards[ci - 1];
        if (prev) {
          prev.focus();
          prev.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        }
        return;
      }
      if (k === "ArrowUp") {
        const allRows2 = [...document.querySelectorAll(".nou-row")].filter((r) => !r.closest("[hidden]"));
        const ri = allRows2.indexOf(row);
        if (ri > 0) {
          const prevRow = allRows2[ri - 1];
          const prevCard = prevRow.querySelectorAll(".nou-card")[ci] || prevRow.querySelector(".nou-card");
          prevCard == null ? void 0 : prevCard.focus();
          prevCard == null ? void 0 : prevCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
          if (!_focusFirstPill()) (_a = document.querySelector(".nav-btn.active, .nav-btn")) == null ? void 0 : _a.focus();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
        return;
      }
      if (k === "ArrowDown") {
        const allRows2 = [...document.querySelectorAll(".nou-row")].filter((r) => !r.closest("[hidden]"));
        const ri = allRows2.indexOf(row);
        if (ri >= 0 && ri < allRows2.length - 1) {
          const nextRow = allRows2[ri + 1];
          const nextCard = nextRow.querySelectorAll(".nou-card")[ci] || nextRow.querySelector(".nou-card");
          nextCard == null ? void 0 : nextCard.focus();
          nextCard == null ? void 0 : nextCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
          const first = document.querySelector(".nrow-card, .card");
          if (first) {
            first.focus();
            first.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        }
        return;
      }
    }
    const CARD = ".nrow-card, .nou-card";
    const allRows = [
      ...[...document.querySelectorAll(".nou-row")].filter((r) => !r.closest("[hidden]") && r.children.length > 0),
      ...document.querySelectorAll(".nrow")
    ];
    const currentRow = active == null ? void 0 : active.closest(".nrow, .nou-row");
    const rowIdx = allRows.indexOf(currentRow);
    if (isNavBtn) {
      const navBtns = [...document.querySelectorAll(".nav-btn[data-type]")];
      const ni = navBtns.indexOf(active);
      if (k === "ArrowRight" && ni < navBtns.length - 1) {
        navBtns[ni + 1].focus();
        return;
      }
      if (k === "ArrowLeft" && ni > 0) {
        navBtns[ni - 1].focus();
        return;
      }
      if (k === "ArrowUp") {
        const uBtns = [...document.querySelectorAll("#topbarUserBtns a, #topbarUserBtns button")].filter((el) => getComputedStyle(el).display !== "none");
        if (uBtns.length) {
          uBtns[0].focus();
          return;
        }
      }
      if (k === "ArrowDown") {
        if (_focusFirstPill()) return;
        const first = (_b = allRows[0]) == null ? void 0 : _b.querySelector(CARD);
        if (first) {
          first.focus();
          first.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }
      return;
    }
    const isUserBtn = (active == null ? void 0 : active.closest("#topbarUserBtns")) !== null;
    if (isUserBtn) {
      const uBtns = [...document.querySelectorAll("#topbarUserBtns a, #topbarUserBtns button")].filter((el) => getComputedStyle(el).display !== "none");
      const ui = uBtns.indexOf(active);
      if (k === "ArrowRight" && ui < uBtns.length - 1) {
        uBtns[ui + 1].focus();
        return;
      }
      if (k === "ArrowLeft" && ui > 0) {
        uBtns[ui - 1].focus();
        return;
      }
      if (k === "ArrowDown") {
        (_c = document.querySelector(".nav-btn.active, .nav-btn")) == null ? void 0 : _c.focus();
        return;
      }
      return;
    }
    if (isPill) {
      const pills = [...document.querySelectorAll(".cat-pill")];
      const pi = pills.indexOf(active);
      if (k === "ArrowRight" && pi < pills.length - 1) {
        pills[pi + 1].focus();
        pills[pi + 1].scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        return;
      }
      if (k === "ArrowLeft" && pi > 0) {
        pills[pi - 1].focus();
        pills[pi - 1].scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        return;
      }
      if (k === "ArrowUp") {
        (_d = document.querySelector(".nav-btn.active, .nav-btn")) == null ? void 0 : _d.focus();
        return;
      }
      if (k === "ArrowDown") {
        const first = (_e = allRows[0]) == null ? void 0 : _e.querySelector(CARD);
        if (first) {
          first.focus();
          first.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        return;
      }
      return;
    }
    if (k === "ArrowRight" || k === "ArrowLeft") {
      if (!currentRow) return;
      const cards = [...currentRow.querySelectorAll(CARD)];
      const ci = cards.indexOf(active);
      if (ci < 0) return;
      const next = k === "ArrowRight" ? cards[ci + 1] : cards[ci - 1];
      if (next) {
        next.focus();
        next.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
      return;
    }
    if (rowIdx < 0) {
      if (k === "ArrowDown") {
        const first = (_f = allRows[0]) == null ? void 0 : _f.querySelector(CARD);
        if (first) {
          first.focus();
          first.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      } else if (k === "ArrowUp") {
        if (!_focusFirstPill()) (_g = document.querySelector(".nav-btn.active,.nav-btn")) == null ? void 0 : _g.focus();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }
    let targetRow;
    if (k === "ArrowDown") {
      targetRow = allRows[rowIdx + 1];
      if (!targetRow) return;
    } else {
      targetRow = rowIdx > 0 ? allRows[rowIdx - 1] : null;
    }
    if (targetRow) {
      const cards = [...currentRow.querySelectorAll(CARD)];
      const ci = Math.max(0, cards.indexOf(active));
      const tCards = [...targetRow.querySelectorAll(CARD)];
      const target = tCards[Math.min(ci, tCards.length - 1)] || tCards[0];
      if (target) {
        target.focus();
        target.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } else {
      if (!_focusFirstPill()) {
        (_h = document.querySelector(".nav-btn.active, .nav-btn")) == null ? void 0 : _h.focus();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }
  }
  function _navGrid(k) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    const active = document.activeElement;
    const isPill = active == null ? void 0 : active.classList.contains("cat-pill");
    const isNavBtn = active == null ? void 0 : active.classList.contains("nav-btn");
    const _firstNouCard = () => {
      for (const row of document.querySelectorAll(".nou-row")) {
        if (row.closest("[hidden]")) continue;
        const c = row.querySelector(".nou-card");
        if (c) return c;
      }
      return null;
    };
    if (isNavBtn) {
      const navBtns = [...document.querySelectorAll(".nav-btn[data-type]")];
      const ni = navBtns.indexOf(active);
      if (k === "ArrowRight" && ni < navBtns.length - 1) {
        navBtns[ni + 1].focus();
        return;
      }
      if (k === "ArrowLeft" && ni > 0) {
        navBtns[ni - 1].focus();
        return;
      }
      if (k === "ArrowUp") {
        const uBtns = [...document.querySelectorAll("#topbarUserBtns a, #topbarUserBtns button")].filter((el) => getComputedStyle(el).display !== "none");
        if (uBtns.length) {
          uBtns[0].focus();
          return;
        }
      }
      if (k === "ArrowDown") {
        if (_focusFirstPill()) return;
        (_a = document.querySelector(".card")) == null ? void 0 : _a.focus();
      }
      return;
    }
    const isUserBtn2 = (active == null ? void 0 : active.closest("#topbarUserBtns")) !== null;
    if (isUserBtn2) {
      const uBtns = [...document.querySelectorAll("#topbarUserBtns a, #topbarUserBtns button")].filter((el) => getComputedStyle(el).display !== "none");
      const ui = uBtns.indexOf(active);
      if (k === "ArrowRight" && ui < uBtns.length - 1) {
        uBtns[ui + 1].focus();
        return;
      }
      if (k === "ArrowLeft" && ui > 0) {
        uBtns[ui - 1].focus();
        return;
      }
      if (k === "ArrowDown") {
        (_b = document.querySelector(".nav-btn.active, .nav-btn")) == null ? void 0 : _b.focus();
        return;
      }
      return;
    }
    if (isPill) {
      const pills = [...document.querySelectorAll(".cat-pill")];
      const pi = pills.indexOf(active);
      if (k === "ArrowRight" && pi < pills.length - 1) {
        pills[pi + 1].focus();
        pills[pi + 1].scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        return;
      }
      if (k === "ArrowLeft" && pi > 0) {
        pills[pi - 1].focus();
        pills[pi - 1].scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        return;
      }
      if (k === "ArrowUp") {
        (_c = document.querySelector(".nav-btn.active, .nav-btn")) == null ? void 0 : _c.focus();
        return;
      }
      if (k === "ArrowDown") {
        (_d = document.querySelector(".card")) == null ? void 0 : _d.focus();
        return;
      }
      return;
    }
    const isNouCard = active == null ? void 0 : active.classList.contains("nou-card");
    if (isNouCard) {
      const row = active.closest(".nou-row");
      const rCards = row ? [...row.querySelectorAll(".nou-card")] : [];
      const ci = rCards.indexOf(active);
      if (k === "ArrowRight") {
        const nxt = rCards[ci + 1];
        if (nxt) {
          nxt.focus();
          nxt.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        }
        return;
      }
      if (k === "ArrowLeft") {
        const prv = rCards[ci - 1];
        if (prv) {
          prv.focus();
          prv.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        }
        return;
      }
      if (k === "ArrowUp") {
        if (!_focusFirstPill()) (_e = document.querySelector(".nav-btn.active,.nav-btn")) == null ? void 0 : _e.focus();
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      if (k === "ArrowDown") {
        const firstCard = document.querySelector(".card");
        if (firstCard) {
          firstCard.focus();
          firstCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        return;
      }
      return;
    }
    const cards = [...document.querySelectorAll(".card")];
    let idx = cards.indexOf(active);
    if (idx < 0) {
      (_f = cards[0]) == null ? void 0 : _f.focus();
      return;
    }
    let cols = 1;
    if (cards.length > 1) {
      const top0 = cards[0].offsetTop;
      while (cols < cards.length && Math.abs(cards[cols].offsetTop - top0) < 4) cols++;
    }
    let next = idx;
    if (k === "ArrowRight") next = Math.min(idx + 1, cards.length - 1);
    else if (k === "ArrowLeft") next = Math.max(0, idx - 1);
    else if (k === "ArrowDown") next = Math.min(idx + cols, cards.length - 1);
    else if (k === "ArrowUp") next = idx - cols;
    if (next < 0) {
      const nou = _firstNouCard();
      if (nou) {
        nou.focus();
        nou.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      if (!_focusFirstPill()) {
        (_g = document.querySelector(".nav-btn.active, .nav-btn")) == null ? void 0 : _g.focus();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      return;
    }
    (_h = cards[next]) == null ? void 0 : _h.focus();
    (_i = cards[next]) == null ? void 0 : _i.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}
function renderPoursuivreRow() {
  try {
    _renderPoursuivreRowInner();
  } catch (e) {
    console.error("[PIPSILY] renderPoursuivreRow:", e);
  }
}
function _renderPoursuivreRowInner() {
  const sect = $("poursuivreSection");
  const row = $("poursuivreRow");
  if (!sect || !row) return;
  if (S.type === "live") {
    sect.hidden = true;
    return;
  }
  const prog = getProg();
  const type = S.type;
  const _hideXXXItem = (item) => _isAdultCat(item == null ? void 0 : item.category_name);
  let inProgress = [];
  if (type === "series") {
    const seriesIdx = {};
    S.series.forEach((s) => {
      seriesIdx[String(s.id || s.stream_id || "")] = s;
    });
    const epKeyRe = /^(.+)\|\|S\d+E\d+$/;
    const best = {};
    Object.keys(prog).forEach((k) => {
      const m = epKeyRe.exec(k);
      if (!m) return;
      const sid = m[1];
      if (!seriesIdx[sid]) return;
      const e = prog[k];
      if (!(e == null ? void 0 : e.ts)) return;
      let pct = e.t > 0 && e.d > 0 ? e.t / e.d : e.pct > 0 ? e.pct : e.t > 30 ? 0.5 : 0;
      if (pct > 1) pct /= 100;
      if (pct <= 0.03 || pct >= 0.97) return;
      if (!best[sid] || e.ts > best[sid].ts) best[sid] = { pct, ts: e.ts };
    });
    inProgress = Object.keys(best).map((sid) => ({ item: seriesIdx[sid], pct: best[sid].pct, ts: best[sid].ts })).filter((x) => !_hideXXXItem(x.item)).sort((a, b) => b.ts - a.ts).slice(0, 15);
  } else {
    const all2 = type === "vod" ? S.vod : S.live;
    inProgress = all2.map((item) => {
      const k1 = itemKey(item), k2 = String(item.id || item.stream_id || "");
      const en = prog[k1] || prog[k2];
      const rawPct = (en == null ? void 0 : en.pct) || ((en == null ? void 0 : en.t) > 0 && (en == null ? void 0 : en.d) > 0 ? en.t / en.d : 0);
      const pct = rawPct > 1 ? rawPct / 100 : rawPct;
      return { item, pct, ts: (en == null ? void 0 : en.ts) || 0 };
    }).filter((x) => x.pct > 0.03 && x.pct < 0.97 && x.ts > 0 && !_hideXXXItem(x.item)).sort((a, b) => b.ts - a.ts).slice(0, 15);
  }
  const inProgKeys = new Set(inProgress.map((x) => itemKey(x.item)));
  const favItems = getFavs().filter((f) => {
    if (!f.item) return false;
    if (_hideXXXItem(f.item)) return false;
    const ftype = f.item.type || type;
    return ftype === type && !inProgKeys.has(itemKey(f.item));
  }).map((f) => ({ item: f.item, pct: 0, ts: 0 })).slice(0, 15);
  const all = [...inProgress, ...favItems].slice(0, 25);
  if (!all.length) {
    sect.hidden = true;
    return;
  }
  sect.hidden = false;
  row.innerHTML = "";
  const frag = document.createDocumentFragment();
  all.forEach(({ item, pct, ts }) => {
    const isLive = item.type === "live";
    const isInProg = ts > 0 && pct > 0.03;
    const card = document.createElement("div");
    card.className = "nou-card" + (isLive ? " nou-card--live" : "");
    card.tabIndex = 0;
    const progBar = isInProg ? `<div class="card-prog-bar card-prog-bar--nou"><div class="card-prog-fill" style="width:${Math.round(pct * 100)}%"></div></div>` : `<div class="nou-fav-badge">❤️</div>`;
    card.innerHTML = `
      <div class="nou-media">
        ${item.stream_icon ? `<img src="${esc(item.stream_icon)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="nou-placeholder">${isInProg ? "▶" : "❤️"}</div>`}
        <div class="nou-overlay"><span class="nou-play">▶</span></div>
        ${progBar}
      </div>
      <div class="nou-info">
        <div class="nou-title">${esc(item.title)}</div>
        <div class="nou-date">${isInProg ? Math.round(pct * 100) + "% visionné" : esc(displayCat(item.category_name) || "Favori")}</div>
      </div>`;
    const activate = () => {
      var _a, _b, _c;
      if (item.type === "series") openPanel(item);
      else if (item.type === "live") {
        if (((_a = item._variants) == null ? void 0 : _a.length) > 1) openLivePicker(item);
        else playItem(((_c = (_b = item._variants) == null ? void 0 : _b[0]) == null ? void 0 : _c.item) || item);
      } else openVodPanel(item);
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
    card.addEventListener("focus", () => {
      document.querySelectorAll(".nou-card.is-tv-focused").forEach((c) => c.classList.remove("is-tv-focused"));
      card.classList.add("is-tv-focused");
      card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });
    card.addEventListener("blur", () => card.classList.remove("is-tv-focused"));
    frag.appendChild(card);
  });
  row.appendChild(frag);
}
function renderContinueRow() {
  renderPoursuivreRow();
}
function renderFavoritesRow() {
  renderPoursuivreRow();
}
function renderNouveautes() {
  const sect = $("nouveautesSection");
  const row = $("nouveautesRow");
  if (!sect || !row) return;
  const recent = [...S.vod].filter((x) => x.added > 0 && x.stream_icon).sort((a, b) => b.added - a.added).slice(0, 20);
  if (!recent.length) {
    sect.hidden = true;
    return;
  }
  sect.hidden = false;
  row.innerHTML = "";
  const frag = document.createDocumentFragment();
  recent.forEach((item) => {
    const card = document.createElement("div");
    card.className = "nou-card";
    card.tabIndex = 0;
    const d = item.added ? new Date(item.added * 1e3) : null;
    const dateStr = d ? d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }) : "";
    card.innerHTML = `
      <div class="nou-media">
        <img src="${esc(item.stream_icon)}" alt="" loading="lazy"
             onerror="this.parentElement.parentElement.style.display='none'">
        ${item.quality ? `<span class="nou-qual">${esc(item.quality)}</span>` : ""}
        <div class="nou-overlay">
          <span class="nou-play">▶</span>
        </div>
      </div>
      <div class="nou-info">
        <div class="nou-title">${esc(item.title)}</div>
        ${dateStr ? `<div class="nou-date">${dateStr}</div>` : ""}
      </div>`;
    card.addEventListener("click", () => openVodPanel(item));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openVodPanel(item);
      }
    });
    card.addEventListener("focus", () => {
      document.querySelectorAll(".nou-card.is-tv-focused").forEach((c) => c.classList.remove("is-tv-focused"));
      card.classList.add("is-tv-focused");
    });
    card.addEventListener("blur", () => card.classList.remove("is-tv-focused"));
    frag.appendChild(card);
  });
  row.appendChild(frag);
  row.addEventListener("keydown", (e) => {
    const cards = [...row.querySelectorAll(".nou-card")];
    const idx = cards.indexOf(document.activeElement);
    if (idx < 0) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      const next = cards[idx + 1];
      if (next) {
        next.focus();
        next.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      const prev = cards[idx - 1];
      if (prev) {
        prev.focus();
        prev.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
    }
  });
  renderHero(recent[0]);
}
function renderHero(item) {
  const hero = $("hero");
  if (!hero || !item) return;
  if (item.stream_icon) {
    hero.style.backgroundImage = `url('${item.stream_icon}')`;
    hero.classList.add("hero--img");
  }
  $("heroTitle").textContent = item.title || "PIPSILY";
  $("heroSubtitle").textContent = item.category_name || "";
}
async function boot() {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v;
  try {
    const cached = JSON.parse(localStorage.getItem("pipsily_available_regions") || "[]");
    const corrupted = cached.some(
      (r) => /^\d|^[-–]/.test(r) || // commence par chiffre ou tiret
      /[()[\]\d]/.test(r) || // contient parenthèses, crochets ou chiffres
      r.length > 35 || // trop long pour être un nom de région
      /event|only|action|cinema|sport|series|kids|gaming/i.test(r)
      // mots thématiques
    );
    if (corrupted) localStorage.removeItem("pipsily_available_regions");
  } catch (e) {
    localStorage.removeItem("pipsily_available_regions");
  }
  if (window.PIPSILY_NATIVE === "android_tv" || window.PIPSIFLIX_NATIVE === "android_tv" || /AndroidTV|GoogleTV|SmartTV/i.test(navigator.userAgent)) {
    document.documentElement.classList.add("is-tv");
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then((reg) => {
      var _a2;
      if (reg.waiting) {
        reg.waiting.postMessage({ type: "SKIP_WAITING" });
      }
      (_a2 = reg.update) == null ? void 0 : _a2.call(reg).catch(() => {
      });
    }).catch(() => {
    });
  }
  if (window.PIPSILY_AUTH) {
    let auth;
    try {
      auth = await window.PIPSILY_AUTH.authGate();
    } catch (e) {
      console.error("[PIPSILY] authGate crash (tables manquantes ?):", e.message);
      let _sess = null;
      try {
        _sess = await ((_b = (_a = window.PIPSILY_AUTH).getSession) == null ? void 0 : _b.call(_a));
      } catch (e2) {
      }
      const _em = (((_c = _sess == null ? void 0 : _sess.user) == null ? void 0 : _c.email) || "").toLowerCase();
      const _adm = _em && _em === (((_d = window.PIPSILY_AUTH) == null ? void 0 : _d.ADMIN_EMAIL) || "").toLowerCase();
      auth = { session: _sess || { user: { id: "err" } }, sub: { ok: true, plan: _adm ? "admin" : "active", unlimited: _adm } };
    }
    if (!auth) return;
    S._userId = ((_f = (_e = auth.session) == null ? void 0 : _e.user) == null ? void 0 : _f.id) || "err";
    S._isAdmin = auth.sub.plan === "admin" || (((_h = (_g = auth.session) == null ? void 0 : _g.user) == null ? void 0 : _h.email) || "").toLowerCase() === (window.PIPSILY_AUTH.ADMIN_EMAIL || "").toLowerCase();
    S._unlim = auth.sub.unlimited;
    const userBtns = $("topbarUserBtns");
    if (userBtns) userBtns.style.display = "flex";
    if (S._isAdmin) {
      const adminBtn = $("adminBtn");
      if (adminBtn) adminBtn.style.display = "inline-flex";
    }
    (_j = (_i = window.PIPSILY_AUTH).startSessionWatcher) == null ? void 0 : _j.call(_i, S._userId);
  } else {
    console.error("[PIPSILY] auth.js indisponible — redirection vers login.html");
    location.replace("./login.html");
    return;
  }
  document.querySelectorAll(".nav-btn[data-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      var _a2, _b2, _c2;
      document.querySelectorAll(".nav-btn[data-type]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if ((_a2 = S.panel) == null ? void 0 : _a2.open) {
        closePanel == null ? void 0 : closePanel();
      }
      S.type = btn.dataset.type;
      S.loading = false;
      S.cat = "";
      S.search = "";
      S.quality = "";
      S.sort = "title";
      S.favOnly = false;
      $("searchInput").value = "";
      document.querySelectorAll(".quality-pill").forEach((p) => p.classList.remove("quality-pill--active"));
      (_b2 = document.querySelector(".quality-pill[data-q='']")) == null ? void 0 : _b2.classList.add("quality-pill--active");
      (_c2 = $("favFilterBtn")) == null ? void 0 : _c2.classList.remove("quality-pill--active");
      const ph = { vod: "Rechercher un film…", series: "Rechercher une série…", live: "Rechercher une chaîne…" };
      $("searchInput").placeholder = ph[S.type] || "Rechercher…";
      window.scrollTo({ top: 0, behavior: "instant" });
      render();
    });
  });
  (_k = $("refreshCacheBtn")) == null ? void 0 : _k.addEventListener("click", async () => {
    var _a2, _b2, _c2;
    const btn = $("refreshCacheBtn");
    const date = $("lastUpdateDate");
    btn.disabled = true;
    btn.textContent = "⏳ Mise à jour…";
    if (date) date.textContent = "Actualisation en cours…";
    const isNativeApk = typeof window.AndroidBridge !== "undefined";
    if (isNativeApk) {
      try {
        const reg = await ((_a2 = navigator.serviceWorker) == null ? void 0 : _a2.ready);
        if (reg == null ? void 0 : reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
          return;
        }
      } catch (e) {
      }
      if ((_b2 = window.AndroidBridge) == null ? void 0 : _b2.clearCache) {
        try {
          window.AndroidBridge.clearCache();
        } catch (e) {
        }
      } else {
        window.location.reload();
      }
      return;
    }
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      const reg = await ((_c2 = navigator.serviceWorker) == null ? void 0 : _c2.ready);
      if (reg == null ? void 0 : reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
    } catch (e) {
    }
    window.location.href = window.location.href.split("?")[0] + "?nocache=" + Date.now();
  });
  $("categorySelect").addEventListener("change", (e) => {
    S.cat = e.target.value;
    render();
  });
  let _searchTimer = null;
  $("searchInput").addEventListener("input", (e) => {
    S.search = e.target.value;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(render, 250);
  });
  $("sortSelect").addEventListener("change", (e) => {
    S.sort = e.target.value;
    render();
  });
  document.querySelectorAll(".quality-pill:not(.fav-pill)").forEach((btn) => {
    btn.addEventListener("click", () => {
      S.quality = btn.dataset.q || "";
      S.favOnly = false;
      document.querySelectorAll(".quality-pill").forEach((p) => p.classList.remove("quality-pill--active"));
      btn.classList.add("quality-pill--active");
      render();
    });
  });
  (_l = $("favFilterBtn")) == null ? void 0 : _l.addEventListener("click", () => {
    var _a2, _b2;
    S.favOnly = !S.favOnly;
    S.quality = "";
    document.querySelectorAll(".quality-pill").forEach((p) => p.classList.remove("quality-pill--active"));
    if (!S.favOnly) (_a2 = document.querySelector(".quality-pill[data-q='']")) == null ? void 0 : _a2.classList.add("quality-pill--active");
    (_b2 = $("favFilterBtn")) == null ? void 0 : _b2.classList.toggle("quality-pill--active", S.favOnly);
    S.shown[S.type] = PER_PAGE;
    render();
  });
  (_m = $("seriesPanel")) == null ? void 0 : _m.addEventListener("click", (e) => {
    if (e.target === $("seriesPanel")) closePanel();
  });
  new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) loadMore();
    },
    { rootMargin: SENTINEL_M }
  ).observe($("gridSentinel"));
  initTV();
  window.addEventListener("popstate", () => {
    var _a2, _b2;
    const picker = document.getElementById("livePicker");
    if (picker) {
      (_a2 = picker._closePicker) == null ? void 0 : _a2.call(picker, true);
      return;
    }
    if (S.panel.open && S.panel.isVod) {
      closeVodPanel(true);
      return;
    }
    if (S.panel.open) {
      closePanel(true);
      return;
    }
    if ((_b2 = $("pip-player")) == null ? void 0 : _b2.classList.contains("pip-open")) {
      PipPlayer.close();
    }
  });
  function _copyFallback(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      PipPlayer._showStatus("✓ Lien copié !");
    } catch (e) {
      PipPlayer._showStatus("Lien : " + text);
    }
  }
  (_n = $("pip-back")) == null ? void 0 : _n.addEventListener("click", () => PipPlayer.close());
  (_o = $("pip-fav")) == null ? void 0 : _o.addEventListener("click", () => PipPlayer.toggleFav());
  (_p = $("pip-prev")) == null ? void 0 : _p.addEventListener("click", () => PipPlayer.goPrev());
  (_q = $("pip-next")) == null ? void 0 : _q.addEventListener("click", () => PipPlayer.goNext());
  (_r = $("pip-native")) == null ? void 0 : _r.addEventListener("click", () => PipPlayer.openNative());
  (_s = $("pip-vlc")) == null ? void 0 : _s.addEventListener("click", () => PipPlayer.openVLC());
  (_t = $("pip-infuse")) == null ? void 0 : _t.addEventListener("click", () => PipPlayer.openInfuse());
  if (isIOS) {
    const iosBar = $("pip-ios-actions");
    if (iosBar) iosBar.hidden = false;
  }
  (_u = $("pip-fullscreen")) == null ? void 0 : _u.addEventListener("click", () => {
    var _a2, _b2;
    const v = $("pip-video");
    if (!v) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (_a2 = document.exitFullscreen || document.webkitExitFullscreen) == null ? void 0 : _a2.call(document);
    } else {
      (_b2 = v.requestFullscreen || v.webkitRequestFullscreen || v.mozRequestFullScreen) == null ? void 0 : _b2.call(v);
    }
  });
  (_v = $("pip-copy")) == null ? void 0 : _v.addEventListener("click", () => {
    var _a2, _b2;
    const url = ((_a2 = PipPlayer._item) == null ? void 0 : _a2.url) || ((_b2 = PipPlayer._item) == null ? void 0 : _b2.stream_url) || "";
    if (!url) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => PipPlayer._showStatus("✓ Lien copié !")).catch(() => _copyFallback(url));
    } else {
      _copyFallback(url);
    }
  });
  document.addEventListener("keydown", (e) => {
    var _a2;
    if (!((_a2 = $("pip-player")) == null ? void 0 : _a2.classList.contains("pip-open"))) return;
    const k = e.key;
    if (["Escape", "GoBack", "BrowserBack", "Back"].includes(k)) {
      e.preventDefault();
      PipPlayer.close();
    } else if (k === "ArrowRight") {
      const v = $("pip-video");
      if (v) {
        e.preventDefault();
        v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10);
      }
    } else if (k === "ArrowLeft") {
      const v = $("pip-video");
      if (v) {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 10);
      }
    } else if (k === "n" || k === "N" || k === "ChannelUp") {
      e.preventDefault();
      PipPlayer.goNext();
    } else if (k === "p" || k === "P" || k === "ChannelDown") {
      e.preventDefault();
      PipPlayer.goPrev();
    }
  }, true);
  getEpMap();
  const [vodJson, seriesJson, liveJson, epIndex] = await Promise.all([
    fetchJson("vod.json"),
    fetchJson("series.json"),
    fetchJson("live.json"),
    fetchJson("episodes_index.json")
  ]);
  if (vodJson) {
    S.vod = normalizeItems(extractArr(vodJson), "vod");
  } else {
    const vodM3u = await fetchText("vod.m3u");
    if (vodM3u) {
      S.vod = parseM3U(vodM3u, "vod");
    }
  }
  if (seriesJson) {
    S.series = normalizeItems(extractArr(seriesJson), "series");
  } else {
    const seriesM3u = await fetchText("series.m3u");
    if (seriesM3u) {
      S.series = parseM3U(seriesM3u, "series");
    }
  }
  if (liveJson) {
    const liveItems = extractArr(liveJson);
    S._liveRegionIdx = null;
    S.live = liveItems.map((x, i) => ({
      // normalisation
      id: x.id || x.stream_id || String(i),
      stream_id: x.stream_id || x.id || String(i),
      title: x.title || x.name || "Sans titre",
      category_id: x.category_id || "",
      category_name: x.category_name || "Autre",
      stream_icon: x.stream_icon || x.image || "",
      stream_url: x.stream_url || x.url || "",
      url: x.stream_url || x.url || "",
      plot: "",
      type: "live",
      quality: ""
    }));
    if (S.live.length) S._liveRegionIdx = _buildLiveRegionIdx(S.live);
  }
  {
    const el = document.getElementById("lastUpdateDate");
    if (el) {
      if (epIndex == null ? void 0 : epIndex.generated) {
        const d = new Date(epIndex.generated);
        const fmt = d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
        const nb = epIndex.total ? ` · ${epIndex.total.toLocaleString("fr-FR")} séries` : "";
        el.textContent = `Mise à jour le ${fmt}${nb}`;
      } else {
        el.textContent = "Catalogue à jour";
      }
    }
  }
  {
    const _ctx = (() => {
      try {
        return JSON.parse(sessionStorage.getItem("iptv_nav_ctx") || "null");
      } catch (e) {
        return null;
      }
    })();
    if ((_ctx == null ? void 0 : _ctx.type) && ["vod", "series", "live"].includes(_ctx.type)) {
      S.type = _ctx.type;
      S.cat = _ctx.cat || "";
      S.search = _ctx.search || "";
      if (S.search) $("searchInput").value = S.search;
      document.querySelectorAll(".nav-btn[data-type]").forEach((b) => {
        b.classList.toggle("active", b.dataset.type === S.type);
      });
      const ph = { vod: "Rechercher un film…", series: "Rechercher une série…", live: "Rechercher une chaîne…" };
      $("searchInput").placeholder = ph[S.type] || "Rechercher…";
      sessionStorage.removeItem("iptv_nav_ctx");
    }
  }
  renderNouveautes();
  render();
  if (document.documentElement.classList.contains("is-tv")) {
    setTimeout(() => {
      const btn = document.querySelector(".nav-btn.active") || document.querySelector(".nav-btn");
      btn == null ? void 0 : btn.focus();
    }, 200);
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      var _a2;
      if (((_a2 = e.data) == null ? void 0 : _a2.type) === "UPDATE_AVAILABLE") showUpdateBanner();
    });
    navigator.serviceWorker.ready.then((reg) => {
      if (reg.waiting) showUpdateBanner();
    }).catch(() => {
    });
  }
  checkApkInstallBanner();
  checkApkUpdate();
}
function showUpdateBanner() {
  if ($("updateBanner")) return;
  const isTV = /TV|GoogleTV|SmartTV|AndroidTV/i.test(navigator.userAgent) || /Android/i.test(navigator.userAgent) && !navigator.userAgent.includes("Mobile");
  const banner = document.createElement("div");
  banner.id = "updateBanner";
  banner.innerHTML = `
    <span>🔄 Mise à jour disponible !</span>
    <button id="updateNowBtn" type="button" tabindex="0"
      style="background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;border:none;
             border-radius:10px;padding:10px 20px;font-weight:700;font-size:14px;cursor:pointer">
      Mettre à jour
    </button>
    <button id="updateDismissBtn" type="button" tabindex="0" aria-label="Fermer"
      style="background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:10px;
             padding:10px 14px;font-size:14px;cursor:pointer">✕</button>`;
  banner.style.cssText = isTV ? `position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;
       justify-content:center;gap:16px;padding:14px 20px;color:#fff;font-size:14px;font-weight:600;
       background:linear-gradient(135deg,#1a2d50,#0f1e3a);border-bottom:2px solid rgba(255,159,44,.5);
       box-shadow:0 4px 24px rgba(0,0,0,.6);` : `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;
       display:flex;align-items:center;gap:12px;padding:14px 18px;color:#fff;font-size:14px;font-weight:600;
       background:linear-gradient(135deg,#1a2d50,#0f1e3a);border:1px solid rgba(255,159,44,.4);
       border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.5);white-space:nowrap;`;
  document.body.appendChild(banner);
  $("updateNowBtn").addEventListener("click", () => {
    var _a;
    (_a = navigator.serviceWorker) == null ? void 0 : _a.ready.then((reg) => {
      var _a2;
      (_a2 = reg.waiting) == null ? void 0 : _a2.postMessage({ type: "SKIP_WAITING" });
      window.location.reload();
    }).catch(() => window.location.reload());
  });
  $("updateDismissBtn").addEventListener("click", () => banner.remove());
  if (isTV) setTimeout(() => {
    var _a;
    return (_a = $("updateNowBtn")) == null ? void 0 : _a.focus();
  }, 100);
}
async function checkApkInstallBanner() {
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isNativeApk = typeof window.AndroidBridge !== "undefined";
  if (!isAndroid || isNativeApk) return;
  const vinfo = await fetchJson("version.json?cb=" + Date.now()).catch(() => null);
  const remoteVer = Number((vinfo == null ? void 0 : vinfo.apk_version) || 0);
  const _rawUrl = (vinfo == null ? void 0 : vinfo.apk_url) || "";
  const url = /^https:\/\/github\.com\//.test(_rawUrl) ? _rawUrl : "https://github.com/morpheus45/VOD/releases/latest";
  const _rawCar = vinfo && vinfo.car_url || "";
  const carUrl = /^https:\/\/github\.com\//.test(_rawCar) ? _rawCar : "";
  const dismissedUntil = Number(localStorage.getItem("pf_apk_install_dismiss") || 0);
  const dismissedVer = Number(localStorage.getItem("pf_apk_install_dismiss_ver") || 0);
  const newVersionOut = remoteVer > 0 && remoteVer !== dismissedVer;
  if (!newVersionOut && Date.now() < dismissedUntil) return;
  if ($("apkInstallBanner")) return;
  const isFirstVisit = !localStorage.getItem("pf_apk_install_dismiss");
  const banner = document.createElement("div");
  banner.id = "apkInstallBanner";
  if (isFirstVisit || newVersionOut) {
    banner.style.cssText = `
      position:fixed;inset:0;z-index:9999;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      background:rgba(5,8,15,.92);backdrop-filter:blur(8px);padding:24px;`;
    banner.innerHTML = `
      <div style="background:linear-gradient(135deg,#0d1a31,#1a1060);border:1px solid rgba(107,63,224,.5);
                  border-radius:20px;padding:28px 24px;max-width:360px;width:100%;text-align:center;
                  box-shadow:0 24px 60px rgba(0,0,0,.8)">
        <img src="./logo.svg" alt="PIPSILY" style="height:48px;margin-bottom:16px">
        <div style="font-size:20px;font-weight:800;color:#eef4ff;margin-bottom:8px">
          ${newVersionOut ? `🆕 PIPSILY v${remoteVer} disponible !` : "📱 Installez l'appli !"}
        </div>
        <div style="font-size:13px;color:#a89be0;margin-bottom:20px;line-height:1.5">
          ${newVersionOut ? (vinfo == null ? void 0 : vinfo.changes) || "Améliorations & corrections de bugs" : "Meilleure expérience · Lecture fluide · Pas de mixed content"}
        </div>
        <a href="${url}" target="_blank" rel="noopener"
          style="display:block;width:100%;box-sizing:border-box;padding:14px;border-radius:12px;
                 background:linear-gradient(135deg,#7B5FE8,#38A8E8);color:#fff;
                 font-size:15px;font-weight:800;text-decoration:none;margin-bottom:10px">
          📥 Télécharger l'APK
        </a>
        ${carUrl ? `
        <a href="${carUrl}" target="_blank" rel="noopener"
          style="display:block;width:100%;box-sizing:border-box;padding:12px;border-radius:12px;
                 background:transparent;border:1px solid rgba(107,63,224,.6);color:#c9b8ff;
                 font-size:13px;font-weight:700;text-decoration:none;margin-bottom:10px">
          🚗 Version autoradio &middot; PIPSILY CAR
        </a>` : ""}
        <button id="apkInstallDismiss"
          style="width:100%;padding:11px;border-radius:12px;border:1px solid rgba(255,255,255,.15);
                 background:transparent;color:#7a9cc0;font-size:13px;cursor:pointer">
          Plus tard (rappel demain)
        </button>
      </div>`;
  } else {
    banner.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:9998;
      display:flex;align-items:center;gap:12px;padding:10px 14px;
      background:linear-gradient(135deg,#1a1060,#0e0a30);
      border-bottom:2px solid rgba(107,63,224,.5);
      color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.6)`;
    banner.innerHTML = `
      <img src="./logo.svg" alt="" style="height:28px">
      <div style="flex:1;font-size:13px;font-weight:700;color:#eef4ff">
        📥 Installer l'appli PIPSILY
        <span style="font-size:11px;font-weight:400;color:#a89be0;margin-left:6px">Meilleure lecture</span>
      </div>
      <a href="${url}" target="_blank" rel="noopener"
        style="padding:8px 14px;border-radius:9px;background:linear-gradient(135deg,#7B5FE8,#38A8E8);
               color:#fff;font-size:12px;font-weight:700;text-decoration:none;white-space:nowrap">
        Installer
      </a>
      <button id="apkInstallDismiss" aria-label="Fermer"
        style="background:rgba(255,255,255,.1);border:none;color:#fff;border-radius:7px;
               padding:7px 9px;font-size:13px;cursor:pointer">✕</button>`;
    document.body.style.paddingTop = "54px";
  }
  document.body.appendChild(banner);
  banner.querySelector("#apkInstallDismiss").onclick = () => {
    banner.remove();
    document.body.style.paddingTop = "";
    localStorage.setItem("pf_apk_install_dismiss", String(Date.now() + 864e5));
    localStorage.setItem("pf_apk_install_dismiss_ver", String(remoteVer));
  };
}
function apkUpdateChannel() {
  try {
    const c = window.AndroidBridge.getUpdateChannel();
    if (c) return String(c);
  } catch (e) {
  }
  return "default";
}
function apkChannelFields() {
  return apkUpdateChannel() === "car" ? { ver: "car_version", url: "car_url", changes: "car_changes", label: "PIPSILY CAR" } : { ver: "apk_version", url: "apk_url", changes: "changes", label: "PIPSILY" };
}
async function checkApkUpdate() {
  if (typeof window.AndroidBridge === "undefined") return;
  try {
    const vinfo = await fetchJson("version.json?cb=" + Date.now());
    const chan = apkChannelFields();
    if (!vinfo || !vinfo[chan.ver] || !vinfo[chan.url]) return;
    const remoteVer = parseInt(vinfo[chan.ver], 10);
    if (!remoteVer) return;
    let localVer = 0;
    try {
      const raw = window.AndroidBridge.getApkVersion();
      localVer = raw ? parseInt(String(raw), 10) : 0;
    } catch (e) {
    }
    if (localVer > 0) {
      localStorage.setItem("pf_local_apk_ver", String(localVer));
    } else {
      localVer = parseInt(localStorage.getItem("pf_local_apk_ver") || "0", 10);
    }
    if (!localVer) return;
    if (remoteVer <= localVer) return;
    localStorage.removeItem("pf_apk_sv4");
    localStorage.removeItem("pf_apk_su4");
    localStorage.removeItem("pf_apk_sv5");
    localStorage.removeItem("pf_apk_su5");
    showApkUpdateBanner(vinfo, remoteVer, chan);
  } catch (e) {
  }
}
function showApkUpdateBanner(vinfo, remoteVer, chan) {
  if ($("apkUpdateBanner")) return;
  chan = chan || { url: "apk_url", changes: "changes", label: "PIPSILY" };
  const isTV = window.PIPSILY_NATIVE === "android_tv" || /AndroidTV|GoogleTV|SmartTV/i.test(navigator.userAgent) || /Android/i.test(navigator.userAgent) && !/Mobile/i.test(navigator.userAgent);
  const banner = document.createElement("div");
  banner.id = "apkUpdateBanner";
  banner.innerHTML = '<div class="apk-tv-modal"><div class="apk-tv-icon">📦</div><h2 class="apk-tv-title">' + chan.label + " v" + remoteVer + ' disponible</h2><p class="apk-tv-changes">' + (vinfo[chan.changes] || "Améliorations & corrections") + '</p><div id="apkProgWrap" style="display:none;margin:16px auto 6px;max-width:340px"><div style="height:10px;border-radius:6px;background:rgba(255,255,255,.12);overflow:hidden"><div id="apkProgBar" style="height:100%;width:0%;border-radius:6px;background:linear-gradient(90deg,#7B5FE8,#38A8E8);transition:width .25s"></div></div><p id="apkProgTxt" style="margin:9px 0 0;font-size:14px;color:#cdd6e6">Téléchargement… 0%</p></div><div class="apk-tv-btns"><button id="apkDownloadBtn" type="button" class="apk-tv-btn apk-tv-btn--install" tabindex="0">⬇ Mettre à jour</button></div>' + (isTV ? '<p class="apk-tv-hint">OK = installer la mise à jour</p>' : "") + "</div>";
  banner.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.96);display:flex;align-items:center;justify-content:center;pointer-events:all;";
  banner.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  document.body.appendChild(banner);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      var _a;
      return (_a = $("apkDownloadBtn")) == null ? void 0 : _a.focus();
    });
  });
  const setApkProg = (pct) => {
    const wrap = $("apkProgWrap"), bar = $("apkProgBar"), txt = $("apkProgTxt");
    if (wrap) wrap.style.display = "block";
    pct = Math.max(0, Math.min(100, parseInt(pct, 10) || 0));
    if (bar) bar.style.width = pct + "%";
    if (txt) txt.textContent = pct >= 100 ? "Installation…" : "Téléchargement… " + pct + "%";
  };
  const startDownload = () => {
    var _a, _b;
    const url = vinfo[chan.url];
    const btn = $("apkDownloadBtn");
    if (btn) {
      btn.textContent = "📥 Téléchargement…";
      btn.disabled = true;
    }
    setApkProg(0);
    if (typeof ((_a = window.AndroidBridge) == null ? void 0 : _a.downloadAndInstall) === "function") {
      window.AndroidBridge.downloadAndInstall(url);
    } else if (typeof ((_b = window.AndroidBridge) == null ? void 0 : _b.openDownloadUrl) === "function") {
      window.AndroidBridge.openDownloadUrl(url);
    } else {
      window.open(url, "_blank");
    }
  };
  window.onApkDownloadProgress = (pct) => {
    if ($("apkUpdateBanner")) setApkProg(pct);
  };
  window.onApkDownloadFailed = (reason) => {
    if (!$("apkUpdateBanner")) return;
    const btn = $("apkDownloadBtn"), txt = $("apkProgTxt"), wrap = $("apkProgWrap");
    if (wrap) wrap.style.display = "block";
    if (txt) txt.textContent = "❌ Échec : " + (reason || "réessayez");
    if (btn) {
      btn.textContent = "🔄 Relancer";
      btn.disabled = false;
      setTimeout(() => btn.focus(), 50);
    }
  };
  $("apkDownloadBtn").onclick = startDownload;
}
window.addEventListener("load", boot);
