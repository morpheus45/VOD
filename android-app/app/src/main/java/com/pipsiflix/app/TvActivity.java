package com.pipsiflix.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;

import androidx.fragment.app.FragmentActivity;

/**
 * PIPSIFLIX — Activité Android TV / Google TV
 *
 * Identique à MainActivity mais optimisée pour :
 *  - Écran 1080p/4K
 *  - Navigation D-Pad (clavier ← ↑ → ↓ + OK + Back)
 *  - Pas de barre de navigation ni de status bar
 *  - Lecture vidéo sans popup "appuyez pour démarrer"
 */
public class TvActivity extends FragmentActivity {

    private static final String APP_URL = "https://morpheus45.github.io/VOD/";
    private WebView webView;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Plein écran total (pas de barre status / navigation)
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );

        setContentView(R.layout.activity_tv);
        webView = findViewById(R.id.tvWebView);

        configureWebView();

        if(savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(APP_URL);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);

        // User-Agent TV pour que app.js détecte isTV = true
        String ua = ws.getUserAgentString();
        ws.setUserAgentString(ua.replace("Mobile", "TV") + " AndroidTV PIPSIFLIX/1.0");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new TvBridge(this), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if(isVideoUrl(url)){ openVideoIntent(url); return true; }
                if(url.startsWith("https://morpheus45.github.io")) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                return true;
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                // Injecter le flag TV + forcer le focus sur le premier élément
                view.evaluateJavascript(
                    "window.PIPSIFLIX_NATIVE='android_tv';" +
                    "document.querySelector('.nav-btn')?.focus();", null);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            private View customView;
            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                customView = view;
                webView.setVisibility(View.GONE);
                setContentView(view);
            }
            @Override
            public void onHideCustomView() {
                setContentView(R.layout.activity_tv);
                webView = findViewById(R.id.tvWebView);
                webView.setVisibility(View.VISIBLE);
            }
        });
    }

    private void openVideoIntent(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(url), "video/*");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch(Exception e) {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        }
    }

    private boolean isVideoUrl(String url) {
        if(url == null) return false;
        String lo = url.toLowerCase();
        return lo.contains("goldenlink.live/") ||
               lo.endsWith(".mkv") || lo.endsWith(".mp4") ||
               lo.endsWith(".avi") || lo.endsWith(".m3u8") || lo.endsWith(".ts");
    }

    // ── Télécommande D-Pad / clavier ──
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        switch(keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                webView.evaluateJavascript(
                    "var v=document.querySelector('video');if(v)v.paused?v.play():v.pause();", null);
                return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                webView.evaluateJavascript("if(typeof goNext==='function')goNext();", null);
                return true;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                webView.evaluateJavascript("if(typeof goPrev==='function')goPrev();", null);
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
                // Passer l'event au WebView (il gèrera lui-même le focus)
                return false;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if(webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        webView.saveState(out);
    }

    static class TvBridge {
        private final TvActivity act;
        TvBridge(TvActivity a) { act = a; }

        @JavascriptInterface
        public void openVideo(String url, String title) {
            act.runOnUiThread(() -> act.openVideoIntent(url));
        }

        @JavascriptInterface
        public String getDeviceType() { return "android_tv"; }
    }
}
