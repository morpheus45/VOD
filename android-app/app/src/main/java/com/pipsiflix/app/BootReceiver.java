package com.pipsiflix.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

/**
 * Démarrage automatique de PIPSILY au boot de la TV.
 *
 * Sur une box où PIPSILY est le launcher (ex. Freebox), il démarre de toute
 * façon comme écran d'accueil. Sur Fire TV, Amazon force SON launcher au boot :
 * un lancement immédiat de TvActivity perd la course (l'accueil Amazon reprend
 * la main juste après). On programme donc le lancement ~8 s APRÈS le boot, une
 * fois l'accueil Amazon posé, pour ouvrir PIPSILY par-dessus.
 *
 * On passe par AlarmManager (et non un Handler) pour survivre à une éventuelle
 * mort du process du receiver pendant le délai.
 *
 * L'app doit avoir été lancée au moins une fois pour recevoir le broadcast.
 */
public class BootReceiver extends BroadcastReceiver {

    /** Délai avant lancement : laisse l'accueil natif se stabiliser d'abord. */
    private static final long LAUNCH_DELAY_MS = 8000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = (intent != null) ? intent.getAction() : null;
        if (action == null) return;

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {
            try {
                Intent launch = new Intent(context, TvActivity.class);
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

                int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    piFlags |= PendingIntent.FLAG_IMMUTABLE;
                }
                PendingIntent pi = PendingIntent.getActivity(
                        context, 0, launch, piFlags);

                AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
                if (am != null) {
                    long triggerAt = SystemClock.elapsedRealtime() + LAUNCH_DELAY_MS;
                    // setAndAllowWhileIdle : pas de permission d'alarme exacte requise
                    // (même sur Android 12+), et suffisant pour un délai de ~8 s au boot.
                    am.setAndAllowWhileIdle(
                            AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
                    Log.i("PipsilyBoot", "Démarrage auto : TvActivity programmée dans "
                            + LAUNCH_DELAY_MS + " ms");
                } else {
                    // Repli : lancement immédiat si AlarmManager indisponible
                    context.startActivity(launch);
                    Log.i("PipsilyBoot", "Démarrage auto : TvActivity lancée (repli immédiat)");
                }
            } catch (Exception e) {
                Log.w("PipsilyBoot", "Échec démarrage auto : " + e.getMessage());
            }
        }
    }
}
