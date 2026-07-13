package com.pipsiflix.app;

import android.util.Log;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * PIPSILY VPN test — Mini proxy HTTP local qui relaie vers le SOCKS5 de Tor.
 *
 * Tor n'expose qu'un SOCKS5 (127.0.0.1:socksPort). On expose ici un proxy HTTP
 * local que l'OkHttpClient d'ExoPlayer utilise (Proxy.Type.HTTP) → les flux sport
 * traversent Tor. DNS résolu côté Tor (ATYP=domaine) : indispensable si le FAI
 * bloque aussi la résolution.
 */
final class HttpToSocksProxy {

    private static final String TAG = "PxTor";

    private final int socksPort;
    private ServerSocket server;
    private volatile boolean running = false;

    HttpToSocksProxy(int socksPort) { this.socksPort = socksPort; }

    int start() throws IOException {
        server = new ServerSocket();
        server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
        running = true;
        final int port = server.getLocalPort();
        Thread accept = new Thread(() -> {
            while (running) {
                try {
                    final Socket client = server.accept();
                    Thread t = new Thread(() -> handle(client), "px-conn");
                    t.setDaemon(true);
                    t.start();
                } catch (IOException e) {
                    if (running) Log.w(TAG, "accept: " + e.getMessage());
                }
            }
        }, "px-accept");
        accept.setDaemon(true);
        accept.start();
        Log.i(TAG, "HTTP->SOCKS proxy 127.0.0.1:" + port + " (socks=" + socksPort + ")");
        return port;
    }

    void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (IOException ignored) {}
    }

    private void handle(Socket client) {
        Socket remote = null;
        try {
            InputStream cin = client.getInputStream();
            byte[] header = readHeaderBlock(cin);
            if (header == null) { closeQuietly(client); return; }
            String headText = new String(header, StandardCharsets.ISO_8859_1);
            int eol = headText.indexOf("\r\n");
            if (eol < 0) { closeQuietly(client); return; }
            String[] parts = headText.substring(0, eol).split(" ");
            if (parts.length < 2) { closeQuietly(client); return; }

            String method = parts[0];
            String target = parts[1];
            String host; int port; boolean connect = false;
            String rewrittenHeader = null;

            if ("CONNECT".equalsIgnoreCase(method)) {
                connect = true;
                int c = target.lastIndexOf(':');
                host = c > 0 ? target.substring(0, c) : target;
                port = c > 0 ? parseIntSafe(target.substring(c + 1), 443) : 443;
            } else {
                String hp; String path = "/";
                String t = target;
                int schemeIdx = t.indexOf("://");
                if (schemeIdx >= 0) t = t.substring(schemeIdx + 3);
                int slash = t.indexOf('/');
                if (slash >= 0) { hp = t.substring(0, slash); path = t.substring(slash); }
                else hp = t;
                int c = hp.indexOf(':');
                host = c > 0 ? hp.substring(0, c) : hp;
                port = c > 0 ? parseIntSafe(hp.substring(c + 1), 80) : 80;
                String newLine = method + " " + path + " " + (parts.length >= 3 ? parts[2] : "HTTP/1.1");
                rewrittenHeader = newLine + headText.substring(eol);
            }

            remote = socks5Connect(host, port);
            if (remote == null) {
                if (connect) writeLine(client, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
                closeQuietly(client);
                return;
            }
            OutputStream rout = remote.getOutputStream();
            if (connect) writeLine(client, "HTTP/1.1 200 Connection established\r\n\r\n");
            else { rout.write(rewrittenHeader.getBytes(StandardCharsets.ISO_8859_1)); rout.flush(); }

            final Socket rFinal = remote;
            Thread up = new Thread(() -> pipe(client, rFinal), "px-up");
            up.setDaemon(true);
            up.start();
            pipe(remote, client);
            up.join(500);
        } catch (Exception e) {
            Log.w(TAG, "handle: " + e.getMessage());
        } finally {
            closeQuietly(remote);
            closeQuietly(client);
        }
    }

    private Socket socks5Connect(String host, int port) {
        try {
            Socket s = new Socket();
            s.connect(new InetSocketAddress("127.0.0.1", socksPort), 15000);
            InputStream in = s.getInputStream();
            OutputStream out = s.getOutputStream();
            out.write(new byte[]{0x05, 0x01, 0x00}); out.flush();
            byte[] r = readN(in, 2);
            if (r == null || r[0] != 0x05 || r[1] != 0x00) { closeQuietly(s); return null; }
            byte[] hb = host.getBytes(StandardCharsets.US_ASCII);
            byte[] req = new byte[4 + 1 + hb.length + 2];
            int i = 0;
            req[i++] = 0x05; req[i++] = 0x01; req[i++] = 0x00; req[i++] = 0x03;
            req[i++] = (byte) hb.length;
            System.arraycopy(hb, 0, req, i, hb.length); i += hb.length;
            req[i++] = (byte) ((port >> 8) & 0xFF);
            req[i]   = (byte) (port & 0xFF);
            out.write(req); out.flush();
            byte[] head = readN(in, 4);
            if (head == null || head[1] != 0x00) { closeQuietly(s); return null; }
            int atyp = head[3] & 0xFF; int addrLen;
            if (atyp == 0x01) addrLen = 4;
            else if (atyp == 0x04) addrLen = 16;
            else if (atyp == 0x03) { byte[] l = readN(in, 1); if (l == null) { closeQuietly(s); return null; } addrLen = l[0] & 0xFF; }
            else { closeQuietly(s); return null; }
            if (readN(in, addrLen + 2) == null) { closeQuietly(s); return null; }
            return s;
        } catch (IOException e) {
            Log.w(TAG, "socks5: " + e.getMessage());
            return null;
        }
    }

    private static byte[] readHeaderBlock(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        int b, state = 0, max = 64 * 1024;
        while ((b = in.read()) != -1) {
            buf.write(b);
            if ((state == 0 || state == 2) && b == '\r') state++;
            else if ((state == 1 || state == 3) && b == '\n') state++;
            else state = 0;
            if (state == 4) return buf.toByteArray();
            if (buf.size() > max) return buf.toByteArray();
        }
        return buf.size() > 0 ? buf.toByteArray() : null;
    }

    private static byte[] readN(InputStream in, int n) throws IOException {
        byte[] b = new byte[n]; int off = 0;
        while (off < n) { int r = in.read(b, off, n - off); if (r < 0) return null; off += r; }
        return b;
    }

    private static void pipe(Socket from, Socket to) {
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            byte[] buf = new byte[16 * 1024]; int r;
            while ((r = in.read(buf)) != -1) { out.write(buf, 0, r); out.flush(); }
        } catch (IOException ignored) {
        } finally { try { to.shutdownOutput(); } catch (IOException ignored) {} }
    }

    private static void writeLine(Socket s, String line) throws IOException {
        s.getOutputStream().write(line.getBytes(StandardCharsets.ISO_8859_1));
        s.getOutputStream().flush();
    }

    private static int parseIntSafe(String s, int def) {
        try { return Integer.parseInt(s.trim()); } catch (Exception e) { return def; }
    }

    private static void closeQuietly(Socket s) {
        if (s != null) try { s.close(); } catch (IOException ignored) {}
    }
}
