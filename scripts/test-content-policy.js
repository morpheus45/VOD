#!/usr/bin/env node
/**
 * Politique de contenu par compte : normalisation et filtrage.
 * Le test extrait le VRAI code des fichiers livrés, jamais une copie.
 * Usage : node scripts/test-content-policy.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let fails = 0;
const ok  = m => console.log('  ✓ ' + m);
const bad = m => { fails++; console.log('  ✗ ' + m); };

// ── Outils partages : tout est extrait du VRAI code livre ─────────────────
const COS_SRC  = fs.readFileSync(path.join(ROOT, 'cosmos.html'), 'utf8');
const APP_SRC  = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'auth.js'), 'utf8');

// Decoupe une fonction declaree en colonne 0 : du prototype jusqu'a la
// premiere accolade fermante en colonne 0. cosmos.html et app.js declarent
// toutes leurs fonctions de premier niveau sans indentation.
function topLevelFn(src, header){
  const i = src.indexOf(header);
  if (i < 0) return null;
  const e = src.indexOf('\n}', i);
  return e < 0 ? null : src.slice(i, e + 2);
}
// Comparaison insensible aux espaces : un simple reformatage ne doit pas
// faire passer une verification de site d'appel pour un retrait d'appel.
const squash   = s => String(s).replace(/\s+/g, '');
const hasCall  = (body, snippet) => squash(body).indexOf(squash(snippet)) >= 0;
const countCall = (body, snippet) => {
  const h = squash(body), n = squash(snippet);
  let c = 0, i = 0;
  for (;;) { const j = h.indexOf(n, i); if (j < 0) break; c++; i = j + n.length; }
  return c;
};

// Le VRAI contentFilter d'auth.js.
function loadAuthApi(){
  const m = AUTH_SRC.match(/\/\/ <content-policy-normalize>([\s\S]*?)\/\/ <\/content-policy-normalize>/);
  if (!m) return null;
  const box = { console };
  vm.createContext(box);
  vm.runInContext(m[1] + '\nglobalThis._api = { normalizeContentPolicy, contentFilter };', box);
  return box._api;
}
// Le VRAI policyFilter de cosmos.html, branche sur le VRAI contentFilter.
// extraSrc : code supplementaire de cosmos.html a charger dans le meme bac a
// sable (resolveItem, refreshContentSilently...). extraCtx : globales du bac.
function loadCosPolicy(extraSrc, extraCtx){
  const m = COS_SRC.match(/\/\/ <content-policy>([\s\S]*?)\/\/ <\/content-policy>/);
  if (!m) return null;
  const api = loadAuthApi();
  const box = Object.assign(
    { console, window: { PIPSILY_AUTH: { contentFilter: api.contentFilter } } },
    extraCtx || {});
  vm.createContext(box);
  vm.runInContext(m[1] + '\n' + (extraSrc || ''), box);
  return box;
}
// Le VRAI appPolicyFilter de app.js.
function loadAppPolicy(){
  const m = APP_SRC.match(/\/\/ <content-policy>([\s\S]*?)\/\/ <\/content-policy>/);
  if (!m) return null;
  const api = loadAuthApi();
  const box = { console, S: {}, window: { PIPSILY_AUTH: { contentFilter: api.contentFilter } } };
  vm.createContext(box);
  vm.runInContext(m[1] + '\nglobalThis._api = { appPolicyFilter };', box);
  return box;
}
// Le VRAI cleanTitle de cosmos.html : la categorie du direct passe par lui.
function loadCosCleanTitle(){
  const fn = topLevelFn(COS_SRC, 'function cleanTitle(t){');
  if (!fn) return null;
  const box = { console };
  vm.createContext(box);
  vm.runInContext(fn + '\nglobalThis._ct = cleanTitle;', box);
  return box._ct;
}

// ── 1. normalizeContentPolicy extrait de auth.js ──────────────────────────
console.log('\n== auth.js : normalisation ==');
{
  const src = fs.readFileSync(path.join(ROOT, 'auth.js'), 'utf8');
  const m = src.match(/\/\/ <content-policy-normalize>([\s\S]*?)\/\/ <\/content-policy-normalize>/);
  if (!m) {
    bad('bloc // <content-policy-normalize> absent de auth.js');
  } else {
    const box = { console };
    vm.createContext(box);
    vm.runInContext(m[1] + '\nglobalThis._api = { normalizeContentPolicy, contentFilter, KID_CAT_RE };', box);
    const f = box._api.normalizeContentPolicy;
    const cas = [
      ['kids', 'kids', 'la valeur kids est conservee'],
      ['all', 'all', 'la valeur all est conservee'],
      [undefined, 'all', 'undefined retombe sur all'],
      [null, 'all', 'null retombe sur all'],
      ['', 'all', 'chaine vide retombe sur all'],
      ['KIDS', 'kids', 'la casse est ignoree'],
      ['teen', 'all', 'une valeur inconnue retombe sur all'],
      [42, 'all', 'un type inattendu retombe sur all'],
    ];
    cas.forEach(c => {
      const got = f(c[0]);
      got === c[1] ? ok(c[2]) : bad(c[2] + ' (obtenu: ' + JSON.stringify(got) + ')');
    });

    // contentFilter : la meme fonction sert les deux interfaces, qui ne
    // nomment pas la categorie pareil.
    const cf = box._api.contentFilter;
    const cosItems = [
      { title: 'Asterix', category: 'FAMILLE & ENFANTS' },
      { title: 'Soul',    category: 'DISNEY+' },
      { title: 'Kubo',    category: 'ANIME & MANGA' },
      { title: 'Heat',    category: 'CRIME & MAFIA' },
      { title: 'Rien',    category: '' },
    ];
    const appItems = [
      { title: 'Asterix', category_name: 'FR - FAMILLE & ENFANTS' },
      { title: 'Heat',    category_name: 'FR - CRIME & MAFIA' },
    ];

    cf(cosItems, 'category', 'all').length === 5
      ? ok('politique all : catalogue inchange')
      : bad('politique all : le catalogue a ete modifie');
    cf(cosItems, 'category', undefined).length === 5
      ? ok('politique absente : catalogue inchange')
      : bad('politique absente : le catalogue a ete modifie');
    cf(null, 'category', 'kids').length === 0
      ? ok('liste absente : renvoie une liste vide sans lever')
      : bad('liste absente : comportement inattendu');

    const cosKids = cf(cosItems, 'category', 'kids').map(i => i.title).sort().join(',');
    cosKids === 'Asterix,Kubo,Soul'
      ? ok('champ category : ne garde que les rayons jeunesse')
      : bad('champ category : obtenu ' + cosKids);

    const appKids = cf(appItems, 'category_name', 'kids').map(i => i.title).join(',');
    appKids === 'Asterix'
      ? ok('champ category_name : ne garde que les rayons jeunesse')
      : bad('champ category_name : obtenu ' + appKids);

    cf(cosItems, 'category', 'kids').every(i => i.category !== '')
      ? ok('un item sans categorie est ecarte en politique kids')
      : bad('un item sans categorie a ete garde');
  }
}

// -- 1bis. Aucune copie du motif ailleurs ---------------------------------
console.log('\n== definition unique ==');
['cosmos.html', 'app.js'].forEach(f => {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  /const\s+KID_CAT_RE/.test(src)
    ? bad(f + ' redefinit KID_CAT_RE - la definition doit rester unique, dans auth.js')
    : ok(f + ' ne redefinit pas le motif');
});

// ── 2. policyFilter extrait de cosmos.html ────────────────────────────────
console.log('\n== cosmos.html : filtrage du catalogue ==');
{
  const src = fs.readFileSync(path.join(ROOT, 'cosmos.html'), 'utf8');
  const m = src.match(/\/\/ <content-policy>([\s\S]*?)\/\/ <\/content-policy>/);
  if (!m) {
    bad('bloc // <content-policy> absent de cosmos.html');
  } else {
    // Le bloc appelle window.PIPSILY_AUTH : on lui fournit le vrai filtre
    // extrait d'auth.js, pour tester les deux ensemble comme en production.
    const authSrc = fs.readFileSync(path.join(ROOT, 'auth.js'), 'utf8');
    const am = authSrc.match(/\/\/ <content-policy-normalize>([\s\S]*?)\/\/ <\/content-policy-normalize>/);
    const abox = { console };
    vm.createContext(abox);
    vm.runInContext(am[1] + '\nglobalThis._cf = contentFilter;', abox);

    const box = { console, window: { PIPSILY_AUTH: { contentFilter: abox._cf } } };
    vm.createContext(box);
    vm.runInContext(m[1] + '\nglobalThis._api = { policyFilter };', box);
    const { policyFilter } = box._api;

    const items = [
      { title: 'Asterix', category: 'FAMILLE & ENFANTS' },
      { title: 'Soul', category: 'DISNEY+' },
      { title: 'Kubo', category: 'ANIME & MANGA' },
      { title: 'Heat', category: 'CRIME & MAFIA' },
      { title: 'Saw', category: 'HORREUR & THRILLER' },
      { title: 'Sans categorie', category: '' },
    ];

    // Politique 'all' : rien n'est retire.
    box.window._cosUser = { sub: { content_policy: 'all' } };
    policyFilter(items).length === items.length
      ? ok('politique all : catalogue inchange')
      : bad('politique all : le catalogue a ete modifie');

    // Politique absente : se comporte comme 'all'.
    box.window._cosUser = undefined;
    policyFilter(items).length === items.length
      ? ok('compte sans politique : catalogue inchange')
      : bad('compte sans politique : le catalogue a ete modifie');

    // Politique 'kids' : seuls les rayons jeunesse survivent.
    box.window._cosUser = { sub: { content_policy: 'kids' } };
    const kids = policyFilter(items);
    const titres = kids.map(i => i.title).sort().join(',');
    titres === 'Asterix,Kubo,Soul'
      ? ok('politique kids : ne garde que les rayons jeunesse')
      : bad('politique kids : obtenu ' + titres);
    kids.every(i => i.category !== '')
      ? ok('politique kids : un item sans categorie est ecarte')
      : bad('politique kids : un item sans categorie a ete garde');
  }
}

// ── 3. Le vrai catalogue reste utilisable en politique kids ───────────────
console.log('\n== catalogue reel ==');
{
  const src = fs.readFileSync(path.join(ROOT, 'cosmos.html'), 'utf8');
  const m = src.match(/\/\/ <content-policy>([\s\S]*?)\/\/ <\/content-policy>/);
  if (m) {
    // Comme en production, window.PIPSILY_AUTH.contentFilter doit etre le
    // vrai filtre d'auth.js : sans lui, policyFilter applique son repli
    // "aucune restriction" et ce test contre le catalogue reel ne verifierait
    // rien (voir section 2 ci-dessus pour la meme extraction).
    const authSrc = fs.readFileSync(path.join(ROOT, 'auth.js'), 'utf8');
    const am = authSrc.match(/\/\/ <content-policy-normalize>([\s\S]*?)\/\/ <\/content-policy-normalize>/);
    const abox = { console };
    vm.createContext(abox);
    vm.runInContext(am[1] + '\nglobalThis._cf = contentFilter;', abox);

    const box = {
      console,
      window: {
        PIPSILY_AUTH: { contentFilter: abox._cf },
        _cosUser: { sub: { content_policy: 'kids' } },
      },
    };
    vm.createContext(box);
    vm.runInContext(m[1] + '\nglobalThis._api = { policyFilter };', box);
    const { policyFilter } = box._api;
    const cleanTitle = t => String(t || '')
      .replace(/^(FR|SRS|EN|VOD|SERIE)\s*[-|:]\s*/i, '').replace(/\s+/g, ' ').trim();

    [['films', 'vod.json'], ['series', 'series.json']].forEach(pair => {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, pair[1]), 'utf8'));
      const items = (j.items || []).map(r => ({
        title: r.title || r.name || '', category: cleanTitle(r.category_name || ''),
      }));
      const kept = policyFilter(items);
      kept.length > 0
        ? ok(pair[0] + ' : ' + kept.length + ' titres jeunesse sur ' + items.length)
        : bad(pair[0] + ' : catalogue jeunesse VIDE, le motif est trop strict');
      const hors = kept.filter(i => !/enfant|famille|kids|jeunesse|junior|dessin|cartoon|anim[ée]|manga|disney/i.test(i.category));
      hors.length === 0
        ? ok(pair[0] + ' : aucun rayon hors jeunesse retenu')
        : bad(pair[0] + ' : rayons hors jeunesse retenus : ' + hors.slice(0, 3).map(i => i.category).join(', '));
    });
  }
}

