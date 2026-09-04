#!/bin/bash
# PIPSILY TV — Installateur Samsung Smart TV (macOS)
# Double-cliquer pour lancer depuis le Finder

# Aller dans le dossier du script (nécessaire pour les chemins relatifs)
cd "$(dirname "$0")"

# Couleurs terminal
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; WHITE='\033[1;37m'; GRAY='\033[0;37m'; NC='\033[0m'

SDB="$(pwd)/sdb/sdb"
WGT="$(pwd)/PIPSILY-TV-signed.wgt"
APP_ID="com.morpheus45.pipsily"

clear
echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║        PIPSILY TV — Installateur Samsung TV          ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Vérifications ─────────────────────────────────────────────────────────────
echo -e "${CYAN}  [0] Vérification des fichiers...${NC}"

if [ ! -f "$SDB" ]; then
  echo -e "${RED}  ✗  sdb introuvable : $SDB${NC}"
  echo "     Vérifier que le dossier sdb/ est présent"
  read -p "  Entrée pour quitter..." ; exit 1
fi

# Supprimer la quarantaine macOS et rendre exécutable
xattr -d com.apple.quarantine "$SDB" 2>/dev/null || true
chmod +x "$SDB"
echo -e "${GREEN}  ✓  sdb prêt${NC}"

if [ ! -f "$WGT" ]; then
  echo -e "${RED}  ✗  PIPSILY-TV-signed.wgt introuvable${NC}"
  read -p "  Entrée pour quitter..." ; exit 1
fi
WGT_SIZE=$(du -k "$WGT" | cut -f1)
echo -e "${GREEN}  ✓  PIPSILY-TV-signed.wgt trouvé (${WGT_SIZE} Ko)${NC}"

echo ""
echo "  ────────────────────────────────────────────────────────"

# ── Guide mode développeur ────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}  ┌─ ÉTAPE 1 : Mode développeur sur ta TV Samsung ─────────┐${NC}"
echo -e "${YELLOW}  │                                                          │${NC}"
echo    "  │  1. Télécommande → Accueil → Paramètres (⚙)             │"
echo    "  │  2. Support → À propos de ce TV                          │"
echo    "  │  3. Clique 5 fois sur le NUMÉRO DE MODÈLE               │"
echo    "  │  4. Mode développeur → ON                                │"
echo    "  │  5. Entre l'adresse IP de CE Mac (voir ci-dessous)       │"
echo    "  │  6. Confirmer → Redémarrer la TV                         │"
echo -e "${YELLOW}  └──────────────────────────────────────────────────────────┘${NC}"
echo ""

# Afficher l'IP locale du Mac
echo -e "${CYAN}  IP de CE Mac :${NC}"
ifconfig | grep "inet " | grep -v "127.0.0.1" | awk '{print "    " $2}' | head -5
echo ""

echo -e "${GRAY}  Trouver l'IP de la TV :${NC}"
echo    "  TV → Paramètres → Général → Réseau → État du réseau → Informations IP"
echo ""

read -p "  → Appuyer sur Entrée quand le mode développeur est activé et la TV redémarrée : "

# ── Saisie IP TV ───────────────────────────────────────────────────────────────
clear
echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║        PIPSILY TV — Installateur Samsung TV          ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}  ┌─ ÉTAPE 2 : Connexion à la TV ───────────────────────────┐${NC}"
echo -e "${YELLOW}  └──────────────────────────────────────────────────────────┘${NC}"
echo ""

