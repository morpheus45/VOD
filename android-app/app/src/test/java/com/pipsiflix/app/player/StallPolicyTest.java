package com.pipsiflix.app.player;

import static com.pipsiflix.app.player.StallPolicy.Decision.IGNORE;
import static com.pipsiflix.app.player.StallPolicy.Decision.RESTART;
import static com.pipsiflix.app.player.StallPolicy.Decision.WAIT;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Le cas qui a motivé cette classe est {@link #lienLentTamponQuiGrossit_neRelancePas()} :
 * c'est le « Flux interrompu » rapporté depuis un autoradio en partage de
 * connexion mobile. Les autres vérifient qu'en le corrigeant on n'a pas
 * désarmé le chien de garde.
 */
public class StallPolicyTest {

    private static final long TIMEOUT = 15_000L;

    // ── Le défaut rapporté ────────────────────────────────────────────

    @Test public void lienLentTamponQuiGrossit_neRelancePas() {
        // Position figée depuis 20 s — mais le tampon a grossi il y a 1 s :
        // des octets arrivent, le flux est vivant, il est seulement lent.
        assertEquals(WAIT, StallPolicy.decide(
            true, false, false, /* buffering */ true,
            /* positionFrozenForMs */ 20_000L, /* bufferFrozenForMs */ 1_000L, TIMEOUT));
    }

    @Test public void miseEnTamponTresLongue_neRelanceJamaisTantQueCaArrive() {
        // Deux minutes de mise en tampon sur un lien saturé : tant que le
        // tampon progresse, on laisse faire.
        assertEquals(WAIT, StallPolicy.decide(
            true, false, false, true, 120_000L, 2_000L, TIMEOUT));
    }

    // ── Le cas que le chien de garde vise depuis le début ──────────────

    @Test public void socketMuette_positionEtTamponFiges_relance() {
        // Plus aucun octet n'arrive : ni la position ni le tampon ne bougent.
        assertEquals(RESTART, StallPolicy.decide(
            true, false, false, true, 20_000L, 20_000L, TIMEOUT));
    }

    @Test public void blocageDeDecodeur_tamponPleinMaisImageFigee_relance() {
        // Pas en mise en tampon : le lecteur se dit prêt, mais l'image ne bouge
        // plus. Le tampon ne peut plus renseigner, le délai tranche.
        assertEquals(RESTART, StallPolicy.decide(
            true, false, false, /* buffering */ false, 20_000L, 0L, TIMEOUT));
    }

    // ── Lecture normale ───────────────────────────────────────────────

    @Test public void lectureQuiAvance_neRelancePas() {
        assertEquals(WAIT, StallPolicy.decide(true, false, false, false, 0L, 0L, TIMEOUT));
    }

    @Test public void gelPlusCourtQueLeDelai_neRelancePas() {
        assertEquals(WAIT, StallPolicy.decide(true, false, false, false, 14_999L, 14_999L, TIMEOUT));
    }

    @Test public void gelPileAuDelai_relance() {
        assertEquals(RESTART, StallPolicy.decide(true, false, false, false, 15_000L, 15_000L, TIMEOUT));
    }

    // ── Rien à surveiller ─────────────────────────────────────────────

    @Test public void pauseUtilisateur_onNeToucheARien() {
        assertEquals(IGNORE, StallPolicy.decide(
            /* playWhenReady */ false, false, false, false, 999_999L, 999_999L, TIMEOUT));
    }

    @Test public void finDuMedia_onNeToucheARien() {
        assertEquals(IGNORE, StallPolicy.decide(true, false, /* ended */ true, false, 999_999L, 999_999L, TIMEOUT));
    }

    @Test public void finDuMediaPrimeSurLIdle() {
        assertEquals(IGNORE, StallPolicy.decide(true, /* idle */ true, /* ended */ true, false, 999_999L, 0L, TIMEOUT));
    }

    // ── Lecteur mort sur erreur fatale ────────────────────────────────

    @Test public void idleDepuisAssezLongtemps_relance() {
        assertEquals(RESTART, StallPolicy.decide(true, /* idle */ true, false, false, 15_000L, 0L, TIMEOUT));
    }

    @Test public void idleRecent_laisseUneChance() {
        assertEquals(WAIT, StallPolicy.decide(true, /* idle */ true, false, false, 3_000L, 0L, TIMEOUT));
    }

    @Test public void idleNeSeLaissePasSauverParLeTampon() {
        // Un lecteur IDLE ne remplit rien : le tampon ne doit pas l'exonérer.
        assertEquals(RESTART, StallPolicy.decide(
            true, /* idle */ true, false, /* buffering */ true, 20_000L, /* tampon frais */ 0L, TIMEOUT));
    }
}
