package com.pipsiflix.app.vpn;

import static org.junit.Assert.*;
import org.junit.Test;

public class VpnServersTest {

    private static final String SAMPLE =
        "[Interface]\n" +
        "PrivateKey = aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXkgMzJieXRlcyE=\n" +
        "Address = 10.64.0.2/32\n" +
        "DNS = 10.64.0.1\n" +
        "[Peer]\n" +
        "PublicKey = eHl6enkgc2VydmVyIHB1YmxpYyBrZXkgMzJieXRlcyE=\n" +
        "Endpoint = 193.138.7.5:51820\n" +
        "AllowedIPs = 0.0.0.0/0\n";

    @Test public void labelFromFilename_prettifies() {
        assertEquals("Windscribe FR Paris",
            VpnServers.labelFromFilename("windscribe-fr-paris.conf"));
        assertEquals("Mullvad CH", VpnServers.labelFromFilename("mullvad-ch.conf"));
    }

    @Test public void parse_readsEndpointAndDns() throws Exception {
        VpnServer s = VpnServers.parse("mullvad-ch.conf", SAMPLE);
        assertEquals("mullvad-ch.conf", s.id);
        assertEquals("Mullvad CH", s.label);
        assertEquals("193.138.7.5",
            s.config.getPeers().get(0).getEndpoint().get().getHost());
    }

    @Test public void parse_honorsNameComment() throws Exception {
        VpnServer s = VpnServers.parse("x.conf", "# name=France · Paris\n" + SAMPLE);
        assertEquals("France · Paris", s.label);
    }
}
