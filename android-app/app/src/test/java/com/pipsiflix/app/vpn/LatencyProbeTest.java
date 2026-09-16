package com.pipsiflix.app.vpn;

import static org.junit.Assert.*;
import com.wireguard.config.Config;
import java.io.BufferedReader;
import java.io.StringReader;
import java.util.*;
import org.junit.Test;

public class LatencyProbeTest {
    private VpnServer srv(String id, String host) throws Exception {
        String c = "[Interface]\nPrivateKey = aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXkgMzJieXRlcyE=\n" +
            "Address = 10.0.0.2/32\nDNS = 10.0.0.1\n[Peer]\n" +
            "PublicKey = eHl6enkgc2VydmVyIHB1YmxpYyBrZXkgMzJieXRlcyE=\n" +
            "Endpoint = " + host + ":51820\nAllowedIPs = 0.0.0.0/0\n";
        return new VpnServer(id, id, Config.parse(new BufferedReader(new StringReader(c))));
    }

    @Test public void ranksByLatencyThenUnreachableLast() throws Exception {
        List<VpnServer> in = Arrays.asList(srv("a","1.1.1.1"), srv("b","2.2.2.2"), srv("c","3.3.3.3"));
        Map<String,Long> lat = new HashMap<>();
        lat.put("1.1.1.1", 120L); lat.put("2.2.2.2", 30L); lat.put("3.3.3.3", Long.MAX_VALUE);
        LatencyProbe.Pinger fake = (host, port) -> lat.get(host);
        List<VpnServer> out = LatencyProbe.rank(in, fake);
        assertEquals("b", out.get(0).id); // 30ms
        assertEquals("a", out.get(1).id); // 120ms
        assertEquals("c", out.get(2).id); // injoignable en dernier
        assertEquals("b", LatencyProbe.fastest(in, fake).id);
    }

    @Test public void fastest_emptyList_returnsNull() {
        assertNull(LatencyProbe.fastest(new ArrayList<>(), (h,p)->1L));
    }
}
