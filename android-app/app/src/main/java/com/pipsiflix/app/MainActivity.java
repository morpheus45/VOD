package com.pipsiflix.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;

import androidx.appcompat.app.AppCompatActivity;

/**
 * PIPSILY — Activité principale (phone & tablet)  v5
 *
 * Corrections v5 :
 *  - MIXED_CONTENT_ALWAYS_ALLOW  → flux HTTP lisibles depuis page HTTPS
 *  - openInVlc()  ajouté (requis par app.js pour lecture directe)
 *  - clearCache() / getApkVersion() / downloadAndInstall() ajoutés
 *  - PIPSILY_NATIVE injecté (corrige détection TV/native dans le JS)
 */
public class MainActivity extends AppCompatActivity {

    private static final String APP_URL      = "https://morpheus45.github.io/VOD/";
    private static final String APK_VERSION  = "10";

    WebView     webView;      // package-private pour le bridge
    ProgressBar progressBar;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Plein écran immersif
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );

        setContentView(R.layout.activity_main);
        webView     = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);

        configureWebView();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            // Vider le cache WebView au premier lancement de cette version
            android.content.SharedPreferences prefs =
                getSharedPreferences("pipsily_prefs", MODE_PRIVATE);
            String lastVer = prefs.getString("apk_version", "");
            if (!APK_VERSION.equals(lastVer)) {
                webView.clearCache(true);
                webView.clearHistory();
                prefs.edit().putString("apk_version", APK_VERSION).apply();
            }
            webView.loadUrl(APP_URL);
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "SetJavaScriptInterface"})
    private void configureWebView() {
        WebSettings ws = webView.getSettings();

        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);

        // ── CRITIQUE : autoriser les flux HTTP depuis une page HTTPS ──
        //    Sans cette ligne, les vidéos HTTP sont bloquées (mixed content)
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(true);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);

        // User-Agent : PIPSILY/5
        ws.setUserAgentString(ws.getUserAgentString() + " PIPSILY/5.0");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        // Bridge JavaScript ↔ Java
        webView.addJavascriptInterface(new PipsilyBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();

                // Intent vidéo intercepté (goldenlink ou extension vidéo connue)
                if (isVideoUrl(url)) {
                    openVideoIntent(url);
                    return true;
                }

                // Rester dans notre domaine
                if (url.startsWith("https://morpheus45.github.io")) return false;

                // Tout le reste → navigateur externe
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                progressBar.setVisibility(View.GONE);
                // Injecter les flags natifs (PIPSILY_NATIVE pour le JS renommé)
                view.evaluateJavascript(
                    "window.PIPSILY_NATIVE='android';" +
                    "window.PIPSIFLIX_NATIVE='android';", null);  // compat legacy
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                if (progress < 100) {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(progress);
                } else {
                    progressBar.setVisibility(View.GONE);
                }
            }

            private View customView;

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                customView = view;
                webView.setVisibility(View.GONE);
                setContentView(view);
            }

            @Override
            public void onHideCustomView() {
                setContentView(R.layout.activity_main);
                webView = findViewById(R.id.webView);
                webView.setVisibility(View.VISIBLE);
                customView = null;
            }
        });
    }

    /** Ouvre une URL vidéo dans un lecteur système (VLC, MX Player…)
     *  Si AUCUNE app vidéo n'est installée, fallback sur player.html (WebView). */
    void openVideoIntent(String url) {
        try {
            // Garder l'URL telle quelle — les serveurs HTTPS DOIVENT rester HTTPS
            // (sinon mixed-content sur la WebView). Pour HTTP cleartext, configuré
            // dans network_security_config.xml.
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(Uri.parse(url), "video/*");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            // Vérifier qu'au moins une app peut gérer l'intent AVANT de démarrer
            if (intent.resolveActivity(getPackageManager()) == null) {
                fallbackToWebPlayer(url);
                return;
            }

            // Chooser : laisse l'utilisateur choisir VLC / MX Player / etc.
            Intent chooser = Intent.createChooser(intent, "Lire avec…");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(chooser);
        } catch (Exception e) {
            // Toute erreur → fallback player.html
            fallbackToWebPlayer(url);
        }
    }

    /** Fallback : ouvre player.html dans la WebView (lecture HTML5 / HLS.js) */
    private void fallbackToWebPlayer(String url) {
        runOnUiThread(() -> {
            try {
                if (webView != null) {
                    // player.html lit l'URL depuis sessionStorage,
                    // déjà rempli par app.js avant l'appel à openInVlc.
                    webView.loadUrl(APP_URL + "player.html");
                }
            } catch (Exception ignored) {}
        });
    }

    private boolean isVideoUrl(String url) {
        if (url == null) return false;
        String lo = url.toLowerCase();
        return lo.contains("goldenlink.live/") ||
               lo.endsWith(".mkv") || lo.endsWith(".mp4") ||
               lo.endsWith(".avi") || lo.endsWith(".mov") ||
               lo.endsWith(".m3u8") || lo.endsWith(".ts") ||
               lo.contains("/movie/") || lo.contains("/series/") ||
               lo.contains("/live/");
    }

    // ── Touche Retour ──
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ||
            keyCode == KeyEvent.KEYCODE_MEDIA_PLAY ||
            keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE) {
            webView.evaluateJavascript(
                "var v=document.querySelector('video');if(v)v.paused?v.play():v.pause();", null);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_MEDIA_NEXT) {
            webView.evaluateJavascript("if(typeof goNext==='function')goNext();", null);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS) {
            webView.evaluateJavascript("if(typeof goPrev==='function')goPrev();", null);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Bridge JavaScript ↔ Java  (window.AndroidBridge)
    // ══════════════════════════════════════════════════════════════════════
    class PipsilyBridge {

        /** Lecteur natif ExoPlayer — appelé par app.js PipPlayer */
        @JavascriptInterface
        public void openPlayer(String url, String title, String subtitle,
                               String episodesJson, int epIndex) {
            runOnUiThread(() -> {
                Intent i = new Intent(MainActivity.this, PlayerActivity.class);
                i.putExtra("url",      url);
                i.putExtra("title",    title);
                i.putExtra("subtitle", subtitle);
                i.putExtra("episodes", episodesJson);
                i.putExtra("epIndex",  epIndex);
                startActivity(i);
            });
        }

        /** Lecture directe (redirigé vers ExoPlayer) */
        @JavascriptInterface
        public void openInVlc(String url, String title, boolean isLive) {
            runOnUiThread(() -> {
                Intent i = new Intent(MainActivity.this, PlayerActivity.class);
                i.putExtra("url",   url);
                i.putExtra("title", title);
                startActivity(i);
            });
        }

        /** Lecture (appelé par player.js) */
        @JavascriptInterface
        public void openVideo(String url, String title) {
            runOnUiThread(() -> {
                Intent i = new Intent(MainActivity.this, PlayerActivity.class);
                i.putExtra("url",   url);
                i.putExtra("title", title);
                startActivity(i);
            });
        }

        /** Télécharge et installe une nouvelle version de l'APK */
        @JavascriptInterface
        public void downloadAndInstall(String apkUrl) {
            runOnUiThread(() -> {
                try {
                    // Ouvrir dans le navigateur → Android gère le téléchargement + install
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(apkUrl));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception ignored) {}
            });
        }

        /** Ouvre une URL (fallback téléchargement APK ancien) */
        @JavascriptInterface
        public void openDownloadUrl(String url) {
            downloadAndInstall(url);
        }

        /** Vide le cache WebView et recharge */
        @JavascriptInterface
        public void clearCache() {
            runOnUiThread(() -> {
                webView.clearCache(true);
                webView.clearHistory();
                webView.loadUrl(APP_URL);
            });
        }

        /** Retourne la version de l'APK (pour la vérification de mise à jour) */
        @JavascriptInterface
        public String getApkVersion() {
            return APK_VERSION;
        }

        /** Type d'appareil */
        @JavascriptInterface
        public String getDeviceType() {
            return "android_phone";
        }
    }
}