// ── 4. appPolicyFilter extrait de app.js ──────────────────────────────────
console.log('\n== app.js : filtrage du catalogue ==');
{
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const m = src.match(/\/\/ <content-policy>([\s\S]*?)\/\/ <\/content-policy>/);
  if (!m) {
    bad('bloc // <content-policy> absent de app.js');
  } else {
    // Comme pour cosmos.html (section 2 ci-dessus) : on fournit le VRAI
    // contentFilter extrait d'auth.js. Le brief initial de cette tache avait
    // une regex sans l'espace attendu par les marqueurs reels d'auth.js
    // (// <content-policy-normalize>, avec espace) : window.PIPSILY_AUTH y
    // restait donc absent du bac a sable, et avec le repli "aucune
    // restriction" de appPolicyFilter, le test aurait verifie 0 chose meme
    // si le filtrage etait casse. On extrait ici exactement comme section 2.
    const authSrc = fs.readFileSync(path.join(ROOT, 'auth.js'), 'utf8');
    const am = authSrc.match(/\/\/ <content-policy-normalize>([\s\S]*?)\/\/ <\/content-policy-normalize>/);
    const abox = { console };
    vm.createContext(abox);
    vm.runInContext(am[1] + '\nglobalThis._cf = contentFilter;', abox);

    const box = { console, S: {}, window: { PIPSILY_AUTH: { contentFilter: abox._cf } } };
    vm.createContext(box);
    vm.runInContext(m[1] + '\nglobalThis._api = { appPolicyFilter };', box);
    const { appPolicyFilter } = box._api;

    const items = [
      { title: 'Asterix', category_name: 'FR - FAMILLE & ENFANTS' },
      { title: 'Soul', category_name: 'FR - DISNEY+' },
      { title: 'Heat', category_name: 'FR - CRIME & MAFIA' },
    ];

    box.S._contentPolicy = 'all';
    appPolicyFilter(items).length === 3
      ? ok('politique all : catalogue inchange')
      : bad('politique all : le catalogue a ete modifie');

    box.S._contentPolicy = undefined;
    appPolicyFilter(items).length === 3
      ? ok('politique absente : catalogue inchange')
      : bad('politique absente : le catalogue a ete modifie');

    box.S._contentPolicy = 'kids';
    const kids = appPolicyFilter(items).map(i => i.title).sort().join(',');
    kids === 'Asterix,Soul'
      ? ok('politique kids : ne garde que les rayons jeunesse')
      : bad('politique kids : obtenu ' + kids);

    // La derive entre interfaces n'est plus possible : le motif n'existe qu'une
    // fois, dans auth.js. La garde de la section 1bis verifie qu'aucun des deux
    // fichiers ne le redefinit.
  }
}

