GitHub VOD App – version fonctionnelle simplifiée

Partie publique :
- index.html
- public.js
- details.html
- details.js

Partie admin :
- admin.html
- admin.js

Icônes / manifeste :
- icon-192.png
- icon-512.png
- manifest.webmanifest
- sw.js

Fichiers à ajouter toi-même à la racine :
- live.json ou live.m3u
- series.json ou series.m3u
- vod.json ou vod.m3u

Comportement :
- Live : ouvre directement le lien
- VOD : ouvre une fiche avec synopsis + bouton Lire
- Séries : ouvre une fiche avec saisons/épisodes + lecture directe de l’épisode

Important :
- cette version neutralise l’ancien service worker pour éviter les pages vides sur mobile
- après mise à jour sur GitHub, fais un rechargement complet sur téléphone
