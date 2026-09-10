# PIPSILY VPN WireGuard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Intégrer un VPN WireGuard dans l'appli Android PIPSILY (`com.pipsiflix.app`) qui route uniquement son propre trafic, empêche toute fuite IP/DNS/IPv6, choisit le serveur le plus rapide, laisse changer de localisation à tout moment, et peut être neutralisé à tout niveau (« portes de retour »).

**Architecture :** Le backend `com.wireguard.android:tunnel` (WireGuard-Go) parse les `.conf` et gère le `VpnService`, le per-app et le DNS. On ajoute au-dessus : un chargeur de configs depuis `assets/vpn/`, un augmenteur de config (force le per-app + blackhole IPv6), une sonde de latence, un `VpnManager` (machine à états + reconnexion), une UI native de sélection, et le gating de démarrage dans `MainActivity`.

**Tech Stack :** Java 17, Android SDK 34 (minSdk 21), `com.wireguard.android:tunnel:1.0.20230706`, JUnit 4 (tests JVM), WebView + Media3 existants (inchangés).

## Global Constraints

- Cible **Android uniquement** — ne rien ajouter côté `tizen-tv/`.
- `applicationId` = `com.pipsiflix.app` ; ABI = `arm64-v8a`, `armeabi-v7a` (inchangé).
- **Ne rien casser** de l'existant : lecture (`PlayerActivity`, v58/v59), purge stockage + buffer (v60). Les seules modifs de fichiers existants autorisées : `app/build.gradle`, `AndroidManifest.xml`, `MainActivity.java` (ajouts uniquement), `.gitignore`, `version.json`.
- **Aucun secret dans le dépôt** : `app/src/main/assets/vpn/` est git-ignoré ; les `.conf` réels sont ajoutés en local.
- Le package du code VPN est `com.pipsiflix.app.vpn`.
- Kill-switch strict par défaut, mais **jamais de blocage définitif** (portes de retour, spec §13).
- Comportement identique à v60 si le VPN est désactivé (interrupteur global OFF) ou si `assets/vpn/` est vide.
- Bumper `versionCode`/`versionName` seulement à la toute fin (tâche finale), pas à chaque tâche.

---

## File Structure

Créés :
- `app/src/main/java/com/pipsiflix/app/vpn/VpnServer.java` — modèle {id, label, Config}.
- `app/src/main/java/com/pipsiflix/app/vpn/VpnServers.java` — découverte/chargement des `.conf` d'`assets/vpn/`.
- `app/src/main/java/com/pipsiflix/app/vpn/ConfigAugmenter.java` — force per-app + blackhole IPv6 sur un `Config`.
- `app/src/main/java/com/pipsiflix/app/vpn/LatencyProbe.java` — mesure/classe la latence des serveurs.
- `app/src/main/java/com/pipsiflix/app/vpn/WgBackend.java` — interface fine au-dessus de GoBackend (réel + fake testable).
- `app/src/main/java/com/pipsiflix/app/vpn/GoWgBackend.java` — impl réelle (GoBackend).
- `app/src/main/java/com/pipsiflix/app/vpn/VpnManager.java` — machine à états, connect/switch/reconnect, prefs.
- `app/src/main/java/com/pipsiflix/app/vpn/VpnPrefs.java` — persistance (interrupteur global, dernier serveur, override session).
- `app/src/main/java/com/pipsiflix/app/vpn/VpnActivity.java` — UI native (statut + sélecteur).
- `app/src/main/res/layout/activity_vpn.xml` — layout du sélecteur.
- `app/src/test/java/com/pipsiflix/app/vpn/*Test.java` — tests JVM.
- `app/src/main/assets/vpn/README.txt` — où déposer les `.conf` (le dossier est git-ignoré à part ce README).

Modifiés (ajouts seulement) :
- `app/build.gradle` — dépendance WireGuard + JUnit.
- `app/src/main/AndroidManifest.xml` — permissions + `<service>`.
- `app/src/main/java/com/pipsiflix/app/MainActivity.java` — gating démarrage + ponts JS + lecture `version.json` `vpn_enabled`.
- `.gitignore` — ignorer `assets/vpn/*.conf`.
- `version.json` — champ `vpn_enabled`.

---

## Task 1: Setup — dépendances, test infra, manifeste, .gitignore

