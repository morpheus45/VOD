/* ============================================================
   PIPSIFLIX — app.js  (réécriture complète)
   Films + Séries · M3U basique & enrichie · Xtream Codes
   Google TV / Android / Mobile
   ============================================================ */

'use strict';

// ── État global ───────────────────────────────────────────

const S = {
  type:    'vod',          // 'vod' | 'series'
  vod:     [],
  series:  [],
  srcVod:  '',
  srcSer:  '',

  // Filtres
  cat:     '',
  search:  '',
  qual:    '',
  sort:    'az',

  // Pagination
  shown:   { vod: 0, series: 0 },
  loading: false,

  // Panneau séries
  panel: {
    open:     false,
    item:     null,
    seasons:  {},    // { "1": [ep,...], "2": [...] }
    meta:     [],    // [{ num, name, cover }]
    selSeason:null,
    directOnly: false
  },

  // Cache épisodes en mémoire
  epCache: {}
};

const PER_PAGE = 48;

// ── Stockage local ────────────────────────────────────────

const STORE = { fav: 'psf_fav', hist: 'psf_hist', prog: 'psf_prog' };

function ls(k, fb) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; }
}
function lw(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function getFavs()  { return ls(STORE.fav,  []); }
function getHist()  { return ls(STORE.hist, []); }
function getProg()  { return ls(STORE.prog, {}); }

function saveProg(key, pct) {
  const p = getProg(); p[key] = { pct, ts: Date.now() }; lw(STORE.prog, p);
}

function isFav(item) { return getFavs().some(x => x.key === itemKey(item)); }

function toggleFav(item) {
  const favs = getFavs(); const k = itemKey(item);
  const idx  = favs.findIndex(x => x.key === k);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.unshift({ key: k, item, at: Date.now() });
  lw(STORE.fav, favs.slice(0, 500));
  // Met à jour le bouton en live
  document.querySelectorAll(`.card[data-key="${CSS.escape(k)}"] .card-fav`).forEach(b => {
    b.classList.toggle('on', isFav(item));
  });
}

function pushHist(item) {
  const h = getHist().filter(x => x.key !== itemKey(item));
  h.unshift({ key: itemKey(item), item, at: Date.now() });
  lw(STORE.hist, h.slice(0, 300));
}

// ── Utilitaires ───────────────────────────────────────────

const $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function itemKey(item) {
  return `${item.type}||${item.id || ''}||${item.title || ''}`;
}

function cleanTitle(t) {
  if (!t) return '';
  let s = String(t);
  s = s.replace(/^(FR|SRS|EN|VOD|SERIE)\s*[-|:]\s*/i, '');
  s = s.replace(/\s*(?:group-title|tvg-\w+)\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\.(mkv|mp4|ts|m3u8|avi|mov)$/i, '');
  s = s.replace(/\s*\(\d{4}\)\s*$/, '');
  return s.replace(/\s+/g, ' ').trim();
}

function inferQuality(src) {
  const t = String(src || '').toLowerCase();
  if (/\b(4k|uhd|2160p?)\b/.test(t)) return '4K';
  if (/\b(fhd|full[\s-]?hd|1080p?|hd|720p?)\b/.test(t)) return 'HD';
  if (/\b(sd|480p?|360p?)\b/.test(t)) return 'SD';
  return '';
}

// ── Fetch helpers ─────────────────────────────────────────

async function fetchJSON(url) {
  try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; }
}
async function fetchText(url) {
  try { const r = await fetch(url); return r.ok ? r.text() : null; } catch { return null; }
}

// ── Parsing M3U (basique + enrichie) ─────────────────────

