package com.pipsiflix.app.vpn;

import static org.junit.Assert.*;

import org.json.JSONObject;
import org.junit.Test;

public class WarpProvisionerTest {

    // Clés base64 VALIDES (32 octets) — la lib WireGuard valide le format au parsing.
    private static final String PRIV = "aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXkgMzJieXRlcyE=";
    private static final String PEER = "eHl6enkgc2VydmVyIHB1YmxpYyBrZXkgMzJieXRlcyE=";

    @Test public void buildRegBody_hasKeyAndFields() throws Exception {
        String json = WarpProvisioner.buildRegBody("MYPUBKEY=");
        JSONObject o = new JSONObject(json);
        assertEquals("MYPUBKEY=", o.getString("key"));
        assertEquals("en_US", o.getString("locale"));
        assertTrue("tos horodaté présent", o.getString("tos").length() > 10);
    }

    private static final String SAMPLE_REG =
        "{\"result\":{\"config\":{" +
        "\"peers\":[{\"public_key\":\"" + PEER + "\"," +
        "\"endpoint\":{\"host\":\"engage.cloudflareclient.com:2408\",\"v4\":\"162.159.192.1:2408\"}}]," +
        "\"interface\":{\"addresses\":{\"v4\":\"172.16.0.9\",\"v6\":\"2606:4700:110:8949::9\"}}" +
        "}}}";

    @Test public void buildConfFromReg_producesValidConf() throws Exception {
        String conf = WarpProvisioner.buildConfFromReg(SAMPLE_REG, PRIV);
        assertTrue("clé privée injectée", conf.contains("PrivateKey = " + PRIV));
        assertTrue("clé publique du pair", conf.contains("PublicKey = " + PEER));
        assertTrue("endpoint host", conf.contains("Endpoint = engage.cloudflareclient.com:2408"));
        assertTrue("adresse v4", conf.contains("172.16.0.9/32"));
        assertTrue("adresse v6", conf.contains("2606:4700:110:8949::9/128"));
        assertTrue("DNS WARP", conf.contains("DNS = 1.1.1.1"));
        assertTrue("blackhole IPv6 dans AllowedIPs", conf.contains("::/0"));
    }

    @Test public void buildConfFromReg_isParsableByVpnServers() throws Exception {
        String conf = WarpProvisioner.buildConfFromReg(SAMPLE_REG, PRIV);
        VpnServer s = VpnServers.parse("warp.conf", conf);
        assertEquals("Auto (WARP)", s.label);
        assertEquals("engage.cloudflareclient.com",
            s.config.getPeers().get(0).getEndpoint().get().getHost());
    }

    // ── Regeneration de l'enregistrement ─────────────────────
    // forget() doit vraiment supprimer le cache, sinon getOrCreate() renverrait
    // l'ancien enregistrement bride et le bouton ne servirait a rien.
    @Test public void forget_supprime_le_cache_et_hasRegistration_suit() throws Exception {
        java.io.File dir = java.nio.file.Files.createTempDirectory("warp").toFile();
        java.io.File cache = new java.io.File(dir, "warp.conf");

        assertFalse("sans fichier, aucun enregistrement", WarpProvisioner.hasRegistrationIn(dir));
        assertFalse("rien a oublier", WarpProvisioner.forgetIn(dir));

        java.nio.file.Files.write(cache.toPath(), "[Interface]".getBytes("UTF-8"));
        assertTrue("fichier present = enregistrement present", WarpProvisioner.hasRegistrationIn(dir));

        assertTrue("forget doit signaler la suppression", WarpProvisioner.forgetIn(dir));
        assertFalse("le fichier doit avoir disparu", cache.exists());
        assertFalse("plus aucun enregistrement", WarpProvisioner.hasRegistrationIn(dir));
    }

    @Test public void forget_est_idempotent() throws Exception {
        java.io.File dir = java.nio.file.Files.createTempDirectory("warp2").toFile();
        assertFalse(WarpProvisioner.forgetIn(dir));
        assertFalse(WarpProvisioner.forgetIn(dir));
    }

    @Test public void un_cache_vide_ne_compte_pas_comme_enregistrement() throws Exception {
        java.io.File dir = java.nio.file.Files.createTempDirectory("warp3").toFile();
        java.io.File cache = new java.io.File(dir, "warp.conf");
        assertTrue(cache.createNewFile());
        assertFalse("fichier vide = pas d enregistrement exploitable",
                    WarpProvisioner.hasRegistrationIn(dir));
    }
}
