package com.pipsiflix.app.vpn;

import android.content.Context;
import android.content.res.AssetManager;
import com.wireguard.config.Config;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;

/** Découvre et parse les configs WireGuard déposées dans assets/vpn/. */
public final class VpnServers {
    private static final String DIR = "vpn";

    /** "windscribe-fr-paris.conf" -> "Windscribe FR Paris". */
    public static String labelFromFilename(String filename) {
        String n = filename;
        int dot = n.lastIndexOf('.');
        if (dot > 0) n = n.substring(0, dot);
        n = n.replace('_', ' ').replace('-', ' ').trim();
        StringBuilder sb = new StringBuilder();
        for (String w : n.split("\\s+")) {
            if (w.isEmpty()) continue;
            if (sb.length() > 0) sb.append(' ');
            // Codes pays de 2 lettres en MAJ, sinon Capitalisation
            if (w.length() == 2) sb.append(w.toUpperCase());
            else sb.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
        }
        return sb.toString();
    }

    /** Parse un .conf. Un commentaire "# name=..." force le libellé. */
    public static VpnServer parse(String filename, String confText) throws IOException, com.wireguard.config.BadConfigException {
        String label = labelFromFilename(filename);
        for (String line : confText.split("\\R")) {
            String t = line.trim();
            if (t.toLowerCase().startsWith("# name=")) {
                label = t.substring(t.indexOf('=') + 1).trim();
                break;
            }
        }
        Config config = Config.parse(new BufferedReader(new StringReader(confText)));
        return new VpnServer(filename, label, config);
    }

    /** Charge toutes les configs valides d'assets/vpn/. Jamais null. */
    public static List<VpnServer> loadFromAssets(Context ctx) {
        List<VpnServer> out = new ArrayList<>();
        AssetManager am = ctx.getAssets();
        String[] files;
        try { files = am.list(DIR); } catch (IOException e) { return out; }
        if (files == null) return out;
        for (String f : files) {
            if (!f.toLowerCase().endsWith(".conf")) continue;
            try {
                StringBuilder sb = new StringBuilder();
                try (BufferedReader r = new BufferedReader(
                        new java.io.InputStreamReader(am.open(DIR + "/" + f)))) {
                    String l; while ((l = r.readLine()) != null) sb.append(l).append('\n');
                }
                out.add(parse(f, sb.toString()));
            } catch (Exception ignored) { /* config invalide → ignorée */ }
        }
        return out;
    }
    private VpnServers() {}
}
