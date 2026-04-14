/* PIPSIFLIX — player.js */

'use strict';

const item = JSON.parse(sessionStorage.getItem('psf_item') || 'null');

const $ = id => document.getElementById(id);

function setStatus(msg) {
  const n = $('status');
  if (!n) return;
  n.hidden   = !msg;
  n.textContent = msg || '';
}

// ── Progression ───────────────────────────────────────────

function getProg() { try { return JSON.parse(localStorage.getItem('psf_prog') || '{}'); } catch { return {}; } }
function saveProg(key, pct) {
  const p = getProg(); p[key] = { pct, ts: Date.now() };
  localStorage.setItem('psf_prog', JSON.stringify(p));
}

// ── URL helpers ───────────────────────────────────────────

function resolveUrl() {
  if (!item) return null;
  if (item.selected_episode) return item.selected_episode.url || item.selected_episode.stream_url || null;
  return item.stream_url || item.url || null;
}

function ext(url) {
  if (!url) return 'mp4';
  try { const e = new URL(url).pathname.split('.').pop().toLowerCase(); return ['mp4','mkv','ts','m3u8'].includes(e) ? e : 'mp4'; }
  catch { const e = url.split('?')[0].split('.').pop().toLowerCase(); return ['mp4','mkv','ts','m3u8'].includes(e) ? e : 'mp4'; }
}
const isHls    = url => url.includes('.m3u8') || url.includes('type=m3u8') || ext(url) === 'm3u8';
const isMpegTs = url => ext(url) === 'ts' || url.includes('.ts?') || url.includes('type=ts');

// ── Player instances ──────────────────────────────────────

let hls = null, mpegts = null;

function destroy() {
  if (hls)    { try { hls.destroy(); }    catch {} hls    = null; }
  if (mpegts) { try { mpegts.destroy(); } catch {} mpegts = null; }
  const v = $('video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
}

// ── Init ──────────────────────────────────────────────────

function init() {
  if (!item) { setStatus('Aucun média sélectionné.'); return; }

  const url = resolveUrl();
  if (!url) { setStatus('URL de lecture introuvable.'); return; }

  // Infos
  const label = item.episode_label ? `${item.title} — ${item.episode_label}` : item.title || 'Lecture';
  const sub   = item.episode_title || item.category_name || '';
  if ($('playerTitle')) $('playerTitle').textContent = label;
  if ($('playerSub'))   $('playerSub').textContent   = sub;
  if ($('plotText'))    $('plotText').textContent     = item.plot || 'Aucune description.';

  updateNav();
  const video = $('video');
  if (!video) return;

  destroy();
  setStatus('Chargement…');

  const progKey = item.progress_key || null;
  const stored  = progKey ? (getProg()[progKey]?.pct || 0) : 0;

  setTimeout(() => {
    if (isHls(url)) {
      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        hls = new Hls({ enableWorker: true, lowLatencyMode: true });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setStatus('');
          if (stored > 2 && video.duration) video.currentTime = video.duration * stored / 100;
          video.play().catch(() => setStatus('Cliquez ▶ pour démarrer'));
        });
        hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) hls.recoverMediaError(); });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.play().then(() => setStatus('')).catch(() => {});
      } else { setStatus('HLS non supporté.'); }

    } else if (isMpegTs(url)) {
      if (typeof window.mpegts !== 'undefined' && window.mpegts.getFeatureList().mseLivePlayback) {
        mpegts = window.mpegts.createPlayer({ type: 'mse', url, isLive: item.type === 'live' });
        mpegts.attachMediaElement(video);
        mpegts.load();
        mpegts.play().then(() => setStatus('')).catch(() => {
          video.src = url; video.play().catch(() => setStatus('Erreur MPEG-TS.'));
        });
      } else { video.src = url; video.play().then(() => setStatus('')).catch(() => setStatus('Format non supporté.')); }

    } else {
      video.src = url;
      video.play().then(() => {
        setStatus('');
        if (stored > 2 && video.duration) video.currentTime = video.duration * stored / 100;
      }).catch(() => setStatus('Format non supporté nativement.'));
    }
  }, 200);

  // Suivi progression
  if (progKey) {
    const tracker = setInterval(() => {
      if (!video || video.ended || video.paused) return;
      const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
      if (pct > 1) saveProg(progKey, pct);
    }, 5000);
    video.addEventListener('ended', () => {
      clearInterval(tracker);
      saveProg(progKey, 100);
      setTimeout(goNext, 3000); // auto-play suivant
    });
  }
}

