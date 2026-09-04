#Requires -Version 5.0
# installer.ps1 — PIPSILY TV — Installateur Samsung Smart TV
# Usage : lancé automatiquement par INSTALLER.bat
#
# Cet installateur N'EST PAS un installateur « sans compte » : il ne peut pas
# fabriquer un certificat valide. Une TV Samsung valide la chaîne de
# certification du distributeur contre la CA racine Samsung, donc le .wgt doit
# avoir été signé au préalable avec un profil Samsung créé dans Tizen Studio
# (Certificate Manager → « + » → Samsung) POUR LE DUID DE CETTE TV.
#
# Ce que fait ce script :
#   - connecte la TV en sdb
#   - lit son DUID automatiquement
#   - vérifie que le .wgt fourni est réellement signable/installable sur elle
#   - installe et lance l'app
#
# Voir tizen-tv/TIZEN-README.md pour la production du .wgt signé.

param([string]$BaseDir = $PSScriptRoot)
$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "PIPSILY TV — Installateur Samsung"

# ─── Couleurs ────────────────────────────────────────────────────────────────
function Write-Step   { param($n,$t) Write-Host "  [$n] $t" -ForegroundColor Cyan }
function Write-OK     { param($t)    Write-Host "  ✓  $t" -ForegroundColor Green }
function Write-Warn   { param($t)    Write-Host "  ⚠  $t" -ForegroundColor Yellow }
function Write-Err    { param($t)    Write-Host "  ✗  $t" -ForegroundColor Red }
function Write-Info   { param($t)    Write-Host "     $t" -ForegroundColor Gray }
function Write-Line   { Write-Host ("  " + "─" * 56) -ForegroundColor DarkGray }
function Write-Banner {
  Clear-Host
  Write-Host ""
  Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
  Write-Host "  ║        PIPSILY TV — Installateur Samsung TV          ║" -ForegroundColor Cyan
  Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
  Write-Host ""
}
function Quit-With { param($code) Read-Host "`n  Entrée pour quitter" | Out-Null; exit $code }

Write-Banner

# ─── Chemins ─────────────────────────────────────────────────────────────────
$SdbExe    = Join-Path $BaseDir "sdb\sdb.exe"
$WgtSigned = Join-Path $BaseDir "PIPSILY-TV-signed.wgt"
$AppId     = "com.morpheus45.pipsily"

# ─── ÉTAPE 0 : Vérification des fichiers ─────────────────────────────────────
Write-Step "0" "Vérification des fichiers..."

if (-not (Test-Path $SdbExe)) {
  Write-Err "sdb.exe introuvable : $SdbExe"
  Write-Info "Le dossier sdb\ doit être présent à côté de INSTALLER.bat"
  Quit-With 1
}
Write-OK "sdb.exe trouvé"

if (-not (Test-Path $WgtSigned)) {
  Write-Err "Package introuvable : PIPSILY-TV-signed.wgt"
  Write-Host ""
  Write-Info "Ce fichier doit être signé avec un profil de certificats Samsung"
  Write-Info "créé pour TA TV. Voir tizen-tv/TIZEN-README.md, section"
  Write-Info "« Créer le profil de certificats »."
  Quit-With 1
}
Write-OK "PIPSILY-TV-signed.wgt trouvé"

Write-Host ""
Write-Line

# ─── ÉTAPE 1 : Guide mode développeur ────────────────────────────────────────
Write-Host ""
Write-Host "  ┌─ ÉTAPE 1 : Mode développeur sur ta TV Samsung ────────────┐" -ForegroundColor Yellow
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  │  1. Paramètres → Support → À propos de ce TV                │" -ForegroundColor White
Write-Host "  │  2. Clique 5 fois sur le NUMÉRO DE MODÈLE                   │" -ForegroundColor White
Write-Host "  │  3. Mode développeur → Activé (ON)                          │" -ForegroundColor White
Write-Host "  │  4. Entre l'adresse IP de CE PC dans 'Host PC IP'           │" -ForegroundColor White
Write-Host "  │  5. Redémarre la TV                                         │" -ForegroundColor White
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
Write-Host ""