**Files:**
- Modify: `android-app/app/build.gradle`
- Modify: `android-app/app/src/main/AndroidManifest.xml`
- Create: `android-app/.gitignore` (ou modifier s'il existe)
- Create: `android-app/app/src/main/assets/vpn/README.txt`
- Test: `android-app/app/src/test/java/com/pipsiflix/app/vpn/SanityTest.java`

**Interfaces:**
- Produces: dépendances `com.wireguard.android:tunnel`, JUnit prêtes ; permissions VPN déclarées ; dossier `assets/vpn/` git-ignoré.

- [ ] **Step 1: Ajouter les dépendances**

Dans `android-app/app/build.gradle`, bloc `dependencies { ... }`, ajouter :

```gradle
    // ── VPN WireGuard embarqué (backend WireGuard-Go) ──
    implementation 'com.wireguard.android:tunnel:1.0.20230706'
    // Tests JVM
    testImplementation 'junit:junit:4.13.2'
```

- [ ] **Step 2: Déclarer permissions + service dans le manifeste**

Dans `android-app/app/src/main/AndroidManifest.xml`, avant `</manifest>` (permissions en tête, service dans `<application>`) :

```xml
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

Dans `<application>` :

```xml
        <service
            android:name="com.wireguard.android.backend.GoBackend$VpnService"
            android:permission="android.permission.BIND_VPN_SERVICE"
            android:foregroundServiceType="specialUse"
            android:exported="false">
            <intent-filter>
                <action android:name="android.net.VpnService" />
            </intent-filter>
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="VPN client for PIPSILY IPTV playback" />
        </service>
        <activity android:name="com.pipsiflix.app.vpn.VpnActivity"
            android:exported="false"
            android:theme="@android:style/Theme.Black.NoTitleBar.Fullscreen" />
```

- [ ] **Step 3: Ignorer les configs VPN + README**

Créer/compléter `android-app/.gitignore` :

```
# Configs VPN WireGuard — secrets, jamais dans le dépôt public
app/src/main/assets/vpn/*.conf
```

Créer `android-app/app/src/main/assets/vpn/README.txt` :

```
Déposez ici vos fichiers WireGuard *.conf (un par serveur).
Nom de fichier = libellé affiché (ex: "windscribe-fr-paris.conf" -> "Windscribe FR Paris").
Optionnel: une ligne "# name=France · Paris" dans le .conf force le libellé.
Ces .conf sont git-ignorés (secrets). L'appli fonctionne sans (sélecteur vide).
```

- [ ] **Step 4: Test sanity (vérifie que le harnais JVM tourne)**

Créer `android-app/app/src/test/java/com/pipsiflix/app/vpn/SanityTest.java` :

```java
package com.pipsiflix.app.vpn;

import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class SanityTest {
    @Test public void harnessRuns() { assertTrue(true); }
}
```

- [ ] **Step 5: Lancer les tests**

Run: `cd android-app && ./gradlew :app:testDebugUnitTest --tests "com.pipsiflix.app.vpn.SanityTest"`
Expected: BUILD SUCCESSFUL, 1 test passé.

- [ ] **Step 6: Vérifier la compilation Android**

Run: `cd android-app && ./gradlew :app:compileDebugJavaWithJavac`
Expected: BUILD SUCCESSFUL (dépendance WireGuard résolue).

- [ ] **Step 7: Commit**

```bash
git add android-app/app/build.gradle android-app/app/src/main/AndroidManifest.xml android-app/.gitignore android-app/app/src/main/assets/vpn/README.txt android-app/app/src/test/java/com/pipsiflix/app/vpn/SanityTest.java
git commit -m "chore(vpn): setup dépendance WireGuard + test infra + manifeste + gitignore configs"
```

---

## Task 2: VpnServer + chargement des configs

**Files:**
- Create: `android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnServer.java`
- Create: `android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnServers.java`
- Test: `android-app/app/src/test/java/com/pipsiflix/app/vpn/VpnServersTest.java`

**Interfaces:**
- Consumes: `com.wireguard.config.Config` (lib).
- Produces:
  - `VpnServer { String id; String label; com.wireguard.config.Config config; }`
  - `VpnServers.labelFromFilename(String filename) -> String`
  - `VpnServers.parse(String filename, String confText) -> VpnServer` (throws `java.text.ParseException` / `IOException` si invalide)
  - `VpnServers.loadFromAssets(android.content.Context) -> java.util.List<VpnServer>` (jamais null ; vide si dossier absent)

- [ ] **Step 1: Test du libellé + parsing (échoue)**

Créer `android-app/app/src/test/java/com/pipsiflix/app/vpn/VpnServersTest.java` :

```java
package com.pipsiflix.app.vpn;

import static org.junit.Assert.*;
import org.junit.Test;

public class VpnServersTest {

    private static final String SAMPLE =
        "[Interface]\n" +
        "PrivateKey = aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXkgMzJieXRlcyE=\n" +
        "Address = 10.64.0.2/32\n" +
        "DNS = 10.64.0.1\n" +
        "[Peer]\n" +
        "PublicKey = eHl6enkgc2VydmVyIHB1YmxpYyBrZXkgMzJieXRlcyE=\n" +
        "Endpoint = 193.138.7.5:51820\n" +
        "AllowedIPs = 0.0.0.0/0\n";

    @Test public void labelFromFilename_prettifies() {
        assertEquals("Windscribe FR Paris",
            VpnServers.labelFromFilename("windscribe-fr-paris.conf"));
        assertEquals("Mullvad CH", VpnServers.labelFromFilename("mullvad-ch.conf"));
    }

    @Test public void parse_readsEndpointAndDns() throws Exception {
        VpnServer s = VpnServers.parse("mullvad-ch.conf", SAMPLE);
        assertEquals("mullvad-ch.conf", s.id);
        assertEquals("Mullvad CH", s.label);
        assertEquals("193.138.7.5",
            s.config.getPeers().get(0).getEndpoint().get().getHost());
    }

    @Test public void parse_honorsNameComment() throws Exception {
        VpnServer s = VpnServers.parse("x.conf", "# name=France · Paris\n" + SAMPLE);
        assertEquals("France · Paris", s.label);
    }
}
```

- [ ] **Step 2: Lancer → échec (classes absentes)**

Run: `cd android-app && ./gradlew :app:testDebugUnitTest --tests "com.pipsiflix.app.vpn.VpnServersTest"`
Expected: FAIL — `VpnServer`/`VpnServers` introuvables.

- [ ] **Step 3: Créer `VpnServer`**

```java
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
```

- [ ] **Step 4: Créer `VpnServers`**

```java
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
```

- [ ] **Step 5: Lancer → succès**

Run: `cd android-app && ./gradlew :app:testDebugUnitTest --tests "com.pipsiflix.app.vpn.VpnServersTest"`
Expected: PASS (3 tests). Si l'API `Config.parse`/`BadConfigException` diffère dans la version 1.0.20230706, aligner l'import/exception sur la lib (vérifier `com.wireguard.config.Config`).

- [ ] **Step 6: Commit**

```bash
git add android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnServer.java android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnServers.java android-app/app/src/test/java/com/pipsiflix/app/vpn/VpnServersTest.java
git commit -m "feat(vpn): modèle VpnServer + chargement/parsing des configs assets/vpn"
```

---

## Task 3: Augmentation config — per-app + blackhole IPv6 + DNS

**Files:**
- Create: `android-app/app/src/main/java/com/pipsiflix/app/vpn/ConfigAugmenter.java`
- Test: `android-app/app/src/test/java/com/pipsiflix/app/vpn/ConfigAugmenterTest.java`

**Interfaces:**
- Consumes: `com.wireguard.config.Config`.
- Produces: `ConfigAugmenter.augment(Config src, String selfPackage) -> Config`
  - Interface : `includedApplications = {selfPackage}` (per-app strict).
  - Peer : `allowedIps` complété avec `0.0.0.0/0` **et** `::/0` (route IPv6 → tun sans adresse v6 = blackhole anti-fuite).
  - DNS conservé tel quel (déjà dans le .conf → pas de fuite DNS).

- [ ] **Step 1: Test (échoue)**

```java
package com.pipsiflix.app.vpn;

import static org.junit.Assert.*;
import com.wireguard.config.Config;
import java.io.BufferedReader;
import java.io.StringReader;
import org.junit.Test;

public class ConfigAugmenterTest {
    private Config base(String allowed) throws Exception {
        String c = "[Interface]\nPrivateKey = aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXkgMzJieXRlcyE=\n" +
            "Address = 10.64.0.2/32\nDNS = 10.64.0.1\n[Peer]\n" +
            "PublicKey = eHl6enkgc2VydmVyIHB1YmxpYyBrZXkgMzJieXRlcyE=\n" +
            "Endpoint = 1.2.3.4:51820\nAllowedIPs = " + allowed + "\n";
        return Config.parse(new BufferedReader(new StringReader(c)));
    }

    @Test public void forcesSelfOnlyApplication() throws Exception {
        Config out = ConfigAugmenter.augment(base("0.0.0.0/0"), "com.pipsiflix.app");
        assertTrue(out.getInterface().getIncludedApplications().contains("com.pipsiflix.app"));
        assertEquals(1, out.getInterface().getIncludedApplications().size());
    }

    @Test public void addsIpv6Blackhole() throws Exception {
        Config out = ConfigAugmenter.augment(base("0.0.0.0/0"), "com.pipsiflix.app");
        boolean hasV6 = out.getPeers().get(0).getAllowedIps().stream()
            .anyMatch(n -> n.toString().equals("::/0"));
        assertTrue("doit router ::/0 pour bloquer la fuite IPv6", hasV6);
    }

    @Test public void keepsDns() throws Exception {
        Config out = ConfigAugmenter.augment(base("0.0.0.0/0"), "com.pipsiflix.app");
        assertFalse(out.getInterface().getDnsServers().isEmpty());
    }
}
```

- [ ] **Step 2: Lancer → échec**

Run: `cd android-app && ./gradlew :app:testDebugUnitTest --tests "com.pipsiflix.app.vpn.ConfigAugmenterTest"`
Expected: FAIL — `ConfigAugmenter` absent.

- [ ] **Step 3: Implémenter `ConfigAugmenter`**

```java
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
```

- [ ] **Step 4: Lancer → succès**

Run: `cd android-app && ./gradlew :app:testDebugUnitTest --tests "com.pipsiflix.app.vpn.ConfigAugmenterTest"`
Expected: PASS (3 tests). Aligner les noms de méthodes builder (`includeApplication`, `addAllowedIp`, `InetNetwork.parse`) sur la lib 1.0.20230706 si nécessaire.

- [ ] **Step 5: Commit**

```bash
git add android-app/app/src/main/java/com/pipsiflix/app/vpn/ConfigAugmenter.java android-app/app/src/test/java/com/pipsiflix/app/vpn/ConfigAugmenterTest.java
git commit -m "feat(vpn): augmentation config per-app + blackhole IPv6 (anti-fuite)"
```

---

## Task 4: Sonde de latence + classement « le plus rapide »

**Files:**
- Create: `android-app/app/src/main/java/com/pipsiflix/app/vpn/LatencyProbe.java`
- Test: `android-app/app/src/test/java/com/pipsiflix/app/vpn/LatencyProbeTest.java`

**Interfaces:**
- Produces:
  - `interface LatencyProbe.Pinger { long pingMs(String host, int port); }` (retourne `Long.MAX_VALUE` si injoignable)
  - `LatencyProbe.rank(List<VpnServer> servers, Pinger p) -> List<VpnServer>` (trié latence croissante ; injoignables en fin)
  - `LatencyProbe.fastest(List<VpnServer> servers, Pinger p) -> VpnServer` (null si liste vide)
  - `LatencyProbe.tcpPinger() -> Pinger` (impl réelle : connexion TCP chronométrée, timeout 1500 ms)

- [ ] **Step 1: Test du classement (échoue)**

```java
package com.pipsiflix.app.vpn;

import static org.junit.Assert.*;
import com.wireguard.config.Config;
import java.io.BufferedReader;
import java.io.StringReader;
import java.util.*;
import org.junit.Test;

public class LatencyProbeTest {
    private VpnServer srv(String id, String host) throws Exception {
        String c = "[Interface]\nPrivateKey = aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXkgMzJieXRlcyE=\n" +
            "Address = 10.0.0.2/32\nDNS = 10.0.0.1\n[Peer]\n" +
            "PublicKey = eHl6enkgc2VydmVyIHB1YmxpYyBrZXkgMzJieXRlcyE=\n" +
            "Endpoint = " + host + ":51820\nAllowedIPs = 0.0.0.0/0\n";
        return new VpnServer(id, id, Config.parse(new BufferedReader(new StringReader(c))));
    }

    @Test public void ranksByLatencyThenUnreachableLast() throws Exception {
        List<VpnServer> in = Arrays.asList(srv("a","1.1.1.1"), srv("b","2.2.2.2"), srv("c","3.3.3.3"));
        Map<String,Long> lat = new HashMap<>();
        lat.put("1.1.1.1", 120L); lat.put("2.2.2.2", 30L); lat.put("3.3.3.3", Long.MAX_VALUE);
        LatencyProbe.Pinger fake = (host, port) -> lat.get(host);
        List<VpnServer> out = LatencyProbe.rank(in, fake);
        assertEquals("b", out.get(0).id); // 30ms
        assertEquals("a", out.get(1).id); // 120ms
        assertEquals("c", out.get(2).id); // injoignable en dernier
        assertEquals("b", LatencyProbe.fastest(in, fake).id);
    }

    @Test public void fastest_emptyList_returnsNull() {
        assertNull(LatencyProbe.fastest(new ArrayList<>(), (h,p)->1L));
    }
}
```

- [ ] **Step 2: Lancer → échec**

Run: `cd android-app && ./gradlew :app:testDebugUnitTest --tests "com.pipsiflix.app.vpn.LatencyProbeTest"`
Expected: FAIL — `LatencyProbe` absent.

- [ ] **Step 3: Implémenter `LatencyProbe`**

```java
package com.pipsiflix.app.vpn;

import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/** Mesure la latence des endpoints et classe les serveurs du plus rapide au plus lent. */
public final class LatencyProbe {

    public interface Pinger { long pingMs(String host, int port); }

    public static Pinger tcpPinger() {
        return (host, port) -> {
            long t0 = System.nanoTime();
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(host, port), 1500);
                return (System.nanoTime() - t0) / 1_000_000L;
            } catch (Exception e) { return Long.MAX_VALUE; }
        };
    }

    private static int port(VpnServer s) {
        try { return s.config.getPeers().get(0).getEndpoint().get().getPort(); }
        catch (Exception e) { return 51820; }
    }
    private static String host(VpnServer s) {
        try { return s.config.getPeers().get(0).getEndpoint().get().getHost(); }
        catch (Exception e) { return ""; }
    }

    public static List<VpnServer> rank(List<VpnServer> servers, Pinger p) {
        List<VpnServer> out = new ArrayList<>(servers);
        final java.util.Map<String,Long> cache = new java.util.HashMap<>();
        for (VpnServer s : out) cache.put(s.id, p.pingMs(host(s), port(s)));
        Collections.sort(out, Comparator.comparingLong(s -> cache.get(s.id)));
        return out;
    }

    public static VpnServer fastest(List<VpnServer> servers, Pinger p) {
        if (servers.isEmpty()) return null;
        List<VpnServer> ranked = rank(servers, p);
        return ranked.get(0);
    }
    private LatencyProbe() {}
}
```

- [ ] **Step 4: Lancer → succès**

Run: `cd android-app && ./gradlew :app:testDebugUnitTest --tests "com.pipsiflix.app.vpn.LatencyProbeTest"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add android-app/app/src/main/java/com/pipsiflix/app/vpn/LatencyProbe.java android-app/app/src/test/java/com/pipsiflix/app/vpn/LatencyProbeTest.java
git commit -m "feat(vpn): sonde de latence + classement du plus rapide"
```

---

## Task 5: VpnManager — machine à états (testée avec un faux backend)

**Files:**
- Create: `android-app/app/src/main/java/com/pipsiflix/app/vpn/WgBackend.java`
- Create: `android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnManager.java`
- Test: `android-app/app/src/test/java/com/pipsiflix/app/vpn/VpnManagerTest.java`

**Interfaces:**
- Produces:
  - `enum VpnManager.State { IDLE, CONNECTING, CONNECTED, RECONNECTING, DISABLED, ERROR }`
  - `interface WgBackend { void up(com.wireguard.config.Config c) throws Exception; void down(); boolean isUp(); long lastHandshakeAgeSec(); }`
  - `interface VpnManager.Listener { void onState(State s, VpnServer current); }`
  - `VpnManager(WgBackend backend, String selfPackage)`
  - `void setServers(List<VpnServer>)`, `void connect(VpnServer)`, `void connectFastest(LatencyProbe.Pinger)`, `void switchTo(VpnServer)`, `void disconnect()`, `State getState()`, `VpnServer getCurrent()`, `void addListener(Listener)`
  - `void onHealthTick()` — appelée périodiquement ; passe en RECONNECTING si `isUp()` faux ou handshake périmé (>180 s).

- [ ] **Step 1: Test de la machine à états (échoue)**

```java
package com.pipsiflix.app.vpn;

