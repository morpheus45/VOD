# PIPSILY — VPN WireGuard intégré (Android) — Spec de conception

Date : 2026-09-09
Portée : appli Android `com.pipsiflix.app` uniquement. Build **perso**.

## 1. Objectif

Intégrer un VPN **dans PIPSILY** pour remplacer l'app ProtonVPN séparée : au
lancement, PIPSILY monte un tunnel **WireGuard**, route **uniquement son propre
trafic**, empêche toute **fuite d'IP et de DNS**, et laisse **changer de
localisation à tout moment** via un sélecteur, avec **choix automatique du
serveur le plus rapide**.

Contrainte assumée par l'utilisateur : la source de serveurs est **gratuite**.
Les serveurs gratuits sont peu nombreux, souvent plafonnés en données et à débit
variable — l'appli atténue en classant/sélectionnant les plus rapides, mais ne
peut pas créer du débit. Ce point est explicitement accepté.

## 2. Décisions (cadrage)

| Sujet | Décision |
|---|---|
| Cible | Android uniquement (la TV Samsung Tizen n'a pas d'API VPN → hors périmètre) |
| Distribution | Build perso ; configs et clés **hors du dépôt public** |
| Protocole | WireGuard (backend `com.wireguard.android:tunnel`, wg-go, ABI arm64-v8a/armeabi-v7a) |
| Périmètre du tunnel | **Per-app** : seul `com.pipsiflix.app` est routé (`addAllowedApplication`) |
| Sécurité | **Kill-switch strict** + anti-fuite IP/DNS/IPv6 |
| Serveurs | **Gratuits**, liste multi-localisations ; **auto = le plus rapide** + sélecteur manuel |
| Changement de localisation | Accessible accueil **et** pendant la lecture, à chaud, reprise auto |
| Source concrète (test) | Windscribe gratuit (~10 pays, configs WireGuard) ; option Cloudflare WARP (illimité, 1 localisation) |

## 3. Principe anti-fuite (cœur de la sécurité)

- Le `VpnService` construit un tun avec `addAllowedApplication("com.pipsiflix.app")`
  et `AllowedIPs = 0.0.0.0/0` (+ `::/0`). **Tout** le trafic de PIPSILY (WebView
  ET ExoPlayer, même process) ne peut sortir que par le tun.
- **Avant le handshake WireGuard confirmé**, aucun paquet ne circule dans le tun →
  les paquets PIPSILY sont **droppés, pas envoyés en clair** → pas de fenêtre de fuite.
- **DNS** : `builder.addDnsServer(<DNS du .conf>)`. Les requêtes DNS de PIPSILY
  partent dans le tunnel vers le résolveur du VPN → jamais vers le DNS du FAI.
- **IPv6** : si le fournisseur fournit une adresse v6 → routée dans le tun ;
  sinon on ajoute une **route v6 blackhole** (aucune adresse v6 assignée) pour que
  le trafic IPv6 de PIPSILY ne puisse pas fuir hors tunnel.
- Le reste de la TV (autres apps) garde sa connexion normale — par conception.

## 4. Architecture — unités isolées

Nouveau package `com.pipsiflix.app.vpn`. Aucune modification des fichiers de
lecture/stockage existants (voir §10).

- **`WgConfig`** — modèle immuable d'une config WireGuard + parseur d'un `.conf`
  standard. Champs : `interfacePrivateKey`, `addresses[]`, `dns[]`,
  `peerPublicKey`, `endpointHost:port`, `allowedIps[]`, `presharedKey?`.
  *Dépend de : rien (parsing texte pur). Testable seul.*
- **`VpnServers`** — découvre et charge les configs embarquées depuis
  `assets/vpn/*.conf`. Retourne une liste `VpnServer { id, label (pays/ville),
  WgConfig }`. Le libellé vient du nom de fichier (ex : `windscribe-fr-paris.conf`
  → « France · Paris ») ou d'un commentaire `# name=` dans le `.conf`.
  *Dépend de : WgConfig, AssetManager.*
- **`LatencyProbe`** — mesure la latence de chaque serveur (connexion TCP courte
  vers `endpointHost:port`, timeout court, 2-3 essais → médiane). Utilisé pour le
  tri « le plus rapide » et le mode Auto. *Dépend de : rien (sockets).*
