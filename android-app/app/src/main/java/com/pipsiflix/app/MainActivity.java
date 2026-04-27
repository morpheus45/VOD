package com.pipsiflix.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;

import androidx.appcompat.app.AppCompatActivity;

/**
 * PIPSIFLIX — Activité principale (phone & tablet)
 * Charge l'app web sur GitHub Pages dans un WebView plein écran.
 *
 * Fonctionnalités :
 *  - Plein écran immersif (pas de barre de navigation)
 *  - Lecture vidéo HTML5 (autoplay, fullscreen, inline)
 *  - Autorisation du trafic HTTP vers goldenlink.live
 *  - Gestion des intents vidéo (ouvrir dans VLC / player système)
 *  - Interface JavaScript pour communiquer avec l'app web
 */
public class MainActivity extends AppCompatActivity {

    private static final String APP_URL = "https://morpheus45.github.io/VOD/";

    private WebView webView;
    private ProgressBar progressBar;

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

        // Charger l'app (ou reprendre la dernière page après rotation)
        if(savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(APP_URL);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings ws = webView.getSettings();

        // ── Fonctionnalités essentielles ──
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);

        // ── Médias ──
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(true);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);

        // ── User-Agent : se présenter comme Android (important pour la détection) ──
        ws.setUserAgentString(ws.getUserAgentString() + " PIPSIFLIX/1.0");

        // ── Cookies ──
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        // ── Interface JavaScript native ──
        webView.addJavascriptInterface(new PipsifixBridge(this), "AndroidBridge");

        // ── Client WebView : intercepter les navigations ──
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();

                // URLs vidéo HTTP → ouvrir avec lecteur système (pas de restriction mixed-content)
                if(isVideoUrl(url)){
                    openVideoIntent(url);
                    return true;
                }

                // Rester dans notre domaine (GitHub Pages)
                if(url.startsWith("https://morpheus45.github.io")) return false;

                // Autres URLs → navigateur externe
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                progressBar.setVisibility(View.GONE);
                // Injecter un flag pour que le JS sache qu'on est dans l'app native
                view.evaluateJavascript("window.PIPSIFLIX_NATIVE = 'android';", null);
            }
        });

        // ── Chrome client : progress + fullscreen vidéo ──
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                if(progress < 100) {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(progress);
                } else {
                    progressBar.setVisibility(View.GONE);
                }
            }

            // Vidéo plein écran inline (HTML5 fullscreen API)
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

    /** Ouvre une URL vidéo dans le lecteur système (VLC, MX Player, etc.) */
    private void openVideoIntent(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(Uri.parse(url), "video/*");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch(Exception e) {
            // Aucun lecteur vidéo → ouvrir dans le navigateur
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        }
    }

    private boolean isVideoUrl(String url) {
        if(url == null) return false;
        String lower = url.toLowerCase();
        return lower.contains("goldenlink.live/") ||
               lower.endsWith(".mkv") || lower.endsWith(".mp4") ||
               lower.endsWith(".avi") || lower.endsWith(".mov") ||
               lower.endsWith(".m3u8") || lower.endsWith(".ts");
    }

    // ── Touche Retour ──
    @Override
    public void onBackPressed() {
        if(webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    // ── Sauvegarder l'état WebView sur rotation ──
    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    // ── Touches media (télécommande BT) ──
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if(keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ||
           keyCode == KeyEvent.KEYCODE_MEDIA_PLAY ||
           keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE) {
            webView.evaluateJavascript(
                "var v=document.querySelector('video');if(v)v.paused?v.play():v.pause();", null);
            return true;
        }
        if(keyCode == KeyEvent.KEYCODE_MEDIA_NEXT) {
            webView.evaluateJavascript(
                "if(typeof goNext==='function')goNext();", null);
            return true;
        }
        if(keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS) {
            webView.evaluateJavascript(
                "if(typeof goPrev==='function')goPrev();", null);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ── Bridge JavaScript ↔ Java ──
    static class PipsifixBridge {
        private final MainActivity activity;
        PipsifixBridge(MainActivity a) { this.activity = a; }

        @JavascriptInterface
        public void openVideo(String url, String title) {
            activity.runOnUiThread(() -> activity.openVideoIntent(url));
        }

        @JavascriptInterface
        public String getDeviceType() { return "android_phone"; }
    }
}