import static org.junit.Assert.*;
import com.wireguard.config.Config;
import java.io.BufferedReader;
import java.io.StringReader;
import java.util.*;
import org.junit.Test;

public class VpnManagerTest {
    static class FakeBackend implements WgBackend {
        boolean up = false; boolean failNext = false; long hsAge = 0;
        public void up(Config c) throws Exception { if (failNext) throw new RuntimeException("fail"); up = true; }
        public void down() { up = false; }
        public boolean isUp() { return up; }
        public long lastHandshakeAgeSec() { return hsAge; }
    }
    private VpnServer srv(String id) throws Exception {
        String c = "[Interface]\nPrivateKey = aGVsbG8gd29ybGQgcHJpdmF0ZSBrZXkgMzJieXRlcyE=\n" +
            "Address=10.0.0.2/32\nDNS=10.0.0.1\n[Peer]\nPublicKey = eHl6enkgc2VydmVyIHB1YmxpYyBrZXkgMzJieXRlcyE=\n" +
            "Endpoint=1.2.3.4:51820\nAllowedIPs=0.0.0.0/0\n";
        return new VpnServer(id, id, Config.parse(new BufferedReader(new StringReader(c))));
    }

    @Test public void connect_reachesConnected() throws Exception {
        FakeBackend b = new FakeBackend();
        VpnManager m = new VpnManager(b, "com.pipsiflix.app");
        VpnServer s = srv("a"); m.setServers(Collections.singletonList(s));
        m.connect(s);
        assertEquals(VpnManager.State.CONNECTED, m.getState());
        assertEquals("a", m.getCurrent().id);
        assertTrue(b.isUp());
    }

