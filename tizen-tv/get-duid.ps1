<#
  get-duid.ps1 - Recupere le DUID d'une TV Samsung
  ------------------------------------------------
  A executer depuis un PC Windows situe SUR LE MEME RESEAU que la TV.
  Le DUID est indispensable pour emettre le certificat distributeur Samsung
  qui autorisera l'installation de PIPSILY TV sur cette TV precise.

  Prealable sur la TV :
    Parametres > Support > A propos de ce TV
    > appuyer 5 fois sur OK sur le numero de modele
    > Mode developpeur : ON, saisir l'IP de ce PC, puis redemarrer la TV

  Usage :
    .\get-duid.ps1 -TvIp 192.168.1.42
#>
param([Parameter(Mandatory=$true)][string]$TvIp)

$ErrorActionPreference = "Continue"

$sdb = @(
  "C:\tizen-studio\tools\sdb.exe",
  "$env:USERPROFILE\tizen-studio\tools\sdb.exe",
  "C:\Program Files\Tizen Studio\tools\sdb.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $sdb) {
  Write-Host "sdb.exe introuvable." -ForegroundColor Red
  Write-Host "Installe Tizen Studio, ou copie sdb.exe (+ ANSI32.dll) a cote de ce script." -ForegroundColor Yellow
  $local = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "sdb.exe"
  if (Test-Path $local) { $sdb = $local } else { exit 1 }
}

Write-Host "`nsdb : $sdb" -ForegroundColor DarkGray
Write-Host "Connexion a $TvIp ..." -ForegroundColor Cyan

& $sdb kill-server 2>&1 | Out-Null
& $sdb start-server 2>&1 | Out-Null
$connect = & $sdb connect $TvIp 2>&1 | Out-String
Write-Host $connect.Trim() -ForegroundColor DarkGray

$devices = & $sdb devices 2>&1 | Out-String
if ($devices -notmatch [regex]::Escape($TvIp)) {
  Write-Host "`nECHEC : la TV ne repond pas." -ForegroundColor Red
  Write-Host "  - Verifie que le mode developpeur est ON et la TV redemarree" -ForegroundColor Yellow
  Write-Host "  - Verifie que l'IP saisie sur la TV est bien celle de CE PC" -ForegroundColor Yellow
  Write-Host "  - Verifie que PC et TV sont sur le meme reseau (pas d'isolation client Wi-Fi)" -ForegroundColor Yellow
  exit 1
}

$duid  = (& $sdb -s "${TvIp}:26101" shell 0 getduid 2>&1 | Out-String).Trim()
$caps  = & $sdb -s "${TvIp}:26101" capability 2>&1 | Out-String

$model    = ([regex]::Match($caps, "platform_name:(.*)")).Groups[1].Value.Trim()
$version  = ([regex]::Match($caps, "platform_version:(.*)")).Groups[1].Value.Trim()
$profile  = ([regex]::Match($caps, "profile_name:(.*)")).Groups[1].Value.Trim()

Write-Host "`n===============================================" -ForegroundColor Green
Write-Host "  DUID    : $duid" -ForegroundColor Green
Write-Host "  Platform: $model $version ($profile)" -ForegroundColor Green
Write-Host "===============================================`n" -ForegroundColor Green

$out = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "duid.txt"
"$duid" | Out-File -FilePath $out -Encoding ascii
Write-Host "Ecrit dans : $out" -ForegroundColor Cyan
Write-Host "Transmets cette ligne pour l'emission du certificat distributeur.`n"
