package com.pipsiflix.app;

import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import org.json.JSONArray;

import androidx.core.content.FileProvider;
import androidx.fragment.app.FragmentActivity;
import java.io.File;

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

    private static final String TAG         = "PipsilyTV";
    private static final String APP_URL     = "https://morpheus45.github.io/VOD/";
    private static final String APK_VERSION = "14";

    WebView webView;

    // ── Téléchargement APK ──────────────────────────────────────────────
    private long             apkDownloadId = -1;
    private BroadcastReceiver apkReceiver  = null;

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

    // ── Téléchargement APK via DownloadManager ──────────────────────────
    /** Télécharge l'APK en arrière-plan puis lance l'installeur système. */
    void startApkDownload(String apkUrl) {
        runOnUiThread(() -> {
            try {
                // Destination : stockage externe app-privé (pas besoin de permission Android 10+)
                File dir  = getExternalFilesDir(null);
                if (dir == null) dir = getCacheDir();   // fallback interne
                final File dest = new File(dir, "PIPSILY_update.apk");
                if (dest.exists()) dest.delete();

                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(apkUrl));
                req.setTitle("PIPSILY — Mise à jour");
                req.setDescription("Téléchargement en cours…");
                req.setDestinationUri(Uri.fromFile(dest));
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);
                req.setMimeType("application/vnd.android.package-archive");

                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                apkDownloadId = dm.enqueue(req);

                Toast.makeText(TvActivity.this, "📥 Téléchargement en cours…", Toast.LENGTH_SHORT).show();

                // Feedback visuel JS — griser le bouton
                if (webView != null) {
                    webView.evaluateJavascript(
                        "var b=document.getElementById('apkDownloadBtn');" +
                        "if(b){b.textContent='📥 Téléchargement…';b.disabled=true;}", null);
                }

                // Receiver : lancer l'installation dès que le DL est terminé
                apkReceiver = new BroadcastReceiver() {
                    @Override public void onReceive(Context ctx, Intent intent) {
                        long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                        if (id != apkDownloadId) return;
                        unregisterApkReceiver();
                        installDownloadedApk(dest);
                    }
                };
                IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                if (Build.VERSION.SDK_INT >= 26) {
                    registerReceiver(apkReceiver, filter, 2 /* RECEIVER_EXPORTED */);
                } else {
                    registerReceiver(apkReceiver, filter);
                }
            } catch (Exception e) {
                Log.e(TAG, "startApkDownload", e);
                Toast.makeText(TvActivity.this,
                    "Erreur téléchargement : " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private void installDownloadedApk(File apkFile) {
        runOnUiThread(() -> {
            try {
                if (!apkFile.exists()) {
                    Toast.makeText(this, "Fichier APK introuvable", Toast.LENGTH_LONG).show();
                    return;
                }
                Uri uri = FileProvider.getUriForFile(this, "com.pipsiflix.app.provider", apkFile);
                Intent install = new Intent(Intent.ACTION_INSTALL_PACKAGE);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(install);
            } catch (Exception e) {
                Log.e(TAG, "installDownloadedApk", e);
                Toast.makeText(this,
                    "Erreur installation : " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private void unregisterApkReceiver() {
        if (apkReceiver != null) {
            try { unregisterReceiver(apkReceiver); } catch (Exception ignored) {}
            apkReceiver = null;
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        unregisterApkReceiver();
    }

    // ── Télécommande ─────────────────────────────────────────────────────
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

        /** Téléchargement direct + installation sans navigateur */
        @JavascriptInterface
        public void downloadAndInstall(String apkUrl) {
            startApkDownload(apkUrl);
        }

        @JavascriptInterface
        public void openDownloadUrl(String url) { startApkDownload(url); }

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