// ── Navigation prev/next ──────────────────────────────────

function getAll() { return Array.isArray(item?.all_episodes) ? item.all_episodes : []; }
function getCur()  { return typeof item?.cur_idx === 'number' ? item.cur_idx : -1; }

function updateNav() {
  const all = getAll(); const idx = getCur();
  const prev = $('prevBtn'); const next = $('nextBtn');
  if (prev) prev.disabled = idx <= 0 || !all.length;
  if (next) next.disabled = idx < 0 || idx >= all.length - 1;
}

function goEp(newIdx) {
  const all = getAll();
  if (newIdx < 0 || newIdx >= all.length) return;
  const ep = all[newIdx];
  if (!ep?.url) return;
  const updated = {
    ...item,
    episode_label:    `S${String(ep.sk).padStart(2,'0')}E${String(ep.episode_num).padStart(2,'0')}`,
    episode_title:    ep.title,
    stream_url:       ep.url,
    url:              ep.url,
    selected_episode: { url: ep.url, stream_url: ep.url },
    progress_key:     ep.progress_key,
    cur_idx:          newIdx
  };
  sessionStorage.setItem('psf_item', JSON.stringify(updated));
  location.reload();
}

function goNext() { goEp(getCur() + 1); }
function goPrev() { goEp(getCur() - 1); }

// ── Actions ───────────────────────────────────────────────

function openNative() {
  const url = resolveUrl(); if (!url) return;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isTV      = /TV|GoogleTV|SmartTV/i.test(navigator.userAgent) ||
                    (navigator.userAgent.includes('Android') && !navigator.userAgent.includes('Mobile'));
  if (isAndroid || isTV) {
    location.href = `intent:${url}#Intent;action=android.intent.action.VIEW;type=video/*;S.title=${encodeURIComponent(item.title||'')};end`;
  } else {
    location.href = 'vlc://' + url;
  }
}

// ── Bindings ──────────────────────────────────────────────

if ($('backBtn'))   $('backBtn').onclick   = () => history.back();
if ($('prevBtn'))   $('prevBtn').onclick   = goPrev;
if ($('nextBtn'))   $('nextBtn').onclick   = goNext;
if ($('nativeBtn')) $('nativeBtn').onclick = openNative;
if ($('fsBtn'))     $('fsBtn').onclick     = () => {
  const v = $('video');
  document.fullscreenElement ? document.exitFullscreen?.() : (v.requestFullscreen || v.webkitRequestFullscreen)?.call(v);
};
if ($('copyBtn'))   $('copyBtn').onclick   = () => {
  const url = resolveUrl();
  if (url) navigator.clipboard.writeText(url).then(() => alert('Lien copié !'));
};
if ($('vlcBtn'))    $('vlcBtn').onclick    = () => {
  const url = resolveUrl(); if (url) location.href = 'vlc://' + url;
};

// ── Clavier / Télécommande ────────────────────────────────

document.addEventListener('keydown', e => {
  const k = e.key; const v = $('video');
  if (['Escape','GoBack','Back','BrowserBack'].includes(k)) { history.back(); return; }
  if (['Enter',' ','MediaPlayPause'].includes(k)) { e.preventDefault(); v?.paused ? v.play() : v?.pause(); }
  else if (['ArrowRight','FastForward'].includes(k)) { if(v){e.preventDefault();v.currentTime+=10;} }
  else if (['ArrowLeft','Rewind'].includes(k))       { if(v){e.preventDefault();v.currentTime-=10;} }
  else if (k==='ArrowUp')   { if(v){e.preventDefault();v.volume=Math.min(1,v.volume+.1);} }
  else if (k==='ArrowDown') { if(v){e.preventDefault();v.volume=Math.max(0,v.volume-.1);} }
  else if (k==='f'||k==='F') { $('fsBtn')?.click(); }
  else if (k==='n'||k==='N'||k==='ChannelUp')   goNext();
  else if (k==='p'||k==='P'||k==='ChannelDown') goPrev();
});

init();
