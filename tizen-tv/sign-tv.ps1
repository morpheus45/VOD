<#
  sign-tv.ps1 - PIPSILY TV : build + signature Samsung + installation
  ------------------------------------------------------------------
  Prerequis : un profil de certificats SAMSUNG cree dans Tizen Studio
              (Tools > Certificate Manager > + > Samsung), lie au DUID
              de la TV visee. Sans lui : install failed[118019].

  Exemples :
    .\sign-tv.ps1 -ProfileName PIPSILY
    .\sign-tv.ps1 -ProfileName PIPSILY -TvIp 192.168.1.42 -Install
#>
param(
  [Parameter(Mandatory=$true)][string]$ProfileName,
  [string]$Duid,
  [string]$TvIp,
  [switch]$Install
)

$ErrorActionPreference = "Stop"
$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$tizen    = "C:\tizen-studio\tools\ide\bin\tizen.bat"
$sdb      = "C:\tizen-studio\tools\sdb.exe"
$buildDir = Join-Path $root ".buildResult"
$outDir   = Join-Path $root "result"
$outWgt   = Join-Path $outDir "PIPSILY-TV-signed.wgt"

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Fail($m) { Write-Host "`n  ECHEC : $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $tizen)) { Fail "Tizen CLI introuvable : $tizen" }

# --- 1. Verifier le profil de signature -------------------------------------
Step 1 "Verification du profil de signature '$ProfileName'"
$profiles = & $tizen security-profiles list 2>&1 | Out-String
if ($profiles -notmatch [regex]::Escape($ProfileName)) {
  Write-Host $profiles -ForegroundColor DarkGray
  Fail @"
Le profil '$ProfileName' n'existe pas.
Cree-le d'abord : Tizen Studio > Tools > Certificate Manager > '+' > SAMSUNG
(pas 'Tizen' : les certificats Tizen sont refuses par les TV Samsung).
Il faut un compte Samsung Developer et le DUID de la TV.
"@
}
Write-Host "  OK - profil trouve" -ForegroundColor Green

# --- 2. Rafraichir les sources depuis git -----------------------------------
Step 2 "Copie des fichiers PIPSILY depuis git (origin/main)"
$repo  = Split-Path -Parent $root
$files = @("app.js","auth.js","player.js","styles.css","player.css","logo.svg",
           "manifest.webmanifest","version.json","login.html","account.html",
           "admin.html","player.html","apple.html")
Push-Location $repo
# git archive | tar : copie octet pour octet, pas de BOM ajoute, pas de
# conversion de fins de ligne, et contourne les placeholders OneDrive
# non hydrates du working tree.
if (Test-Path (Join-Path $root "icons")) { Remove-Item -Recurse -Force (Join-Path $root "icons") }
# NB : pas de pipe git|tar sous PowerShell (le pipeline convertit en texte
# et corrompt le binaire) -> on passe par un fichier tar temporaire.
$tmpTar = Join-Path $env:TEMP "pipsily-src.tar"
$argsList = @("archive", "-o", $tmpTar, "origin/main", "icons") + $files
& git @argsList
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "git archive a echoue (origin/main introuvable ? lance 'git fetch origin')" }
& tar -x -f $tmpTar -C $root
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "extraction tar echouee" }
Remove-Item $tmpTar -Force -ErrorAction SilentlyContinue
Pop-Location
$missing = $files | Where-Object { -not (Test-Path (Join-Path $root $_)) }
if ($missing) { Fail ("fichiers absents apres extraction : " + ($missing -join ", ")) }
Write-Host "  OK - sources a jour" -ForegroundColor Green