    @Test public void up_failure_goesError() throws Exception {
        FakeBackend b = new FakeBackend(); b.failNext = true;
        VpnManager m = new VpnManager(b, "com.pipsiflix.app");
        m.connect(srv("a"));
        assertEquals(VpnManager.State.ERROR, m.getState());
    }

    @Test public void healthTick_staleHandshake_reconnects() throws Exception {
        FakeBackend b = new FakeBackend();
        VpnManager m = new VpnManager(b, "com.pipsiflix.app");
        m.connect(srv("a"));
        b.up = false; // tunnel tombé
        m.onHealthTick();
        assertEquals(VpnManager.State.RECONNECTING, m.getState());
    }

    @Test public void disconnect_goesIdle() throws Exception {
        FakeBackend b = new FakeBackend();
        VpnManager m = new VpnManager(b, "com.pipsiflix.app");
        m.connect(srv("a")); m.disconnect();
        assertEquals(VpnManager.State.IDLE, m.getState());
        assertFalse(b.isUp());
    }
}
```

- [ ] **Step 2: Lancer → échec**

Run: `cd android-app && ./gradlew :app:testDebugUnitTest --tests "com.pipsiflix.app.vpn.VpnManagerTest"`
Expected: FAIL — `WgBackend`/`VpnManager` absents.

- [ ] **Step 3: Créer `WgBackend`**

```java
package com.pipsiflix.app.vpn;

import com.wireguard.config.Config;

/** Abstraction fine du backend WireGuard (réel = GoWgBackend ; fake en test). */
public interface WgBackend {
    void up(Config c) throws Exception;
    void down();
    boolean isUp();
    long lastHandshakeAgeSec(); // Long.MAX_VALUE si inconnu
}
```

- [ ] **Step 4: Créer `VpnManager`**

```java
package com.pipsiflix.app.vpn;

import com.wireguard.config.Config;
import java.util.ArrayList;
import java.util.List;

/** Orchestre l'état du VPN. Sans dépendance Android → testable en JVM. */
public final class VpnManager {
    public enum State { IDLE, CONNECTING, CONNECTED, RECONNECTING, DISABLED, ERROR }
    public interface Listener { void onState(State s, VpnServer current); }

    private static final long STALE_HANDSHAKE_SEC = 180;

    private final WgBackend backend;
    private final String selfPackage;
    private final List<Listener> listeners = new ArrayList<>();
    private List<VpnServer> servers = new ArrayList<>();
    private State state = State.IDLE;
    private VpnServer current = null;

