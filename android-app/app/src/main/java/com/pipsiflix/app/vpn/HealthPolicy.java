package com.pipsiflix.app.vpn;

/**
 * Décide ce que le tick de santé doit faire du tunnel.
 *
 * <p>Le tick tourne toutes les cinq secondes et relançait le tunnel dès que la
 * dernière poignée de main dépassait trois minutes. Il lisait pour cela
 * {@link WgBackend#lastHandshakeAgeSec()}, qui rend {@code Long.MAX_VALUE}
 * quand l'âge est <b>inconnu</b> — c'est-à-dire, notamment, quand aucune poignée
 * de main n'a <b>encore</b> eu lieu.
 *
 * <p>Or {@code VpnManager.connect()} annonce CONNECTED dès que
 * {@code backend.up()} rend la main : l'interface est montée, mais la poignée de
 * main n'est pas faite. Cinq secondes plus tard, le tick lisait donc
 * {@code Long.MAX_VALUE}, le comparait à trois minutes, et relançait.
 *
 * <p>La relance recoupe le tunnel et repart de zéro — donc détruit la poignée de
 * main qui était en train de s'établir. Cinq secondes plus tard, même lecture,
 * même relance. Sur un lien lent, où la poignée de main demande plus que le
 * délai du tick, la boucle ne peut plus se refermer : l'application reconnecte
 * indéfiniment, l'overlay « Reconnexion VPN… » clignote et la lecture est mise
 * en pause à chaque tour.
 *
 * <p>« Inconnu » n'est pas « périmé ». Cette classe sépare les deux :
 *
 * <ul>
 *   <li>aucune poignée de main <b>et</b> connexion récente → on ATTEND, elle a
 *       le droit de prendre son temps ;</li>
 *   <li>aucune poignée de main passé le délai de grâce → le tunnel ne s'établit
 *       pas, on relance — mais un nombre <b>borné</b> de fois ;</li>
 *   <li>poignée de main connue et trop vieille → le cas d'origine, on relance ;</li>
 *   <li>budget de relances épuisé → on abandonne et on rend la main à
 *       l'utilisateur, au lieu de marteler toutes les cinq secondes.</li>
 * </ul>
 *
 * <p>Classe pure, sans dépendance Android, comme {@link VpnGate}.
 */
public final class HealthPolicy {

    /** Ce que le tick doit faire. */
    public enum Action {
        /** Tunnel sain : rien à faire. */
        OK,
        /** Pas encore jugeable : laisser la poignée de main se faire. */
        WAIT,
        /** Tunnel mort ou qui ne s'établit pas : relancer. */
        RECONNECT,
        /** Trop de relances sans résultat : rendre la main à l'utilisateur. */
        GIVE_UP
    }

    /** Délai laissé à une poignée de main pour s'établir avant de juger. */
    public static final long DEFAULT_GRACE_SEC = 45;

    /** Relances enchaînées sans poignée de main fraîche avant d'abandonner. */
    public static final int DEFAULT_MAX_RECONNECTS = 3;

    /**
     * @param interfaceUp            l'interface WireGuard est-elle montée
     * @param handshakeAgeSec        âge de la dernière poignée de main,
     *                               {@code Long.MAX_VALUE} si inconnu
     * @param sinceConnectSec        temps écoulé depuis la dernière montée du tunnel
     * @param consecutiveReconnects  relances enchaînées sans poignée de main fraîche
     * @param staleAfterSec          âge au-delà duquel une poignée de main est périmée
     * @param graceSec               délai de grâce accordé à une poignée de main
     * @param maxReconnects          budget de relances
     */
    public static Action decide(boolean interfaceUp,
                                long handshakeAgeSec,
                                long sinceConnectSec,
                                int  consecutiveReconnects,
                                long staleAfterSec,
                                long graceSec,
                                int  maxReconnects) {

        final boolean budgetEpuise = consecutiveReconnects >= maxReconnects;

        // L'interface elle-même est tombée : rien à attendre, c'est une vraie
        // chute. Le budget s'applique quand même, sinon on martèle un système
        // qui refuse de monter le tunnel.
        if (!interfaceUp) return budgetEpuise ? Action.GIVE_UP : Action.RECONNECT;

        // Aucune poignée de main connue. C'est le cas du démarrage — et c'est
        // celui qui déclenchait la boucle.
        if (handshakeAgeSec == Long.MAX_VALUE) {
            if (sinceConnectSec < graceSec) return Action.WAIT;
            return budgetEpuise ? Action.GIVE_UP : Action.RECONNECT;
        }

        // Poignée de main connue mais trop vieille : le cas que le tick visait
        // depuis le début.
        if (handshakeAgeSec > staleAfterSec) {
            return budgetEpuise ? Action.GIVE_UP : Action.RECONNECT;
        }

        return Action.OK;
    }

    private HealthPolicy() {}
}
