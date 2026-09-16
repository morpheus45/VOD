# Restriction de contenu par compte — design

Date : 2026-09-13
Statut : validé par le propriétaire du projet

## Problème

Un compte doit pouvoir être limité au contenu jeunesse, de façon à ce que
l'enfant qui s'y connecte ne voie rien d'autre, sur n'importe quel appareil.
Cas concret : `nolhan34@gmail.com`, qui utilise Cosmos sur la TV et
l'interface Xstream sur son téléphone. La restriction doit donc valoir sur les
deux, pas seulement sur la TV.

Aujourd'hui PIPSILY ne connaît qu'un contrôle parental par appareil, stocké en
`localStorage` sous `pipsily_adult_pin`. Il ne suit pas le compte et se
désactive depuis les réglages, donc il ne répond pas au besoin.

## Décisions

Trois arbitrages ont été tranchés avec le propriétaire avant conception.

1. **Périmètre** : rayons jeunesse uniquement. Tout ce qui n'est pas une
   catégorie jeunesse disparaît, y compris les nouveautés et la recherche.
2. **Contrôle** : posé par l'administrateur seul, stocké sur le compte. Aucun
   moyen de le voir ni de le lever depuis la TV.
3. **Anime** : inclus. Le rayon est majoritairement familial (Astérix, Kubo,
   Soul, Olive et Tom) mais contient une minorité de titres durs
   (Psycho-Pass, Funan). Risque accepté en connaissance de cause.

## Architecture

### Stockage

Nouvelle colonne sur la table Supabase `profiles`, à côté de `plan`,
`subscription_expires_at`, `devices_allowed` et `parental_pin` :

```sql
alter table profiles
  add column if not exists content_policy text not null default 'all';
```

Valeurs : `'all'` (aucune restriction) et `'kids'` (jeunesse uniquement).

Un champ texte plutôt qu'un booléen pour permettre un niveau intermédiaire
ultérieur sans migration de schéma.

**Contrainte d'accès** : les règles RLS doivent autoriser le compte à LIRE sa
propre valeur mais jamais à l'ÉCRIRE, sinon la restriction se lève par un appel
direct à l'API Supabase. À vérifier et corriger à l'implémentation.

### Transport

`checkSubscription()` dans `auth.js` lit déjà la ligne complète du profil
(`select("*")`). Le champ est exposé dans l'objet de session retourné, à côté
de `plan`, et devient lisible en `window._cosUser.sub.content_policy`.

Valeur par défaut si absente ou illisible : `'all'`. Une restriction ne doit
jamais s'appliquer par accident à un compte adulte à cause d'une erreur réseau.

### Application du filtre : à la source, pas à l'affichage

Les deux interfaces sont des cibles de plein droit. Le propriétaire a précisé
que Nolhan utilise Cosmos sur la TV **et** l'interface Xstream sur son
téléphone.

Première intention rejetée : patcher les fonctions de filtrage d'affichage.
`cosmos.html` a bien un point unique (`isClean`), mais `app.js` filtre dans une
dizaine d'endroits distincts : `filtered()`, `renderNetflixRows()`,
`renderCatPills()`, `renderPoursuivreRow()`, `renderNouveautes()`,
`renderHero()`, l'overlay de recherche et l'index des régions du direct. Les
patcher un par un veut dire en oublier un, aujourd'hui ou à la prochaine
fonctionnalité.

Retenu : **filtrer au chargement du catalogue**, avant que quoi que ce soit ne
lise les données. Chaque interface peuple ses tableaux en un seul endroit :

- `cosmos.html` : `S.allVod`, `S.allSeries`, `S.allItems`, `S.liveItems`
  (deux chemins, cache et réseau) ;
- `app.js` : `S.vod`, `S.series`, `S.live`.

Sur un compte `kids`, ces tableaux ne contiennent que du contenu jeunesse. Tout
ce qui lit en aval est couvert d'office : étagères, grille, recherche, hero,
favoris, reprise de lecture, pastilles de catégories, direct, et toute vue
ajoutée plus tard.

```js
const KID_CAT_RE = /enfant|famille|kids|jeunesse|junior|dessin|cartoon|anim[ée]|manga|disney/i;
```

Ce motif est délibérément appliqué à la CATÉGORIE et non au titre : le titre
d'un film pour adultes peut contenir « famille » par hasard.

Le filtrage adulte existant (`ADULT_RE` dans Cosmos, `_isAdultCat` dans
`app.js`) reste en place et inchangé. Les deux règles sont indépendantes.

### Bascule entre interfaces

Les réglages Cosmos proposent de passer à l'interface Xstream
(`action==='iface'` → `index.html`). Les deux interfaces étant désormais
filtrées à la source, cette bascule n'est plus une échappatoire.

On masque tout de même deux entrées des réglages sur un compte `kids`, par
propreté et non par sécurité : « Interface », et « Contrôle parental » qui n'a
plus d'objet et prêterait à confusion.

### Administration

`admin.html` liste déjà les profils et sait les modifier. On y ajoute un
sélecteur par compte, « Contenu : tout / jeunesse », qui écrit
`content_policy`. Accessible aux seuls administrateurs, comme le reste du
panneau.

## Portée du catalogue résultant

Mesuré sur le catalogue du 2026-09-13.

| Type | Rayons retenus | Titres |
|---|---|---|
| Films | Famille & Enfants, Disney+, Anime & Manga | 1 154 |
| Séries | Enfants, Anime, Multi-lang Anime | 1 537 |
| Chaînes | Enfants, Disney+ | 132 |

## Limites assumées

Le filtrage est appliqué côté client. Sur une TV pilotée à la télécommande, un
enfant ne le contournera pas. Ce n'est pas une barrière contre un adulte qui
ouvrirait les outils de développement du navigateur.

Un verrouillage réel supposerait de filtrer le catalogue côté serveur, avant
envoi. C'est un chantier disproportionné par rapport au besoin exprimé, et il
est explicitement hors périmètre.

## Tests

`scripts/test-shelves.js` est étendu d'une section qui applique le filtre de
catalogue des DEUX interfaces sur les vrais fichiers `vod.json`, `series.json`
et `live.json`, et vérifie, avec la politique `kids` :

- qu'aucun titre retenu n'appartient à une catégorie hors jeunesse ;
- que le catalogue résultant n'est pas vide, pour attraper un motif devenu trop
  strict après un changement de nommage du fournisseur ;
- que le compte des titres retenus correspond aux chiffres du tableau ci-dessus,
  à la dérive du catalogue près.

Et avec la politique `all` :

- que les trois catalogues sont strictement identiques à ce qu'ils sont
  aujourd'hui, pour garantir l'absence de régression sur les comptes normaux.

Le test extrait le vrai code des deux fichiers, comme il le fait déjà pour les
étagères, plutôt que d'en recopier la logique.

## Hors périmètre

- Liste noire de titres individuels.
- Plages horaires d'accès.
- Niveau intermédiaire « adolescent ».
- Filtrage côté serveur.
