package com.pipsiflix.app;

import android.annotation.SuppressLint;
import android.content.pm.ActivityInfo;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.OptIn;
import androidx.fragment.app.FragmentActivity;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.okhttp.OkHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.ui.PlayerView;

import okhttp3.OkHttpClient;

import java.util.concurrent.TimeUnit;

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

    private static final String TAG = "PipsilyPlayer";

    // User-Agent universellement accepté par les serveurs IPTV / Xtream Codes
    private static final String IPTV_UA = "okhttp/4.11.0";

    // Client OkHttp partagé (connexion pooling, meilleure gestion des redirects CDN)
    private static OkHttpClient okClient;

    private ExoPlayer    player;
    private PlayerView   playerView;
    private TextView     titleView, subtitleView;
    private Button       btnPrev, btnNext;
    private LinearLayout epNavBar;
    private LinearLayout titleBar;          // overlay titre haut

    private String[] epUrls;
    private String[] epLabels;
    private String   seriesTitle     = "";
    private int      currentIdx      = 0;
    private boolean  hlsRetried      = false;

    // ── Reprise automatique après coupure réseau ──────────────────────────
    // Un flux IPTV lu sur plusieurs dizaines de minutes voit forcément sa
    // connexion HTTP tomber (rotation côté serveur, renégociation du tunnel
    // VPN, micro-coupure Wi-Fi). Jusqu'ici la lecture s'arrêtait DÉFINITIVEMENT
    // sur un simple message : il fallait ressortir et relancer le film, qui
    // recoupait peu après. On retente désormais à la position courante.
    private static final int  MAX_NET_RETRIES     = 6;
    // Une chaine en direct doit pouvoir encaisser bien plus d'incidents qu'un
    // film : elle est faite pour rester allumee des heures.
    private static final int  MAX_LIVE_RETRIES    = 40;
    // Au-delà de ce temps de lecture saine, l'incident suivant est considéré
    // comme un NOUVEL incident : le compteur repart à zéro.
    private static final long RETRY_RESET_AFTER_MS = 60_000L;
    private int  netRetries      = 0;
    private long lastRetryAtMs   = 0L;
    private boolean  controllerShown = false; // état controller pour toggle TV
    private String   currentUrl      = "";    // URL en cours (pour rapport de progression)
    private long     startPositionMs = 0L;   // position de reprise (0 = depuis le début)

    // Sauvegarde périodique de la progression (toutes les 15 s) : indispensable pour
    // reprendre au bon endroit même si l'appli est coupée brutalement (swipe, kill
    // système, coupure) — onDestroy() n'est alors pas garanti d'être appelé.
    private static final long PROGRESS_SAVE_INTERVAL_MS = 15000L;
    private final android.os.Handler progHandler =
        new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable progRunnable = new Runnable() {
        @Override public void run() {
            reportCurrentProgress();
            progHandler.postDelayed(this, PROGRESS_SAVE_INTERVAL_MS);
        }
    };

    // ── Surveillance anti-blocage (chien de garde) ────────────────────────
    // ExoPlayer n'émet PAS toujours onPlayerError quand un flux IPTV meurt en
    // cours de route : la socket reste ouverte, plus aucun octet n'arrive, et le
    // lecteur tourne indéfiniment sur son cercle de chargement. Aucune erreur →
    // la reprise automatique ne se déclenchait jamais. C'est le motif exact
    // d'une « coupure aléatoire » qui ne repart pas toute seule.
    // On surveille donc la POSITION : si elle n'avance plus alors que la lecture
    // est demandée, on relance le flux nous-mêmes.
    private static final long STALL_CHECK_MS   = 2_000L;   // fréquence du contrôle
    private static final long STALL_TIMEOUT_MS = 15_000L;  // gel toléré avant relance
    private long lastPosMs        = -1L;
    private long lastPosChangeAt  = 0L;
    private boolean reconnecting  = false;
    private final android.os.Handler stallHandler =
        new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable stallRunnable = new Runnable() {
        @Override public void run() {
            stallHandler.postDelayed(this, STALL_CHECK_MS);
            if (player == null || reconnecting) return;
            // La liste peut ne pas etre encore prete : le minuteur est arme
            // dans onResume, qui peut passer avant la construction du player.
            if (epUrls == null || currentIdx < 0 || currentIdx >= epUrls.length) return;
            // Lecture non demandée (pause utilisateur, fin) → rien à surveiller.
            if (!player.getPlayWhenReady()) { lastPosMs = -1L; return; }
            int st = player.getPlaybackState();
            if (st == Player.STATE_IDLE || st == Player.STATE_ENDED) return;

            long pos = player.getCurrentPosition();
            long now = System.currentTimeMillis();
            if (pos != lastPosMs) { lastPosMs = pos; lastPosChangeAt = now; return; }
            if (lastPosChangeAt == 0L) { lastPosChangeAt = now; return; }
            if (now - lastPosChangeAt < STALL_TIMEOUT_MS) return;

            // Position figée trop longtemps alors que la lecture est demandée.
            Log.w(TAG, "Flux gele depuis " + (now - lastPosChangeAt) + " ms — relance");
            lastPosChangeAt = now;
            restartStream(epUrls[currentIdx], "flux fige");
        }
    };

    /** Vrai si le flux courant est une chaîne en direct (pas de fin, pas de reprise). */
    private boolean isLiveStream() {
        try { if (player != null && player.isCurrentMediaItemLive()) return true; } catch (Throwable ignored) {}
        // Repli sur l'URL : chez Xtream, seules les chaines passent par /live/.
        // Surtout PAS « .m3u8 » : beaucoup de films sont servis en HLS et
        // perdraient leur reprise a la position courante.
        return currentUrl.toLowerCase().contains("/live/");
    }

    /** Budget de reprises : une chaîne en direct est faite pour tourner des heures. */
    private int maxRetries() { return isLiveStream() ? MAX_LIVE_RETRIES : MAX_NET_RETRIES; }

    /**
     * Relance le flux courant, en repartant là où on en était pour un film et au
     * bord du direct pour une chaîne — y chercher une position absolue n'aurait
     * pas de sens et ferait échouer la reprise.
     */
    private void restartStream(final String url, final String raison) {
        if (player == null || reconnecting) return;
        if (netRetries >= maxRetries()) {
            Log.w(TAG, "Reprise abandonnee apres " + netRetries + " essais (" + raison + ")");
            runOnUiThread(() -> Toast.makeText(PlayerActivity.this,
                "Flux indisponible — reessayez plus tard", Toast.LENGTH_LONG).show());
            return;
        }
        reconnecting = true;
        netRetries++;
        lastRetryAtMs = System.currentTimeMillis();
        final boolean live = isLiveStream();
        final long resumeAt = live ? -1L : Math.max(0L, player.getCurrentPosition());
        final long backoffMs = Math.min(8_000L, 1000L * netRetries);   // 1 s… plafonné à 8 s
        final int attempt = netRetries, budget = maxRetries();
        Log.i(TAG, "Reprise " + attempt + "/" + budget + " (" + raison + ") "
                 + (live ? "au bord du direct" : "a " + resumeAt + " ms")
                 + " dans " + backoffMs + " ms");
        runOnUiThread(() -> {
            Toast.makeText(PlayerActivity.this,
                "Flux interrompu — reprise (" + attempt + "/" + budget + ")…",
                Toast.LENGTH_SHORT).show();
            progHandler.postDelayed(() -> {
                reconnecting = false;
                if (player == null) return;
                player.stop();
                player.clearMediaItems();
                player.setMediaSource(buildSourceFor(url));
                player.setPlayWhenReady(true);
                player.prepare();
                if (resumeAt > 0) player.seekTo(resumeAt);
                else if (live) { try { player.seekToDefaultPosition(); } catch (Throwable ignored) {} }
                lastPosMs = -1L; lastPosChangeAt = 0L;
            }, backoffMs);
        });
    }

    /** Remonte la position actuelle au WebView (sauvegarde) sans libérer le player. */
    private void reportCurrentProgress() {
        if (player == null || currentUrl.isEmpty()) return;
        try {
            long posMs = player.getCurrentPosition();
            long durMs = player.getDuration();
            long safeDur = (durMs > 0 && durMs != Long.MIN_VALUE) ? durMs : 0;
            if (posMs > 30000) {
                if (MainActivity.sInstance != null && MainActivity.sInstance.get() != null) {
                    MainActivity.reportProgress(currentUrl, posMs, safeDur);
                } else {
                    TvActivity.reportProgress(currentUrl, posMs, safeDur);
                }
            }
        } catch (Exception ignored) {}
    }

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
        titleBar     = findViewById(R.id.titleBar);
        titleView    = findViewById(R.id.playerTitle);
        subtitleView = findViewById(R.id.playerSubtitle);
        epNavBar     = findViewById(R.id.epNavBar);
        btnPrev      = findViewById(R.id.btnPrev);
        btnNext      = findViewById(R.id.btnNext);

        // ── Synchroniser titleBar + epNavBar avec la visibilité du controller ──
        // Le titleBar est une overlay indépendante → il faut la lier manuellement
        playerView.setControllerVisibilityListener(
            (PlayerView.ControllerVisibilityListener) visibility -> {
                controllerShown = (visibility == View.VISIBLE);
                if (titleBar != null) titleBar.setVisibility(visibility);
                // epNavBar : ne montrer que si multi-épisodes
                if (epNavBar != null && epUrls != null && epUrls.length > 1) {
                    epNavBar.setVisibility(visibility);
                }
            }
        );

        // Ne pas auto-afficher le controller au démarrage de la lecture
        // (sinon il reste bloqué visible sur TV)
        playerView.setControllerAutoShow(false);

        // Focus sur playerView lui-même (pas ses boutons internes)
        // → libère le D-pad focus qui empêche le timer d'auto-hide
        playerView.setFocusable(true);
        playerView.requestFocus();

        // ── Lire les extras de l'Intent ──
        String url      = getIntent().getStringExtra("url");      // URL principale
        String title    = getIntent().getStringExtra("title");    // Titre film/série
        String subtitle = getIntent().getStringExtra("subtitle"); // Sous-titre / catégorie
        String epsJson  = getIntent().getStringExtra("episodes"); // JSON épisodes (optionnel)
        int    epIdx    = getIntent().getIntExtra("epIndex", -1);
        startPositionMs = getIntent().getLongExtra("startPositionMs", 0L);

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
        currentUrl = (url != null) ? url : "";
        // ── Garde URL vide ──
        if (url == null || url.trim().isEmpty()) {
            Log.e(TAG, "playUrl: URL vide !");
            Toast.makeText(this, "Erreur : URL de lecture manquante", Toast.LENGTH_LONG).show();
            return;
        }
        Log.d(TAG, "playUrl: " + url);

        // Afficher le bon sous-titre
        if (epUrls.length > 1 && epLabel != null && !epLabel.isEmpty()) {
            subtitleView.setText(epLabel);
            subtitleView.setVisibility(View.VISIBLE);
        }

        hlsRetried = false;
        netRetries = 0;          // nouveau titre → quota de reprises remis à neuf

        if (player == null) {
            // Préférer la piste audio française PRINCIPALE (pas l'audiodescription).
            // ROLE_FLAG_MAIN écarte les pistes "describes video" quand elles sont
            // correctement étiquetées dans le conteneur.
            DefaultTrackSelector ts = new DefaultTrackSelector(this);
            ts.setParameters(ts.buildUponParameters()
                    .setPreferredAudioLanguage("fra")
                    .setPreferredAudioRoleFlags(C.ROLE_FLAG_MAIN));
            // Renderers + décodeur FFmpeg logiciel (E-AC3/AC3/DTS) en repli :
            // décodage matériel d'abord, FFmpeg quand la plateforme ne sait pas
            // (TV sans licence Dolby → la VF E-AC3 redevient lisible)
            // Forcer le décodage audio en PCM (ni offload DSP, ni passthrough).
            // Sur les TV MediaTek, l'audio Dolby E-AC3 part en offload matériel
            // (offload_pipe_start/pause sur « Decoder_85 ») : ce pipeline se met en
            // pause puis redémarre toutes les ~9 s, ce qui déclenche un
            // AudioFlinger.moveEffectChain et gèle 2 à 7 s TOUT le pipeline A/V
            // (le fameux « cercle » de rebuffering). En limitant les capacités du
            // sink au PCM stéréo par défaut, ExoPlayer décode l'audio lui-même
            // (décodeur plateforme, sinon FFmpeg) et écrit dans un AudioTrack PCM
            // stable → plus d'offload instable, plus de gels. Le son sort en stéréo
            // (parfait pour les HP de la TV ; un ampli Dolby ne recevra plus le
            // bitstream 5.1, compromis acceptable vu l'instabilité).
            androidx.media3.exoplayer.DefaultRenderersFactory rf =
                new androidx.media3.exoplayer.DefaultRenderersFactory(this) {
                    @Override
                    protected androidx.media3.exoplayer.audio.AudioSink buildAudioSink(
                            android.content.Context context,
                            boolean enableFloatOutput,
                            boolean enableAudioTrackPlaybackParams) {
                        return new androidx.media3.exoplayer.audio.DefaultAudioSink.Builder(context)
                            .setAudioCapabilities(
                                androidx.media3.exoplayer.audio.AudioCapabilities
                                    .DEFAULT_AUDIO_CAPABILITIES)
                            .setEnableFloatOutput(enableFloatOutput)
                            .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                            .build();
                    }
                }
                    .setExtensionRendererMode(
                        androidx.media3.exoplayer.DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON);
            // Ne PAS laisser ExoPlayer changer la fréquence d'image de l'écran.
            // Sur les TV 4K MediaTek bas de gamme (ex : SWTV-24AE-4K), chaque appel
            // Surface.setFrameRate() pose puis retire un frameRateOverride, ce qui
            // fait renégocier l'affichage en boucle et gèle le décodeur vidéo
            // (C2BqBuffer dequeue failures) → coupure toutes les ~20 s, surtout sur
            // les films 24 im/s. STRATEGY_OFF supprime ces appels tout en gardant
            // la SurfaceView (donc le HDR et le décodage matériel 4K).
            // Réserve de lecture élargie mais bornée en RAM (TV ~1,8 Go) : encaisse
            // les creux de débit du VPN/IPTV sans multiplier les « cercles » de
            // rebuffering. Le plafond en octets (48 Mo) protège de l'OOM.
            androidx.media3.exoplayer.LoadControl loadControl =
                new androidx.media3.exoplayer.DefaultLoadControl.Builder()
                    .setBufferDurationsMs(
                        30_000,   // min : 30 s d'avance visée
                        90_000,   // max : jusqu'à 90 s si la RAM/plafond le permet
                        2_500,    // démarrer la lecture après 2,5 s bufferisées
                        12_000)   // après un blocage : attendre 12 s avant de repartir
                    .setTargetBufferBytes(48 * 1024 * 1024)      // plafond RAM ~48 Mo
                    .setPrioritizeTimeOverSizeThresholds(false)  // le plafond octets prime
                    .build();
            player = new ExoPlayer.Builder(this, rf)
                    .setTrackSelector(ts)
                    .setLoadControl(loadControl)
                    .setVideoChangeFrameRateStrategy(C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_OFF)
                    .build();
            playerView.setPlayer(player);
            playerView.setKeepScreenOn(true);

            player.addListener(new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    // La lecture est repartie et tient depuis assez longtemps :
                    // on rend ses essais au compteur pour la prochaine coupure.
                    if (state == Player.STATE_READY && netRetries > 0
                            && System.currentTimeMillis() - lastRetryAtMs > RETRY_RESET_AFTER_MS) {
                        netRetries = 0;
                    }
                    if (state == Player.STATE_ENDED && currentIdx < epUrls.length - 1) {
                        goEp(currentIdx + 1);
                    }
                }

                @Override
                public void onTracksChanged(Tracks tracks) {
                    // Détecter le repli silencieux : la piste audio PAR DÉFAUT du fichier
                    // (VF principale) n'est pas celle jouée → souvent l'audiodescription
                    // (ex : VF E-AC3 5.1 non décodable par l'appareil → bascule AAC).
                    boolean defaultExists = false, defaultSelected = false, otherSelected = false;
                    int audioGroups = 0;
                    for (Tracks.Group g : tracks.getGroups()) {
                        if (g.getType() != C.TRACK_TYPE_AUDIO) continue;
                        audioGroups++;
                        for (int i = 0; i < g.length; i++) {
                            boolean isDefault =
                                (g.getTrackFormat(i).selectionFlags & C.SELECTION_FLAG_DEFAULT) != 0;
                            if (isDefault) defaultExists = true;
                            if (g.isTrackSelected(i)) {
                                if (isDefault) defaultSelected = true; else otherSelected = true;
                            }
                        }
                    }
                    if (audioGroups > 1 && defaultExists && !defaultSelected && otherSelected) {
                        Toast.makeText(PlayerActivity.this,
                            "⚠️ Piste VF principale non supportée par cet appareil — " +
                            "piste secondaire utilisée (souvent audiodescription).\n" +
                            "Touche ⬆ : changer de piste audio.", Toast.LENGTH_LONG).show();
                    }
                }

                @Override
                public void onPlayerError(PlaybackException error) {
                    Log.e(TAG, "ExoPlayer error [" + error.errorCode + "]", error);
                    String curUrl = epUrls[currentIdx];

                    // ── Reprise à la position courante après coupure réseau ──
                    // C'est le cas de loin le plus fréquent en cours de film.
                    // On rouvre le MÊME flux et on repart où on en était, avec
                    // une attente croissante pour laisser le réseau (ou le
                    // tunnel VPN) se rétablir.
                    if (isRecoverable(error) && netRetries < maxRetries()) {
                        restartStream(curUrl, "erreur " + error.errorCode);
                        return;
                    }

                    // ── Retry automatique : ProgressiveMedia → HLS ──
                    String lo     = curUrl.toLowerCase();
                    boolean wasProgressive = !lo.contains(".m3u8")
                            && !lo.contains("/live/")
                            && !lo.contains("get_series_info");

                    if (wasProgressive && !hlsRetried) {
                        hlsRetried = true;
                        Log.i(TAG, "Retry HLS: " + curUrl);
                        runOnUiThread(() -> {
                            player.stop();
                            player.clearMediaItems();
                            MediaSource src = new HlsMediaSource.Factory(buildDsFactory())
                                    .createMediaSource(MediaItem.fromUri(curUrl));
                            player.setMediaSource(src);
                            player.setPlayWhenReady(true);
                            player.prepare();
                        });
                        return;
                    }

                    // ── Lire le code HTTP exact depuis la cause ──
                    String label = buildErrorLabel(error);
                    runOnUiThread(() ->
                        Toast.makeText(PlayerActivity.this, label, Toast.LENGTH_LONG).show()
                    );
                }
            });
        } else {
            player.stop();
            player.clearMediaItems();
        }

        player.setMediaSource(buildSourceFor(url));
        player.setPlayWhenReady(true);
        // Reprise à la position sauvegardée (0 = depuis le début)
        if (startPositionMs > 0) {
            player.seekTo(startPositionMs);
            startPositionMs = 0L; // consommé — ne pas re-seeker lors d'un changement d'épisode
        }
        player.prepare();

        // Montrer le controller brièvement au démarrage (titre visible 3s)
        // puis l'auto-hide prend le relais (show_timeout=4000 dans le XML)
        playerView.showController();
        playerView.postDelayed(() -> {
            if (player != null && player.isPlaying()) {
                playerView.hideController();
            }
        }, 3000);
    }

    /** Vrai si l'URL doit être lue en HLS (TV live, séries, playlists Xtream). */
    private static boolean isHlsUrl(String url) {
        String lo = (url == null) ? "" : url.toLowerCase();
        return lo.contains(".m3u8") || lo.contains("/live/") || lo.contains("get_series_info");
    }

    /** Source média correspondant au type d'URL — partagée par la lecture et la reprise. */
    // Nombre de reprises SILENCIEUSES tentees par ExoPlayer sur un segment ou une
    // plage avant de remonter une erreur. Le defaut (3) laisse passer trop vite
    // les hoquets d'un serveur IPTV : on absorbe davantage avant d'aller jusqu'a
    // la relance visible du flux, qui elle coupe l'image.
    private static final int LOAD_RETRY_COUNT = 8;
    private androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy loadErrorPolicy() {
        return new androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy(LOAD_RETRY_COUNT);
    }
    private MediaSource buildSourceFor(String url) {
        return isHlsUrl(url)
            ? new HlsMediaSource.Factory(buildDsFactory())
                    .setLoadErrorHandlingPolicy(loadErrorPolicy())
                    .createMediaSource(MediaItem.fromUri(url))
            : new ProgressiveMediaSource.Factory(buildDsFactory())
                    .setLoadErrorHandlingPolicy(loadErrorPolicy())
                    .createMediaSource(MediaItem.fromUri(url));
    }

    /**
     * Erreur dont on peut espérer se remettre en retentant la même URL.
     *
     * Toute la famille ERROR_CODE_IO_* (2000-2999) correspond à un incident de
     * transport : connexion coupée, délai dépassé, réseau perdu — exactement ce
     * que produit une renégociation du tunnel VPN ou un hoquet du serveur IPTV.
     * Un statut HTTP 4xx, lui, est définitif (abonnement, flux supprimé) : le
     * retenter ne ferait que marteler le serveur.
     */
    private static boolean isRecoverable(PlaybackException error) {
        int code = error.errorCode;
        if (code == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS) {
            Throwable cause = error.getCause();
            while (cause != null) {
                if (cause instanceof HttpDataSource.InvalidResponseCodeException) {
                    int http = ((HttpDataSource.InvalidResponseCodeException) cause).responseCode;
                    return http >= 500;            // 5xx = transitoire, 4xx = définitif
                }
                cause = cause.getCause();
            }
            return false;
        }
        return code >= 2000 && code < 3000;        // famille ERROR_CODE_IO_*
    }

    /**
     * Fabrique OkHttp partagée.
     *
     * Avantages vs DefaultHttpDataSource :
     *  - Suit les redirects HTTP→HTTPS et vers d'autres hôtes CDN (406 fix)
     *  - Envoie Accept: * / * par défaut (évite les 406 "Not Acceptable")
     *  - Connection pooling → démarrage plus rapide pour les épisodes suivants
     *  - Gestion SSL plus robuste
     */
    private OkHttpDataSource.Factory buildDsFactory() {
        if (okClient == null) {
            okClient = new OkHttpClient.Builder()
                    .connectTimeout(20, TimeUnit.SECONDS)
                    .readTimeout(30, TimeUnit.SECONDS)
                    .followRedirects(true)
                    .followSslRedirects(true)
                    .build();
        }
        return new OkHttpDataSource.Factory(okClient)
                .setUserAgent(IPTV_UA)
                // Accept: */* évite les 406 sur les CDN qui vérifient le content-type
                .setDefaultRequestProperties(
                    java.util.Collections.singletonMap("Accept", "*/*")
                );
    }

    /** Traduit PlaybackException en message lisible avec le code HTTP exact */
    private String buildErrorLabel(PlaybackException error) {
        // Chercher le code HTTP réel dans la chaîne des causes
        Throwable cause = error.getCause();
        while (cause != null) {
            if (cause instanceof HttpDataSource.InvalidResponseCodeException) {
                int code = ((HttpDataSource.InvalidResponseCodeException) cause).responseCode;
                switch (code) {
                    case 403: return "Accès refusé (403) — abonnement expiré ou flux restreint.";
                    case 404: return "Flux introuvable (404) — ce contenu n'est plus disponible.";
                    case 500:
                    case 502:
                    case 503: return "Erreur serveur (" + code + ") — réessayez dans quelques instants.";
                    default:  return "Erreur HTTP " + code + " — serveur inaccessible.";
                }
            }
            cause = cause.getCause();
        }
        // Erreurs non-HTTP
        switch (error.errorCode) {
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED:
                return "Connexion impossible — vérifiez votre réseau.";
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT:
                return "Délai dépassé — serveur trop lent.";
            case PlaybackException.ERROR_CODE_DECODER_INIT_FAILED:
                return "Codec non supporté par cet appareil.";
            case PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED:
                return "Format vidéo non reconnu.";
            default:
                return "Erreur lecture [" + error.errorCode + "] — " + error.getMessage();
        }
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

    // ─── Bascule de piste audio (VF principale ↔ audiodescription, etc.) ──
    private void cycleAudioTrack() {
        if (player == null) return;
        List<Tracks.Group> audio = new ArrayList<>();
        for (Tracks.Group g : player.getCurrentTracks().getGroups())
            if (g.getType() == C.TRACK_TYPE_AUDIO) audio.add(g);
        if (audio.size() < 2) {
            Toast.makeText(this, "Une seule piste audio disponible", Toast.LENGTH_SHORT).show();
            return;
        }
        int cur = 0;
        for (int i = 0; i < audio.size(); i++) if (audio.get(i).isSelected()) cur = i;
        // Prochaine piste SUPPORTÉE par l'appareil
        for (int step = 1; step <= audio.size(); step++) {
            Tracks.Group g = audio.get((cur + step) % audio.size());
            if (!g.isSupported()) continue;
            TrackSelectionOverride ov = new TrackSelectionOverride(g.getMediaTrackGroup(), 0);
            player.setTrackSelectionParameters(player.getTrackSelectionParameters()
                    .buildUpon()
                    .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
                    .addOverride(ov)
                    .build());
            Format f = g.getTrackFormat(0);
            String codec = f.sampleMimeType != null
                ? f.sampleMimeType.replace("audio/", "").toUpperCase() : "?";
            String label = (f.label != null && !f.label.isEmpty() ? f.label
                          : (f.language != null ? f.language.toUpperCase() : "Piste"))
                + " · " + f.channelCount + " canaux · " + codec;
            Toast.makeText(this, "🔊 Piste audio : " + label, Toast.LENGTH_LONG).show();
            return;
        }
        Toast.makeText(this, "Aucune autre piste audio supportée par cet appareil",
                Toast.LENGTH_LONG).show();
    }

    // ─── Télécommande TV ─────────────────────────────────────────────
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (player == null) return super.onKeyDown(keyCode, event);
        switch (keyCode) {

            // ⬆ (controller masqué) ou touche dédiée : changer de piste audio
            case KeyEvent.KEYCODE_MEDIA_AUDIO_TRACK:
                cycleAudioTrack();
                return true;
            case KeyEvent.KEYCODE_DPAD_UP:
                if (!controllerShown) {
                    cycleAudioTrack();
                    return true;
                }
                return false;

            // OK / Sélection : afficher si masqué, masquer si visible
            case KeyEvent.KEYCODE_DPAD_CENTER:
                if (controllerShown) {
                    playerView.hideController();
                } else {
                    playerView.showController();
                }
                return true;

            // Lecture / Pause
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_SPACE:
                if (player.isPlaying()) player.pause(); else player.play();
                playerView.showController(); // montre la barre quand on pause/reprend
                return true;

            // Épisode suivant / précédent
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                goEp(currentIdx + 1);
                return true;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                goEp(currentIdx - 1);
                return true;

            // Avance / recul 10s (←→ quand controller masqué)
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                player.seekTo(Math.min(player.getCurrentPosition() + 10_000, player.getDuration()));
                playerView.showController();
                return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                player.seekTo(Math.max(player.getCurrentPosition() - 10_000, 0));
                playerView.showController();
                return true;

            // ←→ : avance/recul SEULEMENT si controller masqué
            // (si controller visible, laisser le focus naviguer les boutons)
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                if (!controllerShown) {
                    player.seekTo(Math.min(player.getCurrentPosition() + 10_000, player.getDuration()));
                    return true;
                }
                return false;
            case KeyEvent.KEYCODE_DPAD_LEFT:
                if (!controllerShown) {
                    player.seekTo(Math.max(player.getCurrentPosition() - 10_000, 0));
                    return true;
                }
                return false;

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
        // Sauver la position dès le passage en arrière-plan (appelé de façon fiable,
        // contrairement à onDestroy lors d'un kill brutal) + stopper le minuteur.
        progHandler.removeCallbacks(progRunnable);
        stallHandler.removeCallbacks(stallRunnable);
        reportCurrentProgress();
        if (player != null) player.pause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        setImmersive();
        // (Re)démarrer la sauvegarde périodique pendant la lecture au premier plan.
        progHandler.removeCallbacks(progRunnable);
        progHandler.postDelayed(progRunnable, PROGRESS_SAVE_INTERVAL_MS);
        // (Re)armer la surveillance anti-blocage.
        lastPosMs = -1L; lastPosChangeAt = 0L;
        stallHandler.removeCallbacks(stallRunnable);
        stallHandler.postDelayed(stallRunnable, STALL_CHECK_MS);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        progHandler.removeCallbacks(progRunnable);
        stallHandler.removeCallbacks(stallRunnable);
        // ── Remonter la progression au WebView avant de libérer le player ──
        if (player != null && !currentUrl.isEmpty()) {
            reportCurrentProgress();   // getDuration()=TIME_UNSET géré (durMs=0) côté JS
            player.release();
            player = null;
        }
        // Fermer les sockets encore ouvertes vers le serveur IPTV. Sans cela,
        // le pool OkHttp les gardait actives jusqu'à 5 minutes : en relançant
        // aussitôt une lecture, le compte dépassait sa limite de connexions
        // simultanées et le fournisseur coupait le nouveau flux très vite.
        if (okClient != null) {
            try { okClient.connectionPool().evictAll(); } catch (Exception ignored) {}
            try { okClient.dispatcher().cancelAll(); }   catch (Exception ignored) {}
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
