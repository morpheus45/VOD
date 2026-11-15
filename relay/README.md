# Relais HTTPS — lecture des flux dans le navigateur

## Pourquoi

PIPSILY est servi en HTTPS (GitHub Pages). Les flux du fournisseur IPTV, eux,
sont en HTTP pur, redirections CDN comprises : `http://goldenlink.live/...` →
`http://xxxx.meshivon.cc/...`. Un navigateur refuse de charger une vidéo HTTP
depuis une page HTTPS (« contenu mixte »), sans message visible. Résultat :
rien ne se lit sur PC, iPad ou téléphone sans passer par VLC.

Depuis une origine HTTP (test local), le même film se lit sans problème : le
serveur envoie même `Access-Control-Allow-Origin: *`. Le seul obstacle est le
protocole. Le relais résout ça : il va chercher le flux en HTTP et le ressert
en HTTPS, avec CORS, sans rien installer côté utilisateur.

L'APK (TV, téléphone) n'est pas concerné : son lecteur natif lit le HTTP
directement, et le code l'exclut du relais.

## Déploiement (Cloudflare Workers, gratuit, bande passante non facturée)

1. Créer un compte sur https://dash.cloudflare.com (gratuit).
2. **Workers & Pages → Create → Create Worker**, nommer `pipsily-relay`,
   déployer le modèle, puis **Edit code** : remplacer tout par le contenu de
   `worker.js`, **Deploy**.
3. **Settings → Variables and Secrets → Add**, trois variables (type *Secret*) :
   - `RELAY_KEY` : une clé de votre choix (lettres/chiffres, ex. `k7Pq2xWz`) ;
   - `XT_USER` et `XT_PASS` : l'identifiant et le mot de passe Xtream (ceux de
     la carte « Serveur Xtream » de l'admin, ou ceux d'origine du catalogue).
   Déployer de nouveau.
4. Vérifier : ouvrir `https://pipsily-relay.<compte>.workers.dev/` → affiche
   `PIPSILY relay OK`.
5. Dans **PIPSILY → Admin → Relais HTTPS**, coller
   `https://pipsily-relay.<compte>.workers.dev/p/k7Pq2xWz` (l'URL **avec**
   `/p/` et la clé), **Tester**, puis **Enregistrer**.

Chaque appareil applique le réglage à sa prochaine ouverture (`xtream.js` le
lit dans `app_config`, clé `relay`). Vide = désactivé : comportement d'avant.

## Identifiants jamais visibles

Les URL Xtream du catalogue contiennent l'identifiant et le mot de passe
(`/live/IDENTIFIANT/MOTDEPASSE/56988.m3u8`). Côté navigateur, `xtream.js` les
**retire** avant d'appeler le relais, et le worker les **réinjecte** depuis ses
variables secrètes :

```
navigateur →  https://<worker>/p/<CLE>/x/http/goldenlink.live/live/56988.m3u8
worker     →  http://goldenlink.live/live/<XT_USER>/<XT_PASS>/56988.m3u8
```

Rien n'apparaît donc dans la barre d'adresse ni dans l'onglet Réseau. Les
playlists réécrites suivent la même règle. Reste vrai : les fichiers de
catalogue publiés (`vod.json`, `live.json`…) contiennent toujours ces
identifiants, comme avant ; les cacher aussi est un chantier distinct.

## Format des URL relayées

```
https://<worker>/p/<CLE>/x/http/goldenlink.live/live/56988.m3u8     Xtream (identifiants injectés)
https://<worker>/p/<CLE>/http/6426720.cdn.cc/hlsr/<jeton>/seg.ts    générique (segments CDN)
https://<worker>/p/<CLE>/status                                      {"ok":true,"xt":true}
```

Les playlists HLS sont réécrites à la volée pour que segments et clés passent
aussi par le relais, en résolvant les URL relatives contre l'URL **finale**
(après redirection CDN). Les films (`.mp4`, `.mkv`) passent en flux direct avec
prise en charge de `Range` (avance/recul).

## Limites du plan gratuit

100 000 requêtes par jour. Une chaîne HLS consomme une requête par segment
(≈ 1 toutes les 10 s), un film quelques requêtes : largement suffisant pour un
usage familial. Au-delà, le plan payant (5 $/mois) lève la limite.