// ── 5. Les sites d'appel existent VRAIMENT dans le code livre ─────────────
// Sans cette section, on peut supprimer TOUS les appels de filtrage du code
// livre sans qu'une seule assertion ne tombe : les sections 1 a 4 exercent les
// fonctions en isolation, jamais leur utilisation. C'est la seule section qui
// protege la fonctionnalite elle-meme.
console.log('\n== sites d\'appel dans le code livre ==');
{
  const bc = topLevelFn(COS_SRC, 'function buildContent(allVod,allSeries,liveRaw){');
  if (!bc) {
    bad('cosmos.html : fonction buildContent introuvable');
  } else {
    [['allVod', 'films'], ['allSeries', 'series'], ['liveRaw', 'direct']].forEach(p => {
      hasCall(bc, 'policyFilter(' + p[0] + ')')
        ? ok('cosmos.html buildContent : ' + p[1] + ' filtres')
        : bad('cosmos.html buildContent : policyFilter(' + p[0] + ') ABSENT');
    });
  }

  const rf = topLevelFn(COS_SRC, 'async function refreshContentSilently(){');
  if (!rf) {
    bad('cosmos.html : fonction refreshContentSilently introuvable');
  } else {
    [['d.allVod', 'films'], ['d.allSeries', 'series'], ['d.liveRaw', 'direct']].forEach(p => {
      hasCall(rf, 'policyFilter(' + p[0] + ')')
        ? ok('cosmos.html rafraichissement silencieux : ' + p[1] + ' filtres')
        : bad('cosmos.html rafraichissement silencieux : policyFilter(' + p[0] + ') ABSENT');
    });
  }

  const ri = topLevelFn(COS_SRC, 'function resolveItem(entry){');
  if (!ri) {
    bad('cosmos.html : fonction resolveItem introuvable');
  } else if (countCall(ri, 'policyFilter(') >= 1) {
    ok('cosmos.html resolveItem : les favoris repassent par la politique');
  } else {
    bad('cosmos.html resolveItem : aucun policyFilter - les favoris echappent au filtre');
  }

  // app.js : les CINQ points de peuplement du catalogue.
  [['S.vod=appPolicyFilter(',    2, 'films (JSON + repli M3U)'],
   ['S.series=appPolicyFilter(', 2, 'series (JSON + repli M3U)'],
   ['S.live=appPolicyFilter(',   1, 'direct']].forEach(p => {
    const n = countCall(APP_SRC, p[0]);
    n === p[1]
      ? ok('app.js : ' + p[2] + ' filtres (' + n + ' site(s))')
      : bad('app.js : ' + p[2] + ' - ' + n + ' appel(s) au lieu de ' + p[1]);
  });

  const pr = topLevelFn(APP_SRC, 'function _renderPoursuivreRowInner(){');
  if (!pr) {
    bad('app.js : fonction _renderPoursuivreRowInner introuvable');
  } else if (countCall(pr, 'appPolicyFilter(') >= 1) {
    ok('app.js Poursuivre : les favoris repassent par la politique');
  } else {
    bad('app.js Poursuivre : aucun appPolicyFilter - les favoris echappent au filtre');
  }
}

