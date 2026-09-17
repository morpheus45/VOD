package com.pipsiflix.app.player;

/**
 * Décide si le chien de garde du lecteur doit relancer le flux.
 *
 * <p>Le chien de garde existe parce qu'ExoPlayer n'émet pas toujours
 * {@code onPlayerError} quand un flux IPTV meurt en cours de route : la socket
 * reste ouverte, plus aucun octet n'arrive, et le lecteur tourne indéfiniment
 * sur son cercle de chargement. Il surveillait donc la POSITION de lecture : si
 * elle ne bougeait plus pendant quinze secondes, il relançait le flux.
 *
 * <p>Ce raisonnement confondait deux situations très différentes, parce que la
 * position est figée dans les deux :
 *
 * <ul>
 *   <li><b>le flux est mort</b> — plus rien n'arrive, il faut relancer ;</li>
 *   <li><b>le flux est simplement LENT</b> — le lecteur est en train de
 *       remplir son tampon, les octets arrivent, il n'y a rien à réparer.</li>
 * </ul>
 *
 * <p>Sur un partage de connexion mobile, le second cas est la norme : la mise
 * en tampon dépasse régulièrement quinze secondes. Le chien de garde relançait
 * alors un flux parfaitement sain, jetait le tampon déjà constitué, et la
 * tentative suivante butait sur le même délai — jusqu'à épuisement du budget de
 * reprises. D'où le « Flux interrompu — reprise (n/6) » en boucle, puis
 * « Flux indisponible », causés par la lenteur du lien et non par une coupure.
 *
 * <p>La distinction se fait sur le TAMPON. S'il grossit, des octets arrivent et
 * le flux est vivant. S'il est figé lui aussi, plus rien n'arrive : c'est le cas
 * que le chien de garde vise depuis le début.
 *
 * <p>Classe pure, sans dépendance Android ni media3 : l'appelant traduit les
 * constantes {@code Player.STATE_*} en booléens. C'est ce qui la rend testable
 * hors émulateur, comme {@code VpnGate}.
 */
public final class StallPolicy {

    /** Ce que le chien de garde doit faire à ce tour de surveillance. */
    public enum Decision {
        /** Rien à surveiller : lecture en pause, ou média terminé. */
        IGNORE,
        /** Laisser faire : le flux est vivant, ou le délai n'est pas écoulé. */
        WAIT,
        /** Plus rien n'arrive : relancer le flux. */
        RESTART
    }

    /**
     * @param playWhenReady        la lecture est-elle demandée (faux si l'utilisateur a mis en pause)
     * @param idle                 le lecteur est-il mort sur une erreur fatale (STATE_IDLE)
     * @param ended                le média est-il arrivé à sa fin (STATE_ENDED)
     * @param buffering            le lecteur est-il en train de remplir son tampon (STATE_BUFFERING)
     * @param positionFrozenForMs  depuis combien de temps la position de lecture ne bouge plus
     * @param bufferFrozenForMs    depuis combien de temps le tampon ne grossit plus
     * @param timeoutMs            gel toléré avant de considérer le flux mort
     */
    public static Decision decide(boolean playWhenReady,
                                  boolean idle,
                                  boolean ended,
                                  boolean buffering,
                                  long positionFrozenForMs,
                                  long bufferFrozenForMs,
                                  long timeoutMs) {

        // Pause demandée par l'utilisateur, ou fin normale du média.
        if (!playWhenReady) return Decision.IGNORE;
        if (ended)          return Decision.IGNORE;

        // IDLE alors que la lecture est demandée : le lecteur est mort sur une
        // erreur fatale et personne ne l'a relancé. Aucun tampon ne progresse
        // dans cet état, le délai seul tranche.
        if (idle) {
            return positionFrozenForMs >= timeoutMs ? Decision.RESTART : Decision.WAIT;
        }

        // La position bouge encore, ou pas depuis assez longtemps.
        if (positionFrozenForMs < timeoutMs) return Decision.WAIT;

        // Position figée depuis assez longtemps. Reste à savoir si des octets
        // arrivent : un tampon qui grossit veut dire que oui.
        if (buffering && bufferFrozenForMs < timeoutMs) return Decision.WAIT;

        return Decision.RESTART;
    }

    private StallPolicy() {}
}
