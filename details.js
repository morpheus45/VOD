const $ = id => document.getElementById(id);
function sanitize(s){ return (s || "").toString().trim(); }

function readItem(){
  try {
    const qs = new URLSearchParams(location.search);
    const raw = qs.get("item");
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function parseSeriesApiUrl(apiUrl){
  try{
    const u = new URL(apiUrl);
    return {
      base: u.origin,
      username: u.searchParams.get("username") || "",
      password: u.searchParams.get("password") || ""
    };
  }catch(e){
    return null;
  }
}

function buildEpisodeUrl(seriesApiUrl, episode){
  const info = parseSeriesApiUrl(seriesApiUrl);
  if (!info || !info.base || !info.username || !info.password) return "";
  const episodeId = episode && (episode.id || episode.episode_id || episode.stream_id);
  const ext = ((episode && (episode.container_extension || episode.extension)) || "mp4").toString();
  if (!episodeId) return "";
  return `${info.base}/series/${encodeURIComponent(info.username)}/${encodeURIComponent(info.password)}/${encodeURIComponent(episodeId)}.${ext}`;
}

function fixImg(url){
  return sanitize(url).replace(/\\\//g, "/");
}

async function copyText(v){
  try {
    await navigator.clipboard.writeText(v);
  } catch(e) {}
}

function fillBase(item){
  $("title").textContent = item.title || "Détail";
  document.title = item.title || "Détail";
  $("poster").src = fixImg(item.image || "");
  $("poster").alt = item.title || "poster";
  $("poster").onerror = () => { $("poster").removeAttribute("src"); };
  $("meta").textContent = [item.type === "vod" ? "VOD" : item.type === "series" ? "Série" : "Live", item.category || "", item.meta || ""].filter(Boolean).join(" • ");
  $("plot").textContent = item.plot || (item.type === "vod" ? "Synopsis indisponible." : "");
  $("topType").textContent = item.type === "vod" ? "Fiche VOD" : item.type === "series" ? "Fiche Série" : "Fiche";
}

function setupVod(item){
  $("vodActions").style.display = "flex";
  $("playBtn").href = item.url;
  $("playBtn").textContent = "Lire";
  $("playBtn").addEventListener("click", (e) => {
    e.preventDefault();
    location.href = item.url;
  });
  $("copyBtn").addEventListener("click", () => copyText(item.url));
  const isMixed = location.protocol === "https:" && /^http:\/\//i.test(item.url);
  $("notice").textContent = isMixed
    ? "Le lien vidéo est en HTTP. Le navigateur peut bloquer l’intégration, mais l’ouverture directe fonctionne normalement."
    : "";
}

async function setupSeries(item){
  $("seriesWrap").style.display = "block";
  $("notice").textContent = "";
  $("seriesStatus").textContent = "Chargement des saisons et épisodes…";
  try{
    const res = await fetch(item.url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const seasons = Array.isArray(data.seasons) ? data.seasons : [];
    const episodesObj = data.episodes && typeof data.episodes === "object" ? data.episodes : {};
    let seasonKeys = seasons.map(s => String(s.season_number || s.season || s.id || "")).filter(Boolean);
    if (!seasonKeys.length) seasonKeys = Object.keys(episodesObj);

    if (!seasonKeys.length){
      $("seriesStatus").textContent = "Aucune saison ou épisode trouvé.";
      return;
    }

    let activeSeason = seasonKeys[0];

    function renderSeasonTabs(){
      const wrap = $("seasonTabs");
      wrap.innerHTML = "";
      seasonKeys.forEach(key => {
        const s = seasons.find(x => String(x.season_number || x.season || x.id || "") === String(key));
        const label = (s && s.name) ? s.name : `Saison ${key}`;
        const b = document.createElement("button");
        b.className = "tab" + (String(key) === String(activeSeason) ? " active" : "");
        b.textContent = label;
        b.onclick = () => {
          activeSeason = String(key);
          renderSeasonTabs();
          renderEpisodes();
        };
        wrap.appendChild(b);
      });
    }

    function renderEpisodes(){
      const grid = $("episodeGrid");
      grid.innerHTML = "";
      const eps = (data.episodes && data.episodes[String(activeSeason)]) ? data.episodes[String(activeSeason)] : [];
      if (!eps.length){
        $("seriesStatus").textContent = "Aucun épisode trouvé dans cette saison.";
        return;
      }
      $("seriesStatus").textContent = "";

      eps.forEach(ep => {
        const url = buildEpisodeUrl(item.url, ep);
        const title = sanitize(ep.title || ep.name || `Episode ${ep.episode_num || ""}`);
        const poster = fixImg(ep.movie_image || ep.cover_big || ep.image || item.image || "");
        const plot = sanitize((ep.info && ep.info.plot) || ep.plot || "");
        const runtime = sanitize((ep.info && ep.info.duration) || ep.duration || "");
        const epNum = sanitize(ep.episode_num || ep.ep_num || "");

        const card = document.createElement("div");
        card.className = "epCard";

        const img = document.createElement("img");
        img.className = "epPoster";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.src = poster || "";
        img.alt = title;
        img.onerror = () => { img.removeAttribute("src"); };

        const body = document.createElement("div");
        body.className = "epBody";

        const ttl = document.createElement("h3");
        ttl.style.margin = "0";
        ttl.style.fontSize = "16px";
        ttl.textContent = epNum ? `E${epNum} — ${title}` : title;

        const meta = document.createElement("div");
        meta.className = "epMeta";
        meta.textContent = runtime || "";

        const desc = document.createElement("div");
        desc.className = "epMeta";
        desc.textContent = plot || "";

        const actions = document.createElement("div");
        actions.className = "actions";

        const openBtn = document.createElement("a");
        openBtn.className = "btn btn-primary";
        openBtn.href = url || "#";
        openBtn.textContent = "Lire l'épisode";
        openBtn.onclick = (e) => {
          e.preventDefault();
          if (!url) return;
          location.href = url;
        };

        const copyBtn = document.createElement("button");
        copyBtn.className = "btn";
        copyBtn.type = "button";
        copyBtn.textContent = "Copier le lien";
        copyBtn.onclick = () => copyText(url);

        actions.appendChild(openBtn);
        actions.appendChild(copyBtn);

        body.appendChild(ttl);
        if (runtime) body.appendChild(meta);
        if (plot) body.appendChild(desc);
        body.appendChild(actions);

        card.appendChild(img);
        card.appendChild(body);
        grid.appendChild(card);
      });
    }

    renderSeasonTabs();
    renderEpisodes();
  }catch(e){
    $("seriesStatus").textContent = "Impossible de charger les détails de la série.";
  }
}

(function init(){
  const item = readItem();
  if (!item) {
    $("title").textContent = "Fiche introuvable";
    $("plot").textContent = "Aucune donnée reçue.";
    return;
  }
  fillBase(item);
  if (item.type === "vod") setupVod(item);
  else if (item.type === "series") setupSeries(item);
})();
