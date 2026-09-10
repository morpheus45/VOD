package com.pipsiflix.app.vpn;

import android.content.Context;
import com.wireguard.android.backend.Backend;
import com.wireguard.android.backend.GoBackend;
import com.wireguard.android.backend.Tunnel;
import com.wireguard.config.Config;

/** Backend réel : pilote un tunnel WireGuard-Go nommé "pipsily". */
public final class GoWgBackend implements WgBackend {
    private final Backend backend;
    private Config lastConfig;
    private final Tunnel tunnel = new Tunnel() {
        public String getName() { return "pipsily"; }
        public void onStateChange(Tunnel.State newState) { }
    };

    public GoWgBackend(Context ctx) { this.backend = new GoBackend(ctx.getApplicationContext()); }

    @Override public void up(Config c) throws Exception {
        lastConfig = c;
        backend.setState(tunnel, Tunnel.State.UP, c);
    }
    @Override public void down() {
        try { backend.setState(tunnel, Tunnel.State.DOWN, lastConfig); } catch (Exception ignored) {}
    }
    @Override public boolean isUp() {
        try { return backend.getState(tunnel) == Tunnel.State.UP; } catch (Exception e) { return false; }
    }
    @Override public long lastHandshakeAgeSec() {
        try {
            com.wireguard.android.backend.Statistics st = backend.getStatistics(tunnel);
            long latest = 0;
            for (com.wireguard.crypto.Key k : st.peers()) {
                long t = st.peer(k).latestHandshakeEpochMillis();
                if (t > latest) latest = t;
            }
            if (latest == 0) return Long.MAX_VALUE;
            return (System.currentTimeMillis() - latest) / 1000L;
        } catch (Exception e) { return Long.MAX_VALUE; }
    }
}
