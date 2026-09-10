package com.pipsiflix.app.vpn;

/** Décide si le kill-switch strict doit être appliqué (spec §13). */
public final class VpnGate {
    public static boolean shouldEnforce(boolean globalEnabled, boolean remoteEnabled, boolean sessionOverride) {
        return globalEnabled && remoteEnabled && !sessionOverride;
    }
    private VpnGate() {}
}
