package com.pipsiflix.app.vpn;

import com.wireguard.config.Config;
import java.util.ArrayList;
import java.util.List;

/** Orchestre l'état du VPN. Sans dépendance Android → testable en JVM. */
public final class VpnManager {
    public enum State { IDLE, CONNECTING, CONNECTED, RECONNECTING, DISABLED, ERROR }
    public interface Listener { void onState(State s, VpnServer current); }

    private static final long STALE_HANDSHAKE_SEC = 180;

    private final WgBackend backend;
    private final String selfPackage;
    private final List<Listener> listeners = new ArrayList<>();
    private List<VpnServer> servers = new ArrayList<>();
    // volatile : l'état est lu par le thread UI (tick de santé) et écrit par les
    // threads de (re)connexion en arrière-plan — sans ça, le tick peut lire une
    // valeur périmée et manquer la transition RECONNECTING→CONNECTED.
    private volatile State state = State.IDLE;
    private VpnServer current = null;

    public VpnManager(WgBackend backend, String selfPackage) {
        this.backend = backend; this.selfPackage = selfPackage;
    }

    public void addListener(Listener l) { listeners.add(l); }
    public void removeListener(Listener l) { listeners.remove(l); }
    public State getState() { return state; }
    public VpnServer getCurrent() { return current; }
    public void setServers(List<VpnServer> s) { this.servers = new ArrayList<>(s); }
    public List<VpnServer> getServers() { return new ArrayList<>(servers); }

    private void set(State s) { state = s; for (Listener l : listeners) l.onState(s, current); }

    public void connect(VpnServer s) {
        current = s; set(State.CONNECTING);
        try {
            Config augmented = ConfigAugmenter.augment(s.config, selfPackage);
            backend.up(augmented);
            set(State.CONNECTED);
        } catch (Exception e) { set(State.ERROR); }
    }

    public void connectFastest(LatencyProbe.Pinger pinger) {
        VpnServer f = LatencyProbe.fastest(servers, pinger);
        if (f == null) { set(State.ERROR); return; }
        connect(f);
    }

    public void switchTo(VpnServer s) { backend.down(); connect(s); }

    public void disconnect() { backend.down(); current = null; set(State.IDLE); }

    public void onHealthTick() {
        if (state != State.CONNECTED) return;
        if (!backend.isUp() || backend.lastHandshakeAgeSec() > STALE_HANDSHAKE_SEC) {
            set(State.RECONNECTING);
            // Pas de relance synchrone ici : un backend réel restaure la connexion en
            // arrière-plan (retry WireGuard) ; un appelant explicite (UI/Auto) déclenchera
            // connect()/connectFastest() pour repasser en CONNECTED.
        }
    }
}
