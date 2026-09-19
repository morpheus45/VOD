package com.pipsiflix.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import java.io.File;

/**
 * Ménage des résidus laissés par les mises à jour et par la WebView.
 *
 * Cette classe existe parce que les deux points d'entrée — MainActivity côté
 * téléphone, TvActivity côté téléviseur — dupliquaient leur propre logique de
 * téléchargement, et que la purge profonde n'avait été écrite que dans l'une des
 * deux. Le téléviseur, lui, n'avait donc aucun moyen de récupérer son espace.
 * Tout ce qui doit valoir pour les deux vit ici, et nulle part ailleurs.
 */
final class Menage {

    private static final String TAG   = "PipsilyMenage";
    private static final String PREFS = "pipsily_prefs";
    private static final String CLE_ID_TELECHARGEMENT = "apk_download_id";
    private static final String FICHIER_MAJ = "PIPSILY_update.apk";

    /**
     * Délai de garde avant de toucher à l'APK téléchargée. Une installation
     * peut être en cours pendant que l'activité est recréée — l'utilisateur
     * revient en arrière depuis la boîte de dialogue du système, par exemple.
     * Supprimer le fichier sous le nez de l'installateur casserait la mise à
     * jour. Passé ce délai, l'installation a abouti ou a été abandonnée : dans
     * les deux cas le fichier ne sert plus, car chaque téléchargement le
     * réécrit de zéro et aucun code ne le réutilise.
     */
    private static final long DELAI_GARDE_MS = 10L * 60L * 1000L;

    private Menage() {}

    /** Emplacement de l'APK de mise à jour, identique aux deux chemins de téléchargement. */
    static File fichierMaj(Context ctx) {
        File dir = ctx.getExternalFilesDir(null);
        if (dir == null) dir = ctx.getCacheDir();
        return dir == null ? null : new File(dir, FICHIER_MAJ);
    }