while true; do
  read -p "  Adresse IP de ta TV Samsung (ex: 192.168.1.50) : " TV_IP
  if [[ "$TV_IP" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    break
  fi
  echo -e "${YELLOW}  ⚠  Format invalide — exemple : 192.168.1.50${NC}"
done

echo ""
echo -e "${CYAN}  [1] Connexion à $TV_IP...${NC}"
echo -e "${GRAY}  Assure-toi que la TV et ce Mac sont sur le même Wi-Fi${NC}"
echo ""

"$SDB" connect "$TV_IP" 2>&1 | sed 's/^/     /'

DEVICES=$("$SDB" devices 2>&1)
if echo "$DEVICES" | grep -q "device"; then
  echo -e "${GREEN}  ✓  TV connectée !${NC}"
else
  echo ""
  echo -e "${YELLOW}  ⚠  Connexion difficile. Vérifier que :${NC}"
  echo    "     - Mode développeur activé et TV redémarrée"
  echo    "     - IP du Mac correctement saisie sur la TV"
  echo    "     - TV et Mac sur le même réseau Wi-Fi"
  echo ""
  read -p "  Réessayer ? (o/n) : " RETRY
  if [[ "$RETRY" == "n" || "$RETRY" == "N" ]]; then exit 1; fi
  "$SDB" disconnect "$TV_IP" 2>/dev/null
  sleep 2
  "$SDB" connect "$TV_IP" 2>&1 | sed 's/^/     /'
fi

echo ""
echo "  ────────────────────────────────────────────────────────"

# ── DUID de la TV ─────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}  [2] Lecture du DUID de la TV...${NC}"
TV_DUID=$("$SDB" shell 0 getduid 2>/dev/null | tr -d '\r\n ')
if [ -n "$TV_DUID" ]; then
  echo -e "${GREEN}  ✓  DUID : ${TV_DUID}${NC}"
else
  echo -e "${YELLOW}  ⚠  DUID illisible${NC}"
fi

# ── Contrôle de la signature ──────────────────────────────────────────────────
# Une TV Samsung valide la CHAÎNE du certificat contre la CA racine Samsung.
# Un certificat isolé (auto-signé) est refusé : install failed[118019].
CERT_COUNT=$(unzip -p "$WGT" signature1.xml 2>/dev/null | grep -c "<X509Certificate>")
echo -e "${GRAY}     Chaîne de ${CERT_COUNT} certificat(s) dans signature1.xml${NC}"

if [ "$CERT_COUNT" -lt 2 ]; then
  echo ""
  echo -e "${RED}  ✗  Certificat auto-signé — la TV va refuser (erreur 118019).${NC}"
  echo ""
  echo -e "${YELLOW}  POURQUOI :${NC}"
  echo    "     La TV valide la CHAÎNE du certificat contre la CA racine"
  echo    "     Samsung. Un certificat isolé, même avec le bon DUID, est rejeté."
  echo ""
  echo -e "${YELLOW}  CE QU'IL FAUT FAIRE :${NC}"
  echo    "     1. Installer Tizen Studio + l'extension Samsung TV"
  echo    "     2. Tools → Certificate Manager → « + » → Samsung"
  echo    "     3. Se connecter avec un compte Samsung Developer (gratuit)"
  echo    "     4. Renseigner le DUID de cette TV : ${TV_DUID}"
  echo    "     5. Re-signer le package, puis relancer ce script"
  echo ""
  echo    "     Détail complet : tizen-tv/TIZEN-README.md"
  read -p "  Entrée pour quitter : " ; exit 1
fi
echo -e "${GREEN}  ✓  Chaîne de certification complète${NC}"

echo ""
echo "  ────────────────────────────────────────────────────────"

# ── Installation ──────────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}  ┌─ ÉTAPE 3 : Installation de PIPSILY TV ──────────────────┐${NC}"
echo -e "${YELLOW}  └──────────────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "${CYAN}  [3] Installation du package sur la TV...${NC}"
echo -e "${GRAY}  Cela peut prendre 30 à 60 secondes...${NC}"
echo ""

INSTALL_OUT=$("$SDB" install "$WGT" 2>&1)
echo "$INSTALL_OUT" | sed 's/^/     /'

# Seule source de vérité : l'app est-elle listée sur la TV ?
APP_CHECK=$("$SDB" shell 0 applist 2>&1)
if echo "$APP_CHECK" | grep -q "$APP_ID"; then
  echo -e "${GREEN}  ✓  Application présente sur la TV !${NC}"
else
  echo -e "${RED}  ✗  Installation échouée.${NC}"
  echo ""
  if echo "$INSTALL_OUT" | grep -q "118019"; then
    echo -e "${RED}  CAUSE : Chaîne de certificats refusée par la TV.${NC}"
    echo    "     Le certificat distributeur doit être émis par Samsung"
    echo    "     pour le DUID ${TV_DUID} — voir tizen-tv/TIZEN-README.md"
  elif echo "$INSTALL_OUT" | grep -qi "download failed"; then
    echo -e "${RED}  CAUSE : Le package n'a pas été transféré sur la TV.${NC}"
    echo    "     Relancer le script ; vérifier l'espace disque de la TV."
  elif echo "$INSTALL_OUT" | grep -qi "closed"; then
    echo -e "${RED}  CAUSE : La TV a fermé la connexion.${NC}"
    echo    "     Désactiver puis réactiver le mode développeur,"
    echo    "     bien saisir l'IP de CE Mac, et relancer."
  fi
  read -p "  Entrée pour quitter : " ; exit 1
fi

echo ""
echo -e "${CYAN}  [4] Lancement de PIPSILY TV...${NC}"
"$SDB" shell 0 execute "$APP_ID" 2>&1 | sed 's/^/     /'

echo ""
echo -e "${GREEN}  ╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}  ║                                                      ║${NC}"
echo -e "${GREEN}  ║   ✓  PIPSILY TV est installé et lancé !             ║${NC}"
echo -e "${GREEN}  ║                                                      ║${NC}"
echo -e "${GREEN}  ║   L'app se met à jour automatiquement à chaque       ║${NC}"
echo -e "${GREEN}  ║   lancement — rien d'autre à faire.                 ║${NC}"
echo -e "${GREEN}  ║                                                      ║${NC}"
echo -e "${GREEN}  ╚══════════════════════════════════════════════════════╝${NC}"
echo ""
read -p "  Entrée pour fermer... "
