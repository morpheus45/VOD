package com.pipsiflix.app.vpn;

import static org.junit.Assert.*;
import com.wireguard.config.Config;
import java.io.BufferedReader;
import java.io.StringReader;
import java.util.*;
import org.junit.Test;

public class VpnManagerTest {
    static class FakeBackend implements WgBackend {
        boolean up = false; boolean failNext = false; long hsAge = 0;
        public void up(Config c) throws Exception { if (failNext) throw new RuntimeException("fail"); up = true; }
        public void down() { up = false; }
        public boolean isUp() { return up; }
        public long lastHandshakeAgeSec() { return hsAge; }
    }
    private VpnServer srv(String id) throws Exception {
        String c = "[Interface]\nPrivateKey = aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXkgMzJieXRlcyE=\n" +
            "Address=10.0.0.2/32\nDNS=10.0.0.1\n[Peer]\nPublicKey = eHl6enkgc2VydmVyIHB1YmxpYyBrZXkgMzJieXRlcyE=\n" +
            "Endpoint=1.2.3.4:51820\nAllowedIPs=0.0.0.0/0\n";
        return new VpnServer(id, id, Config.parse(new BufferedReader(new StringReader(c))));
    }

    @Test public void connect_reachesConnected() throws Exception {
        FakeBackend b = new FakeBackend();
        VpnManager m = new VpnManager(b, "com.pipsiflix.app");
        VpnServer s = srv("a"); m.setServers(Collections.singletonList(s));
        m.connect(s);
        assertEquals(VpnManager.State.CONNECTED, m.getState());
        assertEquals("a", m.getCurrent().id);
        assertTrue(b.isUp());
    }

    @Test public void up_failure_goesError() throws Exception {
        FakeBackend b = new FakeBackend(); b.failNext = true;
        VpnManager m = new VpnManager(b, "com.pipsiflix.app");
        m.connect(srv("a"));
        assertEquals(VpnManager.State.ERROR, m.getState());
    }

    @Test public void healthTick_staleHandshake_reconnects() throws Exception {
        FakeBackend b = new FakeBackend();
        VpnManager m = new VpnManager(b, "com.pipsiflix.app");
        m.connect(srv("a"));
        b.up = false; // tunnel tombé
        m.onHealthTick();
        assertEquals(VpnManager.State.RECONNECTING, m.getState());
    }

    @Test public void disconnect_goesIdle() throws Exception {
        FakeBackend b = new FakeBackend();
        VpnManager m = new VpnManager(b, "com.pipsiflix.app");
        m.connect(srv("a")); m.disconnect();
        assertEquals(VpnManager.State.IDLE, m.getState());
        assertFalse(b.isUp());
    }
}
