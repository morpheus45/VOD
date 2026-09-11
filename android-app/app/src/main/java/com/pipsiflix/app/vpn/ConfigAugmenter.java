package com.pipsiflix.app.vpn;

import com.wireguard.config.Config;
import com.wireguard.config.Interface;
import com.wireguard.config.Peer;
import com.wireguard.config.InetNetwork;

/** Renforce une config : per-app strict + blackhole IPv6 (anti-fuite). */
public final class ConfigAugmenter {

    /**
     * PersistentKeepalive appliqué quand le pair n'en déclare pas.
     *
     * Les configs WARP générées par WarpProvisioner n'en contenaient aucun. Sans
     * keepalive, seul le trafic utile entretient le mapping UDP du CGNAT
     * (4G/box opérateur). Or le lecteur bufferise 30 à 90 s d'avance : une fois
     * le tampon plein, il ne redemande plus rien pendant près d'une minute. Le
     * mapping NAT (souvent 30-120 s) expire pendant ce silence, le tunnel meurt
     * et la lecture se coupe en plein film. 25 s est la valeur utilisée par le
     * client WARP officiel : elle tient sous tous les délais NAT courants.
     */
    public static final int DEFAULT_KEEPALIVE_SEC = 25;

    public static Config augment(Config src, String selfPackage) throws Exception {
        // Interface : ne router QUE notre appli + conserver Address/DNS/PrivateKey.
        Interface.Builder ib = new Interface.Builder();
        ib.setKeyPair(src.getInterface().getKeyPair());
        ib.addAddresses(src.getInterface().getAddresses());
        ib.addDnsServers(src.getInterface().getDnsServers());
        ib.includeApplication(selfPackage); // per-app strict
        if (src.getInterface().getListenPort().isPresent())
            ib.setListenPort(src.getInterface().getListenPort().get());
        if (src.getInterface().getMtu().isPresent())
            ib.setMtu(src.getInterface().getMtu().get());

        Config.Builder cb = new Config.Builder();
        cb.setInterface(ib.build());

        for (Peer p : src.getPeers()) {
            Peer.Builder pb = new Peer.Builder();
            pb.setPublicKey(p.getPublicKey());
            if (p.getPreSharedKey().isPresent()) pb.setPreSharedKey(p.getPreSharedKey().get());
            if (p.getEndpoint().isPresent()) pb.setEndpoint(p.getEndpoint().get());
            // Valeur explicite du pair respectée ; sinon on pose le défaut, ce qui
            // couvre aussi les configs déjà en cache sur les appareils installés.
            pb.setPersistentKeepalive(
                p.getPersistentKeepalive().isPresent()
                    ? p.getPersistentKeepalive().get()
                    : DEFAULT_KEEPALIVE_SEC);
            pb.addAllowedIps(p.getAllowedIps());
            // Forcer tout le trafic dans le tun (v4 + v6 blackhole).
            pb.addAllowedIp(InetNetwork.parse("0.0.0.0/0"));
            pb.addAllowedIp(InetNetwork.parse("::/0"));
            cb.addPeer(pb.build());
        }
        return cb.build();
    }
    private ConfigAugmenter() {}
}
