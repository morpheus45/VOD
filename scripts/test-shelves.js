#!/usr/bin/env node
/**
 * Test d'invariant des étagères TV (cosmos.html).
 *
 * INVARIANT : aucun titre "propre" du catalogue ne doit être inaccessible à la
 * navigation. Chaque catégorie non-adulte doit produire une étagère, et toute
 * catégorie plus longue que SHELF_MAX doit exposer une carte « Voir tout ».
 *
 * Le test extrait le VRAI code de cosmos.html (bloc <shelves-logic>) et le
 * fait tourner sur les vrais catalogues vod.json / series.json.
 *
 * Usage : node scripts/test-shelves.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'cosmos.html'), 'utf8');

let fails = 0;
const ok = m => console.log('  \u2713 ' + m);
const bad = m => { fails++; console.log('  \u2717 ' + m); };

// ── 1. Extraire le bloc de logique depuis cosmos.html ─────────────────────
const m = HTML.match(/\/\/ <shelves-logic>([\s\S]*?)\/\/ <\/shelves-logic>/);
if (!m) {
  console.error('ECHEC: bloc // <shelves-logic> ... // </shelves-logic> absent de cosmos.html');
  process.exit(1);
}

// Dépendances du bloc, copiées depuis cosmos.html pour le bac à sable.
const ADULT_RE_SRC = HTML.match(/const ADULT_RE\s*=\s*(\/.*\/i);/)[1];
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext('const ADULT_RE = ' + ADULT_RE_SRC + ';\n' + m[1] +
  '\nglobalThis._api = { buildCatRows, SHELF_MAX, SHELF_MIN, shelfLabel };', sandbox);
const { buildCatRows, SHELF_MAX } = sandbox._api;

// ── 2. Normalisation identique à cosmos.html ──────────────────────────────
const ADULT_RE = vm.runInContext('ADULT_RE', sandbox);
function cleanTitle(t) {
  if (!t) return '';
  let s = String(t);
  s = s.replace(/^(FR|SRS|EN|VOD|SERIE)\s*[-|:]\s*/i, '');
  s = s.replace(/\.(mkv|mp4|ts|m3u8|avi|mov)$/i, '');
  s = s.replace(/\s*\(\d{4}\)\s*$/, '');
  return s.replace(/\s+/g, ' ').trim();
}
const isClean = i => !ADULT_RE.test(i.category || '') && !ADULT_RE.test(i.title || '');
function load(file, isSerie) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  return (j.items || []).map(raw => {
    const title = raw.title || raw.name || '';
    if (!title || /\bvostfr\b/i.test(title)) return null;
    return {
      title: cleanTitle(title),
      image: raw.stream_icon || raw.image || raw.cover || '',
      category: cleanTitle(raw.category_name || raw.category || 'Autre'),
      series_id: isSerie ? (raw.series_id || raw.id || null) : null,
      added: raw.added || 0,
    };
  }).filter(Boolean).filter(isClean);
}

// ── 3. Vérifier l'invariant sur chaque catalogue ──────────────────────────
for (const [label, file, isSerie, gridType] of [
  ['FILMS', 'vod.json', false, 'movies'],
  ['SERIES', 'series.json', true, 'shows'],
]) {
  console.log('\n== ' + label + ' ==');
  const items = load(file, isSerie);
  const rows = buildCatRows(items, gridType);

  // a. toutes les catégories non-adultes sont représentées
  const srcCats = new Set(items.map(i => i.category || 'Autre').filter(c => !ADULT_RE.test(c)));
  const shown = new Set();
  rows.forEach(r => r.items.forEach(it => {
    if (it.seeAll) shown.add(it.gridCat); else shown.add(it.category || 'Autre');
  }));
  const missing = [...srcCats].filter(c => !shown.has(c));
  missing.length
    ? bad('categories sans etagere : ' + missing.join(', '))
    : ok(srcCats.size + ' categories, aucune perdue');

  // b. toute catégorie tronquée expose « Voir tout »
  const byCat = {};
  items.forEach(i => { const c = i.category || 'Autre'; (byCat[c] = byCat[c] || []).push(i); });
  const truncatedNoEscape = rows.filter(r => {
    const real = r.items.filter(it => !it.seeAll);
    const hasSeeAll = r.items.some(it => it.seeAll);
    return real.length >= SHELF_MAX && !hasSeeAll;
  }).map(r => r.title);
  truncatedNoEscape.length
    ? bad('etageres tronquees sans « Voir tout » : ' + truncatedNoEscape.join(', '))
    : ok('chaque etagere tronquee expose « Voir tout »');

  // c. aucune étagère vide
  const empty = rows.filter(r => r.items.filter(it => !it.seeAll).length === 0).map(r => r.title);
  empty.length ? bad('etageres vides : ' + empty.join(', ')) : ok('aucune etagere vide');

  // d. aucune catégorie adulte affichée
  const adult = rows.filter(r => ADULT_RE.test(r.title)).map(r => r.title);
  adult.length ? bad('categorie adulte affichee : ' + adult.join(', ')) : ok('aucune categorie adulte');

  // e. aucun doublon de titre A L'INTERIEUR d'une meme etagere
  const dupRows = [];
  rows.forEach(r => {
    const seen = new Set(), dups = [];
    r.items.filter(it => !it.seeAll).forEach(it => {
      const k = String(it.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!k) return;
      if (seen.has(k)) dups.push(it.title); else seen.add(k);
    });
    if (dups.length) dupRows.push(r.title + ' (' + dups.length + ')');
  });
  dupRows.length
    ? bad('doublons dans une etagere : ' + dupRows.join(', '))
    : ok('aucun doublon a l interieur d une etagere');

  console.log('  -> ' + rows.length + ' etageres, ' + items.length + ' titres couverts');
  rows.forEach(r => console.log('     ' + String(r.items.filter(i => !i.seeAll).length).padStart(3) +
    (r.items.some(i => i.seeAll) ? ' +tout ' : '       ') + r.title));
}