function parseM3U(text, type) {
  const lines = text.split(/\r?\n/);
  const out   = []; let cur = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const group = (line.match(/group-title="([^"]+)"/i) || [,'Autre'])[1];
      const logo  = (line.match(/tvg-logo="([^"]+)"/i)   || [,''])[1];
      const title = line.includes(',') ? line.split(',').slice(1).join(',').trim() : 'Sans titre';
      cur = { title: cleanTitle(title), cat: cleanTitle(group), logo };

    } else if (!line.startsWith('#') && cur) {
      out.push({
        id:    out.length,
        title: cur.title,
        category_name: cur.cat,
        stream_icon:   cur.logo,
        stream_url:    line,
        url:           line,
        plot:  '',
        type,
        quality: inferQuality(`${cur.title} ${cur.cat}`),
        _xtream: type === 'series' && line.includes('get_series_info')
      });
      cur = null;
    }
  }
  return out;
}

// ── Normalisation JSON ────────────────────────────────────

function normalizeItems(arr, type) {
  return (Array.isArray(arr) ? arr : []).map((x, i) => ({
    id:            x.id || x.stream_id || x.series_id || String(i),
    title:         cleanTitle(x.title || x.name || 'Sans titre'),
    category_name: cleanTitle(x.category_name || x.category || 'Autre'),
    stream_icon:   x.stream_icon || x.image || x.cover || x.poster || '',
    stream_url:    x.url || x.stream_url || '',
    url:           x.url || x.stream_url || '',
    plot:          x.plot || x.description || x.overview || '',
    type,
    quality:       inferQuality([x.title, x.name, x.category_name, x.plot].join(' ')),
    _xtream:       type === 'series' &&
                   !!(x.url || x.stream_url || '').includes('get_series_info')
  }));
}

function extractArr(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  for (const k of ['items','streams','channels','movies','series','vod']) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  return [];
}

// ── Xtream Codes — chargement épisodes ───────────────────

function buildEpUrl(apiUrl, ep) {
  if (ep.url && !ep.url.includes('player_api')) return ep.url;
  try {
    const p   = new URL(apiUrl);
    const usr = p.searchParams.get('username');
    const pwd = p.searchParams.get('password');
    if (!usr || !pwd || !ep.id) return '';
    const ext = ep.container_extension || 'mkv';
    return `${p.origin}/series/${usr}/${pwd}/${ep.id}.${ext}`;
  } catch { return ''; }
}

async function loadEpisodes(item) {
  const key = `ep_${item.id}_${item.title}`;
  if (S.epCache[key]) return S.epCache[key];

  const apiUrl = item.stream_url || item.url || '';
  if (!apiUrl) return { seasons: {}, meta: [], directOnly: true };

  // Fetch avec timeout 6s
  let data = null;
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 6000);
    const r    = await fetch(apiUrl, { signal: ctrl.signal });
    clearTimeout(tid);
    data = r.ok ? await r.json() : null;
  } catch { data = null; }

  if (!data) return { seasons: {}, meta: [], directOnly: true };

  const seasons = {};
  if (data.episodes && typeof data.episodes === 'object') {
    Object.entries(data.episodes).forEach(([sk, epList]) => {
      if (!Array.isArray(epList)) return;
      seasons[sk] = epList
        .filter(ep => ep && (ep.id || ep.episode_num))
        .map(ep => ({
          id:                  ep.id,
          episode_num:         Number(ep.episode_num) || 1,
          season:              Number(ep.season || sk),
          title:               cleanTitle(ep.title || ep.name || '') || `Épisode ${ep.episode_num}`,
          url:                 buildEpUrl(apiUrl, ep),
          stream_url:          buildEpUrl(apiUrl, ep),
          container_extension: ep.container_extension || 'mkv',
          plot:                ep.info?.plot || '',
          thumb:               ep.info?.movie_image || ''
        }))
        .sort((a, b) => a.episode_num - b.episode_num);
    });
  }

  const meta = Array.isArray(data.seasons)
    ? data.seasons
        .filter(s => s.season_number > 0)
        .sort((a, b) => a.season_number - b.season_number)
        .map(s => ({ num: s.season_number, name: s.name || `Saison ${s.season_number}`, cover: s.cover_big || s.cover || '' }))
    : [];

  // Enrichir item avec les infos API
  if (data.info) {
    if (!item.plot)         item.plot         = data.info.plot || data.info.description || '';
    if (!item.stream_icon)  item.stream_icon  = data.info.cover || data.info.movie_image || '';
  }

  const result = { seasons, meta, directOnly: false };
  S.epCache[key] = result;
  return result;
}

