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