# --- 3. Build web ------------------------------------------------------------
Step 3 "Build de l'application web"
if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
& $tizen build-web -out .buildResult `
    -e "*.md" -e "*.ps1" -e "*.py" -e "*.spec" -e "*.vbs" -e "*.p12" `
    -e "result/*" -e "build/*" -e "dist/*" -e "tools/*" `
    -e "install-package/*" -e "install-package-mac/*" -- $root | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "build-web a echoue" }

# Le CLI n'honore pas toujours *.bat : nettoyage manuel
Get-ChildItem $buildDir -Recurse -Include *.bat,*.py,*.ps1,*.p12,*.md,*.spec,*.vbs |
  Remove-Item -Force -ErrorAction SilentlyContinue
$n = (Get-ChildItem $buildDir -Recurse -File).Count
Write-Host "  OK - $n fichiers dans .buildResult" -ForegroundColor Green

# --- 4. Packaging signe ------------------------------------------------------
Step 4 "Packaging + signature avec le profil '$ProfileName'"
Get-ChildItem $buildDir -Filter *.wgt | Remove-Item -Force -ErrorAction SilentlyContinue
$pkg = & $tizen package -t wgt -s $ProfileName -- $buildDir 2>&1 | Out-String
Write-Host $pkg -ForegroundColor DarkGray
if ($pkg -match "Not found tizen signature file") { Fail "package genere SANS signature" }

$wgt = Get-ChildItem $buildDir -Filter *.wgt | Select-Object -First 1
if (-not $wgt) { Fail "aucun .wgt produit" }

# --- 5. Verification de la chaine de certificats -----------------------------
Step 5 "Verification de la chaine de certificats"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($wgt.FullName)
try {
  $names = $zip.Entries.FullName
  foreach ($need in @("signature1.xml","author-signature.xml")) {
    if ($names -notcontains $need) { Fail "$need absent du .wgt" }
  }
  $e = $zip.GetEntry("signature1.xml")
  $sr = New-Object System.IO.StreamReader($e.Open())
  $xml = $sr.ReadToEnd(); $sr.Close()
  $certs = ([regex]::Matches($xml, "<X509Certificate>")).Count
  Write-Host "  signature1.xml : $certs certificat(s) dans la chaine"
  if ($certs -le 1) {
    Fail "chaine incomplete ($certs certificat) - la TV renverra install failed[118019].
Le profil utilise est probablement un profil TIZEN auto-signe, pas un profil SAMSUNG."
  }

  # Le certificat distributeur Samsung porte le DUID autorise dans son
  # SubjectAltName (URI:URN:tizen:deviceid=...), PAS dans le sujet (CN=TizenSDK).
  # On decode chaque certificat et on concatene sujet + SAN pour la verification :
  # c'est le seul moyen de detecter une signature faite pour la mauvaise TV sans
  # avoir la TV sous la main.
  $subjects = @()
  $haystack = ""
  foreach ($m in [regex]::Matches($xml, "<X509Certificate>(.*?)</X509Certificate>",
                                  [Text.RegularExpressions.RegexOptions]::Singleline)) {
    $b64 = ($m.Groups[1].Value -replace "\s", "")
    try {
      $c = New-Object Security.Cryptography.X509Certificates.X509Certificate2(,[Convert]::FromBase64String($b64))
      $subjects += $c.Subject
      $haystack += " " + $c.Subject
      $san = $c.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.17" }
      if ($san) { $haystack += " " + $san.Format($false) }
    } catch { }
  }
  Write-Host "  sujets : $($subjects -join ' | ')" -ForegroundColor DarkGray
  if ($Duid) {
    if ($haystack -match [regex]::Escape($Duid)) {
      Write-Host "  OK - le certificat vise bien le DUID $Duid (SubjectAltName)" -ForegroundColor Green
    } else {
      Fail "le DUID $Duid n'apparait ni dans le sujet ni dans le SubjectAltName.
Ce package est signe pour une AUTRE TV -> install failed[118019].
Recree le profil dans Certificate Manager en renseignant ce DUID."
    }
  } else {
    Write-Host "  ! DUID non fourni : impossible de verifier la TV visee" -ForegroundColor Yellow
    Write-Host "    (relance avec -Duid <DUID> pour controler avant d'envoyer le .wgt)" -ForegroundColor DarkGray
  }
} finally { $zip.Dispose() }
Write-Host "  OK - chaine Samsung complete" -ForegroundColor Green

# --- 6. Copie dans result/ ---------------------------------------------------
Step 6 "Copie du package"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item $wgt.FullName $outWgt -Force
$mb = [Math]::Round((Get-Item $outWgt).Length / 1MB, 2)
Write-Host "  OK - $outWgt ($mb Mo)" -ForegroundColor Green

# --- 7. Installation sur la TV ----------------------------------------------
if ($Install) {
  Step 7 "Installation sur la TV"
  if ($TvIp) { & $sdb connect $TvIp | Write-Host }
  $devices = & $sdb devices | Out-String
  if ($devices -notmatch "\d+\.\d+\.\d+\.\d+") {
    Fail "aucune TV connectee. Active le mode developpeur sur la TV puis : sdb connect <IP>"
  }
  $duid = (& $sdb shell 0 getduid | Out-String).Trim()
  Write-Host "  DUID de la TV : $duid" -ForegroundColor Yellow
  Write-Host "  (doit correspondre au DUID du certificat distributeur)" -ForegroundColor DarkGray
  & $sdb install $outWgt | Write-Host
} else {
  Write-Host "`nPour installer :" -ForegroundColor Cyan
  Write-Host "  .\sign-tv.ps1 -ProfileName $ProfileName -Duid $Duid -TvIp <IP_DE_LA_TV> -Install"
}

Write-Host "`nTermine.`n" -ForegroundColor Cyan