    public VpnManager(WgBackend backend, String selfPackage) {
        this.backend = backend; this.selfPackage = selfPackage;
    }

    public void addListener(Listener l) { listeners.add(l); }
    public State getState() { return state; }
    public VpnServer getCurrent() { return current; }
    public void setServers(List<VpnServer> s) { this.servers = new ArrayList<>(s); }
    public List<VpnServer> getServers() { return new ArrayList<>(servers); }

    private void set(State s) { state = s; for (Listener l : listeners) l.onState(s, current); }

    public void connect(VpnServer s) {
        current = s; set(State.CONNECTING);
        try {
            Config augmented = ConfigAugmenter.augment(s.config, selfPackage);
            backend.up(augmented);
            set(State.CONNECTED);
        } catch (Exception e) { set(State.ERROR); }
    }

    public void connectFastest(LatencyProbe.Pinger pinger) {
        VpnServer f = LatencyProbe.fastest(servers, pinger);
        if (f == null) { set(State.ERROR); return; }
        connect(f);
    }

    public void switchTo(VpnServer s) { backend.down(); connect(s); }

    public void disconnect() { backend.down(); current = null; set(State.IDLE); }

    public void onHealthTick() {
        if (state != State.CONNECTED) return;
        if (!backend.isUp() || backend.lastHandshakeAgeSec() > STALE_HANDSHAKE_SEC) {
            set(State.RECONNECTING);
            if (current != null) connect(current); // relance ; l'UI peut ensuite basculer en Auto
        }
    }
}
```

- [ ] **Step 5: Lancer → succès**

Run: `cd android-app && ./gradlew :app:testDebugUnitTest --tests "com.pipsiflix.app.vpn.VpnManagerTest"`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add android-app/app/src/main/java/com/pipsiflix/app/vpn/WgBackend.java android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnManager.java android-app/app/src/test/java/com/pipsiflix/app/vpn/VpnManagerTest.java
git commit -m "feat(vpn): VpnManager (machine à états, reconnexion, auto-fastest)"
```

---

## Task 6: VpnPrefs — persistance + portes de retour (logique testable)

**Files:**
- Create: `android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnPrefs.java`
- Test: `android-app/app/src/test/java/com/pipsiflix/app/vpn/VpnGateTest.java`
- Create: `android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnGate.java`

