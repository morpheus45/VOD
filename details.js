const $ = id => document.getElementById(id);
function sanitize(s){ return (s || "").toString().trim(); }
function fixImg(url){ return sanitize(url).replace(/\\\//g, "/"); }
async function copyText(v){ try { await navigator.clipboard.writeText(v); } catch(e) {} }

function readItem(){
  try {
    const qs = new URLSearchParams(location.search);
    const raw = qs.get("item");
    return raw ? JSON.parse(decodeURIComponent(raw)) : null;
  } catch { return null; }
}

function fillBase(item){
  $("title").textContent = item.title || "Détail";
  document.title = item.title || "Détail";
  $("poster").src = fixImg(item.image || "");
  $("poster").alt = item.title || "poster";
  $("poster").onerror = () => { $("poster").removeAttribute("src"); };
  $("meta").textContent = [item.type === "vod" ? "VOD" : item.type === "series" ? "Série" : "Live", item.category || "", item.meta || ""].filter(Boolean).join(" • ");
  $("plot").textContent = item.plot || "Synopsis indisponible.";
  $("topType").textContent = item.type === "vod" ? "Fiche VOD" : item.type === "series" ? "Fiche Série" : "Fiche Live";
}

function setupVod(item){
  $("vodActions").style.display = "flex";
  $("playBtn").addEventListener("click", e => { e.preventDefault(); location.href = item.url; });
  $("copyBtn").addEventListener("click", () => copyText(item.url));
}

function setupSeries(item){
  $("seriesWrap").style.display = "block";
  const seasons = Array.isArray(item.seasons) ? item.seasons : [];
  const episodesObj = item.episodes && typeof item.episodes === "object" ? item.episodes : {};
  let seasonKeys = seasons.map(s => String(s.season_number || s.season || s.id || "")).filter(Boolean);
  if (!seasonKeys.length) seasonKeys = Object.keys(episodesObj);
  if (!seasonKeys.length) {
    $("seriesStatus").textContent = "Aucune saison ou épisode disponible dans le fichier de catalogue.";
    return;
  }
  let activeSeason = seasonKeys[0];

  function renderTabs(){
    $("seasonTabs").innerHTML = "";
    seasonKeys.forEach(key => {
      const s = seasons.find(x => String(x.season_number || x.season || x.id || "") === String(key));
      const label = (s && s.name) ? s.name : `Saison ${key}`;
      const b = document.createElement("button");
      b.className = "tab" + (String(key) === String(activeSeason) ? " active" : "");
      b.textContent = label;
      b.onclick = () => { activeSeason = String(key); renderTabs(); renderEpisodes(); };
      $("seasonTabs").appendChild(b);
    });
  }

  function renderEpisodes(){
    $("episodeGrid").innerHTML = "";
    const eps = episodesObj[String(activeSeason)] || [];
    if (!eps.length) {
      $("seriesStatus").textContent = "Aucun épisode trouvé dans cette saison.";
      return;
    }
    $("seriesStatus").textContent = "";
    eps.forEach(ep => {
      const title = sanitize(ep.title || ep.name || `Episode ${ep.episode_num || ""}`);
      const poster = fixImg(ep.movie_image || ep.cover_big || ep.image || item.image || "");
      const plot = sanitize((ep.info && (ep.info.plot || ep.info.overview || ep.info.description || ep.info.synopsis)) || ep.plot || "");
      const runtime = sanitize((ep.info && ep.info.duration) || ep.duration || "");
      const epNum = sanitize(ep.episode_num || ep.ep_num || "");
      const url = sanitize(ep.url || ep.stream_url || "");

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
      openBtn.onclick = e => { e.preventDefault(); if (url) location.href = url; };

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
      $("episodeGrid").appendChild(card);
    });
  }

  renderTabs();
  renderEpisodes();
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
