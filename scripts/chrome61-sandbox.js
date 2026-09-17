// ╔══════════════════════════════════════════════════════════════════════╗
// ║  Bac à sable « Chrome 61 » — le moteur des autoradios PIPSILY CAR    ║
// ╚══════════════════════════════════════════════════════════════════════╝
//
// Le WebView AOSP des autoradios est figé en Chrome 61 (septembre 2017).
// esbuild convertit la SYNTAXE vers cette cible, mais pas les API : un
// « globalThis » ou un « new AbortController() » compile sans broncher et
// lève une ReferenceError sur le poste, en silence.
//
// Ce module reconstitue un moteur de cette époque : un global navigateur
// crédible, PRIVÉ de tout ce que Chrome n'a livré qu'APRÈS la 61. Y évaluer
// un fichier de legacy/ reproduit donc ce que fait l'autoradio.

const vm = require("vm");

// Ce que Chrome a livré APRÈS la 61, et que l'autoradio n'a donc pas.
// La version entre parenthèses est celle de la première prise en charge.
const APRES_CHROME_61 = {
  globaux: [
    ["globalThis", 71], ["AbortController", 66], ["AbortSignal", 66],
    ["queueMicrotask", 71], ["BigInt", 67], ["structuredClone", 98],
    ["AggregateError", 85], ["WeakRef", 84], ["FinalizationRegistry", 84],
    ["reportError", 95],
  ],
  membres: [
    ["Object", "fromEntries", 73], ["Object", "hasOwn", 93],
    ["Promise", "allSettled", 76], ["Promise", "any", 85],
    ["Promise.prototype", "finally", 63],
    ["Array.prototype", "flat", 69], ["Array.prototype", "flatMap", 69],
    ["Array.prototype", "at", 92],
    ["String.prototype", "matchAll", 73], ["String.prototype", "replaceAll", 85],
    ["String.prototype", "trimStart", 66], ["String.prototype", "trimEnd", 66],
    ["String.prototype", "at", 92],
  ],
};

const UA_AUTORADIO =
  "Mozilla/5.0 (Linux; Android 12; Build/SP1A.210812.016) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Version/4.0 Chrome/61.0.3163.98 Safari/537.36";

function stockageMemoire() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] || null,
    get length() { return m.size; },
  };
}

function elementBidon() {
  const el = {
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    children: [], attributes: {},
    appendChild(c){ el.children.push(c); return c; }, prepend(){}, remove(){},
    setAttribute(k, v){ el.attributes[k] = v; }, getAttribute(k){ return el.attributes[k] || null; },
    removeAttribute(k){ delete el.attributes[k]; },
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
    querySelector(){ return null; }, querySelectorAll(){ return []; },
    focus(){}, blur(){}, click(){}, insertAdjacentHTML(){}, scrollIntoView(){},
    getBoundingClientRect(){ return { top:0, left:0, right:0, bottom:0, width:0, height:0 }; },
    innerHTML: "", textContent: "", value: "",
  };
  return el;
}

/**
 * Construit un contexte vm simulant Chrome 61.
 *
 * @param {(url:string, opts:object) => Promise} surFetch  fetch simulé ;
 *        par défaut une réponse JSON vide.
 * @returns {{ctx: object, global: object, requetes: Array}}
 */
function creerMoteurChrome61(surFetch) {
  const requetes = [];

  const g = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    TextEncoder, TextDecoder, URL, URLSearchParams, btoa, atob,
    Headers, Request, Response, Blob, FormData, AbortController_NON: undefined,
    performance: { now: () => Date.now() },
    requestAnimationFrame: (f) => setTimeout(f, 0),
    cancelAnimationFrame: clearTimeout,
    matchMedia: () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }),
    IntersectionObserver: function(){ this.observe = function(){}; this.unobserve = function(){}; this.disconnect = function(){}; },
    MutationObserver: function(){ this.observe = function(){}; this.disconnect = function(){}; },
    WebSocket: function(){ this.addEventListener = function(){}; this.close = function(){}; this.send = function(){}; },
    BroadcastChannel: function(){ this.addEventListener = function(){}; this.removeEventListener = function(){}; this.postMessage = function(){}; this.close = function(){}; },
    Image: function(){ this.addEventListener = function(){}; },
    Audio: function(){ this.play = function(){ return Promise.resolve(); }; this.pause = function(){}; this.addEventListener = function(){}; },
    AudioContext: function(){ this.createOscillator = function(){ return { connect(){}, start(){}, stop(){}, frequency:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} } }; };
                              this.createGain = function(){ return { connect(){}, gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} } }; };
                              this.destination = {}; this.currentTime = 0; },
  };

  g.fetch = function (url, opts) {
    requetes.push({ url: String(url), method: (opts && opts.method) || "GET" });
    if (surFetch) return surFetch(String(url), opts || {});
    return Promise.resolve({
      ok: true, status: 200, url: String(url),
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({}),
      text: () => Promise.resolve("{}"),
      clone() { return this; },
    });
  };

  g.window = g;
  g.self = g;
  g.top = g;
  g.parent = g;
  g.addEventListener = function(){};
  g.removeEventListener = function(){};
  g.dispatchEvent = function(){ return true; };
  g.localStorage = stockageMemoire();
  g.sessionStorage = stockageMemoire();
  g.navigator = { userAgent: UA_AUTORADIO, language: "fr-FR", languages: ["fr-FR"], onLine: true, platform: "Linux armv7l" };
  g.location = {
    href: "https://morpheus45.github.io/VOD/index.html",
    origin: "https://morpheus45.github.io",
    pathname: "/VOD/index.html", protocol: "https:", host: "morpheus45.github.io",
    hash: "", search: "", replace(){}, assign(){}, reload(){},
  };
  g.history = { pushState(){}, replaceState(){}, back(){}, go(){} };
  g.screen = { width: 1024, height: 600 };
  g.innerWidth = 1024; g.innerHeight = 600;
  g.devicePixelRatio = 1;
  g.crypto = { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 31 + 7) % 256; return a; } };
  g.document = {
    readyState: "complete",
    documentElement: elementBidon(),
    head: elementBidon(),
    body: elementBidon(),
    createElement: () => elementBidon(),
    createTextNode: (t) => ({ textContent: t }),
    createDocumentFragment: () => elementBidon(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
    write(){}, writeln(){},
    cookie: "", hidden: false, visibilityState: "visible",
    activeElement: null,
  };
  delete g.AbortController_NON;

  const ctx = vm.createContext(g);

  // Retrait de tout ce qui est postérieur à Chrome 61.
  const lignes = [];
  for (const [nom] of APRES_CHROME_61.globaux) lignes.push(`delete this[${JSON.stringify(nom)}];`);
  for (const [porteur, membre] of APRES_CHROME_61.membres) lignes.push(`try { delete ${porteur}[${JSON.stringify(membre)}]; } catch (e) {}`);
  vm.runInContext(lignes.join("\n"), ctx);

  return { ctx, global: g, requetes };
}

module.exports = { creerMoteurChrome61, APRES_CHROME_61, UA_AUTORADIO };
