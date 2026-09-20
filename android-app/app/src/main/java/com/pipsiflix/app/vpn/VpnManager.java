package com.pipsiflix.app.vpn;

import com.wireguard.config.Config;
import java.util.ArrayList;
import java.util.List;

/** Orchestre l'état du VPN. Sans dépendance Android → testable en JVM. */
public final class VpnManager {
    public enum State { IDLE, CONNECTING, CONNECTED, RECONNECTING, DISABLED, ERROR }
    public interface Listener { void onState(State s, VpnServer current); }

    /**
     * Relance demandée par le tick de santé quand le tunnel est mort.
     *
     * onHealthTick() se contentait de passer en RECONNECTING en comptant sur un
     * « appelant explicite » pour relancer la connexion. Personne ne le faisait
     * côté TV : le tunnel restait mort jusqu'au prochain lancement manuel, et
     * comme la config ne route QUE notre application (per-app), le trafic vidéo
     * partait dans un trou noir — d'où des coupures en pleine lecture qui ne se
     * réparaient jamais. L'implémentation est fournie par l'appelant Android,
     * ce qui garde cette classe testable en JVM pure.
     */
    public interface Reconnector { void reconnect(); }

    /** Horloge injectable : les tests n'ont pas à attendre le délai de grâce. */
    public interface Clock { long nowMs(); }

    private static final long STALE_HANDSHAKE_SEC = 180;

    private final WgBackend backend;
    private final String selfPackage;
    // CopyOnWriteArrayList : la liste est mutée depuis le thread UI
    // (register/removeListener) et itérée depuis les threads de connexion
    // (set()) → un ArrayList nu risquerait une ConcurrentModificationException
    // (thread de connexion tué → gel). COW rend l'itération sûre sans verrou.
    private final List<Listener> listeners = new java.util.concurrent.CopyOnWriteArrayList<>();
    private List<VpnServer> servers = new ArrayList<>();
    // volatile : l'état est lu par le thread UI (tick de santé) et écrit par les
    // threads de (re)connexion en arrière-plan — sans ça, le tick peut lire une
    // valeur périmée et manquer la transition RECONNECTING→CONNECTED.
    private volatile State state = State.IDLE;
    private VpnServer current = null;
    // volatile : posé depuis le thread UI, lu depuis le tick de santé.
    private volatile Reconnector reconnector = null;
    private volatile Clock clock = System::currentTimeMillis;
    // Date de la dernière montée du tunnel : sert à accorder un délai de grâce
    // à la poignée de main, que le tick prenait pour une preuve de mort.
    private volatile long connectedAtMs = 0L;
    // Relances enchaînées sans poignée de main fraîche. Remis à zéro dès qu'une
    // poignée de main saine est observée. Borne la boucle de reconnexion.
    private volatile int consecutiveReconnects = 0;

    public VpnManager(WgBackend backend, String selfPackage) {
        this.backend = backend; this.selfPackage = selfPackage;
    }

    public void addListener(Listener l) { listeners.add(l); }
    public void removeListener(Listener l) { listeners.remove(l); }
    public State getState() { return state; }
    public VpnServer getCurrent() { return current; }
    public void setServers(List<VpnServer> s) { this.servers = new ArrayList<>(s); }
    public void setReconnector(Reconnector r) { this.reconnector = r; }
    public void setClock(Clock c) { this.clock = c; }
    public List<VpnServer> getServers() { return new ArrayList<>(servers); }

    private void set(State s) { state = s; for (Listener l : listeners) l.onState(s, current); }

    public void connect(VpnServer s) {
        current = s; set(State.CONNECTING);
        try {
            Config augmented = ConfigAugmenter.augment(s.config, selfPackage);
            backend.up(augmented);
            // up() rend la main dès que l'interface est montée : la poignée de
            // main, elle, n'est pas encore faite. On note l'instant pour que le
            // tick de santé lui laisse le temps de s'établir.
            connectedAtMs = clock.nowMs();
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

        final long ageSec = backend.lastHandshakeAgeSec();
        // Une poignée de main saine prouve que le tunnel vit : on repart d'un
        // budget de relances plein.
        if (ageSec <= STALE_HANDSHAKE_SEC) consecutiveReconnects = 0;

        final long depuisConnexionSec = Math.max(0L, (clock.nowMs() - connectedAtMs) / 1000L);

        switch (HealthPolicy.decide(backend.isUp(), ageSec, depuisConnexionSec,
                                    consecutiveReconnects, STALE_HANDSHAKE_SEC,
                                    HealthPolicy.DEFAULT_GRACE_SEC,
                                    HealthPolicy.DEFAULT_MAX_RECONNECTS)) {
            case RECONNECT:
                consecutiveReconnects++;
                set(State.RECONNECTING);
                // Puis on DEMANDE réellement la relance. La reconnexion elle-même est
                // faite par l'appelant sur un thread de fond (elle fait du réseau) ;
                // ce tick, lui, tourne sur le thread UI.
                Reconnector r = reconnector;
                if (r != null) r.reconnect();
                break;
            case GIVE_UP:
                // Marteler ne sert plus à rien : on rend la main à l'utilisateur,
                // qui se voit proposer réessayer / changer de serveur / continuer
                // sans VPN. Mieux qu'une boucle sans fin.
                set(State.ERROR);
                break;
            case OK:
            case WAIT:
            default:
                break;
        }
    }
}
