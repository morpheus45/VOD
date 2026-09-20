package com.pipsiflix.app.vpn;

import static com.pipsiflix.app.vpn.HealthPolicy.Action.GIVE_UP;
import static com.pipsiflix.app.vpn.HealthPolicy.Action.OK;
import static com.pipsiflix.app.vpn.HealthPolicy.Action.RECONNECT;
import static com.pipsiflix.app.vpn.HealthPolicy.Action.WAIT;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Le cas qui a motivé cette classe est {@link #aucunePoigneeDeMainEncore_attend()} :
 * c'est la reconnexion en boucle rapportée sur PIPSILY CAR. Les autres
 * vérifient qu'en la corrigeant on n'a pas désarmé la surveillance.
 */
public class HealthPolicyTest {

    private static final long INCONNU = Long.MAX_VALUE;   // ce que rend le backend réel
    private static final long STALE   = 180;
    private static final long GRACE   = 45;
    private static final int  BUDGET  = 3;

    private static HealthPolicy.Action decide(boolean up, long age, long depuis, int relances) {
        return HealthPolicy.decide(up, age, depuis, relances, STALE, GRACE, BUDGET);
    }

    // ── Le défaut rapporté ────────────────────────────────────────────

    @Test public void aucunePoigneeDeMainEncore_attend() {
        // Cinq secondes après la montée du tunnel : la poignée de main n'a pas
        // encore eu lieu. C'est exactement l'instant où le tick relançait.
        assertEquals(WAIT, decide(true, INCONNU, 5, 0));
    }

    @Test public void poigneeDeMainLenteMaisDansLeDelai_attend() {
        assertEquals(WAIT, decide(true, INCONNU, 44, 0));
    }

    @Test public void unTickNeConsommeAucunBudgetPendantLaGrace() {
        // Neuf ticks de 5 s pendant la grâce : aucun ne doit relancer.
        for (long t = 5; t < GRACE; t += 5) {
            assertEquals("tick à " + t + " s", WAIT, decide(true, INCONNU, t, 0));
        }
    }

    // ── La surveillance reste armée ───────────────────────────────────

    @Test public void aucunePoigneeDeMainPasseLeDelai_relance() {
        // Passé la grâce, un tunnel qui ne s'établit toujours pas est un vrai
        // problème : là, relancer a du sens.
        assertEquals(RECONNECT, decide(true, INCONNU, 45, 0));
    }

    @Test public void poigneeDeMainPerimee_relance() {
        // Le cas d'origine du tick : le tunnel vivait, il est mort en route.
        assertEquals(RECONNECT, decide(true, 999, 3600, 0));
    }

    @Test public void interfaceTombee_relanceSansAttendre() {
        // Le service VPN a été tué : rien à attendre d'une poignée de main.
        assertEquals(RECONNECT, decide(false, INCONNU, 1, 0));
    }

    @Test public void poigneeDeMainFraiche_rienAFaire() {
        assertEquals(OK, decide(true, 5, 600, 0));
    }

    @Test public void poigneeDeMainPileALaLimite_rienAFaire() {
        assertEquals(OK, decide(true, STALE, 600, 0));
    }

    // ── La boucle est bornée ──────────────────────────────────────────

    @Test public void budgetEpuise_onRendLaMain() {
        // Trois relances sans résultat : on arrête de marteler et l'utilisateur
        // se voit proposer une issue.
        assertEquals(GIVE_UP, decide(true, INCONNU, 60, BUDGET));
    }

    @Test public void budgetEpuise_memeSurPoigneeDeMainPerimee() {
        assertEquals(GIVE_UP, decide(true, 999, 3600, BUDGET));
    }

    @Test public void budgetEpuise_memeInterfaceTombee() {
        assertEquals(GIVE_UP, decide(false, INCONNU, 1, BUDGET));
    }

    @Test public void dernierEssaiAvantAbandon() {
        assertEquals(RECONNECT, decide(true, INCONNU, 60, BUDGET - 1));
    }
}