**Interfaces:**
- Produces:
  - `VpnGate.shouldEnforce(boolean globalEnabled, boolean remoteEnabled, boolean sessionOverride) -> boolean`
    (le kill-switch s'applique seulement si `globalEnabled && remoteEnabled && !sessionOverride`)
  - `VpnPrefs(Context)` avec : `boolean isEnabled()/setEnabled(b)` (interrupteur global, défaut true), `String lastServerId()/setLastServerId(id)`, `boolean sessionOverride()/setSessionOverride(b)` (mémoire vive, remis à false au boot).

- [ ] **Step 1: Test de la logique de gating (échoue)**

```java
package com.pipsiflix.app.vpn;

import static org.junit.Assert.*;
import org.junit.Test;

public class VpnGateTest {
    @Test public void enforcesOnlyWhenAllOn() {
        assertTrue(VpnGate.shouldEnforce(true, true, false));   // normal
        assertFalse(VpnGate.shouldEnforce(false, true, false)); // interrupteur global OFF
        assertFalse(VpnGate.shouldEnforce(true, false, false)); // kill-switch distant OFF
        assertFalse(VpnGate.shouldEnforce(true, true, true));   // override "continuer sans VPN"
    }
}
```

- [ ] **Step 2: Lancer → échec**

Run: `cd android-app && ./gradlew :app:testDebugUnitTest --tests "com.pipsiflix.app.vpn.VpnGateTest"`
Expected: FAIL — `VpnGate` absent.

- [ ] **Step 3: Créer `VpnGate`**

```java
package com.pipsiflix.app.vpn;

/** Décide si le kill-switch strict doit être appliqué (spec §13). */
public final class VpnGate {
    public static boolean shouldEnforce(boolean globalEnabled, boolean remoteEnabled, boolean sessionOverride) {
        return globalEnabled && remoteEnabled && !sessionOverride;
    }
    private VpnGate() {}
}
```

- [ ] **Step 4: Créer `VpnPrefs`**

```java
package com.pipsiflix.app.vpn;

import android.content.Context;
import android.content.SharedPreferences;

/** Persistance des choix VPN + override de session (porte de retour). */
public final class VpnPrefs {
    private static final String P = "pipsily_vpn";
    private final SharedPreferences sp;
    private boolean sessionOverride = false; // mémoire vive uniquement

    public VpnPrefs(Context ctx) { sp = ctx.getSharedPreferences(P, Context.MODE_PRIVATE); }

    public boolean isEnabled() { return sp.getBoolean("enabled", true); }
    public void setEnabled(boolean b) { sp.edit().putBoolean("enabled", b).apply(); }

    public String lastServerId() { return sp.getString("last_server", null); }
    public void setLastServerId(String id) { sp.edit().putString("last_server", id).apply(); }

    public boolean autoFastest() { return sp.getBoolean("auto_fastest", true); }
    public void setAutoFastest(boolean b) { sp.edit().putBoolean("auto_fastest", b).apply(); }

    public boolean sessionOverride() { return sessionOverride; }
    public void setSessionOverride(boolean b) { sessionOverride = b; }
}
```

- [ ] **Step 5: Lancer → succès**

Run: `cd android-app && ./gradlew :app:testDebugUnitTest --tests "com.pipsiflix.app.vpn.VpnGateTest"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnGate.java android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnPrefs.java android-app/app/src/test/java/com/pipsiflix/app/vpn/VpnGateTest.java
git commit -m "feat(vpn): VpnPrefs + logique de gating (portes de retour)"
```

---

## Task 7: GoWgBackend — backend WireGuard réel (device)

**Files:**
- Create: `android-app/app/src/main/java/com/pipsiflix/app/vpn/GoWgBackend.java`

**Interfaces:**
- Consumes: `WgBackend`, `com.wireguard.android.backend.GoBackend`, `com.wireguard.android.backend.Tunnel`.
- Produces: `GoWgBackend(Context)` implémentant `WgBackend` via GoBackend (un seul tunnel nommé "pipsily").

- [ ] **Step 1: Implémenter `GoWgBackend`**

```java
package com.pipsiflix.app.vpn;

import android.content.Context;
import com.wireguard.android.backend.Backend;
import com.wireguard.android.backend.GoBackend;
import com.wireguard.android.backend.Tunnel;
import com.wireguard.config.Config;

/** Backend réel : pilote un tunnel WireGuard-Go nommé "pipsily". */
public final class GoWgBackend implements WgBackend {
    private final Backend backend;
    private Config lastConfig;
    private final Tunnel tunnel = new Tunnel() {
        public String getName() { return "pipsily"; }
        public void onStateChange(Tunnel.State newState) { }
    };

    public GoWgBackend(Context ctx) { this.backend = new GoBackend(ctx.getApplicationContext()); }

    @Override public void up(Config c) throws Exception {
        lastConfig = c;
        backend.setState(tunnel, Tunnel.State.UP, c);
    }
    @Override public void down() {
        try { backend.setState(tunnel, Tunnel.State.DOWN, lastConfig); } catch (Exception ignored) {}
    }
    @Override public boolean isUp() {
        try { return backend.getState(tunnel) == Tunnel.State.UP; } catch (Exception e) { return false; }
    }
    @Override public long lastHandshakeAgeSec() {
        try {
            com.wireguard.android.backend.Statistics st = backend.getStatistics(tunnel);
            long latest = 0;
            for (com.wireguard.crypto.Key k : st.peers()) {
                long t = st.peer(k).latestHandshakeEpochMillis;
                if (t > latest) latest = t;
            }
            if (latest == 0) return Long.MAX_VALUE;
            return (System.currentTimeMillis() - latest) / 1000L;
        } catch (Exception e) { return Long.MAX_VALUE; }
    }
}
```

- [ ] **Step 2: Compiler**

Run: `cd android-app && ./gradlew :app:compileDebugJavaWithJavac`
Expected: BUILD SUCCESSFUL. Si les signatures `Statistics`/`peers()` diffèrent dans 1.0.20230706, aligner (consulter `com.wireguard.android.backend.Statistics`). Le tunnel/handshake ne se teste qu'avec un vrai `.conf` (Task 10).

- [ ] **Step 3: Commit**

```bash
git add android-app/app/src/main/java/com/pipsiflix/app/vpn/GoWgBackend.java
git commit -m "feat(vpn): backend WireGuard réel (GoBackend)"
```

---

## Task 8: VpnActivity — UI native (statut + sélecteur + Auto)

**Files:**
- Create: `android-app/app/src/main/res/layout/activity_vpn.xml`
- Create: `android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnActivity.java`

**Interfaces:**
- Consumes: `VpnManager` (singleton exposé par `MainActivity` en Task 9 : `MainActivity.vpn()` → `VpnManager`, `MainActivity.vpnPrefs()` → `VpnPrefs`).
- Produces: écran TV listant les serveurs triés par latence, une entrée « Auto (le plus rapide) », un interrupteur global, et « Continuer sans VPN ».

- [ ] **Step 1: Layout**

Créer `android-app/app/src/main/res/layout/activity_vpn.xml` :

```xml
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent" android:layout_height="match_parent"
    android:orientation="vertical" android:background="#0A0A0F" android:padding="24dp">
    <TextView android:id="@+id/vpnStatus" android:layout_width="match_parent"
        android:layout_height="wrap_content" android:textColor="#FFFFFF"
        android:textSize="18sp" android:text="VPN" android:paddingBottom="12dp"/>
    <Button android:id="@+id/vpnAuto" android:layout_width="match_parent"
        android:layout_height="wrap_content" android:text="⚡ Auto (le plus rapide)"/>
    <Button android:id="@+id/vpnToggle" android:layout_width="match_parent"
        android:layout_height="wrap_content" android:text="VPN : activé"/>
    <Button android:id="@+id/vpnNoVpn" android:layout_width="match_parent"
        android:layout_height="wrap_content" android:text="Continuer sans VPN (session)"/>
    <TextView android:layout_width="match_parent" android:layout_height="wrap_content"
        android:textColor="#90B8D8" android:text="Localisations :" android:paddingTop="12dp"/>
    <ScrollView android:layout_width="match_parent" android:layout_height="0dp"
        android:layout_weight="1">
        <LinearLayout android:id="@+id/vpnList" android:layout_width="match_parent"
            android:layout_height="wrap_content" android:orientation="vertical"/>
    </ScrollView>
</LinearLayout>
```

- [ ] **Step 2: Activity**

Créer `android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnActivity.java` :

```java
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
```

- [ ] **Step 3: Compiler**

Run: `cd android-app && ./gradlew :app:compileDebugJavaWithJavac`
Expected: BUILD SUCCESSFUL (dépend de `MainActivity.vpn()`/`vpnPrefs()` ajoutés en Task 9 — si tu exécutes Task 8 avant Task 9, compile après Task 9).

- [ ] **Step 4: Commit**

```bash
git add android-app/app/src/main/res/layout/activity_vpn.xml android-app/app/src/main/java/com/pipsiflix/app/vpn/VpnActivity.java
git commit -m "feat(vpn): UI native sélecteur de localisation + Auto + portes de retour"
```

---

## Task 9: Intégration MainActivity — gating démarrage + ponts JS + kill-switch distant

**Files:**
- Modify: `android-app/app/src/main/java/com/pipsiflix/app/MainActivity.java`
- Modify: `version.json`

**Interfaces:**
- Consumes: `VpnManager`, `VpnPrefs`, `GoWgBackend`, `VpnServers`, `VpnGate`, `LatencyProbe`.
- Produces (statiques pour VpnActivity + JS bridge) :
  - `static VpnManager MainActivity.vpn()`
  - `static VpnPrefs MainActivity.vpnPrefs()`
  - Bridge : `AndroidBridge.openVpn()`, `AndroidBridge.getVpnState()`.

- [ ] **Step 1: Champs + accès statiques**

Dans `MainActivity`, ajouter les champs et accesseurs (près de `sInstance`) :

```java
    private static com.pipsiflix.app.vpn.VpnManager sVpn;
    private static com.pipsiflix.app.vpn.VpnPrefs sVpnPrefs;
    public static com.pipsiflix.app.vpn.VpnManager vpn() { return sVpn; }
    public static com.pipsiflix.app.vpn.VpnPrefs vpnPrefs() { return sVpnPrefs; }
    private boolean vpnGateOpen = false; // true quand on peut charger la WebView
```

- [ ] **Step 2: Initialiser le VPN AVANT de charger la WebView**

Dans `onCreate`, remplacer le bloc `else { ... webView.loadUrl(APP_URL); }` par un démarrage conditionné. Nouveau code (le `startWebApp()` factorise le `loadUrl` existant, cache purge incluse) :

```java
        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            android.content.SharedPreferences prefs =
                getSharedPreferences("pipsily_prefs", MODE_PRIVATE);
            String lastVer = prefs.getString("apk_version", "");
            if (!APK_VERSION.equals(lastVer)) {
                webView.clearCache(true); webView.clearHistory();
                prefs.edit().putString("apk_version", APK_VERSION).apply();
            }
            startWithVpnThenLoad();   // ← remplace webView.loadUrl(APP_URL)
        }
```

- [ ] **Step 3: Méthodes VPN dans MainActivity**

Ajouter :

```java
    private static final int REQ_VPN_CONSENT = 8931;

    private void startWithVpnThenLoad() {
        sVpnPrefs = new com.pipsiflix.app.vpn.VpnPrefs(this);
        sVpn = new com.pipsiflix.app.vpn.VpnManager(
            new com.pipsiflix.app.vpn.GoWgBackend(this), getPackageName());
        sVpn.setServers(com.pipsiflix.app.vpn.VpnServers.loadFromAssets(this));

        boolean remoteEnabled = true; // écrasé par version.json (Step 5)
        boolean enforce = com.pipsiflix.app.vpn.VpnGate.shouldEnforce(
            sVpnPrefs.isEnabled(), remoteEnabled, sVpnPrefs.sessionOverride());

        if (!enforce || sVpn.getServers().isEmpty()) {
            // Porte de retour : pas de VPN → comportement v60 exact.
            loadWebApp();
            return;
        }
        // Consentement Android (une fois), puis connexion, puis chargement.
        android.content.Intent prep = android.net.VpnService.prepare(this);
        if (prep != null) startActivityForResult(prep, REQ_VPN_CONSENT);
        else connectThenLoad();
    }

    @Override protected void onActivityResult(int req, int res, android.content.Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_VPN_CONSENT) {
            if (res == RESULT_OK) connectThenLoad();
            else { // refus → on ne bloque pas l'appli
                android.widget.Toast.makeText(this, "VPN refusé — lecture sans VPN", android.widget.Toast.LENGTH_LONG).show();
                sVpnPrefs.setSessionOverride(true); loadWebApp();
            }
        }
    }

    private void connectThenLoad() {
        showVpnOverlay("Connexion VPN…");
        new Thread(() -> {
            if (sVpnPrefs.autoFastest() || sVpnPrefs.lastServerId() == null) {
                sVpn.connectFastest(com.pipsiflix.app.vpn.LatencyProbe.tcpPinger());
            } else {
                com.pipsiflix.app.vpn.VpnServer last = null;
                for (com.pipsiflix.app.vpn.VpnServer s : sVpn.getServers())
                    if (s.id.equals(sVpnPrefs.lastServerId())) last = s;
                if (last != null) sVpn.connect(last);
                else sVpn.connectFastest(com.pipsiflix.app.vpn.LatencyProbe.tcpPinger());
            }
            runOnUiThread(() -> {
                if (sVpn.getState() == com.pipsiflix.app.vpn.VpnManager.State.CONNECTED) {
                    hideVpnOverlay(); loadWebApp();
                } else {
                    showVpnFailoverChoices(); // Réessayer / Auto / Continuer sans VPN
                }
            });
        }).start();
    }

    private void loadWebApp() { vpnGateOpen = true; webView.loadUrl(APP_URL); }
```

- [ ] **Step 4: Overlay natif (anti-blocage)**

Ajouter un overlay simple (vue plein écran ajoutée au décor) + les choix de repli :

```java
    private android.widget.FrameLayout vpnOverlay;
    private void showVpnOverlay(String msg) {
        if (vpnOverlay == null) {
            vpnOverlay = new android.widget.FrameLayout(this);
            vpnOverlay.setBackgroundColor(0xEE0A0A0F);
            android.widget.TextView tv = new android.widget.TextView(this);
            tv.setId(android.R.id.text1); tv.setTextColor(0xFFFFFFFF); tv.setTextSize(18);
            android.widget.FrameLayout.LayoutParams lp = new android.widget.FrameLayout.LayoutParams(-2, -2);
            lp.gravity = android.view.Gravity.CENTER; vpnOverlay.addView(tv, lp);
            addContentView(vpnOverlay, new android.widget.FrameLayout.LayoutParams(-1, -1));
        }
        ((android.widget.TextView) vpnOverlay.findViewById(android.R.id.text1)).setText(msg);
        vpnOverlay.setVisibility(android.view.View.VISIBLE);
    }
    private void hideVpnOverlay() { if (vpnOverlay != null) vpnOverlay.setVisibility(android.view.View.GONE); }

    private void showVpnFailoverChoices() {
        new android.app.AlertDialog.Builder(this)
            .setTitle("VPN indisponible")
            .setMessage("Aucun serveur n'a répondu.")
            .setPositiveButton("Réessayer", (d,w) -> connectThenLoad())
            .setNeutralButton("Choisir un serveur", (d,w) -> {
                hideVpnOverlay();
                startActivity(new android.content.Intent(this, com.pipsiflix.app.vpn.VpnActivity.class));
            })
            .setNegativeButton("Continuer sans VPN", (d,w) -> {
                sVpnPrefs.setSessionOverride(true); hideVpnOverlay(); loadWebApp();
            })
            .setCancelable(false).show();
    }
```

- [ ] **Step 5: Kill-switch distant via version.json**

Dans `version.json` (racine), ajouter le champ :

```json
  "vpn_enabled": true,
```

Dans `MainActivity`, remplacer `boolean remoteEnabled = true;` (Step 3) par une lecture du flag déjà récupéré par le canal de MAJ existant si disponible, sinon `true` par défaut (fail-open pour ne jamais bloquer) :

```java
        boolean remoteEnabled = getSharedPreferences("pipsily_prefs", MODE_PRIVATE)
            .getBoolean("vpn_enabled_remote", true);
```

Et là où l'appli lit déjà `version.json` (updater existant), stocker le flag :

```java
        // à l'endroit du parsing JSON de version.json :
        // prefs.edit().putBoolean("vpn_enabled_remote", json.optBoolean("vpn_enabled", true)).apply();
```

- [ ] **Step 6: Ponts JS pour l'UI web (pastille + accès rapide)**

Dans la classe `PipsilyBridge`, ajouter :

```java
        @android.webkit.JavascriptInterface
        public void openVpn() {
            runOnUiThread(() -> startActivity(
                new android.content.Intent(MainActivity.this, com.pipsiflix.app.vpn.VpnActivity.class)));
        }
        @android.webkit.JavascriptInterface
        public String getVpnState() {
            return sVpn == null ? "OFF" : sVpn.getState().name()
                + "|" + (sVpn.getCurrent() != null ? sVpn.getCurrent().label : "");
        }
```

- [ ] **Step 6b: Surveillance du tunnel + pause lecture (spec §6)**

Planifier un tick de santé qui met la lecture en pause si le tunnel tombe et la
reprend au retour. Ajouter dans `MainActivity` :

```java
    private final android.os.Handler vpnHealth = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable vpnHealthTick = new Runnable() {
        @Override public void run() {
            if (sVpn != null && vpnGateOpen) {
                com.pipsiflix.app.vpn.VpnManager.State before = sVpn.getState();
                sVpn.onHealthTick();
                com.pipsiflix.app.vpn.VpnManager.State after = sVpn.getState();
                if (after == com.pipsiflix.app.vpn.VpnManager.State.RECONNECTING) {
                    // pause la lecture web + affiche l'overlay
                    webView.evaluateJavascript(
                        "try{document.querySelectorAll('video').forEach(v=>v.pause());}catch(e){}", null);
                    showVpnOverlay("Reconnexion VPN…");
                    // onHealthTick() ne fait QUE flip RECONNECTING (décision Task 5) :
                    // c'est ICI qu'on déclenche la reconnexion réelle, une seule fois,
                    // en tâche de fond (sinon jamais de reprise).
                    if (before != com.pipsiflix.app.vpn.VpnManager.State.RECONNECTING) {
                        new Thread(() -> {
                            if (sVpnPrefs.autoFastest())
                                sVpn.connectFastest(com.pipsiflix.app.vpn.LatencyProbe.tcpPinger());
                            else if (sVpn.getCurrent() != null)
                                sVpn.connect(sVpn.getCurrent());
                        }).start();
                    }
                } else if (after == com.pipsiflix.app.vpn.VpnManager.State.CONNECTED
                           && before != com.pipsiflix.app.vpn.VpnManager.State.CONNECTED) {
                    hideVpnOverlay();
                }
            }
            vpnHealth.postDelayed(this, 5000);
        }
    };
```

Démarrer/arrêter le tick dans `onResume`/`onPause` :

```java
    // dans onResume() : vpnHealth.removeCallbacks(vpnHealthTick); vpnHealth.postDelayed(vpnHealthTick, 5000);
    // dans onPause()  : vpnHealth.removeCallbacks(vpnHealthTick);
```

> Note : `PlayerActivity` (ExoPlayer natif) partage le même process ; comme le tun
> est per-app, sa lecture est déjà protégée. La pause ExoPlayer explicite pendant
> une coupure VPN pourra être ajoutée en suivi si besoin (le buffer v60 absorbe les
> courtes reconnexions).

- [ ] **Step 7: Compiler + tests JVM (non-régression)**

Run: `cd android-app && ./gradlew :app:compileDebugJavaWithJavac :app:testDebugUnitTest`
Expected: BUILD SUCCESSFUL, tous les tests VPN passent. Corriger les noms si `loadWebApp`/`startWithVpnThenLoad` référencent un symbole manquant.

- [ ] **Step 8: Commit**

```bash
git add android-app/app/src/main/java/com/pipsiflix/app/MainActivity.java version.json
git commit -m "feat(vpn): gating démarrage + consentement + overlay anti-blocage + kill-switch distant + ponts JS"
```

---

## Task 10: Vérification bout-en-bout sur la TV (device) + bump version

**Files:**
- Modify: `android-app/app/build.gradle` (bump version, dernière étape)

**Interfaces:** aucune (validation).

- [ ] **Step 1: Déposer une vraie config**

Placer au moins un `.conf` WireGuard valide dans `android-app/app/src/main/assets/vpn/` (ex : `windscribe-nl.conf`). (Non commité — git-ignoré.)

- [ ] **Step 2: Build debug coexistant + install**

Run: `cd android-app && ./gradlew :app:assembleDebug`
Puis installer sur la TV (adb connecté) : `adb install -r app/build/outputs/apk/debug/app-debug.apk`
Expected: Success. (Si conflit de signature, désinstaller d'abord la debug uniquement.)

- [ ] **Step 3: Vérifs manuelles (kill-switch + anti-fuite)**

1. Lancer PIPSILY → dialogue de consentement VPN (1re fois) → overlay « Connexion VPN… » → l'appli charge une fois `CONNECTED`.
2. **IP** : dans PIPSILY, ouvrir une page qui montre l'IP publique (ou via un flux) → doit être l'IP du serveur VPN, pas celle du FAI.
3. **DNS** : vérifier via un test de fuite DNS accessible dans le WebView → résolveur = celui du VPN.
4. **Per-app** : sur la TV, une AUTRE app (navigateur système) → IP réelle inchangée.
5. **Kill-switch** : couper le serveur (renommer le `.conf` + relancer, ou couper le net) → lecture en pause + overlay + reconnexion/failover.
6. **Changement de localisation** : bouton VPN → choisir un autre pays → reprise auto.
7. **Portes de retour** : désactiver l'interrupteur global → relancer → comportement v60 (aucun VPN). Réactiver.

- [ ] **Step 4: Bump version (dernier)**

Dans `android-app/app/build.gradle` : `versionCode 60` → `61`, `versionName "60.0"` → `"61.0"`.

- [ ] **Step 5: Commit**

```bash
git add android-app/app/build.gradle
git commit -m "chore(vpn): PIPSILY v61 — VPN WireGuard intégré (Android)"
```

---

## Notes d'exécution

- **Ne pas pousser** vers `origin/main` sans accord explicite (dépôt public ; et l'utilisateur gère les push). Les commits restent locaux jusqu'à validation.
- Les signatures exactes de la lib `com.wireguard.android:tunnel:1.0.20230706` (`Config.Builder`, `Interface.Builder.includeApplication`, `InetNetwork.parse`, `Statistics`) doivent être vérifiées à la compilation de chaque tâche concernée ; ajuster les appels sans changer le comportement décrit.
- Tizen : hors périmètre (aucune modif `tizen-tv/`).
