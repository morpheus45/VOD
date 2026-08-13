package com.pipsiflix.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Reconnaissance vocale HORS-LIGNE via Vosk, pour les appareils qui n'exposent
 * aucun moteur vocal système (Fire TV : ni RecognizerIntent, ni
 * RecognitionService, ni services Google).
 *
 * Le modèle français (~40 Mo) n'est pas embarqué dans l'APK : il est téléchargé
 * au premier usage vocal puis mis en cache dans filesDir. Les usages suivants
 * sont instantanés.
 *
 * La capture micro (AudioRecord) est gérée par vosk-android (SpeechService).
 * Nécessite la permission RECORD_AUDIO (déjà demandée par TvActivity).
 */
public class VoskVoice implements RecognitionListener {

    private static final String TAG = "PipsilyVosk";
    private static final String MODEL_URL =
            "https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip";
    private static final String MODEL_DIR_NAME = "vosk-model-small-fr-0.22";
    private static final float SAMPLE_RATE = 16000.0f;

    public interface Cb {
        void onStatus(String msg);    // ex. "Téléchargement du moteur vocal…" ; "" = prêt/écoute
        void onPartial(String text);  // hypothèse en cours (affichage live)
        void onFinal(String text);    // résultat final (lance la recherche)
        void onError(String msg);
    }

    private final Context ctx;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Model model;
    private SpeechService speechService;
    private Cb cb;
    private volatile boolean busy = false;

    VoskVoice(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    private File modelDir() { return new File(ctx.getFilesDir(), MODEL_DIR_NAME); }

    /** Le modèle est-il déjà présent (dossier "conf" décompressé) ? */
    boolean isModelReady() { return new File(modelDir(), "conf").exists(); }

    /**
     * Prépare le modèle (téléchargement si absent) puis démarre l'écoute.
     * Le téléchargement/décompression se fait hors UI thread ; l'écoute est
     * démarrée sur l'UI thread (SpeechService a besoin d'un Looper pour ses
     * callbacks).
     */
    void start(Cb cb) {
        this.cb = cb;
        if (busy) return;
        busy = true;
        new Thread(() -> {
            try {
                if (!isModelReady()) {
                    post(() -> { if (this.cb != null) this.cb.onStatus("Téléchargement du moteur vocal…"); });
                    downloadAndUnzipModel();
                }
                if (model == null) model = new Model(modelDir().getAbsolutePath());
            } catch (Exception e) {
                Log.w(TAG, "Préparation modèle échouée", e);
                post(() -> { if (this.cb != null) this.cb.onError(e.getMessage()); });
                busy = false;
                return;
            }
            ui.post(() -> {
                try {
                    Recognizer rec = new Recognizer(model, SAMPLE_RATE);
                    speechService = new SpeechService(rec, SAMPLE_RATE);
                    speechService.startListening(VoskVoice.this);
                    if (this.cb != null) this.cb.onStatus("");   // prêt : on écoute
                } catch (Exception e) {
                    Log.w(TAG, "Démarrage écoute échoué", e);
                    if (this.cb != null) this.cb.onError(e.getMessage());
                } finally {
                    busy = false;
                }
            });
        }, "vosk-init").start();
    }

    /** Arrête l'écoute et libère le micro. */
    void stop() {
        try {
            if (speechService != null) {
                speechService.stop();
                speechService.shutdown();
            }
        } catch (Exception ignored) {}
        speechService = null;
    }

    private void post(Runnable r) { ui.post(r); }

    // ── RecognitionListener (callbacks vosk-android, sur l'UI thread) ──
    @Override public void onPartialResult(String hypothesis) {
        String t = field(hypothesis, "partial");
        if (cb != null && t != null && !t.isEmpty()) cb.onPartial(t);
    }
    @Override public void onResult(String hypothesis) {
        String t = field(hypothesis, "text");
        if (cb != null && t != null && !t.isEmpty()) cb.onFinal(t);
    }
    @Override public void onFinalResult(String hypothesis) {
        String t = field(hypothesis, "text");
        if (cb != null && t != null && !t.isEmpty()) cb.onFinal(t);
    }
    @Override public void onError(Exception e) {
        if (cb != null) cb.onError(e != null ? e.getMessage() : "erreur");
    }
    @Override public void onTimeout() { /* pas de parole : on laisse fermer via l'UI */ }

    private String field(String json, String key) {
        try { return new JSONObject(json).optString(key, ""); }
        catch (Exception e) { return ""; }
    }

    // ── Téléchargement + décompression du modèle ──
    private void downloadAndUnzipModel() throws Exception {
        File tmp = new File(ctx.getCacheDir(), "vosk-fr.zip");
        HttpURLConnection c = (HttpURLConnection) new URL(MODEL_URL).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setInstanceFollowRedirects(true);
        try (InputStream in = new BufferedInputStream(c.getInputStream());
             OutputStream out = new FileOutputStream(tmp)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        } finally {
            c.disconnect();
        }

        File dest = ctx.getFilesDir();
        String destPath = dest.getCanonicalPath() + File.separator;
        try (ZipInputStream zis = new ZipInputStream(
                new BufferedInputStream(new FileInputStream(tmp)))) {
            ZipEntry e;
            byte[] buf = new byte[16384];
            while ((e = zis.getNextEntry()) != null) {
                File f = new File(dest, e.getName());
                // Protection zip-slip
                if (!f.getCanonicalPath().startsWith(destPath)) { zis.closeEntry(); continue; }
                if (e.isDirectory()) {
                    f.mkdirs();
                } else {
                    File parent = f.getParentFile();
                    if (parent != null) parent.mkdirs();
                    try (OutputStream fo = new FileOutputStream(f)) {
                        int n;
                        while ((n = zis.read(buf)) != -1) fo.write(buf, 0, n);
                    }
                }
                zis.closeEntry();
            }
        }
        tmp.delete();
        if (!isModelReady()) throw new IllegalStateException("modèle décompressé introuvable");
    }
}
