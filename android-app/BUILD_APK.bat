@echo off
chcp 65001 > nul
echo ╔═══════════════════════════════════════════════════╗
echo ║        PIPSIFLIX — Compilation APK Android        ║
echo ╚═══════════════════════════════════════════════════╝
echo.

:: Vérifier que JAVA est disponible
where java > nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Java n'est pas installé ou pas dans le PATH.
    echo Téléchargez Java 17 : https://adoptium.net/
    pause & exit /b 1
)

:: Télécharger Gradle wrapper si absent
if not exist "gradle\wrapper\gradle-wrapper.jar" (
    echo [INFO] Téléchargement du Gradle wrapper...
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/gradle/gradle/raw/v8.6.0/gradle/wrapper/gradle-wrapper.jar' -OutFile 'gradle\wrapper\gradle-wrapper.jar'"
)

:: Générer un keystore de debug si absent
if not exist "debug.keystore" (
    echo [INFO] Génération du keystore de debug...
    keytool -genkey -v -keystore debug.keystore -alias androiddebugkey ^
        -keyalg RSA -keysize 2048 -validity 10000 ^
        -storepass android -keypass android ^
        -dname "CN=PIPSIFLIX,O=Android,C=FR" 2>nul
)

:: Copier le keystore dans le dossier local
copy debug.keystore app\debug.keystore > nul 2>&1

:: Compiler l'APK debug
echo [BUILD] Compilation en cours...
call gradlew.bat assembleDebug

if errorlevel 1 (
    echo.
    echo [ERREUR] La compilation a échoué.
    echo Ouvrez le projet dans Android Studio pour voir les erreurs.
    pause & exit /b 1
)

echo.
echo ✅ APK généré avec succès !
echo.
echo Emplacement : app\build\outputs\apk\debug\app-debug.apk
echo.
echo Pour installer sur votre téléphone :
echo   1. Activez "Sources inconnues" dans Paramètres Android
echo   2. Copiez app-debug.apk sur votre téléphone
echo   3. Ouvrez-le pour installer
echo.
echo Pour installer sur Android TV :
echo   adb connect [IP_DE_VOTRE_TV]:5555
echo   adb install app\build\outputs\apk\debug\app-debug.apk
echo.
pause
