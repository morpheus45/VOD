package com.pipsiflix.app.vpn;

import android.content.Context;

import com.wireguard.crypto.KeyPair;

import org.json.JSONObject;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Génère un tunnel Cloudflare WARP PROPRE À CHAQUE APPAREIL, au premier lancement.
 *
 * Pourquoi : embarquer une seule config WARP partagée fait que tous les
 * utilisateurs se battent pour le même tunnel (bande passante partagée) et expose
 * une clé publique. Ici, chaque appareil enregistre son propre appareil WARP
 * anonyme auprès de Cloudflare (gratuit, illimité, sans compte), obtient sa clé
 * unique, met la config en cache localement et la réutilise ensuite.
 *
 * Aucune clé n'est donc embarquée dans l'APK ni le dépôt.
 */
public final class WarpProvisioner {

    private static final String REG_URL = "https://api.cloudflareclient.com/v0a2158/reg";
    private static final String CACHE_FILE = "warp.conf";
    private static final String DEFAULT_ENDPOINT = "engage.cloudflareclient.com:2408";

    /** Corps JSON d'enregistrement WARP pour une clé publique donnée. */
    static String buildRegBody(String publicKeyB64) throws Exception {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'+00:00'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        JSONObject o = new JSONObject();
        o.put("key", publicKeyB64);
        o.put("install_id", "");
        o.put("fcm_token", "");
        o.put("tos", f.format(new Date()));
        o.put("model", "PC");
        o.put("serial_number", "");
        o.put("locale", "en_US");
        return o.toString();
    }

    /** Construit le texte .conf WireGuard depuis la réponse d'enregistrement WARP. */
    static String buildConfFromReg(String regJson, String privateKeyB64) throws Exception {
        JSONObject root = new JSONObject(regJson);
        JSONObject res = root.optJSONObject("result");
        if (res == null) res = root; // certaines réponses sont déjà au niveau config
        JSONObject config = res.getJSONObject("config");
        JSONObject peer = config.getJSONArray("peers").getJSONObject(0);
        String peerPub = peer.getString("public_key");
        String endpoint = DEFAULT_ENDPOINT;
        JSONObject ep = peer.optJSONObject("endpoint");
        if (ep != null) {
            String host = ep.optString("host", "");
            if (host.contains(":")) endpoint = host;
            else {
                String v4 = ep.optString("v4", "");
                if (v4.contains(":")) endpoint = v4;
            }
        }
        JSONObject addrs = config.getJSONObject("interface").getJSONObject("addresses");
        String v4 = addrs.optString("v4", "");
        String v6 = addrs.optString("v6", "");
        StringBuilder addr = new StringBuilder();
        if (!v4.isEmpty()) addr.append(v4).append("/32");
        if (!v6.isEmpty()) { if (addr.length() > 0) addr.append(", "); addr.append(v6).append("/128"); }

        return "# name=Auto (WARP)\n"
             + "[Interface]\n"
             + "PrivateKey = " + privateKeyB64 + "\n"
             + "Address = " + addr + "\n"
             + "DNS = 1.1.1.1, 2606:4700:4700::1111\n"
             + "MTU = 1280\n"
             + "[Peer]\n"
             + "PublicKey = " + peerPub + "\n"
             + "AllowedIPs = 0.0.0.0/0, ::/0\n"
             + "Endpoint = " + endpoint + "\n";
    }

    /**
     * Retourne la config WARP de CET appareil : lue depuis le cache si présente,
     * sinon enregistrée maintenant auprès de Cloudflare puis mise en cache.
     * Renvoie null en cas d'échec (réseau/API) → l'appelant gère (failover).
     * À APPELER SUR UN THREAD DE FOND (appel réseau bloquant).
     */
    public static VpnServer getOrCreate(Context ctx) {
        File cache = new File(ctx.getFilesDir(), CACHE_FILE);
        // 1. Cache présent → réutiliser.
        if (cache.isFile() && cache.length() > 0) {
            try {
                String txt = readFile(cache);
                return VpnServers.parse(CACHE_FILE, txt);
            } catch (Exception ignored) { /* cache corrompu → régénérer */ }
        }
        // 2. Enregistrer un nouvel appareil WARP.
        try {
            KeyPair kp = new KeyPair();
            String priv = kp.getPrivateKey().toBase64();
            String pub = kp.getPublicKey().toBase64();

            OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                .build();
            RequestBody body = RequestBody.create(
                buildRegBody(pub), MediaType.parse("application/json; charset=utf-8"));
            Request req = new Request.Builder()
                .url(REG_URL)
                .header("User-Agent", "okhttp/3.12.1")
                .header("CF-Client-Version", "a-6.11-2158")
                .header("Content-Type", "application/json")
                .post(body)
                .build();
            try (Response r = client.newCall(req).execute()) {
                if (!r.isSuccessful() || r.body() == null) return null;
                String conf = buildConfFromReg(r.body().string(), priv);
                writeFile(cache, conf);
                return VpnServers.parse(CACHE_FILE, conf);
            }
        } catch (Exception e) {
            return null;
        }
    }

    private static String readFile(File f) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader(f))) {
            String l; while ((l = r.readLine()) != null) sb.append(l).append('\n');
        }
        return sb.toString();
    }

    private static void writeFile(File f, String content) throws Exception {
        try (java.io.FileWriter w = new java.io.FileWriter(f, false)) { w.write(content); }
    }

    private WarpProvisioner() {}
}