// ── 6. Les favoris ne contournent pas la politique (cosmos.html) ──────────
// Les favoris vivent en localStorage, PAR APPAREIL, sous forme {key,item,at}
// ou `item` est le blob complet avec son url. Ils ne repassent donc jamais par
// le catalogue filtre : sans garde, les favoris d'avant la restriction — et
// ceux d'un adulte sur la meme TV — restent visibles ET lisibles.
console.log('\n== cosmos.html : favoris et politique ==');
{
  const favSrc = topLevelFn(COS_SRC, 'function favId(entry){'); // englobe resolveItem
  if (!favSrc || favSrc.indexOf('function resolveItem') < 0) {
    bad('cosmos.html : favId/resolveItem introuvables');
  } else {
    const box = loadCosPolicy(favSrc, {
      S: { allVod: [], allSeries: [], liveItems: [] },
    });
    vm.runInContext('globalThis._resolve = resolveItem;', box);
    const resolveItem = box._resolve;

    const adulte = { title: 'Heat',    category: 'CRIME & MAFIA',     stream_id: '99', image: 'x' };
    const enfant = { title: 'Asterix', category: 'FAMILLE & ENFANTS', stream_id: '42', image: 'y' };
    const favAdulte = { key: 'vod||99||Heat',    item: adulte,  at: 1 };
    const favEnfant = { key: 'vod||42||Asterix', item: enfant, at: 1 };

    // Catalogue vide : resolveItem retombe sur entry.item, le cas du favori
    // ecarte par la politique.
    box.window._cosUser = { sub: { content_policy: 'all' } };
    resolveItem(favAdulte) === adulte
      ? ok('politique all : le favori reste resolu tel quel')
      : bad('politique all : le favori a ete altere ou perdu');

    box.window._cosUser = undefined;
    resolveItem(favAdulte) === adulte
      ? ok('politique absente : le favori reste resolu tel quel')
      : bad('politique absente : le favori a ete altere ou perdu');

    box.window._cosUser = { sub: { content_policy: 'kids' } };
    !resolveItem(favAdulte)
      ? ok('politique kids : un favori hors politique n\'est plus resolu')
      : bad('politique kids : un favori hors politique reste visible ET lisible');
    resolveItem(favEnfant) === enfant
      ? ok('politique kids : un favori jeunesse reste resolu')
      : bad('politique kids : un favori jeunesse a ete perdu');

    // Meme verrou quand l'item EST dans le catalogue (chemin de re-resolution).
    box.S.allVod = [adulte, enfant];
    !resolveItem(favAdulte)
      ? ok('politique kids : re-resolution par le catalogue filtree elle aussi')
      : bad('politique kids : la re-resolution par le catalogue contourne le filtre');
    resolveItem(favEnfant) === enfant
      ? ok('politique kids : re-resolution d\'un favori jeunesse conservee')
      : bad('politique kids : re-resolution d\'un favori jeunesse perdue');

    // Les appelants doivent survivre a l'absence : ils enchainent tous un
    // .filter(i=>i&&...) ou .filter(Boolean) sur le resultat.
    let planta = false;
    let restant = [];
    try {
      restant = [favAdulte, favEnfant].map(resolveItem).filter(i => i && i.title);
    } catch (e) { planta = true; }
    (!planta && restant.length === 1 && restant[0].title === 'Asterix')
      ? ok('les appelants filtrent l\'absence sans lever')
      : bad('les appelants ne gerent pas l\'absence (' + (planta ? 'exception' : restant.length + ' item(s)') + ')');
  }
}

