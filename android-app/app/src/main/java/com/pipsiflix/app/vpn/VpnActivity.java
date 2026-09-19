package com.pipsiflix.app.vpn;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import com.pipsiflix.app.MainActivity;
import com.pipsiflix.app.R;
import java.util.List;

public class VpnActivity extends Activity {
    private VpnManager vpn; private VpnPrefs prefs;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        setContentView(R.layout.activity_vpn);
        vpn = MainActivity.vpn(); prefs = MainActivity.vpnPrefs();
        if (vpn == null || prefs == null) { finish(); return; }

        TextView status = findViewById(R.id.vpnStatus);
        status.setText("État : " + vpn.getState()
            + (vpn.getCurrent() != null ? " · " + vpn.getCurrent().label : ""));

        ((Button) findViewById(R.id.vpnAuto)).setOnClickListener(v -> {
            prefs.setAutoFastest(true);
            new Thread(() -> vpn.connectFastest(LatencyProbe.tcpPinger())).start();
            Toast.makeText(this, "Connexion au plus rapide…", Toast.LENGTH_SHORT).show();
            finish();
        });

        Button toggle = findViewById(R.id.vpnToggle);
        toggle.setText(prefs.isEnabled() ? "VPN : activé" : "VPN : désactivé");
        toggle.setOnClickListener(v -> {
            prefs.setEnabled(!prefs.isEnabled());
            toggle.setText(prefs.isEnabled() ? "VPN : activé" : "VPN : désactivé");
            Toast.makeText(this, "Redémarre PIPSILY pour appliquer", Toast.LENGTH_LONG).show();
        });

        findViewById(R.id.vpnNoVpn).setOnClickListener(v -> {
            prefs.setSessionOverride(true);
            vpn.disconnect();
            Toast.makeText(this, "VPN désactivé pour cette session (IP exposée)", Toast.LENGTH_LONG).show();
            finish();
        });

        // ── Regenerer le tunnel ────────────────────────────────────────
        // Le WARP gratuit peut se faire brider : la poignee de main reussit
        // encore, mais le debit s'effondre et le catalogue ne se telecharge
        // plus. Un enregistrement neuf repart avec de nouvelles cles, donc un
        // compte different. Mesure sur la TV le 18/09 : 30 Ko/s dans le tunnel
        // contre 448 Ko/s sans.
        Button regen = new Button(this);
        regen.setText("↻ Regenerer le tunnel (si lenteur)");
        regen.setOnClickListener(v -> {
            regen.setEnabled(false);
            regen.setText("Regeneration en cours…");
            new Thread(() -> {
                boolean efface = WarpProvisioner.forget(this);
                try { vpn.disconnect(); } catch (Throwable ignored) {}
                VpnServer neuf = WarpProvisioner.getOrCreate(this);
                runOnUiThread(() -> {
                    if (neuf == null) {
                        regen.setEnabled(true);
                        regen.setText("↻ Regenerer le tunnel (echec, reessayez)");
                        Toast.makeText(this,
                            "Enregistrement impossible : verifiez la connexion",
                            Toast.LENGTH_LONG).show();
                        return;
                    }
                    java.util.List<VpnServer> l = new java.util.ArrayList<>();
                    l.add(neuf);
                    l.addAll(VpnServers.loadFromAssets(this));
                    vpn.setServers(l);
                    new Thread(() -> vpn.connectFastest(LatencyProbe.tcpPinger())).start();
                    Toast.makeText(this,
                        efface ? "Nouveau tunnel cree, reconnexion…"
                               : "Tunnel cree, reconnexion…",
                        Toast.LENGTH_LONG).show();
                    finish();
                });
            }).start();
        });
        ((LinearLayout) findViewById(R.id.vpnList)).addView(regen);

        LinearLayout list = findViewById(R.id.vpnList);
        List<VpnServer> servers = vpn.getServers();
        for (VpnServer s : servers) {
            Button b2 = new Button(this);
            b2.setText(s.label);
            b2.setOnClickListener(v -> {
                prefs.setAutoFastest(false);
                prefs.setLastServerId(s.id);
                new Thread(() -> vpn.switchTo(s)).start();
                Toast.makeText(this, "Changement de localisation : " + s.label, Toast.LENGTH_SHORT).show();
                finish();
            });
            list.addView(b2);
        }
    }
}
