package com.pipsiflix.app.vpn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import com.wireguard.config.Config;
import java.io.BufferedReader;
import java.io.StringReader;
import java.util.Collections;
import org.junit.Test;

/**
 * Rejoue la boucle rapportée sur PIPSILY CAR sur le VpnManager complet, et non
 * sur la seule décision : le tick tourne toutes les cinq secondes pendant
 * plusieurs minutes, avec un backend qui n'a JAMAIS de poignée de main — ce que
 * rend le backend réel tant que le tunnel ne s'établit pas
 * ({@code Long.MAX_VALUE}).
 *
 * <p>Le FakeBackend de VpnManagerTest rend {@code hsAge = 0} par défaut, soit une
 * poignée de main parfaitement fraîche dès la montée du tunnel. C'est pour cela
 * que la suite existante ne pouvait pas voir le défaut : le double était plus
 * optimiste que l'appareil.
 */
public class VpnManagerHealthTest {

    /** Backend qui monte bien l'interface, mais dont la poignée de main n'arrive jamais. */
    static class BackendSansPoigneeDeMain implements WgBackend {
        boolean up = false;
        int montees = 0;
        public void up(Config c) { up = true; montees++; }
        public void down() { up = false; }
        public boolean isUp() { return up; }
        public long lastHandshakeAgeSec() { return Long.MAX_VALUE; }  // « inconnu »
    }

    /** Horloge pilotée : on avance le temps sans attendre. */
    static class Horloge implements VpnManager.Clock {
        long ms = 1_000_000L;
        public long nowMs() { return ms; }
        void avancer(long sec) { ms += sec * 1000L; }
    }

    private VpnServer srv(String id) throws Exception {
        String c = "[Interface]\nPrivateKey = aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXkgMzJieXRlcyE=\n" +
            "Address=10.0.0.2/32\nDNS=10.0.0.1\n[Peer]\nPublicKey = eHl6enkgc2VydmVyIHB1YmxpYyBrZXkgMzJieXRlcyE=\n" +
            "Endpoint=1.2.3.4:51820\nAllowedIPs=0.0.0.0/0\n";
        return new VpnServer(id, id, Config.parse(new BufferedReader(new StringReader(c))));
    }

    @Test public void tunnelLent_neReconnectePasPendantLaGrace() throws Exception {
        BackendSansPoigneeDeMain b = new BackendSansPoigneeDeMain();
        Horloge h = new Horloge();
        VpnManager m = new VpnManager(b, "com.pipsiflix.car");
        m.setClock(h);
        final int[] relances = {0};
        m.setReconnector(() -> relances[0]++);

        VpnServer s = srv("warp");
        m.setServers(Collections.singletonList(s));
        m.connect(s);
        assertEquals(VpnManager.State.CONNECTED, m.getState());

        // Huit ticks de 5 s = 40 s, soit moins que le délai de grâce.
        for (int i = 0; i < 8; i++) { h.avancer(5); m.onHealthTick(); }

        assertEquals("aucune relance tant que la poignée de main a le droit d'arriver", 0, relances[0]);
        assertEquals(VpnManager.State.CONNECTED, m.getState());
    }

    @Test public void tunnelQuiNeSEtablitJamais_relanceUnNombreBorneDeFois() throws Exception {
        BackendSansPoigneeDeMain b = new BackendSansPoigneeDeMain();
        Horloge h = new Horloge();
        VpnManager m = new VpnManager(b, "com.pipsiflix.car");
        m.setClock(h);
        final int[] relances = {0};
        // Le reconnecteur réel remonte le tunnel : on le simule, c'est ce qui
        // remettait le compteur de grâce à zéro et entretenait la boucle.
        m.setReconnector(() -> { relances[0]++; try { m.connect(srv("warp")); } catch (Exception e) { throw new RuntimeException(e); } });

        VpnServer s = srv("warp");
        m.setServers(Collections.singletonList(s));
        m.connect(s);

        // Dix minutes de ticks toutes les cinq secondes : 120 occasions de boucler.
        for (int i = 0; i < 120; i++) { h.avancer(5); m.onHealthTick(); }

        assertTrue("la boucle doit être bornée, pas infinie (" + relances[0] + " relances)",
                   relances[0] <= HealthPolicy.DEFAULT_MAX_RECONNECTS);
        assertEquals("passé le budget, l'utilisateur reprend la main",
                     VpnManager.State.ERROR, m.getState());
    }

    @Test public void poigneeDeMainQuiFinitParArriver_remetLeBudgetAZero() throws Exception {
        // Backend dont la poignée de main apparaît après un moment.
        class BackendTardif implements WgBackend {
            boolean up = false; long age = Long.MAX_VALUE;
            public void up(Config c) { up = true; }
            public void down() { up = false; }
            public boolean isUp() { return up; }
            public long lastHandshakeAgeSec() { return age; }
        }
        BackendTardif b = new BackendTardif();
        Horloge h = new Horloge();
        VpnManager m = new VpnManager(b, "com.pipsiflix.car");
        m.setClock(h);
        final int[] relances = {0};
        m.setReconnector(() -> relances[0]++);

        VpnServer s = srv("warp");
        m.connect(s);
        for (int i = 0; i < 6; i++) { h.avancer(5); m.onHealthTick(); }   // 30 s : dans la grâce
        assertEquals(0, relances[0]);

        b.age = 2;                                   // la poignée de main arrive
        for (int i = 0; i < 100; i++) { h.avancer(5); m.onHealthTick(); }

        assertEquals("un tunnel sain ne doit jamais être relancé", 0, relances[0]);
        assertEquals(VpnManager.State.CONNECTED, m.getState());
    }
}
