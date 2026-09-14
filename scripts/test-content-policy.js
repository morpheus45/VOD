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

console.log('\n' + (fails ? 'ECHEC : ' + fails + ' assertion(s)' : 'OK : toutes les assertions passent'));
process.exit(fails ? 1 : 0);
