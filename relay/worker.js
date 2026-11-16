/**
 * PIPSILY Relay Worker - Cloudflare Workers
 *
 * Relais HTTPS pour flux vidéo IPTV (HTTP pur -> HTTPS, anti mixed content).
 *
 * Déploiement : créer un Worker dans le tableau de bord Cloudflare (Workers).
 * Coller ce fichier. Ajouter les variables RELAY_KEY, XT_USER et XT_PASS
 * (Settings → Variables and Secrets). Noter l'URL https://<nom>.<compte>.workers.dev
 *
 * Deux formes d'URL :
 *   /p/<CLE>/http/<hôte>/<chemin>            relais générique (segments CDN, Pluto…)
 *   /p/<CLE>/x/http/<hôte>/live/<id>.m3u8    Xtream : l'identifiant et le mot de passe
 *                                            sont ajoutés ICI (XT_USER / XT_PASS),
 *                                            jamais visibles côté navigateur.
 *   /p/<CLE>/status                          JSON : relais joignable, identifiants présents ?
 */

"use strict";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Accept, Accept-Encoding, If-Range, If-None-Match, If-Modified-Since",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified, Access-Control-Max-Age",
  "Access-Control-Max-Age": "86400"
};

// Accept-Encoding n'est pas transmis : la vidéo ne se compresse pas, et un corps
// recompressé rendrait Content-Length faux.
const FORWARDED_HEADERS = [
  "Range", "Accept", "If-Range", "If-None-Match", "If-Modified-Since"
];

const UPSTREAM_COPY_HEADERS = [
  "Content-Type", "Content-Length", "Content-Range", "Accept-Ranges",
  "ETag", "Last-Modified", "Cache-Control"
];

function buildCors() {
  return { ...CORS_HEADERS };
}

function copyUpstreamHeaders(upstream, out) {
  for (const name of UPSTREAM_COPY_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }
}

const XT_TYPES = new Set(["live", "movie", "series"]);
const XT_API   = /^(player_api|get|xmltv)\.php$/i;

// Marqueur qui remplace la paire identifiant/mot de passe dans les URL relayées.
// Le CDN du fournisseur la recopie n'importe où dans ses chemins de segments
// (/hlsr/<jeton>/…/ID/MDP/…) : on la masque où qu'elle soit.
const XT_MARK = "__xt__";

// URL amont → URL relais. Si le chemin porte les identifiants Xtream connus du
// worker, ils sont remplacés par XT_MARK (forme « x ») : rien ne doit les faire
// réapparaître côté navigateur, même via une playlist réécrite.
function relayUrl(origin, key, target, env) {
  const scheme = target.protocol.replace(":", "");
  const host = target.host;
  const segs = target.pathname.split("/").filter(Boolean);
  if (env && env.XT_USER && env.XT_PASS) {
    for (let i = 0; i + 1 < segs.length; i++) {
      if (segs[i] === env.XT_USER && segs[i + 1] === env.XT_PASS) {
        segs.splice(i, 2, XT_MARK);
        return `${origin}/p/${key}/x/${scheme}/${host}/${segs.join("/")}${target.search}`;
      }
    }
  }
  const path = segs.join("/");
  return `${origin}/p/${key}/${scheme}/${host}${path ? "/" + path : ""}${target.search}`;
}