// ── Panneau Séries ────────────────────────────────────────

function openPanel(item) {
  S.panel.open      = true;
  S.panel.item      = item;
  S.panel.seasons   = {};
  S.panel.meta      = [];
  S.panel.selSeason = null;
  S.panel.directOnly= false;

  document.body.style.overflow = 'hidden';

  // Afficher avec spinner
  $('panel').hidden    = false;
  $('backdrop').hidden = false;
  renderPanelHead(item);
  renderPanelBody(null); // null = état chargement

  // Charger les épisodes
  loadEpisodes(item).then(({ seasons, meta, directOnly }) => {
    S.panel.seasons    = seasons;
    S.panel.meta       = meta;
    S.panel.directOnly = directOnly;
    const keys = Object.keys(seasons).sort((a, b) => Number(a) - Number(b));
    S.panel.selSeason  = keys[0] || null;
    renderPanelBody(seasons);
  });
}

function closePanel() {
  S.panel.open           = false;
  S.panel.item           = null;
  $('panel').hidden      = true;
  $('backdrop').hidden   = true;
  document.body.style.overflow = '';
}

function renderPanelHead(item) {
  const el = $('panelHead');
  const nb = Object.keys(S.panel.seasons).length;
  el.innerHTML = `
    <div class="ph-kicker">Série</div>
    <div class="ph-row">
      <div>
        <div class="ph-title">${esc(item.title)}</div>
        ${nb ? `<div class="ph-meta">${nb} saison${nb>1?'s':''}</div>` : ''}
      </div>
      <button class="ph-close" id="closeBtn" title="Fermer">✕</button>
    </div>`;
  $('closeBtn').onclick = closePanel;
}