// ── 7. Le direct, et la non-regression sur les vrais fichiers ─────────────
// live.json n'etait teste nulle part alors que la categorie y est construite
// differemment dans chaque interface : cleanTitle(category_name) cote Cosmos,
// category_name brut cote app.js, sur des libelles du genre « EU | FR | ENFANTS ».
console.log('\n== live.json : les deux formes de champ ==');
{
  const api = loadAuthApi();
  const cleanTitle = loadCosCleanTitle();
  if (!api || !cleanTitle) {
    bad('extraction de contentFilter / cleanTitle impossible');
  } else {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'live.json'), 'utf8'));
    const rows = raw.items || raw;
    // Forme Cosmos : category = cleanTitle(category_name)  (cf. fetchContentData)
    const cosLive = rows.map(r => ({
      title: cleanTitle(r.title || r.name || ''),
      category: cleanTitle(r.category_name || r.category || 'Live TV'),
    }));
    // Forme app.js : category_name brut  (cf. normalisation du bloc liveJson)
    const appLive = rows.map(r => ({
      title: r.title || r.name || 'Sans titre',
      category_name: r.category_name || 'Autre',
    }));

    const KID = /enfant|famille|kids|jeunesse|junior|dessin|cartoon|anim[ée]|manga|disney/i;
    const keptCos = api.contentFilter(cosLive, 'category', 'kids');
    const keptApp = api.contentFilter(appLive, 'category_name', 'kids');

    keptCos.length > 0
      ? ok('direct/Cosmos : ' + keptCos.length + ' chaines jeunesse sur ' + cosLive.length)
      : bad('direct/Cosmos : AUCUNE chaine jeunesse, le motif ne reconnait pas les libelles du direct');
    keptApp.length > 0
      ? ok('direct/app.js : ' + keptApp.length + ' chaines jeunesse sur ' + appLive.length)
      : bad('direct/app.js : AUCUNE chaine jeunesse, le motif ne reconnait pas les libelles du direct');
    keptCos.length === keptApp.length
      ? ok('direct : les deux interfaces gardent le meme nombre de chaines')
      : bad('direct : divergence entre interfaces (' + keptCos.length + ' vs ' + keptApp.length + ')');

    const horsCos = keptCos.filter(i => !KID.test(i.category));
    horsCos.length === 0
      ? ok('direct/Cosmos : aucun rayon hors jeunesse retenu')
      : bad('direct/Cosmos : rayons hors jeunesse : ' + horsCos.slice(0, 3).map(i => i.category).join(', '));
    const horsApp = keptApp.filter(i => !KID.test(i.category_name));
    horsApp.length === 0
      ? ok('direct/app.js : aucun rayon hors jeunesse retenu')
      : bad('direct/app.js : rayons hors jeunesse : ' + horsApp.slice(0, 3).map(i => i.category_name).join(', '));

    // Libelles reels du fichier : « EU | FR | ENFANTS » garde, « EU | FR | NEWS » ecarte.
    const catsCos = new Set(keptCos.map(i => i.category));
    const toutesCats = new Set(cosLive.map(i => i.category));
    const kidCats = [...toutesCats].filter(c => KID.test(c));
    kidCats.length > 0 && kidCats.every(c => catsCos.has(c))
      ? ok('direct : toutes les categories jeunesse du fichier survivent (' + kidCats.join(' / ') + ')')
      : bad('direct : categorie jeunesse perdue parmi ' + kidCats.join(' / '));
    [...toutesCats].filter(c => !KID.test(c)).every(c => !catsCos.has(c))
      ? ok('direct : aucune categorie non jeunesse ne survit')
      : bad('direct : une categorie non jeunesse a survecu');
  }
}

