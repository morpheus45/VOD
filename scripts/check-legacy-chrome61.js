#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════╗
// ║  Vérifie que legacy/ tourne VRAIMENT sur le moteur des autoradios    ║
// ╚══════════════════════════════════════════════════════════════════════╝
//
// Pourquoi ce fichier existe
// ──────────────────────────
// build-legacy.yml validait jusqu'ici deux choses : que les SOURCES du dépôt
// n'emploient pas d'API trop récente, et que le résultat PARSE en ES2018.
// Ni l'une ni l'autre ne couvrait legacy/supabase.js, qui n'est pas une source
// du dépôt mais un bundle repris d'un CDN.
//
// Ce bundle référence « globalThis » (Chrome 71) au premier niveau. Il parse
// parfaitement — donc acorn le validait — puis lève une ReferenceError à
// l'évaluation sur l'autoradio. « window.supabase » reste alors indéfini,
// auth.js en conclut « Supabase CDN non chargé », et toute tentative de
// connexion répond « Service d'authentification indisponible », que le poste
// ait Internet ou non. C'est exactement la panne rapportée sur PIPSILY CAR.
//
// Un contrôle statique ne pouvait pas voir ça : il faut EXÉCUTER le fichier
// sur un moteur privé des API postérieures à Chrome 61.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { creerMoteurChrome61 } = require("./chrome61-sandbox.js");

const RACINE = path.resolve(__dirname, "..");
const LEGACY = path.join(RACINE, "legacy");

const SUPA_URL  = "https://gwmuazostbbgroplnlql.supabase.co";
const SUPA_ANON = "sb_publishable_cNZ37Mjd57b_9nlyCvtkkA_wSIszOMR";

// Chaque page charge SES fichiers, dans SON moteur : index.html et player.html
// ne sont jamais chargées ensemble, et évaluer tout dans un seul contexte
// ferait mentir le contrôle (doubles déclarations qui n'existent pas en vrai).
const PAGES = [
  { page: "login.html",  fichiers: ["supabase.js", "auth.js"] },
  { page: "index.html",  fichiers: ["supabase.js", "auth.js", "app.js"] },
  { page: "player.html", fichiers: ["player.js"] },
];

let echecs = 0;
const ok = (m) => console.log("  ✓ " + m);
const ko = (m, d) => { echecs++; console.log("::error::" + m); if (d) console.log("    ↳ " + d); };

const lire = (f) => fs.readFileSync(path.join(LEGACY, f), "utf8");
const court = (e) => (e && e.name ? e.name + " : " + e.message : String(e));

// ── 1. Chaque page doit charger ses fichiers sans lever ─────────────────
console.log("\n[1/3] Chargement des pages sur un moteur Chrome 61");

const presents = fs.readdirSync(LEGACY).filter((f) => f.endsWith(".js"));
if (presents.length === 0) ko("legacy/ ne contient aucun fichier .js");

// Recensé AVANT la boucle : un fichier reste couvert même si le chargement
// s'arrête sur une erreur plus haut dans la page.
const couverts = new Set();
for (const { fichiers } of PAGES) for (const f of fichiers) couverts.add(f);

let moteurIndex = null;

for (const { page, fichiers } of PAGES) {
  const moteur = creerMoteurChrome61();
  let intact = true;
  for (const f of fichiers) {
    if (!fs.existsSync(path.join(LEGACY, f))) { ko("legacy/" + f + " est absent (chargé par " + page + ")"); intact = false; break; }
    try {
      vm.runInContext(lire(f), moteur.ctx, { filename: "legacy/" + f });
    } catch (e) {
      ko(page + " : legacy/" + f + " lève « " + court(e) + " » sur un moteur Chrome 61",
         "Ce fichier plantera sur l'autoradio. esbuild convertit la syntaxe, pas les API.");
      intact = false;
      break;
    }
  }
  if (intact) ok(page + " charge " + fichiers.map((f) => "legacy/" + f).join(", "));
  if (page === "index.html" && intact) moteurIndex = moteur;
}

for (const f of presents) {
  if (!couverts.has(f)) ko("legacy/" + f + " n'est vérifié par aucune page — ajoutez-le à PAGES dans " + path.relative(RACINE, __filename));
}

// ── 2. window.supabase doit exister et être utilisable ──────────────────
console.log("\n[2/3] La bibliothèque Supabase est-elle exploitable ?");

