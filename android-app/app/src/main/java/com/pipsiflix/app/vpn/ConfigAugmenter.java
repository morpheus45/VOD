package com.pipsiflix.app.vpn;

import com.wireguard.config.Config;
import com.wireguard.config.Interface;
import com.wireguard.config.Peer;
import com.wireguard.config.InetNetwork;

/** Renforce une config : per-app strict + blackhole IPv6 (anti-fuite). */
public final class ConfigAugmenter {

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
            if (p.getPersistentKeepalive().isPresent())
                pb.setPersistentKeepalive(p.getPersistentKeepalive().get());
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
