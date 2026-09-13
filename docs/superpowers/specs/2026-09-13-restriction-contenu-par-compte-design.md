# Restriction de contenu par compte — design

Date : 2026-09-13
Statut : validé par le propriétaire du projet

## Problème

Un compte doit pouvoir être limité au contenu jeunesse, de façon à ce que
l'enfant qui s'y connecte ne voie rien d'autre, sur n'importe quel appareil.
Cas concret : `nolhan34@gmail.com`.

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

### Application du filtre

`cosmos.html` filtre tout son contenu par un point unique, `isClean(item)`,
appelé par les étagères, la grille, la recherche, les favoris, la reprise de
lecture et le direct. Ce point devient `isAllowed(item)` :

- il conserve le filtrage adulte actuel (`ADULT_RE`) ;
- sur un compte `kids`, il exige en plus que la catégorie du titre corresponde
  au motif jeunesse.

```js
const KID_CAT_RE = /enfant|famille|kids|jeunesse|junior|dessin|cartoon|anim[ée]|manga|disney/i;
```

Ce motif est délibérément appliqué à la CATÉGORIE et non au titre : le titre
d'un film pour adultes peut contenir « famille » par hasard.

### Le contournement par l'autre interface

Les réglages Cosmos proposent de basculer vers l'interface Xstream
(`action==='iface'` → `index.html`), qui possède son propre filtrage
(`filtered()` et `_isAdultCat` dans `app.js`) et ignorerait la restriction.
Un seul clic suffirait à en sortir.

Trois mesures :

1. La même règle jeunesse est appliquée dans `filtered()` de `app.js`, ainsi
   que dans la construction des pastilles de catégories.
2. L'entrée « Interface » est masquée des réglages sur un compte `kids`.
3. L'entrée « Contrôle parental » est masquée aussi : elle n'a plus d'objet et
   sa présence prêterait à confusion.

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

`scripts/test-shelves.js` est étendu d'une section qui, avec la politique
`kids` active :

- vérifie qu'aucun titre affiché, dans aucune étagère ni dans la grille,
  n'appartient à une catégorie hors jeunesse ;
- vérifie que le catalogue résultant n'est pas vide, pour attraper un motif
  devenu trop strict après un changement de nommage du fournisseur ;
- vérifie que la politique `all` laisse le catalogue inchangé par rapport à
  aujourd'hui, pour garantir l'absence de régression sur les comptes normaux.

## Hors périmètre

- Liste noire de titres individuels.
- Plages horaires d'accès.
- Niveau intermédiaire « adolescent ».
- Filtrage côté serveur.
