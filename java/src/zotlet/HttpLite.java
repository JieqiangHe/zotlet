package zotlet;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/** Just enough HTTP/1.x request parsing for a local server (no dependency on the JDK's httpserver module). */
final class HttpLite {
    private HttpLite() {}

    static final class Request {
        String method, path, version;
        final Map<String, String> headers = new LinkedHashMap<>(); // lower-case names; repeated headers joined with ", "
        InputStream in;
        byte[] rest; // bytes read past the head
        int restPos;

        String header(String name) { return headers.get(name); }
    }

    private static final int MAX_HEAD = 64 * 1024;

    /** Read the request line and headers; null if the connection closed first. */
    static Request readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int end = -1;
        byte[] all = new byte[0];
        while (end < 0) {
            int n = in.read(buf);
            if (n < 0) {
                if (head.size() == 0) return null;
                throw new IOException("Incomplete request");
            }
            head.write(buf, 0, n);
            all = head.toByteArray();
            end = indexOf(all, new byte[]{'\r', '\n', '\r', '\n'});
            if (end < 0 && all.length > MAX_HEAD) throw new IOException("Request head is too large");
        }
        String text = new String(all, 0, end, StandardCharsets.ISO_8859_1);
        String[] lines = text.split("\r\n");
        String[] first = lines[0].split(" ");
        if (first.length < 3) throw new IOException("Bad request line");
        Request r = new Request();
        r.method = first[0];
        r.path = first[1];
        r.version = first[2];
        for (int k = 1; k < lines.length; k++) {
            int colon = lines[k].indexOf(':');
            if (colon <= 0) continue;
            String name = Text.lower(lines[k].substring(0, colon).trim());
            String value = new String(lines[k].substring(colon + 1).trim().getBytes(StandardCharsets.ISO_8859_1), StandardCharsets.UTF_8);
            r.headers.merge(name, value, (a, b) -> name.equals("host") ? a : a + ", " + b);
        }
        r.in = in;
        r.rest = java.util.Arrays.copyOfRange(all, end + 4, all.length);
        return r;
    }

    private static int indexOf(byte[] data, byte[] pattern) {
        outer:
        for (int i = 0; i + pattern.length <= data.length; i++) {
            for (int j = 0; j < pattern.length; j++) if (data[i + j] != pattern[j]) continue outer;
            return i;
        }
        return -1;
    }

    private static int readByte(Request r) throws IOException {
        if (r.restPos < r.rest.length) return r.rest[r.restPos++] & 0xff;
        return r.in.read();
    }

    /** Exactly n bytes of body. */
    static byte[] readBody(Request r, int n) throws IOException {
        byte[] out = new byte[n];
        int k = 0;
        while (k < n && r.restPos < r.rest.length) out[k++] = r.rest[r.restPos++];
        while (k < n) {
            int m = r.in.read(out, k, n - k);
            if (m < 0) throw new IOException("Incomplete request body");
            k += m;
        }
        return out;
    }

    /** The body by Content-Length or chunked transfer coding; at most `max` bytes (else -1 is thrown as TooLarge). */
    static byte[] readBody(Request r, long max) throws IOException {
        String te = r.header("transfer-encoding");
        if (te != null && Text.lower(te).contains("chunked")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            for (;;) {
                StringBuilder line = new StringBuilder();
                for (int c; (c = readByte(r)) != '\n'; ) {
                    if (c < 0) throw new IOException("Incomplete request body");
                    if (c != '\r') line.append((char) c);
                }
                String size = line.toString().split(";")[0].trim();
                int n = Integer.parseInt(size, 16);
                if (n == 0) {
                    for (int c; (c = readByte(r)) != '\n'; ) if (c < 0) break; // trailer end
                    return out.toByteArray();
                }
                if (out.size() + (long) n > max) throw new TooLarge();
                out.write(readBody(r, n));
                readByte(r); readByte(r); // CRLF
            }
        }
        String length = r.header("content-length");
        long n = length == null ? 0 : Long.parseLong(length.trim());
        if (n > max) throw new TooLarge();
        return readBody(r, (int) n);
    }

    static final class TooLarge extends IOException {}

    static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 409: return "Conflict";
            case 410: return "Gone";
            case 411: return "Length Required";
            case 413: return "Payload Too Large";
            case 415: return "Unsupported Media Type";
            case 500: return "Internal Server Error";
            case 501: return "Not Implemented";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            default: return "Status";
        }
    }
}
