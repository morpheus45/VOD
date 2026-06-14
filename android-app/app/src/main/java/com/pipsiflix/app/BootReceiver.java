package com.pipsiflix.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Démarrage automatique de PIPSILY au boot de la TV.
 * Lance TvActivity (interface TV) dès que l'appareil a fini de démarrer.
 * L'app doit avoir été lancée au moins une fois pour recevoir le broadcast.
 */
public class BootReceiver extends BroadcastReceiver {

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
                context.startActivity(launch);
                Log.i("PipsilyBoot", "Démarrage auto : TvActivity lancée");
            } catch (Exception e) {
                Log.w("PipsilyBoot", "Échec démarrage auto : " + e.getMessage());
            }
        }
    }
}
