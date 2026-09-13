# Restriction de contenu par compte — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Limiter un compte donné au contenu jeunesse, sur les deux interfaces, la restriction étant posée par l'administrateur seul et attachée au compte.

**Architecture :** Une colonne `content_policy` sur la table Supabase `profiles` traverse `auth.js` jusqu'aux deux interfaces. Chacune filtre son catalogue **au chargement**, là où ses tableaux sont peuplés en un seul endroit, si bien que toute vue en aval est couverte sans être modifiée. Le panneau admin écrit la colonne.

**Tech Stack :** JavaScript navigateur sans transpilation, Supabase (PostgreSQL + RLS), Node pour les tests.

## Global Constraints

- Cible WebView ancienne : pas d'optional chaining (`?.`) ni de `\p{L}` dans le code livré à `cosmos.html`. Utiliser `function(){}` et des tests explicites de nullité.
- Valeur par défaut en cas d'absence, d'erreur réseau ou de valeur inconnue : `'all'`. Une restriction ne doit jamais s'appliquer par accident à un compte adulte.
- Le motif jeunesse s'applique à la CATÉGORIE, jamais au titre.
- Le filtrage adulte existant (`ADULT_RE` dans Cosmos, `_isAdultCat` dans `app.js`) reste en place et inchangé.
- Motif jeunesse, identique dans les deux fichiers, mot pour mot :
  `/enfant|famille|kids|jeunesse|junior|dessin|cartoon|anim[ée]|manga|disney/i`
- Aucun nouvel APK : tous les fichiers touchés sont servis par GitHub Pages.
- Messages de commit en français, terminés par `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1 : Colonne Supabase et règles d'accès

**Files:**
- Create: `docs/sql/2026-09-13-content-policy.sql`

**Interfaces:**
- Consumes: rien.
- Produces: la colonne `profiles.content_policy text not null default 'all'`, lisible par le propriétaire du compte, modifiable par les seuls administrateurs.

Cette tâche comporte une action manuelle : le fichier SQL doit être exécuté par le propriétaire dans l'éditeur SQL de son projet Supabase. L'agent ne dispose pas des accès.

- [ ] **Step 1 : Écrire le script de migration**

Créer `docs/sql/2026-09-13-content-policy.sql` :

```sql
-- Restriction de contenu par compte.
-- Voir docs/superpowers/specs/2026-09-13-restriction-contenu-par-compte-design.md
-- À exécuter une fois dans l'éditeur SQL du projet Supabase.

-- 1. La colonne. 'all' = aucune restriction, 'kids' = jeunesse uniquement.
alter table public.profiles
  add column if not exists content_policy text not null default 'all';

-- 2. Valeurs autorisées, pour qu'une faute de frappe ne passe pas en base.
alter table public.profiles
  drop constraint if exists profiles_content_policy_check;
alter table public.profiles
  add constraint profiles_content_policy_check
  check (content_policy in ('all', 'kids'));

-- 3. Le compte ne doit JAMAIS pouvoir modifier sa propre restriction, sinon
--    elle se lève par un appel direct à l'API. On remplace la politique de
--    mise à jour par une version qui gèle la colonne pour le propriétaire.
drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update"
  on public.profiles for update
  using  (auth.uid() = id)
  with check (
    auth.uid() = id
    and content_policy = (select p.content_policy from public.profiles p where p.id = auth.uid())
  );
```

- [ ] **Step 2 : Faire exécuter le script**

Demander au propriétaire d'ouvrir son projet Supabase, onglet SQL Editor, d'y coller le contenu du fichier et de l'exécuter. Attendre sa confirmation avant de poursuivre.

- [ ] **Step 3 : Vérifier la colonne**

Faire exécuter cette requête de contrôle et demander le résultat :

```sql
select email, plan, content_policy
from public.profiles
order by created_at desc
limit 10;
```

Attendu : la colonne `content_policy` existe et vaut `all` partout.

- [ ] **Step 4 : Vérifier que le compte ne peut pas s'auto-modifier**

Faire exécuter, en étant connecté comme un utilisateur NON administrateur :

```sql
update public.profiles set content_policy = 'all' where id = auth.uid();
```

Attendu : la requête est refusée ou n'affecte aucune ligne dès lors que la valeur diffère de l'actuelle. Si elle passe, la politique RLS de l'étape 1 n'a pas été appliquée : reprendre l'étape 2.

- [ ] **Step 5 : Commit**

```bash
git add docs/sql/2026-09-13-content-policy.sql
git commit -m "feat(db): colonne content_policy sur profiles, non modifiable par le compte

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2 : Exposer la politique depuis auth.js