# Afficher l'IP locale du PC
Write-Host "  IP de CE PC :" -ForegroundColor Cyan -NoNewline
try {
  $localIps = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.*" }
  ).IPAddress
  if ($localIps) {
    $localIps | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
  } else { Write-Host "  (voir Paramètres Windows → Wi-Fi → Propriétés)" -ForegroundColor Yellow }
} catch { Write-Host "  (non détectée)" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  ┌─ COMMENT TROUVER L'IP DE LA TV ────────────────────────────┐" -ForegroundColor DarkGray
Write-Host "  │  TV : Paramètres → Général → Réseau → État du réseau       │" -ForegroundColor Gray
Write-Host "  │       → Informations IP                                     │" -ForegroundColor Gray
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor DarkGray
Write-Host ""
Read-Host "  → Appuyer sur Entrée quand le mode développeur est activé et la TV redémarrée" | Out-Null

# ─── ÉTAPE 2 : Saisie IP TV + connexion ──────────────────────────────────────
Write-Banner
Write-Host "  ┌─ ÉTAPE 2 : Connexion à la TV ──────────────────────────────┐" -ForegroundColor Yellow
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
Write-Host ""

$tvIp = ""
while ($true) {
  $tvIp = (Read-Host "  Entre l'adresse IP de ta TV Samsung (ex: 192.168.1.50)").Trim()
  if ($tvIp -match '^\d{1,3}(\.\d{1,3}){3}$') { break }
  Write-Warn "Adresse IP invalide. Format attendu : 192.168.1.XXX"
}

Write-Host ""
Write-Step "1" "Connexion à la TV ($tvIp)..."
Write-Host ""

$ErrorActionPreference = "Continue"
$connectOut = & $SdbExe connect $tvIp | Out-String
Write-Info $connectOut.Trim()

$devices = & $SdbExe devices | Out-String
if ($devices -match [regex]::Escape($tvIp)) {
  Write-OK "TV connectée !"
} else {
  Write-Host ""
  Write-Warn "Connexion difficile. Vérifie que :"
  Write-Info "  - La TV est en mode développeur (étape 1)"
  Write-Info "  - L'IP de CE PC est bien entrée dans 'Host PC IP' sur la TV"
  Write-Info "  - TV et PC sont sur le même réseau Wi-Fi"
  Write-Info "  - La TV a bien redémarré après activation du mode dev"
  Write-Host ""
  $retry = Read-Host "  Réessayer ? (O/n)"
  if ($retry -eq "n" -or $retry -eq "N") { exit 1 }

  Write-Step "1" "Nouvelle tentative..."
  & $SdbExe disconnect $tvIp | Out-Null
  Start-Sleep 2
  & $SdbExe connect $tvIp | Out-Null

  $devices = & $SdbExe devices | Out-String
  if (-not ($devices -match [regex]::Escape($tvIp))) {
    Write-Err "Impossible de joindre la TV. Abandon."
    Quit-With 1
  }
  Write-OK "TV connectée !"
}

Write-Host ""
Write-Line

# ─── ÉTAPE 3 : DUID de la TV (automatique) ───────────────────────────────────
Write-Host ""
Write-Step "2" "Lecture du DUID de la TV..."

$tvDuid = (& $SdbExe -s "${tvIp}:26101" shell 0 getduid | Out-String).Trim()
if ($tvDuid -match '^[A-Za-z0-9\-]{8,64}$') {
  Write-OK "DUID : $tvDuid"
} else {
  $tvDuid = ""
  Write-Warn "DUID illisible — la vérification du certificat sera partielle."
}

Write-Host ""
Write-Line

# ─── ÉTAPE 4 : Contrôle du package avant installation ────────────────────────
Write-Host ""
Write-Step "3" "Contrôle de la signature du package..."

Add-Type -AssemblyName System.IO.Compression.FileSystem
$certCount = 0
$certSubjects = @()
try {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($WgtSigned)
  $entry = $zip.Entries | Where-Object { $_.FullName -eq "signature1.xml" }
  if ($entry) {
    $reader = New-Object System.IO.StreamReader($entry.Open())
    $xml = $reader.ReadToEnd(); $reader.Close()
    $matches = [regex]::Matches($xml, '<X509Certificate>([^<]+)</X509Certificate>')
    $certCount = $matches.Count
    foreach ($m in $matches) {
      $der = [Convert]::FromBase64String(($m.Groups[1].Value -replace '\s',''))
      $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(,$der)
      $certSubjects += $c.Subject
    }
  }
  $zip.Dispose()
} catch {
  Write-Warn "Lecture de la signature impossible : $_"
}

if ($certCount -eq 0) {
  Write-Err "Le package ne contient aucune signature distributeur."
  Quit-With 1
}

Write-Info "Chaîne de $certCount certificat(s) dans signature1.xml"

if ($certCount -lt 2) {
  Write-Host ""
  Write-Err "Certificat auto-signé — la TV va refuser (erreur 118019)."
  Write-Host ""
  Write-Host "  POURQUOI :" -ForegroundColor Yellow
  Write-Info "La TV valide la CHAÎNE du certificat contre la CA racine Samsung."
  Write-Info "Un certificat isolé, même avec le bon DUID, est rejeté."
  Write-Host ""
  Write-Host "  CE QU'IL FAUT FAIRE :" -ForegroundColor Yellow
  Write-Info "1. Installer Tizen Studio + l'extension Samsung TV"
  Write-Info "2. Tools → Certificate Manager → « + » → Samsung"
  Write-Info "3. Se connecter avec un compte Samsung Developer (gratuit)"
  Write-Info "4. Renseigner le DUID de cette TV : $tvDuid"
  Write-Info "5. Re-signer le package avec ce profil, puis relancer ce script"
  Write-Host ""
  Write-Info "Détail complet : tizen-tv/TIZEN-README.md"
  Quit-With 1
}

Write-OK "Chaîne de certification complète"

if ($tvDuid -and ($certSubjects -join ' ') -notmatch [regex]::Escape($tvDuid)) {
  Write-Host ""
  Write-Warn "Le DUID $tvDuid n'apparaît pas dans le certificat distributeur."
  Write-Info "Ce package a probablement été signé pour une AUTRE TV."
  Write-Info "L'installation va sans doute échouer en 118019."
  Write-Host ""
  $go = Read-Host "  Tenter quand même ? (o/N)"
  if ($go -ne "o" -and $go -ne "O") { exit 1 }
} elseif ($tvDuid) {
  Write-OK "Le certificat vise bien cette TV"
}

Write-Host ""
Write-Line

# ─── ÉTAPE 5 : Installation ───────────────────────────────────────────────────
Write-Host ""
Write-Host "  ┌─ ÉTAPE 5 : Installation de PIPSILY TV ─────────────────────┐" -ForegroundColor Yellow
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
Write-Host ""
Write-Step "4" "Installation du package sur la TV..."
Write-Info "Cela peut prendre 30 à 60 secondes..."
Write-Host ""

$installOut = & $SdbExe -s "${tvIp}:26101" install $WgtSigned | Out-String
Write-Info $installOut.Trim()

$appCheck = & $SdbExe -s "${tvIp}:26101" shell 0 applist | Out-String
$installOk = $appCheck -match [regex]::Escape($AppId)

if (-not $installOk) {
  Write-Host ""
  Write-Err "Installation échouée."
  Write-Host ""

  if ($installOut -match "118019") {
    Write-Host "  CAUSE : Chaîne de certificats refusée par la TV." -ForegroundColor Red
    Write-Info "Le certificat distributeur doit être émis par Samsung"
    Write-Info "pour le DUID $tvDuid — voir tizen-tv/TIZEN-README.md"
  } elseif ($installOut -match "download failed") {
    Write-Host "  CAUSE : Le package n'a pas été transféré sur la TV." -ForegroundColor Red
    Write-Info "Relancer le script ; vérifier l'espace disque de la TV."
  } elseif ($installOut -match "closed") {
    Write-Host "  CAUSE : La TV a fermé la connexion." -ForegroundColor Red
    Write-Info "1. Désactiver le mode développeur, le réactiver"
    Write-Info "   et bien entrer l'IP de CE PC dans 'Host PC IP'"
    Write-Info "2. Laisser la TV démarrer 30 secondes après le reboot"
    Write-Info "3. Relancer cet installateur"
  } else {
    Write-Info "Sortie sdb : $installOut"
  }

  Quit-With 1
}

Write-OK "Application présente sur la TV !"

Write-Host ""
Write-Line

# ─── ÉTAPE 6 : Lancement ──────────────────────────────────────────────────────
Write-Host ""
Write-Step "5" "Lancement de PIPSILY TV..."
& $SdbExe -s "${tvIp}:26101" shell 0 execute $AppId | Out-Null

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║                                                          ║" -ForegroundColor Green
Write-Host "  ║   ✓  PIPSILY TV est installé et lancé !                 ║" -ForegroundColor Green
Write-Host "  ║                                                          ║" -ForegroundColor Green
Write-Host "  ║   L'app vérifiera les mises à jour automatiquement       ║" -ForegroundColor Green
Write-Host "  ║   à chaque lancement — rien d'autre à faire.            ║" -ForegroundColor Green
Write-Host "  ║                                                          ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Info "Tu peux fermer cette fenêtre."
Write-Host ""
Read-Host "  Entrée pour quitter" | Out-Null
