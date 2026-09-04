# PIPSILY TV — Application Samsung Smart TV (Tizen)

App packagée (.wgt) avec mise à jour automatique, basée sur le code PIPSILY existant.

---

## ⚠ À lire en premier — il n'existe pas d'installation « sans compte »

Une TV Samsung **ne regarde pas le contenu du certificat, elle valide sa chaîne de
certification contre la CA racine Samsung**. Un certificat auto-signé — même avec le
DUID de la TV dans le `CN` — est systématiquement refusé :

```
install failed[118019]        →  « Invalid certificate chain with certificate in signature »
```

Il n'y a **aucun contournement** : un profil de certificats émis par Samsung est
obligatoire, et il s'obtient avec un compte Samsung Developer (gratuit) via
Tizen Studio. Le certificat distributeur est lié au **DUID de la TV visée**, donc
un package signé pour une TV ne s'installe pas sur une autre.

> Historique : les versions publiées jusqu'à la release `tv-v1` incluse signaient avec
> un certificat auto-signé généré à la volée. Ces `.wgt` n'ont jamais pu s'installer sur
> aucune TV. Voir la section *Erreurs d'installation* pour le détail.

---

## Prérequis

| Outil | Version | Lien |
|---|---|---|
| Tizen Studio | 5.x ou + | [Télécharger](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html) |
| Samsung TV Extension | inclus | Via Tizen Studio Package Manager |
| **Compte Samsung Developer** | **obligatoire**, gratuit | [developer.samsung.com](https://developer.samsung.com) |
| TV Samsung en mode développeur | — | Voir section ci-dessous |
| DUID de la TV | — | `sdb shell 0 getduid` une fois la TV connectée |

---

## Activer le mode développeur sur la TV

1. Aller dans **Paramètres → Support → À propos de ce TV**
2. Appuyer **5 fois** sur le bouton **OK** sur le **numéro de modèle** affiché
3. Un dialogue s'ouvre : **Mode développeur → ON**
4. Entrer l'**adresse IP de ton PC**
5. Redémarrer la TV
6. La TV est maintenant accessible via `sdb` (Samsung Device Bridge)

---

## Structure du projet

```
tizen-tv/
├── config.xml          ← Manifest Tizen (ID app, privileges, profile TV)
├── index.html          ← Shell HTML principal (pas de Service Worker)
├── tizen-update.js     ← Moteur de mise à jour automatique
├── tizen-tv.js         ← Adaptations télécommande Samsung
├── build.ps1           ← Script de build PowerShell
├── .project            ← Config Tizen Studio
├── .tproject           ← Config profil Tizen Studio
├── icon.png            ← Icône 128×128 (copiée depuis icons/ par build.ps1)
├── icon_large.png      ← Icône 512×512
│
│   ← Fichiers PIPSILY copiés par build.ps1 →
├── app.js
├── auth.js
├── styles.css
├── ... (tous les assets PIPSILY)
└── icons/
```

---

## Premier build

### 1. Préparer les fichiers

```powershell
cd "C:\Users\cedri\OneDrive\Desktop\VOD-push\tizen-tv"
.\build.ps1
```

Le script copie tous les fichiers PIPSILY dans le dossier `tizen-tv/` et propose de lancer le build automatique si Tizen CLI est dans le PATH.

### 2. Créer le profil de certificats (une fois par TV)

Dans Tizen Studio :

1. **Tools → Certificate Manager → « + »**
2. Choisir **Samsung** (surtout pas *Tizen* : les certificats Tizen ne sont pas
   reconnus par les TV Samsung)
3. Se connecter avec le compte Samsung Developer
4. **Renseigner le DUID de la TV** quand l'assistant le demande
5. Le profil est écrit dans :

```
Windows : C:\Users\<user>\SamsungCertificate\<profil>\
macOS   : ~/SamsungCertificate/<profil>/
```

et contient les deux fichiers utilisés pour signer :

```
author.p12        ← certificat auteur
distributor.p12   ← certificat distributeur, lié au DUID de la TV
```

Chacun embarque la **chaîne complète** (feuille + intermédiaire + racine Samsung).
C'est cette chaîne, et elle seule, qui fait accepter le package.

### 3. Packager

**Option A — Tizen Studio (recommandé) :**

1. **File → Import → Tizen → Tizen Project** → sélectionner le dossier `tizen-tv/`
2. Clic droit sur le projet → **Build Signed Package**
3. Le fichier `PIPSILY-TV.wgt` apparaît dans `result/`, déjà signé

**Option B — `sign_wgt.py` (signature seule, hors Tizen Studio) :**

Utile pour re-signer un `.wgt` existant pour une autre TV sans relancer l'IDE.
Le script ne crée aucun certificat : il consomme le profil Samsung de l'étape 2.

```bash
python sign_wgt.py \
  --input  PIPSILY-TV.wgt \
  --output PIPSILY-TV-signed.wgt \
  --profile MonProfil \
  --author-pass <mdp> --dist-pass <mdp> \
  --duid BDCJ72JNWV264          # optionnel : vérifie que le certificat vise bien cette TV
```

Dépendances : `pip install cryptography lxml`.

> Le binaire `sign_wgt.exe` livré dans `install-package/` est un build PyInstaller de
> ce script. **Après toute modification de `sign_wgt.py`, il faut le régénérer**, sinon
> l'installateur continue d'utiliser l'ancienne logique :
> `pyinstaller --onefile sign_wgt.py`

### 4. Installer sur la TV via sdb

```bash
# Connecter la TV (remplacer IP par l'IP de ta TV)
sdb connect 192.168.1.XXX

# Vérifier la connexion
sdb devices

# Récupérer le DUID (à donner au Certificate Manager)
sdb shell 0 getduid

# Installer le .wgt
sdb install PIPSILY-TV-signed.wgt

# Lancer l'app
sdb shell 0 execute com.morpheus45.pipsily
```

---

## Erreurs d'installation

| Message | Cause réelle | Correctif |
|---|---|---|
| `install failed[118019]` | Chaîne de certificats invalide (« Invalid certificate chain with certificate in signature »). Typiquement un certificat auto-signé, ou un seul certificat au lieu de la chaîne complète. | Signer avec un profil **Samsung** (étape 2) |
| `download failed[16]` | Le `.wgt` n'est pas au chemin passé à `vd_appinstall` | `sdb push` le fichier d'abord, ou utiliser `sdb install` |
| Installation OK mais DUID d'une autre TV | Le certificat distributeur est lié à un DUID précis | Re-signer avec le profil de la bonne TV |

Pour vérifier ce que contient réellement un `.wgt` avant de perdre du temps sur la TV :

```python
# nombre de certificats dans la chaîne — doit être > 1
import zipfile, re
x = zipfile.ZipFile("PIPSILY-TV-signed.wgt").read("signature1.xml").decode()
print(len(re.findall(r"<X509Certificate>", x)))
```

---

## Workflow de mise à jour

Quand une nouvelle version est prête, le processus est le suivant :

### Côté développeur

```
1. Modifier le code PIPSILY (app.js, styles.css, etc.)
2. Incrémenter tizen_version dans version.json (ex: 1 → 2)
3. Mettre à jour tizen_changes dans version.json
4. Lancer .\build.ps1 pour copier les nouveaux fichiers
5. Dans Tizen Studio : Build Signed Package → PIPSILY-TV.wgt
6. Créer un release GitHub : tag "tv-v2", uploader PIPSILY-TV.wgt
7. Mettre à jour tizen_url dans version.json
8. git push origin main
```

⚠ **Limite du modèle « une release pour tout le monde »** : le certificat distributeur
est lié au DUID d'**une** TV. Le `.wgt` publié dans une release ne s'installe donc que
sur la TV pour laquelle il a été signé. Pour équiper une autre TV, il faut re-signer
avec un profil créé pour son DUID (étape 2, puis `sign_wgt.py --profile`).

Cela vaut aussi pour la mise à jour automatique décrite ci-dessous : `tizen-update.js`
télécharge le `.wgt` de la release, qui sera rejeté sur toute TV autre que celle
d'origine. Tant qu'il n'y a qu'une TV, ça fonctionne ; au-delà, il faut soit un
`.wgt` par DUID, soit un compte Samsung Partner.

### Côté TV (automatique)

Au prochain lancement de l'app :
1. `tizen-update.js` vérifie `version.json` sur GitHub Pages
2. Si `tizen_version` > version installée → overlay "Mise à jour disponible"
3. L'utilisateur clique "Mettre à jour maintenant"
4. Téléchargement du `.wgt` + installation via `tizen.package.install()`
5. L'app se relance automatiquement

---

## Commandes sdb utiles

```bash
# Lister les apps installées (marche sur TV de série)
sdb shell 0 applist

# DUID de la TV
sdb shell 0 getduid

# Profil / version de plateforme
sdb capability

# Désinstaller l'app
sdb shell 0 vd_appuninstall com.morpheus45.pipsily

# Copier un fichier vers la TV
sdb push fichier.wgt /home/owner/share/tmp/sdk_tools/tmp/
```

⚠ Sur une TV de série (non debug), ces commandes répondent `closed` et ne
fonctionnent **pas**, quelle que soit la configuration :

- `sdb shell` sans wrapper `0` (pas de shell interactif)
- `sdb dlog` (logs plateforme fermés)

Le diagnostic se limite donc au code de retour de `vd_appinstall`, d'où l'intérêt
du tableau *Erreurs d'installation* ci-dessus.

---

## Notes importantes

- **Pas de Service Worker** : les apps `.wgt` Tizen packagées ne supportent pas les Service Workers. La mise à jour est gérée par `tizen-update.js` à la place.
- **HLS.js** est épinglé à `1.5.15` (version fixe) pour éviter des régressions sur le moteur WebKit de Tizen.
- **`$TIZEN_SCRIPT`** dans `index.html` est un placeholder remplacé automatiquement par Tizen Studio lors du build — ne pas modifier.
- **`updateBar`** de PIPSILY est conservé dans le DOM mais masqué (`display:none`) pour éviter les erreurs JavaScript dans `app.js`.
- Le profil `tv-samsung-public-7.0` cible Tizen 3.0+ (TV depuis 2016). Pour les TV plus anciennes, changer en `tv-samsung-public-5.0`.
- **`packagemanager.install`** nécessite une signature Samsung Partner (au-delà du certificat développeur standard). Si l'API n'est pas disponible, `tizen-update.js` affiche un message de fallback avec le lien de téléchargement. À noter : ce privilège n'est **pas** la cause de l'erreur `118019` — le retirer de `config.xml` ne change rien, seul le certificat compte.
- **Canonicalisation XML** — `sign_wgt.py` calcule les digests et la signature sur des éléments **déjà rattachés** à `<Signature>`, et sérialise **sans `pretty_print`**. Ces deux points sont indispensables : en C14N inclusive, un élément calculé détaché n'hérite pas du `xmlns` par défaut porté par `<Signature>`, et l'indentation insère des nœuds texte dans `SignedInfo`. Dans les deux cas la signature reste syntaxiquement présente mais devient invalide. Ne pas réintroduire `pretty_print=True`.
