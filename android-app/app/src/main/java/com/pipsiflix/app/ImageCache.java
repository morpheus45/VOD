package com.pipsiflix.app;

import android.content.Context;
import android.webkit.WebResourceResponse;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;

/**
 * Cache disque des vignettes du poste PIPSILY CAR.
 *
 * Le WebView est volontairement en LOAD_NO_CACHE (pour que les mises à jour web
 * arrivent toujours, le service worker ne tournant pas sur ce moteur figé). Sans
 * cache, chaque vignette TMDB était re-téléchargée à CHAQUE session à travers le
 * tunnel WireGuard logiciel de l'ARMv7. Ici on cache UNIQUEMENT les images TMDB
 * (immuables) sur le disque de l'application : cela n'affecte NI le code web
 * (toujours frais), NI la lecture vidéo.
 *
 * Tout est FAIL-SAFE : la moindre erreur → get() renvoie null → le WebView charge
 * l'image normalement (comportement d'avant). Auto-suppression : plafond de taille
 * avec éviction des plus anciennes (LRU par date de dernier accès).
 */
final class ImageCache {

    private static final long MAX_BYTES = 60L * 1024 * 1024;   // ~60 Mo
    private static final int  TIMEOUT   = 8000;                // ms (connexion + lecture)

    private static File sDir;

    private ImageCache() {}

    /** À appeler une fois au démarrage : prépare le dossier et élague en tâche de fond. */
    static synchronized void init(Context ctx) {
        try {
            File dir = new File(ctx.getCacheDir(), "thumbs");
            if (!dir.exists()) dir.mkdirs();
            sDir = dir;
            new Thread(ImageCache::prune, "thumb-prune").start();
        } catch (Throwable t) {
            sDir = null;
        }
    }

    /** Vignette depuis le disque (ou téléchargée puis stockée), ou null → chargement normal. */
    static WebResourceResponse get(String url) {
        try {
            File dir = sDir;
            if (dir == null || url == null) return null;
            File f = new File(dir, key(url));
            byte[] bytes;
            if (f.exists() && f.length() > 0) {
                f.setLastModified(System.currentTimeMillis());   // LRU : marque l'accès
                bytes = readFile(f);
            } else {
                bytes = download(url);
                if (bytes == null || bytes.length == 0) return null;
                writeAtomic(f, bytes);
            }
            if (bytes == null || bytes.length == 0) return null;
            return new WebResourceResponse(mime(url), null, new ByteArrayInputStream(bytes));
        } catch (Throwable t) {
            return null;   // fail-safe : le WebView chargera l'image lui-même
        }
    }

    private static String key(String url) {
        return Integer.toHexString(url.hashCode()) + "_" + url.length();
    }

    private static String mime(String url) {
        String u = url.toLowerCase();
        if (u.contains(".png"))  return "image/png";
        if (u.contains(".webp")) return "image/webp";
        return "image/jpeg";
    }

    private static byte[] download(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(TIMEOUT);
            c.setReadTimeout(TIMEOUT);
            c.setInstanceFollowRedirects(true);
            if (c.getResponseCode() != 200) return null;
            InputStream in = new BufferedInputStream(c.getInputStream());
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
            in.close();
            return bos.toByteArray();
        } catch (Throwable t) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static byte[] readFile(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        try {
            byte[] out = new byte[(int) f.length()];
            int off = 0, n;
            while (off < out.length && (n = in.read(out, off, out.length - off)) != -1) off += n;
            return out;
        } finally {
            in.close();
        }
    }

    private static void writeAtomic(File f, byte[] bytes) {
        try {
            File tmp = new File(f.getAbsolutePath() + ".tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            try { out.write(bytes); out.flush(); } finally { out.close(); }
            if (!tmp.renameTo(f)) tmp.delete();
        } catch (Throwable ignored) {}
    }

    /** Éviction : si le dossier dépasse le plafond, supprime les fichiers les plus anciens. */
    private static void prune() {
        try {
            File dir = sDir;
            if (dir == null) return;
            File[] files = dir.listFiles();
            if (files == null) return;
            long total = 0;
            for (File f : files) total += f.length();
            if (total <= MAX_BYTES) return;
            Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            for (File f : files) {
                if (total <= MAX_BYTES) break;
                long len = f.length();
                if (f.delete()) total -= len;
            }
        } catch (Throwable ignored) {}
    }
}
