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

console.log('\n' + (fails ? 'ECHEC : ' + fails + ' assertion(s)' : 'OK : toutes les assertions passent'));
process.exit(fails ? 1 : 0);