- **`PipsilyVpnService extends android.net.VpnService`** — monte le tun (per-app,
  DNS, MTU, routes v4/v6 selon §3), démarre le tunnel wg-go via le backend, tourne
  en **foreground service** (notification discrète, obligatoire pour un VPN).
  *Dépend de : tunnel lib, WgConfig.*
- **`VpnManager`** (singleton) — orchestrateur + machine à états :
  `IDLE → NEED_CONSENT → CONNECTING → CONNECTED → RECONNECTING → ERROR`.
  API : `ensureConsent()`, `connect(serverId)`, `connectFastest()`, `switchTo(serverId)`,
  `disconnect()`, `getState()`, `addListener()`. **Health-check** périodique :
  âge du dernier handshake (exposé par wg-go) ; si périmé/interface down →
  `RECONNECTING` (backoff, bascule vers le prochain plus rapide en mode Auto).
  *Dépend de : PipsilyVpnService, VpnServers, LatencyProbe.*
- **`VpnActivity`** (ou overlay natif, D-pad TV) — UI : état courant, IP publique
  vue (via un echo à travers le tunnel), **liste triée par latence** (⚡ le plus
  rapide en haut), entrée **« Auto »**, sélection = `switchTo`. *Dépend de : VpnManager.*

## 5. Sélection du plus rapide + changement de localisation

- Mode par défaut **« Auto (le plus rapide) »** : `connectFastest()` = `LatencyProbe`
  sur tous les serveurs → connexion au meilleur. Dernier choix mémorisé
  (SharedPreferences `pipsily_vpn`).
- Sélecteur accessible **partout** : bouton/pastille VPN à l'accueil et un overlay
  rappelable pendant la lecture (touche dédiée + entrée menu). Changement à chaud :
  `switchTo` coupe le tunnel courant, monte le nouveau ; si une lecture est en cours,
  elle est **mise en pause puis reprise** automatiquement après le nouveau handshake
  (overlay « Changement de localisation… » ~2 s).

## 6. Kill-switch & reconnexion

- MainActivity **ne charge pas la WebView / ne lance pas la lecture** tant que
  `VpnManager.getState() != CONNECTED` (handshake OK **+** sonde de joignabilité à
  travers le tunnel). Overlay natif « Connexion VPN… » en attendant.
- Perte du tunnel en cours d'usage → `RECONNECTING` : pause de la lecture (bridge →
  JS `pause` / `player.pause()`), overlay, reconnexion (même serveur puis, en Auto,
  bascule vers le plus rapide). Reprise auto au retour de `CONNECTED`.
- **Fail-safe anti-blocage** : si aucune connexion n'aboutit après un délai / N
  essais, l'overlay ne reste PAS bloqué — il propose **[Réessayer] [Changer de
  serveur] [Continuer sans VPN]**. « Continuer sans VPN » est un **override
  conscient** (avertissement « IP exposée ») qui lève la porte pour cette session.
  Voir §13.

## 7. Consentement & foreground service

- 1er lancement : `VpnService.prepare()` → dialogue système Android **une fois**
  (« PIPSILY souhaite configurer un VPN »). Résultat OK → démarrage du service.
  Ensuite, connexion auto silencieuse.
- `PipsilyVpnService` en foreground (Android 14 : `foregroundServiceType` adapté,
  `POST_NOTIFICATIONS`). Notification minimale (état + serveur).
- Un seul VPN actif à la fois sur Android → celui de PIPSILY remplace ProtonVPN.

## 8. Source des serveurs & secrets

- Les `.conf` vivent dans `app/src/main/assets/vpn/`. **`assets/vpn/` est
  ajouté au `.gitignore`** : les clés WireGuard (privées) ne sont **jamais**
  commitées dans le dépôt public `morpheus45/VOD`.
- Source de test : compte **Windscribe gratuit** → générer des configs WireGuard
  pour les localisations gratuites → déposer les fichiers. Option **Cloudflare WARP**
  (illimité, rapide, 1 localisation « au plus proche ») en entrée « secours ».
- L'APK **CI public ne contient aucun secret VPN** (dossier absent du dépôt) ;
  seule ta build locale embarque les configs. La fonctionnalité se dégrade
  proprement si `assets/vpn/` est vide (sélecteur vide + message).