function renderPanelBody(seasons) {
  const el   = $('panelBody');
  const item = S.panel.item;
  if (!item) return;

  const cover = item.stream_icon || '';

  // Bloc hero
  const heroHtml = `
    <div class="p-hero">
      ${cover
        ? `<img class="p-cover" src="${esc(cover)}" alt="" loading="lazy">`
        : `<div class="p-cover p-cover--empty">🎬</div>`}
      <div>
        <div class="p-synopsis">${esc(item.plot || 'Chargement…')}</div>
        ${seasons === null ? `<div class="p-loading"><span class="spin"></span> Chargement des saisons…</div>` : ''}
      </div>
    </div>`;

  if (seasons === null) {
    el.innerHTML = heroHtml;
    return;
  }

  const keys = Object.keys(seasons).sort((a, b) => Number(a) - Number(b));
  const sel  = S.panel.selSeason;

  // Mise à jour du head avec nb saisons
  renderPanelHead(item);

  // Onglets saisons
  let tabsHtml = '';
  if (keys.length > 1) {
    tabsHtml = `<div class="p-tabs">` +
      keys.map(sk => {
        const m     = S.panel.meta.find(x => String(x.num) === sk);
        const label = m ? m.name : `Saison ${sk}`;
        const cnt   = (seasons[sk] || []).length;
        return `<button class="p-tab ${sk === sel ? 'on' : ''}" data-sk="${esc(sk)}" type="button">
          ${esc(label)} <span style="opacity:.65;font-weight:400">${cnt}ep</span>
        </button>`;
      }).join('') +
    `</div>`;
  } else if (keys.length === 1) {
    const m = S.panel.meta.find(x => String(x.num) === keys[0]);
    tabsHtml = `<div style="font-size:13px;color:var(--muted);margin-bottom:10px">${esc(m?.name || `Saison ${keys[0]}`)}</div>`;
  }

  // Épisodes
  let epsHtml = '';
  if (!sel || keys.length === 0) {
    // Pas de saisons
    if (S.panel.directOnly) {
      epsHtml = `<div class="p-noep" style="color:var(--gold)">⚠️ Chargement des épisodes bloqué (CORS). Lecture directe uniquement.</div>`;
    }
    const directUrl = item.stream_url || item.url || '';
    if (directUrl) {
      epsHtml += `<button class="p-direct" id="directBtn" type="button">▶ Lire le flux direct</button>`;
    } else {
      epsHtml += `<div class="p-noep">Aucun épisode disponible.</div>`;
    }
  } else {
    const eps  = seasons[sel] || [];
    const prog = getProg();

    epsHtml = `<div class="p-eps">` +
      eps.map((ep, idx) => {
        const code  = `S${String(sel).padStart(2,'0')}E${String(ep.episode_num).padStart(2,'0')}`;
        const progK = `${item.id}||${code}`;
        const pct   = prog[progK]?.pct || 0;
        const done  = pct >= 90;
        const hasUrl= !!ep.url;

        return `
          <button class="ep ${done ? 'watched' : ''}"
                  data-sk="${esc(sel)}" data-idx="${idx}"
                  type="button"
                  ${!hasUrl ? 'disabled' : ''}
                  title="${hasUrl ? esc(ep.title) : 'URL non disponible'}">
            <span class="ep-code">${esc(code)}</span>
            <span class="ep-title">${esc(ep.title || `Épisode ${ep.episode_num}`)}</span>
            ${done  ? `<span class="ep-done">✓</span>` : ''}
            ${!done && pct > 2 ? `<span class="ep-done" style="color:var(--muted);font-size:10px">${Math.round(pct)}%</span>` : ''}
            ${hasUrl ? `<span class="ep-play">▶</span>` : '<span class="ep-play" style="color:rgba(255,255,255,.1)">🔒</span>'}
          </button>
          ${pct > 2 ? `<div class="ep-prog"><div class="ep-prog-fill" style="width:${Math.min(pct,100)}%"></div></div>` : ''}
        `;
      }).join('') +
    `</div>`;
  }

  el.innerHTML = heroHtml + tabsHtml + epsHtml;

  // Bind onglets
  el.querySelectorAll('.p-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      S.panel.selSeason = btn.dataset.sk;
      renderPanelBody(S.panel.seasons);
      el.scrollTop = el.querySelector('.p-tabs')?.offsetTop || 0;
    });
  });

  // Bind épisodes
  el.querySelectorAll('.ep:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const sk  = btn.dataset.sk;
      const idx = Number(btn.dataset.idx);
      const ep  = (S.panel.seasons[sk] || [])[idx];
      if (ep && ep.url) playEpisode(item, ep, sk);
    });
  });

  // Lecture directe
  $('directBtn')?.addEventListener('click', () => playItem(item));
}

// ── Lecture ───────────────────────────────────────────────

function playEpisode(series, ep, season) {
  pushHist(series);

  // Index global prev/next
  const allEps = [];
  const keys   = Object.keys(S.panel.seasons).sort((a,b) => Number(a)-Number(b));
  keys.forEach(sk => (S.panel.seasons[sk] || []).forEach((e,i) => allEps.push({ sk, i, ep: e })));
  const curIdx = allEps.findIndex(x => x.sk === season && x.ep.episode_num === ep.episode_num);

  const code = `S${String(season).padStart(2,'0')}E${String(ep.episode_num).padStart(2,'0')}`;

  sessionStorage.setItem('psf_item', JSON.stringify({
    type:           'series',
    series_id:      series.id,
    title:          series.title,
    episode_label:  code,
    episode_title:  ep.title,
    category_name:  series.category_name || '',
    stream_icon:    ep.thumb || series.stream_icon || '',
    stream_url:     ep.url,
    url:            ep.url,
    plot:           ep.plot || series.plot || '',
    progress_key:   `${series.id}||${code}`,
    all_episodes:   allEps.map(x => ({
      sk:          x.sk,
      episode_num: x.ep.episode_num,
      title:       x.ep.title,
      url:         x.ep.url,
      progress_key:`${series.id}||S${String(x.sk).padStart(2,'0')}E${String(x.ep.episode_num).padStart(2,'0')}`
    })),
    cur_idx: curIdx
  }));
  location.href = 'player.html';
}

