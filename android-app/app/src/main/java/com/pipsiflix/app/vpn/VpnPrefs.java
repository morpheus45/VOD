package com.pipsiflix.app.vpn;

import android.content.Context;
import android.content.SharedPreferences;

/** Persistance des choix VPN + override de session (porte de retour). */
public final class VpnPrefs {
    private static final String P = "pipsily_vpn";
    private final SharedPreferences sp;
    private boolean sessionOverride = false; // mémoire vive uniquement

    public VpnPrefs(Context ctx) { sp = ctx.getSharedPreferences(P, Context.MODE_PRIVATE); }

    public boolean isEnabled() { return sp.getBoolean("enabled", true); }
    public void setEnabled(boolean b) { sp.edit().putBoolean("enabled", b).apply(); }

    public String lastServerId() { return sp.getString("last_server", null); }
    public void setLastServerId(String id) { sp.edit().putString("last_server", id).apply(); }

    public boolean autoFastest() { return sp.getBoolean("auto_fastest", true); }
    public void setAutoFastest(boolean b) { sp.edit().putBoolean("auto_fastest", b).apply(); }

    public boolean sessionOverride() { return sessionOverride; }
    public void setSessionOverride(boolean b) { sessionOverride = b; }
}
