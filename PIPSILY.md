# PIPSILY — Documentation technique complète

> Version app : **6.9** · APK : **v25** · SW cache : **pipsily-v197** · Date : 2026-05-27

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Architecture](#2-architecture)
3. [Structure des fichiers](#3-structure-des-fichiers)
4. [Sources de données](#4-sources-de-données)
5. [Authentification & abonnements](#5-authentification--abonnements)
6. [Lecteur vidéo — PipPlayer](#6-lecteur-vidéo--pipplayer)
7. [Navigation TV (D-pad)](#7-navigation-tv-d-pad)
8. [Section Poursuivre](#8-section-poursuivre)
9. [Contrôle parental (PIN adulte)](#9-contrôle-parental-pin-adulte)
10. [Mise à jour APK](#10-mise-à-jour-apk)
11. [Service Worker & cache](#11-service-worker--cache)
12. [Clés de stockage local](#12-clés-de-stockage-local)
13. [AndroidBridge — API Java↔JS](#13-androidbridge--api-javajs)
14. [Plateformes supportées](#14-plateformes-supportées)
15. [Samsung TV (Tizen)](#15-samsung-tv-tizen)
16. [Déploiement](#16-déploiement)
17. [Bugs corrigés — historique](#17-bugs-corrigés--historique)

---

## 1. Vue d'ensemble

PIPSILY est une application **IPTV PWA** (Progressive Web App) hébergée sur GitHub Pages (`morpheus45/VOD`). Elle consomme un flux Xtream Codes pour afficher Films, Séries et TV en direct.

Elle existe sous trois formes :

| Forme | Technologie | Lecteur vidéo |
|-------|-------------|---------------|
| **PWA** (navigateur) | GitHub Pages | HLS.js interne (PipPlayer) |
| **APK Android** (v25) | WebView + ExoPlayer | AndroidBridge → ExoPlayer natif |
| **App Samsung TV** (Tizen v1) | Widget .wgt | HLS.js interne |

L'URL de production est `https://morpheus45.github.io/VOD/`.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        index.html                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ styles.css│  │  app.js  │  │  auth.js │  │player.js│ │
│  └──────────┘  └────┬─────┘  └────┬─────┘  └─────────┘ │
│                     │              │                     │
│          ┌──────────┴──┐    ┌──────┴──────┐             │
│          │  PipPlayer  │    │  Supabase   │             │
│          │  (HLS.js)   │    │  Auth / DB  │             │
│          └──────┬──────┘    └─────────────┘             │
│                 │                                        │
│          ┌──────┴──────┐                                 │
│          │AndroidBridge│  ← Java WebView interface       │
│          │ (APK only)  │                                 │
│          └─────────────┘                                 │
└─────────────────────────────────────────────────────────┘
         ↓
   Service Worker (sw.js)
   Cache shell + network-first JSON/M3U
```

### État global `S`

Tout l'état de l'application est centralisé dans l'objet `S` (défini dans `app.js`) :

```js
S = {
  type      : "vod" | "series" | "live",
  vod       : [],          // catalogue VOD chargé
  series    : [],          // catalogue séries
  live      : [],          // canaux TV
  cat       : "",          // catégorie sélectionnée
  search    : "",          // texte de recherche
  quality   : "",          // filtre qualité (HD, FHD, 4K…)
  region    : "",          // filtre région TV
  sort      : "title",     // tri actif
  shown     : { vod, series, live },  // items affichés (pagination)
  panel     : { open, series, seasonsMap, seasonsMeta, selSeason },
  epCache   : {},          // épisodes en mémoire
  epDb      : {}           // base pré-générée episodes_part*.json
}
```

---

## 3. Structure des fichiers

```
VOD-push/
├── index.html              Page principale (Films / Séries / TV)
├── login.html              Connexion Supabase
├── account.html            Mon compte (abonnement, PIN parental, Wero)
├── admin.html              Panneau admin (gestion utilisateurs/plans)
├── player.html             Lecteur standalone (fallback)
├── install.html            Guide d'installation (7 plateformes)
├── vitrine.html            Page de présentation publique
├── merci.html              Page de confirmation paiement
├── samsung-tv.html         Guide Samsung TV
│
├── app.js                  Logique principale (v6.9, ~4 300 lignes)
├── auth.js                 Auth Supabase + gestion abonnements
├── player.js               Lecteur standalone (player.html)
├── styles.css              Styles globaux (v103)
├── player.css              Styles lecteur
│
├── sw.js                   Service Worker (cache pipsily-v197)
├── manifest.webmanifest    Manifest PWA
├── logo.svg                Logo
│
├── version.json            Versions APK + Tizen + changelogs
│
├── live.json               Catalogue TV en direct (~326 Ko)
├── series.json             Catalogue séries (~3,4 Mo)
├── episodes_index.json     Index des parties d'épisodes
├── episodes_map.json       Mapping série → partie JSON
├── episodes_part1–11.json  Données épisodes (partitionnées)
├── series_catalog*.json    Catalogue séries enrichi (partitionné)
│
├── icons/
│   ├── icon-192.png
│   ├── icon-512.png
│   └── splash/             Splash screens iOS (7 tailles)
│
└── tizen-tv/               App Samsung TV (.wgt)
    ├── config.xml
    ├── tizen-tv.js
    ├── tizen-update.js
    └── build.ps1
```

---

## 4. Sources de données

### Xtream Codes API

L'app consomme une API Xtream Codes. Les credentials sont saisis par l'utilisateur dans `account.html` et stockés localement.

| Endpoint | Usage |
|----------|-------|
| `get_vod_streams` | Films |
| `get_series` | Séries (métadonnées) |
| `get_series_info` | Épisodes d'une série |
| `get_live_streams` | Canaux TV |
| `get_vod_categories` | Catégories Films |
| `get_series_categories` | Catégories Séries |
| `get_live_categories` | Catégories TV |

### Catalogue pré-généré (GitHub Pages)

Pour les séries, les épisodes sont pré-indexés en JSON partitionné (`episodes_part1–11.json`) afin d'éviter les appels API répétés. Le fichier `episodes_map.json` donne la correspondance `seriesId → partie`.

### Version distante (`version.json`)

```json
{
  "apk_version": 25,
  "apk_url": "https://github.com/morpheus45/VOD/releases/download/v25/PIPSILY.apk",
  "tizen_version": 1,
  "tizen_url": "https://…/tv-v1/PIPSILY-TV-signed.wgt"
}
```

Utilisé par `checkApkUpdate()` pour détecter et proposer les mises à jour.

---

## 5. Authentification & abonnements

**Backend** : Supabase (PostgreSQL + Auth)

**Tables** :
- `profiles` : `id`, `plan`, `subscription_expires_at`, `devices_allowed`
- `sessions` : `user_id`, `device_id`, `token`, `last_seen`

### Plans

| Plan | Appareils simultanés | Appareils enregistrés |
|------|---------------------|-----------------------|
| `active` (défaut) | 1 | 1 |
| `unlimited` | 4 | 3 |
| `admin` | ∞ | ∞ |

### Flux d'authentification

1. `login.html` → Supabase Magic Link ou email/password
2. `checkAuth()` dans `auth.js` → vérifie session + plan
3. Si plan expiré → modal de renouvellement (Wero)
4. Si trop d'appareils → modal blocage

### Compte admin

L'email `cedric.lago@gmail.com` est traité comme `plan = "admin"` avec accès illimité et panneau admin visible.

### Paiement Wero

Le numéro Wero est encodé en base64 dans `auth.js` (`WERO_PHONE`). La page `account.html` l'affiche avec un lien de paiement direct.

---

## 6. Lecteur vidéo — PipPlayer

L'objet `PipPlayer` (défini dans `app.js`) gère la lecture vidéo sous trois modes, sélectionnés automatiquement :

### Mode 1 — AndroidBridge (APK)

```
PipPlayer.open(item)
  → AndroidBridge.openPlayer(url, title, sub, epsJson, epIdx)
  → AndroidBridge.openPlayerAt(url, …, savedMs)  // reprend à la position
```

ExoPlayer natif s'ouvre, prend le contrôle de l'écran. À la fermeture, Java appelle `window.onAndroidPlayerClosed(url, posMs, durMs)` via `webView.evaluateJavascript()`.

### Mode 2 — iOS AVPlayer

Sur Safari iOS / PWA iOS, le lecteur utilise le tag `<video>` natif avec un overlay plein écran.

### Mode 3 — HLS.js interne (navigateur)

Sur tous les autres contextes (PC, Samsung TV), HLS.js décode le flux `.m3u8` dans un `<video>` dans l'overlay PipPlayer.

### Rappel de position (`openPlayerAt`)

La progression est sauvegardée dans `pf_progress_v4` (localStorage). Avant chaque ouverture :

```js
_getSavedProgressMs(item)  // retourne posMs en ms, 0 si < 10s
```

Si `savedMs > 0` et que le bridge Android supporte `openPlayerAt`, ExoPlayer reprend à la position.

### Callback `onAndroidPlayerClosed`

```js
window.onAndroidPlayerClosed = function(url, posMs, durMs)
```

Reçoit la position finale. Stocke la progression et rafraîchit Poursuivre. Restaure le focus TV via `_restoreTvFocus()`.

**Points de sortie** (tous appellent `_restoreTvFocus()`) :
1. `posMs < 30 000 ms` → trop court, on ignore
2. `pct > 0.97` → quasi-terminé, on ignore
3. Chemin série (épKey trouvé) → sauvegarde épisode
4. Chemin VOD/Live → sauvegarde item

### `_restoreTvFocus()`

```js
function _restoreTvFocus(){
  setTimeout(() => {
    const f = PipPlayer._lastFocus;
    PipPlayer._lastFocus = null;
    if(f && f !== document.body && f.isConnected){
      f.focus();
      f.scrollIntoView?.({ behavior:"smooth", block:"nearest" });
    } else {
      document.querySelector(".nrow-card, .card")?.focus();
    }
  }, 200);
}
```

- Restaure l'élément focusé avant l'ouverture du lecteur
- Exclut `document.body` (isConnected=true mais focus() no-op)
- Fallback : première `.nrow-card` ou `.card` du DOM

---

## 7. Navigation TV (D-pad)

La navigation est gérée par un `keydown` global dans `app.js`. Trois modes selon le contexte :

```js
const panelOpen  = S.panel.open;
const useNetflix = $("grid")?.classList.contains("netflix-rows");

if(panelOpen)  { _navPanel(k);   return; }
if(useNetflix) { _navNetflix(k); return; }
_navGrid(k);
```

### `_navGrid` — grille classique

- `ArrowLeft/Right` : navigation dans la rangée
- `ArrowUp` : remonte aux nav-btns (Films/Séries/TV) si en haut de grille
- `ArrowDown` : descend dans la grille

**Branche `.nou-card`** (Poursuivre/Favoris) :
```
ArrowUp   → focusFirstPill() ou nav-btn
ArrowDown → première .card de la grille
ArrowLeft/Right → dans la rangée Poursuivre
```

### `_navNetflix` — rangées style Netflix

- `rowIdx < 0` (focus dans les pills) :
  - `ArrowDown` → première carte de la 1re rangée
  - `ArrowUp` → nav-btn ou premier pill
- `rowIdx >= 0` : navigation par rangées

### `_navPanel` — panneau série

Navigation dans la liste des épisodes d'une saison.

### Touches spéciales

| Touche | Action |
|--------|--------|
| `Enter` / ` ` | Activer élément focusé |
| `Escape` / `GoBack` / `Back` | Fermer panneau / overlay |
| `BrowserBack` | Retour |

---

## 8. Section Poursuivre

La section "▶ Poursuivre" affiche en haut de l'app :
1. **Items en cours** (progression 3%–97%) triés par timestamp décroissant (15 max)
2. **Favoris non commencés** complétant jusqu'à 25 items

### Fonction principale

```js
function renderPoursuivreRow()           // wrapper avec try/catch
function _renderPoursuivreRowInner()     // logique réelle
```

Alias : `renderContinueRow()` et `renderFavoritesRow()` redirigent vers `renderPoursuivreRow()`.

### Filtre XXX

```js
const _hideXXXItem = item =>
  _startsXXX(item?.category_name) ||
  _startsXXX(item?.title) ||
  _startsXXX(item?.name);
```

```js
function _startsXXX(c){
  if(!c) return false;
  if(c.startsWith("xXx")) return false;  // film "xXx" — à garder
  return /^xxx/i.test(c);               // xxx / XXX / Xxx → filtrer
}
```

**Règles** :
- Le contenu dont la catégorie **OU** le titre **OU** le nom commence par `xxx` (insensible à la casse) est **toujours masqué** dans Poursuivre
- Cela s'applique **même si le PIN adulte est déverrouillé**
- Exception : `xXx` (film d'action) est toujours visible
- Ce filtre s'applique aux inProgress (séries + VOD) et aux favoris

### Clés de progression

```
pf_progress_v4 = {
  "vod||<id>||<titre>"  : { pct, ts },        // clé itemKey (VOD)
  "<id>"                : { t, d, ts },        // clé numérique (VOD)
  "<seriesId>||S01E01"  : { t, d, pct, ts }   // clé épisode série
}
```

---

## 9. Contrôle parental (PIN adulte)

### Configuration

Dans `account.html` → section "Code parental" → l'utilisateur définit un code PIN 4 chiffres, stocké dans `localStorage.pipsily_adult_pin`.

### Fonctionnement

La pill de catégorie `__ADULT__` est spéciale :

```js
if(cat === "__ADULT__" && !sessionStorage.getItem("pipsily_adult_unlocked")){
  showAdultPinPrompt(pills);
  return;
}
```

Après validation du PIN :
```js
sessionStorage.setItem("pipsily_adult_unlocked", "1");
renderGrid(true);
if(typeof renderPoursuivreRow === "function") renderPoursuivreRow();
```

**Note** : le déverrouillage est valable pour la **session en cours uniquement** (`sessionStorage`). Il permet la navigation dans les catégories adulte via la pill, mais n'affecte **pas** la section Poursuivre (XXX toujours masqué).

---

## 10. Mise à jour APK

### `checkApkUpdate()` (au démarrage, APK uniquement)

1. Récupère `version.json` depuis GitHub Pages
2. Récupère la version installée via `AndroidBridge.getApkVersion()` → stocke dans `pf_local_apk_ver`
3. Si `remoteVer > localVer` ET pas de suppression active → affiche `showApkUpdateBanner()`

### Suppression (éviter les re-affichages)

| Clé localStorage | Valeur | Rôle |
|-----------------|--------|------|
| `pf_apk_sv4` | `String(remoteVer)` | Version supprimée (ne plus notifier pour cette version) |
| `pf_apk_su4` | `Date.now() + 86400000` | Timestamp d'expiration de la suppression (24h) |
| `pf_local_apk_ver` | `String(ver)` | Version APK connue (mise à jour **uniquement** par le bridge) |

**Important** : `pf_local_apk_ver` n'est **jamais** écrit lors du clic "Télécharger" (pour ne pas masquer la bannière si l'installation échoue). Il est uniquement mis à jour par `AndroidBridge.getApkVersion()` au prochain démarrage après installation.

### Bannière obligatoire

`showApkUpdateBanner()` crée un overlay plein écran (`z-index: 99999`) sans bouton "Fermer". 

**Keydown handler** :
```js
banner.addEventListener("keydown", e => {
  if(["Escape","GoBack","Back","BrowserBack"].includes(e.key)){
    e.preventDefault(); e.stopPropagation(); // pas de retour arrière
  } else if(e.key !== "Enter" && e.key !== " "){
    e.preventDefault(); e.stopPropagation(); // bloque scroll/navigation D-pad
  }
}, true);
```

---

## 11. Service Worker & cache

**Fichier** : `sw.js` — version actuelle : `pipsily-v197`

### Stratégie de cache

| Type de ressource | Stratégie |
|-------------------|-----------|
| `.json` / `.m3u` | **Network-first** (cache en fallback) |
| Shell (HTML/CSS/JS/images) | **Cache-first** + mise à jour réseau en arrière-plan |
| Navigation (`index.html`) | Fallback cache si réseau indisponible |

### Mise à jour automatique

Au `install` : purge **tous** les anciens caches, met en cache le shell, appelle `skipWaiting()` immédiatement.

Au `activate` : `clients.claim()` + envoi de `{ type: "RELOAD" }` à tous les onglets ouverts → rechargement automatique sans intervention utilisateur.

### Shell (fichiers mis en cache)

```js
["./", "./index.html", "./login.html", "./account.html", "./admin.html",
 "./player.html", "./install.html", "./vitrine.html", "./merci.html",
 "./samsung-tv.html", "./styles.css?v=103", "./player.css",
 "./app.js?v=166", "./auth.js", "./player.js?v=51",
 "./manifest.webmanifest", "./logo.svg",
 "./icons/icon-192.png", "./icons/icon-512.png", "./version.json",
 + 7 splash screens iOS]
```

### Bumper le cache

À chaque modification de fichier, incrémenter `CACHE` dans `sw.js` :
```js
const CACHE = "pipsily-v198"; // ← incrémenter
```
Cela force le rechargement sur tous les clients au prochain démarrage.

---

## 12. Clés de stockage local

### `localStorage`

| Clé | Type | Description |
|-----|------|-------------|
| `pf_favorites_v4` | JSON array | Favoris de l'utilisateur |
| `pf_history_v4` | JSON array | Historique de visionnage (300 entrées max) |
| `pf_progress_v4` | JSON object | Progression par item (clé → `{pct, t, d, ts}`) |
| `pipsily_adult_pin` | string | Code PIN parental |
| `pipsily_region` | string | Filtre région TV actif |
| `pipsily_available_regions` | JSON array | Régions TV détectées |
| `pipsily_session_token` | string | Token de session (anti-multi-device) |
| `pf_local_apk_ver` | string | Version APK installée connue |
| `pf_apk_sv4` | string | Version APK supprimée (notification) |
| `pf_apk_su4` | string | Timestamp expiration suppression |
| `pf_apk_install_dismiss` | string | Suppression bannière d'installation PWA |
| `pf_apk_install_dismiss_ver` | string | Version supprimée pour installation |

### `sessionStorage`

| Clé | Valeur | Description |
|-----|--------|-------------|
| `pipsily_adult_unlocked` | `"1"` | PIN adulte déverrouillé (session uniquement) |
| `iptv_nav_ctx` | JSON | Contexte de navigation IPTV (saison/épisode) |

---

## 13. AndroidBridge — API Java↔JS

L'APK expose une interface Java accessible via `window.AndroidBridge` dans la WebView.

### Méthodes utilisées

| Méthode | Arguments | Description |
|---------|-----------|-------------|
| `openPlayer(url, title, sub, epsJson, epIdx)` | — | Ouvre ExoPlayer |
| `openPlayerAt(url, title, sub, epsJson, epIdx, posMs)` | — | Ouvre ExoPlayer à une position |
| `openInVlc(url, title, isLive)` | — | Ouvre VLC natif (fallback) |
| `downloadAndInstall(url)` | — | Télécharge et installe un APK |
| `openDownloadUrl(url)` | — | Ouvre l'URL de téléchargement |
| `getApkVersion()` | → string | Retourne la version APK installée |
| `fetchJson(url)` | → string JSON | Fetch HTTP depuis Java (contourne mixed-content) |
| `fetchUrlAsync(url, cbName)` | — | Fetch asynchrone, résultat via callback JS |
| `clearCache()` | — | Vide le cache WebView |

### Callback Java → JS

```js
window.onAndroidPlayerClosed(url, posMs, durMs)
// Appelé par MainActivity.reportProgress() via evaluateJavascript()
```

---

## 14. Plateformes supportées

| Plateforme | Mode | Notes |
|------------|------|-------|
| Android TV / Google TV | APK v25 + WebView | ExoPlayer natif, D-pad complet |
| Android mobile | APK v25 | Même APK |
| iOS / iPadOS (Safari) | PWA | AVPlayer natif, splash screens |
| iOS / iPadOS (Chrome/Firefox) | PWA | HLS.js |
| macOS (Safari/Chrome) | Web | HLS.js |
| Windows / Linux | Web | HLS.js |
| Samsung TV (Tizen 3+) | App .wgt | HLS.js |
| LG TV (webOS) | Web navigateur | HLS.js |

### Détection iOS

```js
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
           || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isSafariIOS = isIOS && /Safari/i.test(UA) && !/CriOS|FxiOS/.test(UA);
const isIOSContext = isIOS; // inclut PWA standalone
```

### Détection TV (précoce, avant 1er rendu)

```html
<script>
  if(/AndroidTV|GoogleTV|SmartTV/i.test(navigator.userAgent) || /\bTV\b/.test(UA)){
    document.documentElement.classList.add('is-tv');
  }
</script>
```

---

## 15. Samsung TV (Tizen)

Sous-dossier `tizen-tv/`. App packagée en `.wgt` (widget Tizen).

**ID** : `com.morpheus45.pipsily`  
**Version** : 1.0.0  
**Entry point** : `index.html`

### Build

```powershell
# Dans tizen-tv/
.\build.ps1
# Génère dist/PIPSILY-TV.wgt, puis sign_wgt.py signe avec developer.p12
```

**Fichier signé** : `dist/PIPSILY-TV-signed.wgt`  
**Distribué via** : GitHub Releases `tv-v1`

### Mise à jour auto Tizen

`tizen-update.js` vérifie `version.json → tizen_version` au démarrage et affiche une notification si une nouvelle version est disponible.

---

## 16. Déploiement

### GitHub Pages (PWA)

```bash
git add <fichiers modifiés>
git commit -m "fix: description"
git push origin main
# → GitHub Pages déploie automatiquement en ~30s
```

### Règle de bump SW obligatoire

**À chaque modification de `app.js`, `styles.css`, `auth.js` ou tout fichier du shell** :
→ Incrémenter `const CACHE = "pipsily-vXXX"` dans `sw.js`

Sans ce bump, les utilisateurs continuent de voir l'ancienne version jusqu'à la prochaine mise à jour de leur SW (jusqu'à 24h).

### APK Android

1. Modifier `versionCode` + `versionName` dans `build.gradle`
2. Build APK signé
3. Créer une GitHub Release `v<N>` et uploader l'APK
4. Mettre à jour `version.json` → `apk_version: <N>`
5. Commit + push → déclenchement automatique de la bannière de mise à jour

---

## 17. Bugs corrigés — historique

### Session mai 2026

#### Correctifs fonctionnels majeurs

| Bug | Description | Fix |
|-----|-------------|-----|
| Poursuivre vide | Le filtre adulte masquait tous les films/séries en cours | Supprimé le filtre adulte général, conservé uniquement le filtre XXX |
| XXX dans Poursuivre | Les items `category_name` ou `title` commençant par "xxx" restaient visibles | `_hideXXXItem()` vérifie category_name + title + name |
| PIN bypass Poursuivre | `adultOK=true` désactivait le filtre XXX dans Poursuivre | Supprimé `adultOK` de `_hideXXXItem` — filtre toujours actif |
| `xXx` filtré à tort | Le film "xXx" (vin Diesel) était masqué | Exception `startsWith("xXx")` dans `_startsXXX` |

#### Navigation TV

| Bug | Description | Fix |
|-----|-------------|-----|
| Impossible de remonter aux nav-btns | Après retour de visionnage, ArrowUp ne remontait pas | `_navNetflix` rowIdx<0 + ArrowUp → `_focusFirstPill()` |
| Boucle infinie nou-card ↔ cards | ArrowDown depuis nou-card focussait cards[0] qui renvoyait vers nou-card | Branche `.nou-card` dédiée dans `_navGrid` |
| Focus perdu après lecteur natif | `onAndroidPlayerClosed` ne restaurait pas le focus sur le chemin série | `_restoreTvFocus()` appelé à tous les points de sortie |
| `document.body` comme focus | `body.isConnected=true` → `body.focus()` no-op, fallback jamais atteint | Garde `f !== document.body` dans `_restoreTvFocus()` |

#### APK / Bannière mise à jour

| Bug | Description | Fix |
|-----|-------------|-----|
| Bannière APK à chaque démarrage | Clés de suppression `pf_apk_sv4`/`pf_apk_su4` jamais écrites | Écriture lors du clic "Télécharger" |
| `pf_local_apk_ver` prématuré | Version mémorisée avant fin de l'installation → masquage permanent si échec | Ligne supprimée du onclick ; seul le bridge met à jour cette clé |
| GoBack quitte l'app pendant bannière | `e.preventDefault()` manquant sur GoBack/Back | Ajouté dans le keydown handler |
| Flèches D-pad traversent bannière | `e.preventDefault()` manquant dans le else-if du keydown | Ajouté : `e.preventDefault(); e.stopPropagation()` |

#### PIN parental

| Bug | Description | Fix |
|-----|-------------|-----|
| Poursuivre non rafraîchi après PIN unlock | `renderGrid(true)` appelé mais pas `renderPoursuivreRow()` | `renderPoursuivreRow()` ajouté après `renderGrid(true)` dans `showAdultPinPrompt` |

---

*Généré le 2026-05-27 — PIPSILY v6.9 / APK v25 / SW pipsily-v197*