console.log('\n== non-regression : politique all ne touche a rien ==');
{
  // La spec exige qu'en politique 'all' les trois catalogues soient STRICTEMENT
  // identiques a ce qu'ils sont sans restriction. On le verifie sur les VRAIS
  // fichiers, via les VRAIS points d'entree des deux interfaces, pas sur
  // quelques items synthetiques.
  const cleanTitle = loadCosCleanTitle();
  const cosBox = loadCosPolicy('globalThis._pf = policyFilter;');
  const appBox = loadAppPolicy();
  if (!cleanTitle || !cosBox || !appBox) {
    bad('extraction des filtres impossible');
  } else {
    const policyFilter    = cosBox._pf;
    const appPolicyFilter = appBox._api.appPolicyFilter;
    const identique = (out, src) =>
      Array.isArray(out) && out.length === src.length && out.every((v, i) => v === src[i]);

    const fichiers = [
      ['films',  'vod.json'],
      ['series', 'series.json'],
      ['direct', 'live.json'],
    ];
    fichiers.forEach(pair => {
      const raw  = JSON.parse(fs.readFileSync(path.join(ROOT, pair[1]), 'utf8'));
      const rows = raw.items || raw;
      const cosItems = rows.map(r => ({
        title: r.title || r.name || '',
        category: cleanTitle(r.category_name || r.category || ''),
      }));
      const appItems = rows.map(r => ({
        title: r.title || r.name || '',
        category_name: r.category_name || 'Autre',
      }));

      cosBox.window._cosUser = { sub: { content_policy: 'all' } };
      const cosAll = policyFilter(cosItems);
      cosBox.window._cosUser = undefined;
      const cosAbsente = policyFilter(cosItems);
      appBox.S._contentPolicy = 'all';
      const appAll = appPolicyFilter(appItems);
      appBox.S._contentPolicy = undefined;
      const appAbsente = appPolicyFilter(appItems);

      identique(cosAll, cosItems) && identique(cosAbsente, cosItems)
        ? ok(pair[0] + '/Cosmos : ' + cosItems.length + ' items rendus a l\'identique')
        : bad(pair[0] + '/Cosmos : le catalogue a ete modifie en politique all');
      identique(appAll, appItems) && identique(appAbsente, appItems)
        ? ok(pair[0] + '/app.js : ' + appItems.length + ' items rendus a l\'identique')
        : bad(pair[0] + '/app.js : le catalogue a ete modifie en politique all');
    });
  }
}