    /** Mémorise l'identifiant du téléchargement, pour pouvoir le retirer au prochain lancement. */
    static void memoriserTelechargement(Context ctx, long id) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
               .edit().putLong(CLE_ID_TELECHARGEMENT, id).apply();
        } catch (Throwable ignored) {}
    }

    /**
     * Efface ce qu'une mise à jour laisse derrière elle : l'APK téléchargée
     * (≈ 16 Mo, jamais supprimée après l'installation) et l'entrée du
     * gestionnaire de téléchargements Android.
     *
     * L'ancien code n'appelait `remove()` que si un téléchargement avait été
     * lancé dans la MÊME session du processus. Or une mise à jour redémarre
     * forcément l'application : l'identifiant était perdu et l'entrée restait
     * dans la liste système, une de plus à chaque version. On le range donc
     * dans les préférences.
     *
     * À appeler au démarrage. Ne fait rien si un téléchargement est trop récent.
     */
    static void nettoyerResidusMaj(Context ctx) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            long idEnCours = prefs.getLong(CLE_ID_TELECHARGEMENT, -1L);

            // Un telechargement en cours ne doit RIEN subir. Le garde
            // d'anciennete seul ne suffisait pas : entre le `dest.delete()` et
            // la premiere ecriture de DownloadManager, le fichier n'existe pas,
            // donc il paraissait « vieux » — et on annulait la mise a jour en
            // vol. Meme chose pour un telechargement en attente reseau depuis
            // plus de dix minutes. Symptome : sur lien lent, la mise a jour
            // repartait de zero a chaque lancement, sans un mot.
            if (idEnCours > 0) {
                try {
                    DownloadManager dmv =
                        (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dmv != null && telechargementEnCours(dmv, idEnCours)) {
                        Log.i(TAG, "Téléchargement " + idEnCours
                                 + " en cours — aucun ménage");
                        return;
                    }
                } catch (Throwable ignored) {}
            }

            File f = fichierMaj(ctx);
            boolean recent = f != null && f.exists()
                && (System.currentTimeMillis() - f.lastModified()) < DELAI_GARDE_MS;
            if (recent) {
                Log.i(TAG, "APK de mise à jour récente — installation peut-être en cours, on n'y touche pas");
                return;
            }

            if (f != null && f.exists()) {
                long mo = f.length() / (1024L * 1024L);
                Log.i(TAG, "Suppression de l'APK de mise à jour (" + mo + " Mo) : "
                         + (f.delete() ? "faite" : "refusée"));
            }

            long id = idEnCours;
            if (id > 0) {
                try {
                    DownloadManager dm =
                        (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm == null) return;
                    // L'etat a deja ete verifie en tete de methode.
                    dm.remove(id);
                    Log.i(TAG, "Entrée de téléchargement " + id + " retirée");
                } catch (Throwable t) {
                    Log.w(TAG, "Retrait de l'entrée de téléchargement impossible : " + t);
                }
                prefs.edit().remove(CLE_ID_TELECHARGEMENT).apply();
            }
        } catch (Throwable t) {
            Log.w(TAG, "Ménage des résidus de mise à jour échoué : " + t);
        }
    }

    /**
     * Purge les caches WebView volumineux (CacheStorage du Service Worker, cache
     * HTTP Chromium, GPUCache, blob_storage…) en PRÉSERVANT « Local Storage »
     * (le login/session). À appeler AVANT la création de la WebView.
     *
     * Pourquoi : le stockage de l'appli monte tout seul (observé : 3,2 Go) sans que
     * webView.clearCache() n'y change rien — car clearCache ne touche PAS le
     * CacheStorage du Service Worker, et WebView n'expose aucune API pour le vider.
     * On supprime donc directement les sous-dossiers de cache, en gardant le dossier
     * « Local Storage » où vit le token de session → espace récupéré, login conservé.
     * Ne se déclenche qu'au-delà de 1 Go pour ne pas ralentir les démarrages normaux.
     *
     * Cosmos n'enregistre aucun service worker, mais ses réglages proposent de
     * basculer vers l'interface Xstream, qui en enregistre un : à partir de là, un
     * téléviseur sans cette purge n'a plus aucun moyen de récupérer cet espace.
     */
    static void purgerCachesVolumineux(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT < 26) return;
            android.app.usage.StorageStatsManager ssm =
                (android.app.usage.StorageStatsManager)
                    ctx.getSystemService(Context.STORAGE_STATS_SERVICE);
            if (ssm == null) return;
            android.app.usage.StorageStats st = ssm.queryStatsForPackage(
                android.os.storage.StorageManager.UUID_DEFAULT,
                ctx.getPackageName(), android.os.Process.myUserHandle());
            long dataMb = st.getDataBytes() / (1024L * 1024L);
            if (dataMb < 1024) return;   // < 1 Go : rien à faire
            File webviewDir = new File(ctx.getDataDir(), "app_webview");
            File base = new File(webviewDir, "Default");
            if (!base.isDirectory()) base = webviewDir;   // appareils sans profil "Default"
            String[] aPurger = {
                "Service Worker", "Cache", "GPUCache", "Code Cache",
                "blob_storage", "IndexedDB", "Session Storage",
                "File System", "Shared Dictionary"
            };
            for (String p : aPurger) supprimerRecursif(new File(base, p));
            Log.i(TAG, "Purge caches WebView : data etait " + dataMb
                     + " Mo (Local Storage/login preserve)");
        } catch (Throwable t) {
            Log.w(TAG, "purge WebView echouee : " + t);
        }
    }

    /**
     * Le telechargement est-il encore en vol ? On interroge l'etat reel plutot
     * que de deduire quoi que ce soit de la presence du fichier : l'identifiant
     * est range a l'ENQUEUE, il ne dit donc rien de l'avancement.
     */
    private static boolean telechargementEnCours(DownloadManager dm, long id) {
        android.database.Cursor c = null;
        try {
            c = dm.query(new DownloadManager.Query().setFilterById(id));
            if (c == null || !c.moveToFirst()) return false;   // entree disparue
            int etat = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            return etat == DownloadManager.STATUS_PENDING
                || etat == DownloadManager.STATUS_RUNNING
                || etat == DownloadManager.STATUS_PAUSED;
        } catch (Throwable t) {
            // Dans le doute on se declare « en cours » : ne rien casser prime
            // sur recuperer 16 Mo.
            Log.w(TAG, "Etat du téléchargement illisible : " + t);
            return true;
        } finally {
            if (c != null) { try { c.close(); } catch (Throwable ignored) {} }
        }
    }

    private static void supprimerRecursif(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] enfants = f.listFiles();
            if (enfants != null) for (File e : enfants) supprimerRecursif(e);
        }
        f.delete();
    }
}