const supa = moteurIndex && moteurIndex.ctx.supabase;
if (!supa || typeof supa.createClient !== "function") {
  ko("window.supabase.createClient est absent après chargement de legacy/supabase.js",
     "auth.js répondra « Service d'authentification indisponible » à chaque connexion.");
} else {
  ok("window.supabase.createClient est présent");
  const auth = moteurIndex.ctx.PIPSILY_AUTH;
  if (!auth || typeof auth.signIn !== "function") ko("window.PIPSILY_AUTH.signIn est absent après chargement de legacy/auth.js");
  else ok("window.PIPSILY_AUTH.signIn est présent");
}

// ── 3. Séquence de connexion complète, réseau simulé ────────────────────
//
// Charger le fichier ne suffit pas : createClient, getSession,
// signInWithPassword et une lecture de table doivent aboutir ET taper les
// bonnes URL. Un fetch simulé répond à la place de Supabase.
console.log("\n[3/3] Séquence de connexion de bout en bout");

function reponse(corps) {
  const texte = JSON.stringify(corps);
  return Promise.resolve({
    ok: true, status: 200, url: "",
    headers: { get: () => "application/json" },
    json: () => Promise.resolve(JSON.parse(texte)),
    text: () => Promise.resolve(texte),
    clone() { return this; },
  });
}

const appels = [];
let m2 = null;
try {
  m2 = creerMoteurChrome61((url) => {
    appels.push(url);
    if (url.indexOf("/auth/v1/token") >= 0)
      return reponse({ access_token: "a.b.c", token_type: "bearer", expires_in: 3600,
                       refresh_token: "r", user: { id: "u1", email: "test@example.com" } });
    if (url.indexOf("/rest/v1/profiles") >= 0)
      return reponse({ id: "u1", email: "test@example.com", plan: "admin", content_policy: "all" });
    return reponse({});
  });
  vm.runInContext(lire("supabase.js"), m2.ctx, { filename: "legacy/supabase.js" });
} catch (e) {
  ko("Séquence non jouée : legacy/supabase.js ne se charge pas (" + court(e) + ")");
  m2 = null;
  terminer();
}

const scenario = `
(async function () {
  var r = { etapes: [] };
  try {
    var c = supabase.createClient(${JSON.stringify(SUPA_URL)}, ${JSON.stringify(SUPA_ANON)},
      { auth: { persistSession: true, autoRefreshToken: true, storageKey: "pipsily_auth" } });
    r.etapes.push(["createClient", null]);

    var s = await c.auth.getSession();
    r.etapes.push(["getSession", s && s.error ? String(s.error.message) : null]);

    var i = await c.auth.signInWithPassword({ email: "test@example.com", password: "motdepasse" });
    r.etapes.push(["signInWithPassword", i && i.error ? String(i.error.message) : null]);

    var p = await c.from("profiles").select("*").eq("id", "u1").single();
    r.etapes.push(["from(profiles).select().eq().single()", p && p.error ? String(p.error.message) : null]);
  } catch (e) {
    r.exception = e.name + " : " + e.message;
  }
  return r;
})()
`;

if (m2) {
  vm.runInContext(scenario, m2.ctx)
    .then((r) => {
      for (const [etape, erreur] of r.etapes) {
        if (erreur) ko("« " + etape + " » a répondu une erreur : " + erreur);
        else ok(etape);
      }
      if (r.exception) ko("La séquence de connexion a levé : " + r.exception);

      const aTape = (frag) => appels.some((u) => u.indexOf(frag) >= 0);
      if (aTape("/auth/v1/token")) ok("appel émis vers /auth/v1/token");
      else ko("Aucun appel à /auth/v1/token — la connexion ne part pas au réseau");
      if (aTape("/rest/v1/profiles")) ok("appel émis vers /rest/v1/profiles");
      else ko("Aucun appel à /rest/v1/profiles — la lecture de profil ne part pas");

      terminer();
    })
    .catch((e) => { ko("La séquence de connexion a été rejetée : " + court(e)); terminer(); });
}

function terminer() {
  if (echecs) {
    console.log("\n✗ " + echecs + " problème(s) : legacy/ ne fonctionnerait pas sur l'autoradio.\n");
    process.exit(1);
  }
  console.log("\n✓ legacy/ s'exécute sur un moteur Chrome 61.\n");
  process.exit(0);
}
