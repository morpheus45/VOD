@echo off
chcp 65001 >nul 2>&1

:: ── Si lancé depuis PowerShell, se relancer automatiquement en CMD ──
if defined PSModulePath (
  cmd /c "%~f0" %*
  exit /b
)

color 0B
cls

echo.
echo  ╔══════════════════════════════════════════════════════════╗
echo  ║           PIPSILY TV — Installation Samsung              ║
echo  ║              Application Smart TV (Tizen)                ║
echo  ╚══════════════════════════════════════════════════════════╝
echo.

:: Vérifier si PowerShell est disponible
powershell -Command "exit 0" >nul 2>&1
if errorlevel 1 (
  echo  [ERREUR] PowerShell requis. Mise a jour Windows necessaire.
  pause
  exit /b 1
)

:: Lancer le vrai installer PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer.ps1" "%~dp0"
pause