**Files:**
- Modify: `auth.js` — fonction `checkSubscription`, autour des lignes 109 à 124
- Test: `scripts/test-content-policy.js` (créé ici)

**Interfaces:**
- Consumes: la colonne de la Task 1.
- Produces: `normalizeContentPolicy(value)` exporté sur `window.PIPSILY_AUTH`, et la garantie que l'objet rendu par `checkSubscription()` porte toujours un champ `content_policy` valant `'all'` ou `'kids'`.

`checkSubscription` diffuse déjà le profil entier (`...prof`), donc la colonne arrive d'elle-même dans le cas nominal. Mais trois chemins de repli rendent des objets sans profil : mode dev, profil introuvable, exception. Sans normalisation, `sub.content_policy` y vaut `undefined` et le code appelant doit s'en méfier partout. On normalise donc à la source.

- [ ] **Step 1 : Écrire le test qui échoue**

Créer `scripts/test-content-policy.js` :

```js
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
    vm.runInContext(m[1] + '\nglobalThis._f = normalizeContentPolicy;', box);
    const f = box._f;
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
  }
}

console.log('\n' + (fails ? 'ECHEC : ' + fails + ' assertion(s)' : 'OK : toutes les assertions passent'));
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2 : Lancer le test pour le voir échouer**

Run: `node scripts/test-content-policy.js`
Expected: FAIL, `bloc // <content-policy-normalize> absent de auth.js`

- [ ] **Step 3 : Implémenter dans auth.js**

Insérer ce bloc dans `auth.js`, juste au-dessus de `async function checkSubscription(userId){` :

```js
// <content-policy-normalize>
// Restriction de contenu par compte. Toute valeur absente, inconnue ou d'un
// type inattendu retombe sur 'all' : une restriction ne doit jamais
// s'appliquer par accident a un compte adulte a cause d'une erreur reseau.
function normalizeContentPolicy(value){
  return (typeof value === 'string' && value.toLowerCase() === 'kids') ? 'kids' : 'all';
}
// </content-policy-normalize>
```

Puis normaliser les quatre sorties de `checkSubscription`. Remplacer :

```js
    return { ok: false, plan: "pending" };
```

par :

```js
    return { ok: false, plan: "pending", content_policy: "all" };
```

Remplacer :

```js
  if(!prof) return { ok: false, plan: null };
```

par :

```js
  if(!prof) return { ok: false, plan: null, content_policy: "all" };
```

Remplacer :

```js
  if(prof.plan === "admin" || prof.plan === "unlimited")
    return { ok: true, unlimited: true, ...prof };
```

par :

```js
  if(prof.plan === "admin" || prof.plan === "unlimited")
    return { ok: true, unlimited: true, ...prof,
             content_policy: normalizeContentPolicy(prof.content_policy) };
```

Remplacer :

```js
  return { ok, unlimited: false, ...prof };
```

par :

```js
  return { ok, unlimited: false, ...prof,
           content_policy: normalizeContentPolicy(prof.content_policy) };
```

Enfin, exposer la fonction sur l'objet global. Trouver l'objet assigné à `window.PIPSILY_AUTH` et y ajouter l'entrée `normalizeContentPolicy,` à côté des autres fonctions exportées.

- [ ] **Step 4 : Lancer le test pour le voir passer**

Run: `node scripts/test-content-policy.js`
Expected: PASS, 8 assertions vertes.

- [ ] **Step 5 : Commit**

