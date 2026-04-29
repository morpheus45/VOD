@echo off
chcp 65001 > nul
echo.
echo ╔═══════════════════════════════════════════════════╗
echo ║         PIPSILY — Compilation APK Android         ║
echo ╚═══════════════════════════════════════════════════╝
echo.

:: Vérifier Java
where java > nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Java n'est pas dans le PATH.
    echo Installez Java 17 : https://adoptium.net/
    pause & exit /b 1
)

:: Permissions gradlew (Windows ne nécessite pas chmod)
set KEYSTORE=%~dp0release.jks

if exist "%KEYSTORE%" (
    echo [INFO] Keystore release trouvé → APK signé ^(installable par-dessus^)
    set BUILD_TYPE=assembleRelease
    set SIGNING_ARGS=-Pandroid.injected.signing.store.file=%KEYSTORE%
    :: Lire KS_PASS, KS_ALIAS, KS_KEY_PASS depuis l'env ou utiliser les valeurs par défaut
    if "%KS_PASS%"=="" set KS_PASS=android
    if "%KS_ALIAS%"=="" set KS_ALIAS=pipsily
    if "%KS_KEY_PASS%"=="" set KS_KEY_PASS=android
    set SIGNING_ARGS=%SIGNING_ARGS% -Pandroid.injected.signing.store.password=%KS_PASS%
    set SIGNING_ARGS=%SIGNING_ARGS% -Pandroid.injected.signing.key.alias=%KS_ALIAS%
    set SIGNING_ARGS=%SIGNING_ARGS% -Pandroid.injected.signing.key.password=%KS_KEY_PASS%
    set OUT_APK=app\build\outputs\apk\release\app-release.apk
) else (
    echo [INFO] Pas de keystore release.jks — APK debug généré
    echo [INFO] L'APK debug ne peut pas se mettre à jour par-dessus un APK release.
    echo [INFO] Pour signer : créez release.jks avec keytool et relancez ce script.
    set BUILD_TYPE=assembleDebug
    set SIGNING_ARGS=
    set OUT_APK=app\build\outputs\apk\debug\app-debug.apk
)

echo.
echo [BUILD] Compilation %BUILD_TYPE%...
call gradlew.bat %BUILD_TYPE% %SIGNING_ARGS% --stacktrace

if errorlevel 1 (
    echo.
    echo [ERREUR] La compilation a échoué.
    echo Ouvrez Android Studio pour voir les erreurs détaillées.
    pause & exit /b 1
)

:: Copier et renommer l'APK
copy "%OUT_APK%" "PIPSILY.apk" > nul
echo.
echo ╔═══════════════════════════════════════════════════╗
echo ║  ✅  APK généré : android-app\PIPSILY.apk         ║
echo ╚═══════════════════════════════════════════════════╝
echo.
echo Prochaines étapes :
echo   1. Publiez PIPSILY.apk sur GitHub Releases ^(tag v5^)
echo   2. OU double-cliquez pour l'installer directement
echo.
pause
