package com.pipsiflix.app;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ServiceConnection;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import org.torproject.jni.TorService;

/**
 * PIPSILY VPN test — Gestion du moteur Tor embarqué (info.guardianproject:tor-android).
 *
 * Démarre TorService, attend STATUS_ON, lit getSocksPort(), lance le pont HTTP->SOCKS
 * et renvoie son port HTTP (passé à ExoPlayer via OkHttpClient / Proxy.HTTP).
 * Singleton : Tor reste démarré tant que l'app tourne.
 */
final class TorManager {

    private static final String TAG = "TorMgr";
    private static final long BOOTSTRAP_TIMEOUT_MS = 90_000;

    interface Listener {
        void onTorReady(int httpProxyPort);
        void onTorError(String message);
    }

    private static final TorManager INSTANCE = new TorManager();
    static TorManager get() { return INSTANCE; }
    private TorManager() {}

    private final Handler main = new Handler(Looper.getMainLooper());

    private Context appCtx;
    private TorService boundService;
    private HttpToSocksProxy proxy;
    private int httpProxyPort = -1;

    private boolean starting = false;
    private boolean ready = false;
    private boolean torOn = false;
    private Listener pending;

    private BroadcastReceiver statusReceiver;
    private ServiceConnection connection;
    private final Runnable timeoutRunnable = () -> failPending("Tor : délai de connexion dépassé");

    synchronized void ensureStarted(Context ctx, Listener l) {
        this.appCtx = ctx.getApplicationContext();
        if (ready && httpProxyPort > 0) {
            if (l != null) main.post(() -> l.onTorReady(httpProxyPort));
            return;
        }
        this.pending = l;
        if (starting) return;
        starting = true;

        statusReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent intent) {
                String status = intent.getStringExtra(TorService.EXTRA_STATUS);
                Log.i(TAG, "Tor status = " + status);
                if (TorService.STATUS_ON.equals(status)) { torOn = true; tryFinishIfReady(); }
                else if (TorService.STATUS_OFF.equals(status)) {
                    torOn = false;
                    if (!ready) failPending("Tor s'est arrêté avant d'être prêt");
                }
            }
        };
        IntentFilter filter = new IntentFilter(TorService.ACTION_STATUS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            appCtx.registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            appCtx.registerReceiver(statusReceiver, filter);
        }

        connection = new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName name, IBinder service) {
                try {
                    boundService = ((TorService.LocalBinder) service).getService();
                    tryFinishIfReady();
                } catch (Throwable t) { failPending("Bind TorService: " + t.getMessage()); }
            }
            @Override public void onServiceDisconnected(ComponentName name) { boundService = null; }
        };

        try {
            appCtx.bindService(new Intent(appCtx, TorService.class), connection, Context.BIND_AUTO_CREATE);
        } catch (Throwable t) {
            failPending("Impossible de démarrer Tor: " + t.getMessage());
            return;
        }
        main.postDelayed(timeoutRunnable, BOOTSTRAP_TIMEOUT_MS);
    }

    private synchronized void tryFinishIfReady() {
        if (ready || !torOn || boundService == null) return;
        int socks = 0;
        try { socks = boundService.getSocksPort(); } catch (Throwable ignored) {}
        if (socks <= 0) socks = 9050;
        try {
            proxy = new HttpToSocksProxy(socks);
            httpProxyPort = proxy.start();
            ready = true; starting = false;
            main.removeCallbacks(timeoutRunnable);
            Log.i(TAG, "Tor prêt — socks=" + socks + " httpProxy=" + httpProxyPort);
            final int port = httpProxyPort;
            final Listener l = pending; pending = null;
            if (l != null) main.post(() -> l.onTorReady(port));
        } catch (Exception e) { failPending("Pont HTTP->SOCKS: " + e.getMessage()); }
    }

    private synchronized void failPending(String msg) {
        Log.w(TAG, "échec: " + msg);
        starting = false;
        main.removeCallbacks(timeoutRunnable);
        final Listener l = pending; pending = null;
        if (l != null) main.post(() -> l.onTorError(msg));
    }

    synchronized void stop() {
        ready = false; starting = false; torOn = false; httpProxyPort = -1;
        main.removeCallbacks(timeoutRunnable);
        if (proxy != null) { proxy.stop(); proxy = null; }
        if (appCtx != null) {
            try { if (statusReceiver != null) appCtx.unregisterReceiver(statusReceiver); } catch (Exception ignored) {}
            try { if (connection != null) appCtx.unbindService(connection); } catch (Exception ignored) {}
            try { appCtx.stopService(new Intent(appCtx, TorService.class)); } catch (Exception ignored) {}
        }
        statusReceiver = null; connection = null; boundService = null;
    }

    boolean isReady() { return ready && httpProxyPort > 0; }
    int getHttpProxyPort() { return httpProxyPort; }
}