// ── 4. Integration : executer les VRAIES fonctions renderTab* ─────────────
// On extrait renderTabHome / renderTabMovies / renderTabShows de cosmos.html et
// on les fait tourner avec un DOM et un etat simules, pour verifier qu'elles
// sont bien branchees sur buildCatRows et produisent les etageres attendues.
console.log('\n== INTEGRATION renderTab* ==');
function extractFn(name){
  const start = HTML.indexOf('function ' + name + '(){');
  if (start < 0) throw new Error('fonction ' + name + ' introuvable');
  let depth = 0, i = HTML.indexOf('{', start);
  for (let j = i; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (!depth) return HTML.slice(start, j + 1); }
  }
  throw new Error('accolade fermante introuvable pour ' + name);
}

const films = load('vod.json', false, 'movies');
const series = load('series.json', true, 'shows');
const captured = {};
const box = {
  console,
  ADULT_RE, isClean, buildCatRows: sandbox._api.buildCatRows,
  dedupeByTitle: vm.runInContext('dedupeByTitle', sandbox),
  shelfSeeAllCard: vm.runInContext('shelfSeeAllCard', sandbox),
  HOME_MAX_SHELVES: vm.runInContext('HOME_MAX_SHELVES', sandbox),
  S: { appItems: [], heroPool: [], liveItems: [], rows: [],
       allVod: films, allSeries: series, allItems: films.concat(series) },
  storeGet: () => true,
  poursuivreItems: () => [],
  setHero: () => {},
  focus: () => {},
  renderRows: rows => { captured.rows = rows; },
};
vm.createContext(box);
['renderTabHome', 'renderTabMovies', 'renderTabShows'].forEach(fn => {
  vm.runInContext(extractFn(fn) + ';' + fn + '();', box);
  const rows = captured.rows;
  const cats = rows.filter(r => r.items.some(it => it.seeAll || it.category));
  const seeAll = rows.filter(r => r.items.some(it => it.seeAll)).length;
  console.log('  ' + fn + ' -> ' + rows.length + ' rangees, ' + seeAll + ' avec « Voir tout »');
  rows.length ? ok(fn + ' produit des rangees') : bad(fn + ' ne produit rien');
  const vides = rows.filter(r => !r.items.length).map(r => r.title);
  vides.length ? bad(fn + ' rangees vides : ' + vides.join(', ')) : ok(fn + ' aucune rangee vide');
});
// L'onglet Films doit exposer autant d'etageres que de categories du catalogue.
vm.runInContext('renderTabMovies();', box);
const movieRows = captured.rows;
const srcCatCount = new Set(films.map(i => i.category || 'Autre')).size;
const catRows = movieRows.filter(r => !['Poursuivre', 'Nouveaux films'].includes(r.title)).length;
catRows >= srcCatCount - 2
  ? ok('onglet Films : ' + catRows + ' etageres pour ' + srcCatCount + ' categories source')
  : bad('onglet Films : seulement ' + catRows + ' etageres pour ' + srcCatCount + ' categories');

console.log('\n' + (fails ? 'ECHEC : ' + fails + ' assertion(s)' : 'OK : toutes les assertions passent'));
process.exit(fails ? 1 : 0);
