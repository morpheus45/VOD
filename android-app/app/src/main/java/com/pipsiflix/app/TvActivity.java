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
import org.json.JSONArray;

import androidx.fragment.app.FragmentActivity;

/**
 * PIPSILY — Activité Android TV / Google TV  v5
 *
 * Corrections v5 :
 *  - MIXED_CONTENT_ALWAYS_ALLOW  → flux HTTP lisibles depuis page HTTPS
 *  - openInVlc() ajouté
 *  - clearCache() / getApkVersion() / downloadAndInstall() ajoutés
 *  - PIPSILY_NATIVE injecté (+ compat PIPSIFLIX_NATIVE)
 */
public class TvActivity extends FragmentActivity {

    private static final String APP_URL     = "https://morpheus45.github.io/VOD/";
    private static final String APK_VERSION = "10";

    WebView webView;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

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

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);

        // ── CRITIQUE : autoriser les flux HTTP depuis une page HTTPS ──
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);

        // User-Agent TV — contient "AndroidTV" pour que isTV=true dans le JS
        String ua = ws.getUserAgentString().replace("Mobile", "TV");
        ws.setUserAgentString(ua + " AndroidTV PIPSILY/5.0");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new TvBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (isVideoUrl(url)) { openVideoIntent(url); return true; }
                if (url.startsWith("https://morpheus45.github.io")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
                catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Injecter les flags natifs TV + focus D-pad sur premier élément
                view.evaluateJavascript(
                    "window.PIPSILY_NATIVE='android_tv';" +
                    "window.PIPSIFLIX_NATIVE='android_tv';" +   // compat legacy
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

    void openVideoIntent(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse(url), "video/*");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (i.resolveActivity(getPackageManager()) == null) {
                fallbackToWebPlayer(); return;
            }
            Intent chooser = Intent.createChooser(i, "Lire avec…");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(chooser);
        } catch (Exception e) {
            fallbackToWebPlayer();
        }
    }

    private void fallbackToWebPlayer() {
        runOnUiThread(() -> {
            try {
                if (webView != null) webView.loadUrl(APP_URL + "player.html");
            } catch (Exception ignored) {}
        });
    }

    private boolean isVideoUrl(String url) {
        if (url == null) return false;
        String lo = url.toLowerCase();
        return lo.contains("goldenlink.live/") ||
               lo.endsWith(".mkv") || lo.endsWith(".mp4") ||
               lo.endsWith(".avi") || lo.endsWith(".m3u8") || lo.endsWith(".ts") ||
               lo.contains("/movie/") || lo.contains("/series/") ||
               lo.contains("/live/");
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        switch (keyCode) {
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
                return false;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        webView.saveState(out);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Bridge TV
    // ══════════════════════════════════════════════════════════════════════
    class TvBridge {

        /** Lecteur natif ExoPlayer — appelé par app.js PipPlayer */
        @JavascriptInterface
        public void openPlayer(String url, String title, String subtitle,
                               String episodesJson, int epIndex) {
            runOnUiThread(() -> {
                Intent i = new Intent(TvActivity.this, PlayerActivity.class);
                i.putExtra("url",      url);
                i.putExtra("title",    title);
                i.putExtra("subtitle", subtitle);
                i.putExtra("episodes", episodesJson);
                i.putExtra("epIndex",  epIndex);
                startActivity(i);
            });
        }

        @JavascriptInterface
        public void openInVlc(String url, String title, boolean isLive) {
            // Redirigé vers ExoPlayer natif (plus fiable que VLC externe)
            runOnUiThread(() -> {
                Intent i = new Intent(TvActivity.this, PlayerActivity.class);
                i.putExtra("url",   url);
                i.putExtra("title", title);
                startActivity(i);
            });
        }

        @JavascriptInterface
        public void openVideo(String url, String title) {
            runOnUiThread(() -> {
                Intent i = new Intent(TvActivity.this, PlayerActivity.class);
                i.putExtra("url",   url);
                i.putExtra("title", title);
                startActivity(i);
            });
        }

        @JavascriptInterface
        public void downloadAndInstall(String apkUrl) {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(apkUrl));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void openDownloadUrl(String url) { downloadAndInstall(url); }

        @JavascriptInterface
        public void clearCache() {
            runOnUiThread(() -> {
                webView.clearCache(true);
                webView.clearHistory();
                webView.loadUrl(APP_URL);
            });
        }

        @JavascriptInterface
        public String getApkVersion() { return APK_VERSION; }

        @JavascriptInterface
        public String getDeviceType() { return "android_tv"; }
    }
}
