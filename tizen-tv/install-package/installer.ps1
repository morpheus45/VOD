#Requires -Version 5.0
# installer.ps1 — PIPSILY TV — Installateur Samsung Smart TV
# Usage : lancé automatiquement par INSTALLER.bat

param([string]$BaseDir = $PSScriptRoot)
$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "PIPSILY TV — Installateur Samsung"

# ─── Couleurs ────────────────────────────────────────────────────────────────
function Write-Step   { param($n,$t) Write-Host "  [$n] $t" -ForegroundColor Cyan }
function Write-OK     { param($t)    Write-Host "  ✓  $t" -ForegroundColor Green }
function Write-Warn   { param($t)    Write-Host "  ⚠  $t" -ForegroundColor Yellow }
function Write-Err    { param($t)    Write-Host "  ✗  $t" -ForegroundColor Red }
function Write-Info   { param($t)    Write-Host "     $t" -ForegroundColor Gray }
function Write-Line   { Write-Host "  " + ("─" * 56) -ForegroundColor DarkGray }
function Write-Banner {
  Clear-Host
  Write-Host ""
  Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
  Write-Host "  ║        PIPSILY TV — Installateur Samsung TV          ║" -ForegroundColor Cyan
  Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
  Write-Host ""
}

Write-Banner

# ─── Chemins ─────────────────────────────────────────────────────────────────
$SdbExe  = Join-Path $BaseDir "sdb\sdb.exe"
$WgtFile = Join-Path $BaseDir "PIPSILY-TV-signed.wgt"
$AppId   = "com.morpheus45.pipsily"

# ─── Vérifications préliminaires ─────────────────────────────────────────────
Write-Step "0" "Vérification des fichiers..."

if (-not (Test-Path $SdbExe)) {
  Write-Err "sdb.exe introuvable : $SdbExe"
  Write-Info "Le dossier sdb\ doit être présent à côté de INSTALLER.bat"
  Read-Host "`n  Appuyer sur Entrée pour quitter" | Out-Null
  exit 1
}
Write-OK "sdb.exe trouvé"

if (-not (Test-Path $WgtFile)) {
  Write-Err "Package introuvable : PIPSILY-TV-signed.wgt"
  Write-Info "Vérifier que le fichier est bien dans le même dossier que INSTALLER.bat"
  Read-Host "`n  Appuyer sur Entrée pour quitter" | Out-Null
  exit 1
}
$wgtSize = [Math]::Round((Get-Item $WgtFile).Length / 1KB)
Write-OK "PIPSILY-TV-signed.wgt trouvé ($wgtSize Ko)"

Write-Host ""
Write-Line

# ─── Guide : activer le mode développeur ─────────────────────────────────────
Write-Host ""
Write-Host "  ┌─ ÉTAPE 1 : Mode développeur sur ta TV Samsung ────────────┐" -ForegroundColor Yellow
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  │  1. Sur la télécommande : Accueil → Paramètres             │" -ForegroundColor White
Write-Host "  │  2. Support → À propos de ce TV                            │" -ForegroundColor White
Write-Host "  │  3. Clique 5 fois sur le numéro de MODÈLE affiché          │" -ForegroundColor White
Write-Host "  │  4. Dialogue : Mode développeur → Activé (ON)              │" -ForegroundColor White
Write-Host "  │  5. Entre l'adresse IP de CE PC (indiqué ci-dessous)       │" -ForegroundColor White
Write-Host "  │  6. Redémarre la TV                                         │" -ForegroundColor White
Write-Host "  │                                                             │" -ForegroundColor DarkGray
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
Write-Host ""

# Afficher l'IP locale du PC
Write-Host "  IP de CE PC :" -ForegroundColor Cyan -NoNewline
$localIps = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.*" }
).IPAddress
if ($localIps) {
  $localIps | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
} else {
  Write-Host "  (non détectée — voir Paramètres Windows → Wi-Fi → Propriétés)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  ┌─ COMMENT TROUVER L'IP DE LA TV ────────────────────────────┐" -ForegroundColor DarkGray
Write-Host "  │  TV : Paramètres → Général → Réseau → État du réseau       │" -ForegroundColor Gray
Write-Host "  │       → Informations IP                                     │" -ForegroundColor Gray
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor DarkGray
Write-Host ""

Read-Host "  → Appuyer sur Entrée quand le mode développeur est activé et la TV redémarrée" | Out-Null

# ─── Saisie IP TV ─────────────────────────────────────────────────────────────
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
Write-Info "Assure-toi que la TV et ce PC sont sur le même réseau Wi-Fi"
Write-Host ""

$connectOut = & $SdbExe connect $tvIp 2>&1 | Out-String
Write-Info $connectOut.Trim()

# Vérifier connexion
$devices = & $SdbExe devices 2>&1 | Out-String
if ($devices -match $tvIp -or $devices -match "device") {
  Write-OK "TV connectée !"
} else {
  Write-Host ""
  Write-Warn "Connexion difficile. Vérifie que :"
  Write-Info "  - La TV est en mode développeur (étape 1)"
  Write-Info "  - L'IP du PC est bien entrée dans la TV"
  Write-Info "  - TV et PC sont sur le même réseau Wi-Fi"
  Write-Info "  - La TV a bien redémarré après activation du mode dev"
  Write-Host ""
  $retry = Read-Host "  Réessayer ? (O/n)"
  if ($retry -eq "n" -or $retry -eq "N") { exit 1 }

  Write-Step "1" "Nouvelle tentative..."
  & $SdbExe disconnect $tvIp 2>&1 | Out-Null
  Start-Sleep 2
  & $SdbExe connect $tvIp 2>&1 | Out-Null
}

Write-Host ""
Write-Line

# ─── Installation ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ┌─ ÉTAPE 3 : Installation de PIPSILY TV ─────────────────────┐" -ForegroundColor Yellow
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
Write-Host ""
Write-Step "2" "Installation du package sur la TV..."
Write-Info "Cela peut prendre 30 à 60 secondes..."
Write-Host ""

$installOut = & $SdbExe install $WgtFile 2>&1 | Out-String
Write-Info $installOut.Trim()

if ($installOut -match "successful|installed|success" -or $LASTEXITCODE -eq 0) {
  Write-OK "Installation réussie !"
} else {
  Write-Warn "Résultat incertain — vérification..."
  $appCheck = & $SdbExe shell 0 applist 2>&1 | Out-String
  if ($appCheck -match $AppId) {
    Write-OK "Application présente sur la TV !"
  } else {
    Write-Err "Installation échouée."
    Write-Info "Sortie : $installOut"
    Write-Host ""
    Write-Info "Si l'erreur mentionne 'signature' ou 'certificate' :"
    Write-Info "  → Le mode développeur TV n'est pas encore actif"
    Write-Info "  → Redémarre la TV et relance cet installateur"
    Read-Host "`n  Entrée pour quitter" | Out-Null
    exit 1
  }
}

Write-Host ""
Write-Line

# ─── Lancement ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Step "3" "Lancement de PIPSILY TV..."
& $SdbExe shell 0 execute $AppId 2>&1 | Out-Null

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