function playItem(item) {
  pushHist(item);
  sessionStorage.setItem('psf_item', JSON.stringify({
    ...item,
    stream_url: item.stream_url || item.url,
    url:        item.url || item.stream_url
  }));
  location.href = 'player.html';
}

// ── Filtres / Tri ─────────────────────────────────────────

function filtered() {
  let items = [...(S.type === 'vod' ? S.vod : S.series)];
  if (S.cat)    items = items.filter(x => x.category_name === S.cat);
  if (S.search) {
    const q = S.search.toLowerCase();
    items = items.filter(x => x.title.toLowerCase().includes(q) || (x.plot||'').toLowerCase().includes(q));
  }
  if (S.qual)   items = items.filter(x => x.quality === S.qual);
  if (S.sort === 'cat') items.sort((a,b) => a.category_name.localeCompare(b.category_name) || a.title.localeCompare(b.title));
  else                   items.sort((a,b) => a.title.localeCompare(b.title));
  return items;
}

// ── Rendu grille ─────────────────────────────────────────

function renderGrid(reset = false) {
  const grid  = $('grid');
  const empty = $('empty');
  const col   = filtered();
  const lim   = S.shown[S.type];
  const items = col.slice(0, lim);

  if (!items.length) { grid.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  if (reset) grid.innerHTML = '';

  const frag = document.createDocumentFragment();
  items.slice(grid.children.length).forEach(item => {
    const card = document.createElement('div');
    const key  = itemKey(item);
    card.className       = 'card';
    card.tabIndex        = 0;
    card.dataset.key     = key;
    card.dataset.itemType= item.type;

    const poster = item.stream_icon || '';
    const isSer  = item.type === 'series';

    card.innerHTML = `
      <div class="card-img">
        ${poster
          ? `<img src="${esc(poster)}" alt="" loading="lazy">`
          : `<div class="card-placeholder">🎬</div>`}
        <span class="card-badge ${isSer ? 'card-badge--s' : ''}">${isSer ? 'Série' : 'Film'}</span>
        ${item.quality ? `<span class="card-qual">${esc(item.quality)}</span>` : ''}
        <button class="card-fav ${isFav(item) ? 'on' : ''}" title="Favori" aria-label="Favori" type="button">♥</button>
      </div>
      <div class="card-info">
        <div class="card-title">${esc(item.title)}</div>
        <div class="card-cat">${esc(item.category_name)}</div>
      </div>`;

    card.querySelector('.card-fav').addEventListener('click', e => {
      e.stopPropagation(); toggleFav(item);
    });

    const activate = () => {
      if (item.type === 'series') openPanel(item);
      else playItem(item);
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });

    frag.appendChild(card);
  });

  grid.appendChild(frag);
  $('stats').textContent = `${col.length} éléments · ${grid.children.length} affichés`;
}

function resetAndRender() {
  S.shown[S.type] = PER_PAGE;
  renderGrid(true);
  updateCats();
}

function updateCats() {
  const all  = S.type === 'vod' ? S.vod : S.series;
  const cats = [...new Set(all.map(x => x.category_name))].sort();
  const sel  = $('catSelect');
  sel.innerHTML = `<option value="">Toutes catégories</option>` +
    cats.map(c => `<option value="${esc(c)}" ${c===S.cat?'selected':''}>${esc(c)}</option>`).join('');
}

