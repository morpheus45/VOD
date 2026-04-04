Release fusionnée

L’existant est conservé.
Ajouts :
- admin protégé par mot de passe : Morpheus45!
- admin-panel avec génération Xtream de vod_catalog.json et series_catalog.json
- site public compatible live + vod + séries
- détails VOD avec synopsis si disponible
- détails séries avec saisons / épisodes / synopsis si disponibles dans series_catalog.json

Important :
- les synopsis et saisons/épisodes ne peuvent apparaître que si le catalogue enrichi existe
- si le serveur Xtream bloque le CORS, la génération depuis GitHub Pages peut échouer
