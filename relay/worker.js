/**
 * PIPSILY Relay Worker - Cloudflare Workers
 *
 * Relais HTTPS pour flux vidéo IPTV (HTTP pur -> HTTPS, anti mixed content).
 *
 * Déploiement : créer un Worker dans le tableau de bord Cloudflare (Workers).
 * Coller ce fichier. Ajouter la variable RELAY_KEY (Settings → Variables).
 * Noter l'URL https://<nom>.<compte>.workers.dev
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

function relayUrl(origin, key, target) {
  const scheme = target.protocol.replace(":", "");
  const host = target.host;
  const path = target.pathname.replace(/^\//, "");
  const pathPart = path ? "/" + path : "";
  return `${origin}/p/${key}/${scheme}/${host}${pathPart}${target.search}`;
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
    const scheme = parts[2];
    if (scheme !== "http" && scheme !== "https") {
      return new Response("Bad Request", { status: 400, headers: buildCors() });
    }
    const host = parts[3];
    if (!host) {
      return new Response("Bad Request", { status: 400, headers: buildCors() });
    }

    const upstreamUrl = `${scheme}://${host}/${parts.slice(4).join("/")}${url.search}`;
    const headers = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    headers["User-Agent"] = "Mozilla/5.0 (PIPSILY relay)";

    try {
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
        const toRelay = (ref) => relayUrl(origin, key, new URL(ref, finalUrl));
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