function loadMore() {
  if (S.loading) return;
  S.loading = true;
  const col  = filtered();
  const next = Math.min(S.shown[S.type] + PER_PAGE, col.length);
  if (next > S.shown[S.type]) { S.shown[S.type] = next; renderGrid(); }
  S.loading = false;
}

// ── Navigation clavier TV ─────────────────────────────────

function initTV() {
  document.addEventListener('keydown', e => {
    const k = e.key;

    // Fermer panneau
    if (['Escape','GoBack','Back','BrowserBack'].includes(k)) {
      if (!$('panel').hidden) { e.preventDefault(); closePanel(); }
      return;
    }

    // D-pad
    if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(k)) return;
    const panelOpen = !$('panel').hidden;
    const focusable = panelOpen
      ? [...$('panel').querySelectorAll('.p-tab, .ep:not([disabled]), .ph-close, .p-direct')]
      : [...document.querySelectorAll('.card, .tab, .filters select, .filters input')];

    const idx = focusable.indexOf(document.activeElement);
    if (idx < 0) return;
    e.preventDefault();

    let cols = 1;
    if (!panelOpen) {
      const g = $('grid');
      if (g) cols = Math.max(1, Math.round(g.offsetWidth / 155));
    }

    let next = idx;
    if (k === 'ArrowRight') next = idx + 1;
    else if (k === 'ArrowLeft') next = Math.max(0, idx - 1);
    else if (k === 'ArrowDown') next = idx + cols;
    else if (k === 'ArrowUp')   next = idx - cols;

    focusable[Math.min(Math.max(0, next), focusable.length - 1)]?.focus();
  });
}

// ── Boot ──────────────────────────────────────────────────

async function boot() {

  // ── Onglets Films / Séries ──
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('tab--active'));
      btn.classList.add('tab--active');
      S.type   = btn.dataset.type;
      S.cat    = '';
      S.search = '';
      $('searchInput').value = '';
      closePanel();   // ← ferme le panneau quand on change d'onglet
      resetAndRender();
    });
  });

  // ── Filtres ──
  $('catSelect').addEventListener('change', e => { S.cat    = e.target.value; resetAndRender(); });
  $('searchInput').addEventListener('input', e => { S.search = e.target.value; resetAndRender(); });
  $('qualSelect').addEventListener('change', e => { S.qual   = e.target.value; resetAndRender(); });
  $('sortSelect').addEventListener('change', e => { S.sort   = e.target.value; resetAndRender(); });

  // ── Fermer panneau sur backdrop ──
  $('backdrop').addEventListener('click', closePanel);

  // ── Infinite scroll ──
  new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) loadMore();
  }, { rootMargin: '300px' }).observe($('sentinel'));

  // ── Navigation TV ──
  initTV();

  // ── Chargement VOD ──
  const vodJson = await fetchJSON('vod.json');
  if (vodJson) {
    S.vod    = normalizeItems(extractArr(vodJson), 'vod');
    S.srcVod = 'vod.json';
  } else {
    const vodM3u = await fetchText('vod.m3u');
    if (vodM3u) { S.vod = parseM3U(vodM3u, 'vod'); S.srcVod = 'vod.m3u'; }
  }

  // ── Chargement Séries ──
  const serJson = await fetchJSON('series.json');
  if (serJson) {
    S.series = normalizeItems(extractArr(serJson), 'series');
    S.srcSer = 'series.json';
  } else {
    const serM3u = await fetchText('series.m3u');
    if (serM3u) { S.series = parseM3U(serM3u, 'series'); S.srcSer = 'series.m3u'; }
  }

  // ── Affichage initial ──
  S.shown.vod    = PER_PAGE;
  S.shown.series = PER_PAGE;
  resetAndRender();
}

window.addEventListener('load', boot);
