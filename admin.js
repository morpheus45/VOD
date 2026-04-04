
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    source: null,
    currentType: 'series',
    selectedCategory: 'all',
    search: '',
    libraries: {
      series: {meta:{kind:'series'}, categories: [], items: []},
      vod: {meta:{kind:'vod'}, categories: [], items: []}
    }
  };

  function setStatus(msg, type='info') {
    const el = $('status');
    el.textContent = msg;
    el.style.color = type === 'error' ? '#ff9a9a' : type === 'ok' ? '#90f0b3' : '#eef3ff';
  }

  function escapeAttr(v){ return String(v ?? '').replace(/"/g, "'"); }

  function parseXtreamUrl(raw) {
    try {
      const url = new URL(raw.trim());
      const username = url.searchParams.get('username') || '';
      const password = url.searchParams.get('password') || '';
      const action = url.searchParams.get('action') || '';
      const base = url.origin;
      return {
        raw: raw.trim(),
        base, username, password, action,
        playerApi: `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
        api: (action) => `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=${encodeURIComponent(action)}`
      };
    } catch { return null; }
  }

  function updateSourceTags() {
    $('baseTag').textContent = `Base : ${state.source?.base || '-'}`;
    $('userTag').textContent = `Utilisateur : ${state.source?.username || '-'}`;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  function updateCounts() {
    $('seriesCount').textContent = state.libraries.series.items.length;
    $('seriesCount').textContent = state.libraries.series.items.length;
    $('vodCount').textContent = state.libraries.vod.items.length;
  }

  async function importLive(src) {
    setStatus('Import Live : catégories…');
    const categories = await fetchJson(src.api('get_live_categories'));
    const streams = await fetchJson(src.api('get_live_streams'));
    const catMap = new Map((categories || []).map(c => [String(c.category_id), c.category_name || `Catégorie ${c.category_id}`]));
    const items = (streams || []).map(s => ({
      id: String(s.stream_id),
      title: s.name || `Live ${s.stream_id}`,
      category_id: String(s.category_id || 'uncategorized'),
      category_name: catMap.get(String(s.category_id || 'uncategorized')) || 'Sans catégorie',
      stream_icon: s.stream_icon || '',
      stream_url: `${src.base}/live/${encodeURIComponent(src.username)}/${encodeURIComponent(src.password)}/${encodeURIComponent(s.stream_id)}.${s.container_extension || 'ts'}`,
      type: 'live'
    }));
    
  }

  async function importVod(src) {
    setStatus('Import VOD : catégories…');
    const categories = await fetchJson(src.api('get_vod_categories'));
    const catMap = new Map((categories || []).map(c => [String(c.category_id), c.category_name || `Catégorie ${c.category_id}`]));
    const items = [];
    for (let i=0;i<(categories || []).length;i++) {
      const cat = categories[i];
      setStatus(`Import VOD : ${i+1}/${categories.length} — ${cat.category_name || cat.category_id}`);
      let streams = [];
      try {
        streams = await fetchJson(`${src.api('get_vod_streams')}&category_id=${encodeURIComponent(cat.category_id)}`);
      } catch (e) {}
      for (const s of (streams || [])) {
        const ext = s.container_extension || 'mp4';
        items.push({
          id: String(s.stream_id),
          title: s.name || `VOD ${s.stream_id}`,
          category_id: String(cat.category_id),
          category_name: catMap.get(String(cat.category_id)) || 'Sans catégorie',
          stream_icon: s.stream_icon || '',
          stream_url: `${src.base}/movie/${encodeURIComponent(src.username)}/${encodeURIComponent(src.password)}/${encodeURIComponent(s.stream_id)}.${ext}`,
          type: 'vod'
        });
      }
    }
    state.libraries.vod = {
      meta: {kind:'vod', created_at:new Date().toISOString(), source_base:src.base, username:src.username},
      categories: [...new Map(items.map(i => [i.category_id, {category_id:i.category_id, category_name:i.category_name}])).values()],
      items
    };
  }

  async function importSeries(src) {
    setStatus('Import Séries : catégories…');
    const categories = await fetchJson(src.api('get_series_categories'));
    const catMap = new Map((categories || []).map(c => [String(c.category_id), c.category_name || `Catégorie ${c.category_id}`]));
    const seriesList = await fetchJson(src.api('get_series'));
    const items = (seriesList || []).map(s => ({
      id: String(s.series_id || s.stream_id || Math.random()),
      title: s.name || `Série ${s.series_id || ''}`,
      category_id: String(s.category_id || 'uncategorized'),
      category_name: catMap.get(String(s.category_id || 'uncategorized')) || 'Sans catégorie',
      stream_icon: s.cover || s.stream_icon || '',
      stream_url: `${src.playerApi}&action=get_series_info&series_id=${encodeURIComponent(s.series_id || s.stream_id || '')}`,
      type: 'series'
    }));
    state.libraries.series = {
      meta: {kind:'series', created_at:new Date().toISOString(), source_base:src.base, username:src.username, note:'stream_url pointe vers get_series_info'},
      categories: [...new Map(items.map(i => [i.category_id, {category_id:i.category_id, category_name:i.category_name}])).values()],
      items
    };
  }

  async function importAll() {
    const raw = $('apiUrl').value.trim();
    const parsed = parseXtreamUrl(raw);
    if (!parsed || !parsed.username || !parsed.password) {
      setStatus("Lien invalide ou identifiants absents.", 'error');
      return;
    }
    state.source = parsed;
    updateSourceTags();
    try { localStorage.setItem('xtream_api_url', raw); } catch (e) {}

    try {
      await importSeries(parsed);
      updateCounts(); renderAll();
      await importVod(parsed);
      updateCounts(); renderAll();
      setStatus("Import terminé : Live + Séries + VOD. Exporte maintenant les fichiers.", 'ok');
    } catch (e) {
      setStatus(`Échec import : ${e.message}`, 'error');
    }
  }

  function buildM3U(type) {
    const library = state.libraries[type];
    const lines = ['#EXTM3U'];
    for (const item of library.items) {
      const logo = item.stream_icon ? ` tvg-logo="${escapeAttr(item.stream_icon)}"` : '';
      const group = item.category_name ? ` group-title="${escapeAttr(item.category_name)}"` : '';
      lines.push(`#EXTINF:-1${logo}${group},${item.title}`);
      lines.push(item.stream_url);
    }
    return lines.join('\n');
  }

  function parseM3U(text, forcedType='vod') {
    const lines = text.split(/\r?\n/);
    const items = [];
    let current = null;
    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF:')) {
        const groupMatch = line.match(/group-title="([^"]+)"/i);
        const logoMatch = line.match(/tvg-logo="([^"]+)"/i);
        const title = line.includes(',') ? line.split(',').slice(1).join(',').trim() : 'Sans titre';
        current = {
          id: String(items.length + 1),
          title,
          category_name: groupMatch ? groupMatch[1] : 'Sans catégorie',
          category_id: groupMatch ? groupMatch[1] : 'uncategorized',
          stream_icon: logoMatch ? logoMatch[1] : '',
          stream_url: '',
          type: forcedType
        };
      } else if (!line.startsWith('#') && current) {
        current.stream_url = line;
        items.push(current);
        current = null;
      }
    }
    return {
      meta: {kind:forcedType, created_at:new Date().toISOString()},
      categories: [...new Map(items.map(i => [i.category_id, {category_id:i.category_id, category_name:i.category_name}])).values()],
      items
    };
  }

  function downloadText(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function currentLibrary() {
    return state.libraries[state.currentType];
  }

  function renderCategories() {
    const wrap = $('categoryList');
    const lib = currentLibrary();
    wrap.innerHTML = '';
    const allBtn = document.createElement('button');
    allBtn.className = 'category-btn' + (state.selectedCategory === 'all' ? ' active' : '');
    allBtn.textContent = `Toutes (${lib.items.length})`;
    allBtn.onclick = () => { state.selectedCategory = 'all'; renderAll(); };
    wrap.appendChild(allBtn);

    for (const cat of lib.categories) {
      const count = lib.items.filter(x => String(x.category_id) === String(cat.category_id)).length;
      const btn = document.createElement('button');
      btn.className = 'category-btn' + (state.selectedCategory === String(cat.category_id) ? ' active' : '');
      btn.textContent = `${cat.category_name} (${count})`;
      btn.onclick = () => { state.selectedCategory = String(cat.category_id); renderAll(); };
      wrap.appendChild(btn);
    }
  }

  function filteredItems() {
    const lib = currentLibrary();
    const q = state.search.toLowerCase().trim();
    return lib.items.filter(item => {
      const catOk = state.selectedCategory === 'all' || String(item.category_id) === String(state.selectedCategory);
      const searchOk = !q || item.title.toLowerCase().includes(q) || (item.category_name || '').toLowerCase().includes(q);
      return catOk && searchOk;
    });
  }

  function playItem(item) {
    const player = $('player');
    $('playerTitle').textContent = `${item.title}${item.category_name ? ' — ' + item.category_name : ''}`;
    if (state.currentType === 'series') {
      player.removeAttribute('src');
      player.load();
      window.open(item.stream_url, '_blank');
      return;
    }
    player.src = item.stream_url;
    player.play().catch(() => {});
  }

  function renderGrid() {
    const items = filteredItems();
    const grid = $('grid');
    $('countTag').textContent = `${items.length} élément${items.length > 1 ? 's' : ''}`;
    $('sectionTitle').textContent = state.currentType === 'series' ? 'Catalogue Séries' : 'Catalogue VOD';
    grid.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'Aucun élément à afficher.';
      grid.appendChild(empty);
      return;
    }
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'item';
      const poster = document.createElement('div');
      poster.className = 'poster';
      if (item.stream_icon) poster.style.backgroundImage = `url("${item.stream_icon}")`;
      const body = document.createElement('div');
      body.className = 'item-body';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = item.title;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = item.category_name || state.currentType;
      const row = document.createElement('div');
      row.className = 'row';
      row.style.marginTop = '10px';
      const playBtn = document.createElement('button');
      playBtn.className = 'primary';
      playBtn.textContent = state.currentType === 'series' ? 'Ouvrir' : 'Lire';
      playBtn.onclick = () => playItem(item);
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copier lien';
      copyBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(item.stream_url); setStatus(`Lien copié : ${item.title}`, 'ok'); }
        catch { setStatus("Impossible de copier le lien.", 'error'); }
      };
      row.append(playBtn, copyBtn);
      body.append(title, meta, row);
      card.append(poster, body);
      grid.append(card);
    }
  }

  function renderAll() {
    updateCounts();
    renderCategories();
    renderGrid();
  }

  async function tryAutoload() {
    const targets = [['series.json','series'],['vod.json','vod'],['series.m3u','series'],['vod.m3u','vod']];
    let loaded = 0;
    for (const [name, type] of targets) {
      try {
        const res = await fetch(`./${name}?v=${Date.now()}`);
        if (!res.ok) continue;
        const text = await res.text();
        if (name.endsWith('.json')) {
          const data = JSON.parse(text);
          if (data && Array.isArray(data.items)) { state.libraries[type] = data; loaded++; }
        } else {
          const data = parseM3U(text, type);
          if (data.items.length) { state.libraries[type] = data; loaded++; }
        }
      } catch (e) {}
    }
    renderAll();
    setStatus(loaded ? `Chargement terminé : ${loaded} fichier(s) trouvé(s).` : 'Aucun fichier racine trouvé.');
  }

  $('parseBtn').onclick = () => {
    const parsed = parseXtreamUrl($('apiUrl').value);
    if (!parsed) return setStatus("Lien non reconnu.", 'error');
    state.source = parsed;
    updateSourceTags();
    setStatus(`Lien reconnu. Action détectée : ${parsed.action || '(aucune)'}`, 'ok');
  };

  $('importAllBtn').onclick = importAll;
  $('saveCredsBtn').onclick = () => {
    const raw = $('apiUrl').value.trim();
    if (!raw) return setStatus("Aucun lien à mémoriser.", 'error');
    try { localStorage.setItem('xtream_api_url', raw); } catch (e) {}
    setStatus("URL mémorisée.", 'ok');
  };

  $('clearCredsBtn').onclick = () => {
    try {
      localStorage.removeItem('xtream_api_url');
      localStorage.removeItem('xtream_libraries');
    } catch (e) {}
    $('apiUrl').value = '';
    state.source = null;
    state.libraries = {
      series: {meta:{kind:'series'}, categories: [], items: []},
      vod: {meta:{kind:'vod'}, categories: [], items: []}
    };
    updateSourceTags();
    renderAll();
    setStatus("Données effacées.", 'ok');
  };

  $('downloadLiveJsonBtn').onclick = () => state.libraries.series.items.length ? downloadText('live.json', JSON.stringify(state.libraries.live, null, 2), 'application/json;charset=utf-8') : setStatus('Aucune donnée live.', 'error');
  $('downloadSeriesJsonBtn').onclick = () => state.libraries.series.items.length ? downloadText('series.json', JSON.stringify(state.libraries.series, null, 2), 'application/json;charset=utf-8') : setStatus('Aucune donnée séries.', 'error');
  $('downloadVodJsonBtn').onclick = () => state.libraries.vod.items.length ? downloadText('vod.json', JSON.stringify(state.libraries.vod, null, 2), 'application/json;charset=utf-8') : setStatus('Aucune donnée VOD.', 'error');
  $('downloadLiveM3uBtn').onclick = () => state.libraries.series.items.length ? downloadText('live.m3u', buildM3U('live'), 'audio/x-mpegurl;charset=utf-8') : setStatus('Aucune donnée live.', 'error');
  $('downloadSeriesM3uBtn').onclick = () => state.libraries.series.items.length ? downloadText('series.m3u', buildM3U('series'), 'audio/x-mpegurl;charset=utf-8') : setStatus('Aucune donnée séries.', 'error');
  $('downloadVodM3uBtn').onclick = () => state.libraries.vod.items.length ? downloadText('vod.m3u', buildM3U('vod'), 'audio/x-mpegurl;charset=utf-8') : setStatus('Aucune donnée VOD.', 'error');
  $('autoloadBtn').onclick = tryAutoload;

  $('jsonFile').addEventListener('change', async (e) => {
    for (const file of [...(e.target.files || [])]) {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data || !Array.isArray(data.items)) continue;
        const lname = file.name.toLowerCase();
        const type = lname.includes('live') ? 'live' : lname.includes('series') ? 'series' : 'vod';
        state.libraries[type] = data;
      } catch (err) {}
    }
    renderAll(); setStatus('Fichiers JSON chargés.', 'ok');
  });

  $('m3uFile').addEventListener('change', async (e) => {
    for (const file of [...(e.target.files || [])]) {
      try {
        const text = await file.text();
        const lname = file.name.toLowerCase();
        const type = lname.includes('live') ? 'live' : lname.includes('series') ? 'series' : 'vod';
        state.libraries[type] = parseM3U(text, type);
      } catch (err) {}
    }
    renderAll(); setStatus('Fichiers M3U chargés.', 'ok');
  });

  $('searchInput').addEventListener('input', (e) => { state.search = e.target.value || ''; renderGrid(); });

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      state.currentType = btn.dataset.type;
      state.selectedCategory = 'all';
      renderAll();
    });
  });

  function boot() {
    try {
      const savedUrl = localStorage.getItem('xtream_api_url');
      if (savedUrl) {
        $('apiUrl').value = savedUrl;
        state.source = parseXtreamUrl(savedUrl);
        updateSourceTags();
      }
    } catch (e) {}
    updateCounts();
    renderAll();
    tryAutoload();
  }
  boot();
})();
