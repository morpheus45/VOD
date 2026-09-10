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
}
