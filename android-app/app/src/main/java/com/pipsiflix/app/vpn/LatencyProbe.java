package com.pipsiflix.app.vpn;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/** Mesure la latence des endpoints et classe les serveurs du plus rapide au plus lent. */
public final class LatencyProbe {

    public interface Pinger { long pingMs(String host, int port); }

    public static Pinger tcpPinger() {
        return (host, port) -> {
            long t0 = System.nanoTime();
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(host, port), 1500);
                return (System.nanoTime() - t0) / 1_000_000L;
            } catch (Exception e) { return Long.MAX_VALUE; }
        };
    }

    private static int port(VpnServer s) {
        try { return s.config.getPeers().get(0).getEndpoint().get().getPort(); }
        catch (Exception e) { return 51820; }
    }
    private static String host(VpnServer s) {
        try { return s.config.getPeers().get(0).getEndpoint().get().getHost(); }
        catch (Exception e) { return ""; }
    }

    public static List<VpnServer> rank(List<VpnServer> servers, Pinger p) {
        List<VpnServer> out = new ArrayList<>(servers);
        final java.util.Map<String,Long> cache = new java.util.HashMap<>();
        for (VpnServer s : out) cache.put(s.id, p.pingMs(host(s), port(s)));
        Collections.sort(out, Comparator.comparingLong(s -> cache.get(s.id)));
        return out;
    }

    public static VpnServer fastest(List<VpnServer> servers, Pinger p) {
        if (servers.isEmpty()) return null;
        List<VpnServer> ranked = rank(servers, p);
        return ranked.get(0);
    }
    private LatencyProbe() {}
}