## 9. Dépendances & manifeste

- `build.gradle` : `implementation 'com.wireguard.android:tunnel:1.0.20230706'`.
  ABI inchangées (arm64-v8a, armeabi-v7a).
- `AndroidManifest.xml` : permissions `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_SPECIAL_USE` (ou type approprié), `POST_NOTIFICATIONS` ;
  `<service android:name=".vpn.PipsilyVpnService"
  android:permission="android.permission.BIND_VPN_SERVICE" ...>` avec
  `<intent-filter><action android:name="android.net.VpnService"/></intent-filter>`.

## 10. Intégration MainActivity (chirurgicale — ne casse rien)

- Ajouts uniquement : au démarrage, appeler `VpnManager.ensureConsent()` puis
  connexion ; **retarder** le `webView.loadUrl(APP_URL)` existant jusqu'à `CONNECTED`
  (overlay pendant l'attente). Aucune modification des correctifs lecture (v58/v59)
  ni de la purge stockage (v60).
- Nouveaux ponts JS (`AndroidBridge`) : `getVpnState()`, `openVpn()`,
  `setVpnServer(id)`, `listVpnServers()` — pour une pastille d'état optionnelle
  côté web. Le pilotage réel du VPN reste **natif**.

## 11. Tests

- **Unitaire** : `WgConfig` parse un `.conf` d'exemple → tous les champs corrects
  (clé, endpoint, DNS, allowedIps). `LatencyProbe` trie une liste simulée.
- **Manuel (adb, TV)** :
  1. Lancement → dialogue consentement (1re fois) → handshake → état `CONNECTED`.
  2. **IP publique de PIPSILY = celle du VPN** (echo à travers le tunnel).
  3. **Pas de fuite DNS** : la résolution de PIPSILY utilise le DNS du VPN.
  4. **Per-app** : une autre app (ex : navigateur système) garde l'**IP réelle**.
  5. **Pas de fuite IPv6** : aucune sortie v6 directe.
  6. **Kill-switch** : couper le serveur → lecture en pause + overlay + reconnexion.
  7. **Changement de localisation** à chaud pendant lecture → reprise auto.

## 12. Hors périmètre

- TV **Samsung Tizen** : pas d'API VPN embarquée → non couvert (VPN au niveau
  box/routeur si besoin).
- Pas de distribution grand public (build perso ; secrets hors dépôt).

## 13. Portes de retour en arrière (fail-safe « si ça foire »)

Quatre niveaux, du plus léger au plus radical — la fonctionnalité doit toujours
pouvoir être neutralisée sans casser l'appli :

1. **Interrupteur global VPN (on/off)** — réglage persistant dans PIPSILY. **Off →
   comportement strictement identique à v60** (pas de tunnel, pas de porte de
   démarrage, aucune modification de la lecture). C'est la porte de retour
   principale : un basculement et tout revient à l'état sain actuel.
2. **Override runtime « Continuer sans VPN »** — quand la connexion échoue
   (serveur mort, quota gratuit épuisé…), l'utilisateur n'est jamais enfermé :
   il peut réessayer, changer de serveur, ou continuer sans VPN pour cette
   session (avec avertissement). Évite le blocage dû au kill-switch strict.
3. **Kill-switch distant via `version.json`** — un champ `vpn_enabled` (défaut
   `true`). Si mis à `false`, l'appli **saute entièrement le VPN au prochain
   lancement**, sans réinstallation ni rebuild. Permet de désactiver la
   fonctionnalité à distance si une build part en vrille.
4. **Rollback APK** — la fonctionnalité est **additive et isolée** (`vpn/*` +
   service + porte de démarrage conditionnée par l'interrupteur). Revenir à la
   **v60** (réinstallation via ADB ou canal de MAJ) restaure une app saine
   connue ; les configs/clés restant hors dépôt, aucun résidu sensible.

## 14. Risques assumés

- **Débit gratuit** variable/plafonné → possibles rebufferings malgré le tri par
  latence (accepté). Atténuation : mode Auto + bascule vers le plus rapide.
- Fournisseurs gratuits pouvant changer/expirer leurs serveurs → configs à
  régénérer périodiquement.