```bash
git add auth.js scripts/test-content-policy.js
git commit -m "feat(auth): expose content_policy, normalisee et repliee sur all

Les quatre sorties de checkSubscription portent desormais toujours le champ,
y compris les chemins de repli sans profil. Toute valeur absente ou inconnue
retombe sur all pour ne jamais restreindre un compte adulte par accident.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3 : Filtrer le catalogue dans cosmos.html

**Files:**
- Modify: `cosmos.html` — insérer le bloc avant `function isClean(` (ligne ~1120), puis modifier `buildContent` (ligne ~1493) et la branche de rafraîchissement silencieux (ligne ~1445)
- Test: `scripts/test-content-policy.js` (étendu)

**Interfaces:**
- Consumes: `window._cosUser.sub.content_policy` posé par `auth.js` (Task 2).
- Produces: `cosContentPolicy()` renvoyant `'all'` ou `'kids'`, et `policyFilter(list)` renvoyant la liste filtrée. Les items de Cosmos portent leur catégorie dans le champ `category`.

- [ ] **Step 1 : Écrire le test qui échoue**

Insérer dans `scripts/test-content-policy.js`, juste avant la ligne de bilan finale :

```js
// ── 2. policyFilter extrait de cosmos.html ────────────────────────────────
console.log('\n== cosmos.html : filtrage du catalogue ==');
{
  const src = fs.readFileSync(path.join(ROOT, 'cosmos.html'), 'utf8');
  const m = src.match(/\/\/ <content-policy>([\s\S]*?)\/\/ <\/content-policy>/);
  if (!m) {
    bad('bloc // <content-policy> absent de cosmos.html');
  } else {
    const box = { console, window: {} };
    vm.createContext(box);
    vm.runInContext(m[1] + '\nglobalThis._api = { policyFilter, KID_CAT_RE };', box);
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
    const box = { console, window: { _cosUser: { sub: { content_policy: 'kids' } } } };
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
```

- [ ] **Step 2 : Lancer le test pour le voir échouer**

Run: `node scripts/test-content-policy.js`
Expected: FAIL, `bloc // <content-policy> absent de cosmos.html`

- [ ] **Step 3 : Insérer le bloc dans cosmos.html**

Insérer juste au-dessus de la ligne `function isClean(i){return !ADULT_RE.test(...)}` :

```js
// ══════ RESTRICTION DE CONTENU PAR COMPTE ═══════════════════════════════
// <content-policy>
// Un compte peut etre limite aux rayons jeunesse. La valeur vient du profil
// Supabase et suit le compte, pas l'appareil. Voir
// docs/superpowers/specs/2026-09-13-restriction-contenu-par-compte-design.md
//
// Le filtre est applique AU CHARGEMENT du catalogue, pas a l'affichage :
// toutes les vues lisent S.allVod / S.allSeries / S.liveItems, donc etageres,
// grille, recherche, hero, favoris, reprise et direct sont couverts d'office,
// y compris les vues ajoutees plus tard.
//
// Le meme bloc existe dans app.js pour l'interface Xstream. Les deux doivent
// filtrer a l'identique ; scripts/test-content-policy.js le verifie.
const KID_CAT_RE = /enfant|famille|kids|jeunesse|junior|dessin|cartoon|anim[ée]|manga|disney/i;
function cosContentPolicy(){
  try{
    var u = window._cosUser;
    var p = u && u.sub ? u.sub.content_policy : null;
    return (typeof p === 'string' && p.toLowerCase() === 'kids') ? 'kids' : 'all';
  }catch(e){ return 'all'; }
}
function policyFilter(list){
  if(!list || cosContentPolicy() !== 'kids') return list || [];
  return list.filter(function(i){ return !!i && KID_CAT_RE.test(i.category || ''); });
}
// </content-policy>
```

- [ ] **Step 4 : Appliquer le filtre dans buildContent**

Dans `function buildContent(allVod,allSeries,liveRaw){`, remplacer la première ligne :

```js
  S.allVod=allVod;S.allSeries=allSeries;S.allItems=[...allVod,...allSeries];
  S.liveItems=_cosRegionFilter(groupLiveItems(liveRaw.filter(isClean)));
```

par :

```js
  // Restriction de compte appliquee a la SOURCE : tout ce qui lit ces tableaux
  // en aval est couvert sans modification.
  allVod=policyFilter(allVod); allSeries=policyFilter(allSeries);
  liveRaw=policyFilter(liveRaw);
  S.allVod=allVod;S.allSeries=allSeries;S.allItems=[...allVod,...allSeries];
  S.liveItems=_cosRegionFilter(groupLiveItems(liveRaw.filter(isClean)));
```

- [ ] **Step 5 : Appliquer le filtre dans la branche de rafraîchissement silencieux**

Dans la même fonction de rafraîchissement, remplacer :

```js
      S.allVod=d.allVod;S.allSeries=d.allSeries;S.allItems=[...d.allVod,...d.allSeries];
      S.liveItems=_cosRegionFilter(groupLiveItems(d.liveRaw.filter(isClean)));
```

par :

```js
      // Meme filtre que buildContent : ce chemin met a jour les donnees sans
      // repasser par le rendu, il doit donc filtrer lui aussi.
      S.allVod=policyFilter(d.allVod);S.allSeries=policyFilter(d.allSeries);
      S.allItems=[...S.allVod,...S.allSeries];
      S.liveItems=_cosRegionFilter(groupLiveItems(policyFilter(d.liveRaw).filter(isClean)));
```

- [ ] **Step 6 : Lancer le test pour le voir passer**

Run: `node scripts/test-content-policy.js`
Expected: PASS, toutes les assertions vertes, dont les comptes de titres jeunesse sur le vrai catalogue.

- [ ] **Step 7 : Vérifier la syntaxe du fichier livré**

```bash
node -e "const s=require('fs').readFileSync('cosmos.html','utf8');const b=[...s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);require('fs').writeFileSync(process.env.TEMP+'/cos.js',b.join('\n;\n'));"
node --check "$TEMP/cos.js" && echo "SYNTAXE OK"
```

Expected: `SYNTAXE OK`

- [ ] **Step 8 : Vérifier que les comptes normaux ne régressent pas**

Run: `node scripts/test-shelves.js`
Expected: PASS. Ce test tourne sans `window._cosUser`, donc en politique `all` : il prouve que le catalogue complet est intact.

- [ ] **Step 9 : Commit**

```bash
git add cosmos.html scripts/test-content-policy.js
git commit -m "feat(cosmos): filtre le catalogue a la source selon la politique du compte

Applique dans buildContent et dans le rafraichissement silencieux, donc en
amont de toutes les vues. Etageres, grille, recherche, hero, favoris, reprise
et direct sont couverts sans etre modifies.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4 : Filtrer le catalogue dans app.js

**Files:**
- Modify: `app.js` — bloc inséré au-dessus de `function filtered(){` (ligne ~2055), politique lue vers la ligne 4130, filtre appliqué lignes ~4343 à ~4375
- Test: `scripts/test-content-policy.js` (étendu)

**Interfaces:**
- Consumes: `auth.sub.content_policy` rendu par `authGate()` dans `boot()`.
- Produces: `S._contentPolicy`, `appContentPolicy()`, `appPolicyFilter(list)`. Les items de `app.js` portent leur catégorie dans le champ `category_name`, pas `category`.

- [ ] **Step 1 : Écrire le test qui échoue**

Insérer dans `scripts/test-content-policy.js`, avant la ligne de bilan finale :

```js
// ── 4. appPolicyFilter extrait de app.js ──────────────────────────────────
console.log('\n== app.js : filtrage du catalogue ==');
{
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const m = src.match(/\/\/ <content-policy>([\s\S]*?)\/\/ <\/content-policy>/);
  if (!m) {
    bad('bloc // <content-policy> absent de app.js');
  } else {
    const box = { console, S: {} };
    vm.createContext(box);
    vm.runInContext(m[1] + '\nglobalThis._api = { appPolicyFilter, KID_CAT_RE };', box);
    const { appPolicyFilter, KID_CAT_RE } = box._api;

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

    // Les deux interfaces doivent utiliser EXACTEMENT le meme motif.
    const cosSrc = fs.readFileSync(path.join(ROOT, 'cosmos.html'), 'utf8');
    const cosM = cosSrc.match(/const KID_CAT_RE = (\/.*\/i);/);
    cosM && cosM[1] === String(KID_CAT_RE)
      ? ok('le motif jeunesse est identique dans les deux interfaces')
      : bad('le motif jeunesse DIFFERE entre cosmos.html et app.js');
  }
}
```

- [ ] **Step 2 : Lancer le test pour le voir échouer**

Run: `node scripts/test-content-policy.js`
Expected: FAIL, `bloc // <content-policy> absent de app.js`

- [ ] **Step 3 : Insérer le bloc dans app.js**

Insérer juste au-dessus de `function filtered(){` :

```js
// ══════ RESTRICTION DE CONTENU PAR COMPTE ═══════════════════════════════
// <content-policy>
// Jumeau du bloc de cosmos.html. Les deux interfaces doivent filtrer a
// l'identique ; scripts/test-content-policy.js compare les deux motifs.
// Ici les items portent leur categorie dans category_name, pas category.
const KID_CAT_RE = /enfant|famille|kids|jeunesse|junior|dessin|cartoon|anim[ée]|manga|disney/i;
function appContentPolicy(){
  const p = S._contentPolicy;
  return (typeof p === 'string' && p.toLowerCase() === 'kids') ? 'kids' : 'all';
}
function appPolicyFilter(list){
  if(!list || appContentPolicy() !== 'kids') return list || [];
  return list.filter(i => !!i && KID_CAT_RE.test(i.category_name || ''));
}
// </content-policy>
```

- [ ] **Step 4 : Lire la politique après l'authentification**

Dans `boot()`, après la ligne `S._unlim   = auth.sub.unlimited;`, ajouter :

```js
    // Restriction de contenu du compte, lue avant tout chargement de catalogue.
    S._contentPolicy = (auth.sub && auth.sub.content_policy === "kids") ? "kids" : "all";
```

Ajouter aussi la même ligne dans la branche `catch` juste au-dessus, où l'objet `auth` de secours est fabriqué, en y insérant `content_policy: "all"` dans l'objet `sub`.

- [ ] **Step 5 : Appliquer le filtre au chargement du catalogue**

Remplacer :

```js
  if(vodJson){ S.vod = normalizeItems(extractArr(vodJson), "vod"); }
```

par :

```js
  if(vodJson){ S.vod = appPolicyFilter(normalizeItems(extractArr(vodJson), "vod")); }
```

Remplacer :

```js
    if(vodM3u){ S.vod = parseM3U(vodM3u, "vod"); }
```

par :

```js
    if(vodM3u){ S.vod = appPolicyFilter(parseM3U(vodM3u, "vod")); }
```

Remplacer :

```js
  if(seriesJson){ S.series = normalizeItems(extractArr(seriesJson), "series"); }
```

par :

```js
  if(seriesJson){ S.series = appPolicyFilter(normalizeItems(extractArr(seriesJson), "series")); }
```

Remplacer :

```js
    if(seriesM3u){ S.series = parseM3U(seriesM3u, "series"); }
```

par :

```js
    if(seriesM3u){ S.series = appPolicyFilter(parseM3U(seriesM3u, "series")); }
```

Pour le direct, trouver la fin de l'expression `S.live = liveItems.map((x, i) => ({ ... }));` et envelopper le résultat. La ligne d'ouverture devient :

```js
    S.live = appPolicyFilter(liveItems.map((x, i) => ({  // normalisation
```

et la parenthèse fermante correspondante, en fin d'expression, gagne une parenthèse : `})));` au lieu de `}));`.

- [ ] **Step 6 : Lancer le test pour le voir passer**

Run: `node scripts/test-content-policy.js`
Expected: PASS, dont l'assertion comparant les deux motifs.

- [ ] **Step 7 : Vérifier la syntaxe**

Run: `node --check app.js`
Expected: aucune sortie, code de retour 0. L'enveloppement du direct à l'étape 5 est le point où une parenthèse se perd facilement.

- [ ] **Step 8 : Commit**

```bash
git add app.js scripts/test-content-policy.js
git commit -m "feat(xstream): filtre le catalogue a la source selon la politique du compte

app.js filtre a une dizaine d'endroits a l'affichage ; les patcher un par un
reviendrait a en oublier un. Le filtre est donc pose la ou S.vod, S.series et
S.live sont peuples, en un seul endroit chacun.

Un test compare le motif jeunesse des deux interfaces pour empecher la derive.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5 : Masquer deux entrées de réglages sur un compte jeunesse

**Files:**
- Modify: `cosmos.html` — fonction `renderSettings`, autour de la ligne 2700

**Interfaces:**
- Consumes: `cosContentPolicy()` de la Task 3.
- Produces: rien que d'autres tâches consomment.

Les deux interfaces étant filtrées, la bascule n'est plus une échappatoire. On masque par propreté, et parce que l'entrée « Contrôle parental » n'a plus d'objet sur un compte déjà restreint.

- [ ] **Step 1 : Modifier la construction de la liste**

Dans `renderSettings`, après la construction du tableau `items`, avant l'ajout de l'entrée admin, insérer :

```js
  // Compte restreint : la bascule d'interface et le controle parental n'ont
  // plus d'objet. Masquage de confort, pas de securite : les deux interfaces
  // filtrent deja a la source.
  if(cosContentPolicy() === 'kids'){
    for(var _i=items.length-1;_i>=0;_i--){
      if(items[_i].action === 'iface' || items[_i].action === 'parental') items.splice(_i,1);
    }
  }
```

- [ ] **Step 2 : Vérifier la syntaxe**

```bash
node -e "const s=require('fs').readFileSync('cosmos.html','utf8');const b=[...s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);require('fs').writeFileSync(process.env.TEMP+'/cos.js',b.join('\n;\n'));"
node --check "$TEMP/cos.js" && echo "SYNTAXE OK"
```

Expected: `SYNTAXE OK`

- [ ] **Step 3 : Vérifier dans le navigateur**

Servir le dossier et ouvrir une copie de contrôle, puis exécuter dans la console de la page :

```js
window._cosUser = { sub: { content_policy: 'kids' } };
renderSettings();
[...document.querySelectorAll('.set-item')].map(e => e.dataset.action);
```

Expected: la liste ne contient ni `iface` ni `parental`. Chaque entrée porte son action en `data-action`, ce qui évite de dépendre du libellé affiché.

Refaire avec `window._cosUser = { sub: { content_policy: 'all' } }` puis `renderSettings()` : les deux actions doivent réapparaître.

- [ ] **Step 4 : Commit**

```bash
git add cosmos.html
git commit -m "feat(cosmos): masque bascule d'interface et controle parental sur un compte jeunesse

Masquage de confort : les deux interfaces filtrant deja a la source, la
bascule n'est plus une echappatoire. Le controle parental, lui, n'a plus
d'objet sur un compte deja restreint.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6 : Sélecteur dans le panneau d'administration

**Files:**
- Modify: `admin.html` — `renderUserCards` (ligne ~375, bloc `user-card__actions`) et ajout d'une fonction à côté de `setUnlimited` (ligne ~515)

**Interfaces:**
- Consumes: la colonne de la Task 1.
- Produces: `setContentPolicy(userId, policy)`, appelée depuis les boutons de la carte utilisateur.

- [ ] **Step 1 : Ajouter la fonction d'écriture**

Juste au-dessus de `async function setUnlimited(userId){`, insérer :

```js
    async function setContentPolicy(userId, policy){
      try {
        const { error } = await A.supabase.from("profiles")
          .update({ content_policy: policy }).eq("id", userId);
        if(error) throw error;
        showGlobalMsg(policy === "kids" ? "✓ Compte limité au contenu jeunesse"
                                        : "✓ Restriction de contenu levée");
        loadAdmin();
      } catch(err){ alert("Erreur restriction : " + (err.message||err)); }
    }
```

- [ ] **Step 2 : Ajouter les boutons sur la carte**

Dans `renderUserCards`, dans le bloc `<div class="user-card__actions">`, juste avant le bouton Supprimer, insérer :

```js
                  ${u.content_policy === "kids"
                    ? `<button class="action-btn" style="background:rgba(120,170,255,.2);color:#9cc4ff;border:1px solid rgba(120,170,255,.5);font-weight:800"
                        onclick="setContentPolicy('${u.id}','all')">👦 Jeunesse : activé — lever</button>`
                    : `<button class="action-btn" onclick="setContentPolicy('${u.id}','kids')">👦 Limiter au jeunesse</button>`}
```

- [ ] **Step 3 : Afficher l'état dans les métadonnées**

Dans le même bloc, à l'intérieur de `<div class="user-card__meta">`, après la ligne des appareils, ajouter :

```js
              ${u.content_policy === "kids" ? `<span>👦 Contenu jeunesse</span>` : ""}
```

- [ ] **Step 4 : Rien à exposer**

Vérifié à la conception : `admin.html` ne fait aucune assignation `window.setUnlimited = ...`. Ses fonctions sont déclarées au niveau global du script et `onclick` les résout directement. La nouvelle fonction suit le même schéma, aucune ligne supplémentaire n'est nécessaire.

Contrôle : `grep -c "window.setUnlimited" admin.html` doit renvoyer `0`.

- [ ] **Step 5 : Vérifier dans le navigateur**

Ouvrir `admin.html` connecté en administrateur. Attendu : chaque carte utilisateur autre que la vôtre porte un bouton « Limiter au jeunesse ». Cliquer dessus sur un compte de test, vérifier que le badge « Contenu jeunesse » apparaît et que le bouton devient « Jeunesse : activé — lever ».

- [ ] **Step 6 : Commit**

```bash
git add admin.html
git commit -m "feat(admin): bouton de restriction jeunesse par compte

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7 : Vérification de bout en bout et déploiement

**Files:**
- Modify: aucun, sauf correction éventuelle.

**Interfaces:**
- Consumes: les Tasks 1 à 6.
- Produces: la fonctionnalité en ligne.

- [ ] **Step 1 : Lancer toute la suite**

```bash
node scripts/test-content-policy.js
node scripts/test-shelves.js
```

Expected: les deux passent.

- [ ] **Step 2 : Vérifier Cosmos avec un compte restreint**

Servir le dossier, ouvrir une copie de contrôle, et dans la console de la page :

```js
window._cosUser = { sub: { content_policy: 'kids' } };
buildContent(S.allVod, S.allSeries, []);
renderTabMovies();
[...document.querySelectorAll('#content .row-title')].map(e => e.textContent.trim());
```

Expected: seuls des rayons jeunesse apparaissent, aucun rayon Horreur, Crime, Drama ni Western.

- [ ] **Step 3 : Vérifier la recherche sous restriction**

Toujours dans la console, chercher un titre pour adultes connu du catalogue :

```js
openSearchResults('saw');
S.gridItems.length;
```

Expected: `0`. La recherche lit les mêmes tableaux, donc elle ne peut rien remonter d'exclu.

- [ ] **Step 4 : Poser la restriction sur le compte réel**

Dans le panneau admin, cliquer « Limiter au jeunesse » sur `nolhan34@gmail.com`. Vérifier en base :

```sql
select email, content_policy from public.profiles where email = 'nolhan34@gmail.com';
```

Expected: `kids`.

- [ ] **Step 5 : Fusionner et déployer**

```bash
git checkout main
git merge --ff-only feat/restriction-contenu-par-compte
git push origin main
```

Aucun APK n'est requis : les quatre fichiers touchés sont servis par GitHub Pages, et les deux applications sont réglées sur `LOAD_NO_CACHE`.

- [ ] **Step 6 : Vérifier que la version en ligne contient le code**

```bash
curl -s "https://morpheus45.github.io/VOD/cosmos.html" | grep -c "content-policy"
curl -s "https://morpheus45.github.io/VOD/app.js" | grep -c "content-policy"
```

Expected: un compte non nul pour les deux.

- [ ] **Step 7 : Vérifier sur l'appareil de Nolhan**

Lui faire relancer PIPSILY sur la TV puis sur le téléphone. Attendu : catalogue jeunesse des deux côtés, et absence des entrées Interface et Contrôle parental dans les réglages Cosmos.

---

## Notes d'exécution

**Ordre imposé.** La Task 1 bloque tout le reste : sans la colonne, `checkSubscription` ne rend rien à normaliser et le panneau admin écrit dans le vide. Les Tasks 3 et 4 sont indépendantes l'une de l'autre et peuvent être menées en parallèle.

**Point de vigilance de la Task 4.** L'enveloppement de `S.live` ajoute une parenthèse fermante à une expression longue. C'est l'endroit du plan où une erreur de syntaxe est la plus probable ; l'étape 7 de cette tâche existe pour ça.

**Comportement en cas de panne.** Le repli est `'all'`, donc une erreur de lecture du profil donne une session non filtrée. C'est un choix documenté dans la spec. Pour l'inverser, il suffit de changer le repli de `normalizeContentPolicy` et des deux fonctions `contentPolicy`, en acceptant qu'une panne Supabase restreigne alors tous les comptes, y compris adultes.
