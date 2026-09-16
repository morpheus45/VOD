package com.pipsiflix.app.vpn;

import com.wireguard.config.Config;

/** Un serveur VPN = une config WireGuard + un libellé affichable. */
public final class VpnServer {
    public final String id;      // nom de fichier, identifiant stable
    public final String label;   // libellé affiché (pays/ville)
    public final Config config;  // config WireGuard parsée
    public VpnServer(String id, String label, Config config) {
        this.id = id; this.label = label; this.config = config;
    }
}
