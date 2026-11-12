package zotlet;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Outgoing HTTP (doi.org, Crossref, PubMed, the style repository) with HttpURLConnection only,
 * so it runs on any Java runtime (TBtools' included). Tests point every request at a local mock
 * with ZOTLET_FETCH_BASE: https://host/path → <base>/host/path.
 */
public final class Net {
    private Net() {}

    public static final class Response {
        public final int status;
        public final byte[] body;
        Response(int status, byte[] body) { this.status = status; this.body = body; }
        public boolean ok() { return status >= 200 && status < 300; }
        public String text() { return new String(body, StandardCharsets.UTF_8); }
    }

    /** A failure before any HTTP status (DNS, refused, timeout). */
    public static final class NetError extends IOException {
        public final boolean timeout;
        public final String code;
        NetError(String message, boolean timeout, String code) { super(message); this.timeout = timeout; this.code = code; }
    }

    public interface Fetcher {
        Response get(String url, Map<String, String> headers) throws NetError;
    }

    public static final int TIMEOUT_MS = 20000;
    public static final String USER_AGENT = "zotlet/1.0 (personal reference manager)";

    public static Fetcher defaultFetcher() {
        String base = System.getenv("ZOTLET_FETCH_BASE");
        return (url, headers) -> get(base == null || base.isEmpty() ? url : url.replaceFirst("^https?://", base.replaceAll("/+$", "") + "/"), headers);
    }

    public static Response get(String url, Map<String, String> headers) throws NetError {
        HttpURLConnection c = null;
        try {
            URL u = new URL(url);
            int redirects = 0;
            for (;;) {
                c = (HttpURLConnection) u.openConnection();
                c.setConnectTimeout(TIMEOUT_MS);
                c.setReadTimeout(TIMEOUT_MS);
                c.setInstanceFollowRedirects(false);
                c.setRequestProperty("User-Agent", USER_AGENT);
                for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
                int status = c.getResponseCode();
                if (status >= 300 && status < 400 && status != 304 && c.getHeaderField("Location") != null && redirects++ < 10) {
                    // Follow across http/https too (HttpURLConnection does not).
                    u = new URL(u, c.getHeaderField("Location"));
                    c.disconnect();
                    continue;
                }
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                return new Response(status, in == null ? new byte[0] : readAll(in, 64 * 1024 * 1024));
            }
        } catch (SocketTimeoutException e) {
            throw new NetError("timeout", true, "ETIMEDOUT");
        } catch (UnknownHostException e) {
            throw new NetError("getaddrinfo ENOTFOUND " + e.getMessage(), false, "ENOTFOUND");
        } catch (java.net.ConnectException e) {
            throw new NetError(String.valueOf(e.getMessage()), false, "ECONNREFUSED");
        } catch (IOException e) {
            throw new NetError(String.valueOf(e.getMessage()), false, e.getClass().getSimpleName());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    public static byte[] readAll(InputStream in, long max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        long total = 0;
        for (int n; (n = in.read(buf)) > 0; ) {
            total += n;
            if (total > max) throw new IOException("Response is too large");
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    public static String host(String url) {
        try { return new URL(url).getHost(); } catch (Exception e) { return url; }
    }
}