// ── 8. Rafraichissement silencieux : comparer du filtre avec du filtre ────
// `d.allVod` est brut, `S.allVod` est filtre : sur un compte kids, comparer
// leurs longueurs rend `changed` vrai en PERMANENCE, et l'accueil se
// reconstruit a chaque rafraichissement en retirant un hero au hasard.
(async () => {
  console.log('\n== cosmos.html : rafraichissement silencieux ==');
  const rf = topLevelFn(COS_SRC, 'async function refreshContentSilently(){');
  if (!rf) {
    bad('cosmos.html : fonction refreshContentSilently introuvable');
  } else {
    const RAW = {
      allVod: [
        { title: 'Asterix', category: 'FAMILLE & ENFANTS', image: 'a' },
        { title: 'Kirikou', category: 'JEUNESSE',          image: 'b' },
        { title: 'Heat',    category: 'CRIME & MAFIA',     image: 'c' },
        { title: 'Saw',     category: 'HORREUR',           image: 'd' },
      ],
      allSeries: [
        { title: 'Pokemon', category: 'ANIME & MANGA',  image: 'e' },
        { title: 'Dexter',  category: 'CRIME & MAFIA',  image: 'f' },
      ],
      liveRaw: [],
    };
    // Dependances de refreshContentSilently, reduites au strict necessaire.
    const prelude = [
      'let _refreshing=false;',
      'function saveCache(){}',
      'function groupLiveItems(l){return l;}',
      'function _cosRegionFilter(l){return l;}',
      'function isClean(){return true;}',
      'function shuffle(a){return a.slice();}',
      'async function fetchContentData(){return CNT.raw;}',
      'function buildContent(a,b,c){CNT.built++;S.allVod=policyFilter(a);' +
        'S.allSeries=policyFilter(b);S.allItems=S.allVod.concat(S.allSeries);}',
      'globalThis._refresh = function(){ return refreshContentSilently(); };',
    ].join('\n');

    const neuf = () => loadCosPolicy(prelude + '\n' + rf, {
      S: { sec: 'home', zone: 'hero', allVod: [], allSeries: [], allItems: [], liveItems: [], heroPool: [] },
      CNT: { built: 0, raw: RAW },
    });

    // Compte restreint, catalogue distant inchange : aucun re-rendu attendu.
    const bk = neuf();
    bk.window._cosUser = { sub: { content_policy: 'kids' } };
    vm.runInContext('buildContent(CNT.raw.allVod, CNT.raw.allSeries, CNT.raw.liveRaw);', bk);
    bk.CNT.built = 0;
    await bk._refresh();
    bk.CNT.built === 0
      ? ok('politique kids : catalogue inchange => pas de reconstruction de l\'accueil')
      : bad('politique kids : l\'accueil se reconstruit sans raison (brut compare a filtre)');

    // Controle positif : un vrai ajout DOIT declencher la reconstruction.
    bk.CNT.raw = {
      allVod: RAW.allVod.concat([{ title: 'Totoro', category: 'ANIME & MANGA', image: 'g' }]),
      allSeries: RAW.allSeries,
      liveRaw: [],
    };
    await bk._refresh();
    bk.CNT.built === 1
      ? ok('politique kids : un vrai ajout declenche bien la reconstruction')
      : bad('politique kids : un vrai ajout ne declenche pas la reconstruction (' + bk.CNT.built + ')');

    // Compte non restreint : comportement d'origine inchange.
    const ba = neuf();
    ba.window._cosUser = { sub: { content_policy: 'all' } };
    vm.runInContext('buildContent(CNT.raw.allVod, CNT.raw.allSeries, CNT.raw.liveRaw);', ba);
    ba.CNT.built = 0;
    await ba._refresh();
    ba.CNT.built === 0
      ? ok('politique all : catalogue inchange => pas de reconstruction')
      : bad('politique all : reconstruction inattendue');
    ba.CNT.raw = {
      allVod: RAW.allVod.concat([{ title: 'Heat 2', category: 'CRIME & MAFIA', image: 'h' }]),
      allSeries: RAW.allSeries,
      liveRaw: [],
    };
    await ba._refresh();
    ba.CNT.built === 1
      ? ok('politique all : un vrai ajout declenche bien la reconstruction')
      : bad('politique all : un vrai ajout ne declenche pas la reconstruction (' + ba.CNT.built + ')');
  }

  console.log('\n' + (fails ? 'ECHEC : ' + fails + ' assertion(s)' : 'OK : toutes les assertions passent'));
  process.exit(fails ? 1 : 0);
})();
