package com.pipsiflix.app;

import android.annotation.SuppressLint;
import android.content.pm.ActivityInfo;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.OptIn;
import androidx.fragment.app.FragmentActivity;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * PIPSILY — Lecteur vidéo natif ExoPlayer v1
 *
 * Supporte :
 *  - Flux HLS (.m3u8) : TV en direct, séries
 *  - Fichiers directs (.mp4, .mkv, etc.) : VOD
 *  - Navigation épisodes (prev/next via boutons + télécommande)
 *  - Télécommande TV (KEYCODE_MEDIA_*)
 *  - HTTP et HTTPS (pas de restriction mixed content côté Java)
 */
@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends FragmentActivity {

    private ExoPlayer    player;
    private PlayerView   playerView;
    private TextView     titleView, subtitleView;
    private Button       btnPrev, btnNext;
    private LinearLayout epNavBar;

    private String[] epUrls;
    private String[] epLabels;
    private String   seriesTitle = "";
    private int      currentIdx  = 0;

    // ─── Lifecycle ────────────────────────────────────────────────────
    @SuppressLint("SourceLockedOrientationActivity")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Garder l'écran allumé + plein écran immersif
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setImmersive();
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);

        setContentView(R.layout.activity_player);

        playerView   = findViewById(R.id.playerView);
        titleView    = findViewById(R.id.playerTitle);
        subtitleView = findViewById(R.id.playerSubtitle);
        epNavBar     = findViewById(R.id.epNavBar);
        btnPrev      = findViewById(R.id.btnPrev);
        btnNext      = findViewById(R.id.btnNext);

        // ── Lire les extras de l'Intent ──
        String url      = getIntent().getStringExtra("url");      // URL principale
        String title    = getIntent().getStringExtra("title");    // Titre film/série
        String subtitle = getIntent().getStringExtra("subtitle"); // Sous-titre / catégorie
        String epsJson  = getIntent().getStringExtra("episodes"); // JSON épisodes (optionnel)
        int    epIdx    = getIntent().getIntExtra("epIndex", -1);

        seriesTitle = title != null ? title : "";
        titleView.setText(seriesTitle);

        if (subtitle != null && !subtitle.isEmpty()) {
            subtitleView.setText(subtitle);
            subtitleView.setVisibility(View.VISIBLE);
        }

        // ── Parser la liste d'épisodes ──
        List<String> urlList   = new ArrayList<>();
        List<String> labelList = new ArrayList<>();

        if (epsJson != null && !epsJson.isEmpty() && !epsJson.equals("[]")) {
            try {
                JSONArray arr = new JSONArray(epsJson);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject ep    = arr.getJSONObject(i);
                    String     epUrl = ep.optString("url", "");
                    if (epUrl.isEmpty()) continue;
                    String lbl = ep.optString("episode_label", "");
                    String ttl = ep.optString("title", "");
                    String display = lbl.isEmpty() ? ttl : (ttl.isEmpty() ? lbl : lbl + " — " + ttl);
                    urlList.add(epUrl);
                    labelList.add(display);
                }
            } catch (Exception ignored) {}
        }

        if (urlList.isEmpty()) {
            // Lecture simple (pas d'épisodes)
            urlList.add(url != null ? url : "");
            labelList.add(subtitle != null ? subtitle : "");
            currentIdx = 0;
        } else {
            currentIdx = (epIdx >= 0 && epIdx < urlList.size()) ? epIdx : 0;
        }

        epUrls   = urlList.toArray(new String[0]);
        epLabels = labelList.toArray(new String[0]);

        // ── Boutons épisodes ──
        if (epUrls.length > 1) {
            epNavBar.setVisibility(View.VISIBLE);
            updateEpButtons();
            btnPrev.setOnClickListener(v -> goEp(currentIdx - 1));
            btnNext.setOnClickListener(v -> goEp(currentIdx + 1));
        }

        // ── Lancer la lecture ──
        playUrl(epUrls[currentIdx], epLabels[currentIdx]);
    }

    // ─── Initialiser ExoPlayer et lancer la lecture ───────────────────
    private void playUrl(String url, String epLabel) {
        // Afficher le bon sous-titre
        if (epUrls.length > 1 && epLabel != null && !epLabel.isEmpty()) {
            subtitleView.setText(epLabel);
            subtitleView.setVisibility(View.VISIBLE);
        }

        // Créer ou réinitialiser le player
        if (player == null) {
            player = new ExoPlayer.Builder(this).build();
            playerView.setPlayer(player);
            playerView.setKeepScreenOn(true);

            player.addListener(new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    // Auto-passer à l'épisode suivant à la fin
                    if (state == Player.STATE_ENDED && currentIdx < epUrls.length - 1) {
                        goEp(currentIdx + 1);
                    }
                }
            });
        } else {
            player.stop();
            player.clearMediaItems();
        }

        // Fabrique HTTP — pas de restriction mixed content côté Java
        DefaultHttpDataSource.Factory dsFactory = new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(20_000)
                .setReadTimeoutMs(30_000)
                .setUserAgent("PIPSILY/8.0 (Android)");

        MediaSource source;
        String      lUrl = url.toLowerCase();

        if (lUrl.contains(".m3u8") || lUrl.contains("/live/") || lUrl.contains("get_series_info")) {
            // ── HLS (TV Live, séries Xtream) ──
            source = new HlsMediaSource.Factory(dsFactory)
                    .createMediaSource(MediaItem.fromUri(url));
        } else {
            // ── Fichier direct (MP4, MKV…) ──
            source = new ProgressiveMediaSource.Factory(dsFactory)
                    .createMediaSource(MediaItem.fromUri(url));
        }

        player.setMediaSource(source);
        player.setPlayWhenReady(true);
        player.prepare();
    }

    // ─── Navigation épisodes ──────────────────────────────────────────
    private void goEp(int idx) {
        if (idx < 0 || idx >= epUrls.length) return;
        currentIdx = idx;
        updateEpButtons();
        playUrl(epUrls[currentIdx], epLabels[currentIdx]);
    }

    private void updateEpButtons() {
        btnPrev.setEnabled(currentIdx > 0);
        btnPrev.setAlpha(currentIdx > 0 ? 1f : 0.4f);
        btnNext.setEnabled(currentIdx < epUrls.length - 1);
        btnNext.setAlpha(currentIdx < epUrls.length - 1 ? 1f : 0.4f);
    }

    // ─── Télécommande TV ─────────────────────────────────────────────
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (player == null) return super.onKeyDown(keyCode, event);
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_SPACE:
                if (player.isPlaying()) player.pause(); else player.play();
                return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                goEp(currentIdx + 1);
                return true;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                goEp(currentIdx - 1);
                return true;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                player.seekTo(Math.min(player.getCurrentPosition() + 10_000, player.getDuration()));
                return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_DPAD_LEFT:
                player.seekTo(Math.max(player.getCurrentPosition() - 10_000, 0));
                return true;
            case KeyEvent.KEYCODE_BACK:
                finish();
                return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ─── Lifecycle ────────────────────────────────────────────────────
    @Override
    protected void onPause() {
        super.onPause();
        if (player != null) player.pause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        setImmersive();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (player != null) {
            player.release();
            player = null;
        }
    }

    // ─── Plein écran immersif ─────────────────────────────────────────
    private void setImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY     |
                View.SYSTEM_UI_FLAG_FULLSCREEN           |
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION      |
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN    |
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }
}
