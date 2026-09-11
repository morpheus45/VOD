package com.pipsiflix.app.vpn;

import static org.junit.Assert.*;
import com.wireguard.config.Config;
import java.io.BufferedReader;
import java.io.StringReader;
import org.junit.Test;

public class ConfigAugmenterTest {
    private Config base(String allowed) throws Exception {
        String c = "[Interface]\nPrivateKey = aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXkgMzJieXRlcyE=\n" +
            "Address = 10.64.0.2/32\nDNS = 10.64.0.1\n[Peer]\n" +
            "PublicKey = eHl6enkgc2VydmVyIHB1YmxpYyBrZXkgMzJieXRlcyE=\n" +
            "Endpoint = 1.2.3.4:51820\nAllowedIPs = " + allowed + "\n";
        return Config.parse(new BufferedReader(new StringReader(c)));
    }

    @Test public void forcesSelfOnlyApplication() throws Exception {
        Config out = ConfigAugmenter.augment(base("0.0.0.0/0"), "com.pipsiflix.app");
        assertTrue(out.getInterface().getIncludedApplications().contains("com.pipsiflix.app"));
        assertEquals(1, out.getInterface().getIncludedApplications().size());
    }

    @Test public void addsIpv6Blackhole() throws Exception {
        Config out = ConfigAugmenter.augment(base("0.0.0.0/0"), "com.pipsiflix.app");
        // NB: com.wireguard.config.InetNetwork#toString() délègue à
        // InetAddress#getHostAddress(), qui ne compresse pas les zéros IPv6
        // (RFC 5952) sur ce JDK — "::/0" est donc rendu "0:0:0:0:0:0:0:0/0".
        // Les deux littéraux désignent la même route (adresse IPv6 non spécifiée,
        // masque /0) ; voir task-3-report.md pour la preuve.
        boolean hasV6 = out.getPeers().get(0).getAllowedIps().stream()
            .anyMatch(n -> n.toString().equals("::/0") || n.toString().equals("0:0:0:0:0:0:0:0/0"));
        assertTrue("doit router ::/0 pour bloquer la fuite IPv6", hasV6);
    }

    @Test public void keepsDns() throws Exception {
        Config out = ConfigAugmenter.augment(base("0.0.0.0/0"), "com.pipsiflix.app");
        assertFalse(out.getInterface().getDnsServers().isEmpty());
    }

    @Test public void appliesDefaultPersistentKeepalive() throws Exception {
        // Une config WARP generee sans PersistentKeepalive doit recevoir la
        // valeur par defaut : sans elle, le mapping UDP du CGNAT expire pendant
        // les periodes de silence (buffer video plein = plus aucune requete
        // pendant ~1 min) et le tunnel meurt en pleine lecture.
        Config out = ConfigAugmenter.augment(base("0.0.0.0/0"), "com.pipsiflix.app");
        assertTrue("keepalive doit etre pose par defaut",
            out.getPeers().get(0).getPersistentKeepalive().isPresent());
        assertEquals(Integer.valueOf(ConfigAugmenter.DEFAULT_KEEPALIVE_SEC),
            out.getPeers().get(0).getPersistentKeepalive().get());
    }

    @Test public void keepsExplicitPersistentKeepalive() throws Exception {
        String c = "[Interface]\nPrivateKey = aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXkgMzJieXRlcyE=\n" +
            "Address = 10.64.0.2/32\nDNS = 10.64.0.1\n[Peer]\n" +
            "PublicKey = eHl6enkgc2VydmVyIHB1YmxpYyBrZXkgMzJieXRlcyE=\n" +
            "Endpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 15\n";
        Config out = ConfigAugmenter.augment(
            Config.parse(new BufferedReader(new StringReader(c))), "com.pipsiflix.app");
        assertEquals(Integer.valueOf(15), out.getPeers().get(0).getPersistentKeepalive().get());
    }
}
