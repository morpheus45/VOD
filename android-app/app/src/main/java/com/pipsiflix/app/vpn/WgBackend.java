package com.pipsiflix.app.vpn;

import com.wireguard.config.Config;

/** Abstraction fine du backend WireGuard (réel = GoWgBackend ; fake en test). */
public interface WgBackend {
    void up(Config c) throws Exception;
    void down();
    boolean isUp();
    long lastHandshakeAgeSec(); // Long.MAX_VALUE si inconnu
}