// Forme « x » → URL amont complète, identifiants injectés depuis l'environnement.
//   …/live/123.m3u8        (client : type puis id)      → /live/ID/MDP/123.m3u8
//   …/hlsr/T/__xt__/a/b.ts (playlist réécrite ci-dessus) → /hlsr/T/ID/MDP/a/b.ts
//   …/player_api.php?…     → username/password ajoutés à la requête
function xtreamUpstream(scheme, host, rest, search, env) {
  if (!env.XT_USER || !env.XT_PASS) return null;
  const u = encodeURIComponent(env.XT_USER), p = encodeURIComponent(env.XT_PASS);
  const mi = rest.indexOf(XT_MARK);
  if (mi >= 0) {
    const segs = rest.slice(); segs.splice(mi, 1, u, p);
    return `${scheme}://${host}/${segs.join("/")}${search}`;
  }
  if (XT_TYPES.has(rest[0]) && rest.length >= 2) {
    return `${scheme}://${host}/${rest[0]}/${u}/${p}/${rest.slice(1).join("/")}${search}`;
  }
  if (rest.length === 1 && XT_API.test(rest[0])) {
    const q = (search || "").replace(/^\?/, "").split("&").filter(s => s && !/^(username|password)=/i.test(s));
    q.push("username=" + u, "password=" + p);
    return `${scheme}://${host}/${rest[0]}?${q.join("&")}`;
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: buildCors() });
    }
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: buildCors() });
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "p") {
      return new Response("PIPSILY relay OK", { status: 200, headers: buildCors() });
    }

    const key = env.RELAY_KEY;
    if (!key || parts[1] !== key) {
      return new Response("forbidden", { status: 403, headers: buildCors() });
    }
    if (parts[2] === "status") {
      const body = JSON.stringify({ ok: true, xt: !!(env.XT_USER && env.XT_PASS) });
      return new Response(body, { status: 200, headers: { ...buildCors(), "Content-Type": "application/json" } });
    }
    // Diagnostic : /p/<CLE>/dbg/http/<hôte>/<chemin> → statut, en-têtes et début
    // du corps de la réponse amont (sans suivre les redirections).
    const dbgMode = parts[2] === "dbg";
    const xMode = parts[2] === "x";
    const base = (xMode || dbgMode) ? 3 : 2;  // index du schéma dans le chemin
    const scheme = parts[base];
    if (scheme !== "http" && scheme !== "https") {
      return new Response("Bad Request", { status: 400, headers: buildCors() });
    }
    const host = parts[base + 1];
    if (!host) {
      return new Response("Bad Request", { status: 400, headers: buildCors() });
    }

    let upstreamUrl;
    if (xMode) {
      upstreamUrl = xtreamUpstream(scheme, host, parts.slice(base + 2), url.search, env);
      if (!upstreamUrl) {
        const msg = (env.XT_USER && env.XT_PASS) ? "Bad Request" : "relay: variables XT_USER / XT_PASS manquantes";
        return new Response(msg, { status: (env.XT_USER && env.XT_PASS) ? 400 : 500, headers: buildCors() });
      }
    } else {
      upstreamUrl = `${scheme}://${host}/${parts.slice(base + 2).join("/")}${url.search}`;
    }
    const headers = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    // User-Agent du navigateur transmis tel quel (le fournisseur filtre les clients)
    headers["User-Agent"] = request.headers.get("User-Agent") || "Mozilla/5.0 (PIPSILY relay)";

    try {
      if (dbgMode) {
        const r = await fetch(upstreamUrl, { method: "GET", headers, redirect: "manual" });
        const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
        const txt = (await r.text()).slice(0, 300);
        return new Response(JSON.stringify({ upstreamUrl, status: r.status, headers: h, body: txt }, null, 1),
          { status: 200, headers: { ...buildCors(), "Content-Type": "application/json" } });
      }
      const upstream = await fetch(upstreamUrl, { method, headers, redirect: "follow" });

      if (method === "HEAD") {
        const outHeaders = buildCors();
        copyUpstreamHeaders(upstream, outHeaders);
        return new Response(null, { status: upstream.status, headers: outHeaders });
      }

      const outHeaders = buildCors();
      copyUpstreamHeaders(upstream, outHeaders);

      const finalUrl = upstream.url || upstreamUrl;
      const contentType = upstream.headers.get("Content-Type") || "";
      const pathLower = (url.pathname + " " + finalUrl.split("?")[0]).toLowerCase();
      const isPlaylist = contentType.includes("mpegurl") || /\.m3u8?(\s|$)/.test(pathLower);

      if (isPlaylist && upstream.ok) {
        // Playlist HLS : chaque URI (segment, sous-playlist, clé) est résolue
        // contre l'URL FINALE (après redirection CDN) puis renvoyée vers le relais.
        const text = await upstream.text();
        const origin = url.origin;
        const toRelay = (ref) => relayUrl(origin, key, new URL(ref, finalUrl), env);
        const rewritten = text.split(/\r?\n/).map((line) => {
          const t = line.trim();
          if (!t) return line;
          if (!t.startsWith("#")) return toRelay(t);                       // ligne URI
          return line.replace(/URI="([^"]*)"/g, (m, ref) => `URI="${toRelay(ref)}"`); // attribut URI="…"
        });
        // Le corps a changé : les longueurs amont ne valent plus.
        delete outHeaders["Content-Length"];
        delete outHeaders["Content-Range"];
        return new Response(rewritten.join("\n"), {
          status: upstream.status,
          headers: { ...outHeaders, "Content-Type": "application/vnd.apple.mpegurl" }
        });
      }

      return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
    } catch (error) {
      return new Response(`upstream error: ${error.message}`, { status: 502, headers: buildCors() });
    }
  }
};
