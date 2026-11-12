package zotlet;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** String helpers with JavaScript semantics (whitespace, trim, URI encoding), so results match the Node version. */
public final class Text {
    private Text() {}

    /** The characters of JavaScript's \s (Java's \s is ASCII only). */
    public static final String WS = "[\\t\\n\\x0B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
    private static final Pattern WS_RUN = Pattern.compile(WS + "+");

    public static boolean isWs(char c) {
        return c == '\t' || c == '\n' || c == 0x0B || c == '\f' || c == '\r' || c == ' ' || c == 0xa0 || c == 0x1680
            || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
    }

    public static String trim(String s) {
        int a = 0, b = s.length();
        while (a < b && isWs(s.charAt(a))) a++;
        while (b > a && isWs(s.charAt(b - 1))) b--;
        return s.substring(a, b);
    }

    /** s.replace(/\s+/g, ' ').trim() */
    public static String squash(String s) {
        return trim(WS_RUN.matcher(s).replaceAll(" "));
    }

    public static boolean blank(Object v) {
        return !(v instanceof String) || trim((String) v).isEmpty();
    }

    public static String lower(String s) {
        return s.toLowerCase(java.util.Locale.ROOT);
    }

    /** JavaScript's decodeURIComponent; throws IllegalArgumentException on malformed input. */
    public static String decodeURIComponent(String s) {
        if (s.indexOf('%') < 0) return s;
        StringBuilder out = new StringBuilder();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c != '%') { out.append(c); i++; continue; }
            bytes.reset();
            while (i < s.length() && s.charAt(i) == '%') {
                if (i + 3 > s.length()) throw new IllegalArgumentException("URI malformed");
                int hi = Character.digit(s.charAt(i + 1), 16), lo = Character.digit(s.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) throw new IllegalArgumentException("URI malformed");
                bytes.write(hi * 16 + lo);
                i += 3;
            }
            byte[] b = bytes.toByteArray();
            // Validate strict UTF-8 like JS does.
            java.nio.charset.CharsetDecoder dec = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT);
            try { out.append(dec.decode(java.nio.ByteBuffer.wrap(b))); }
            catch (java.nio.charset.CharacterCodingException e) { throw new IllegalArgumentException("URI malformed"); }
        }
        return out.toString();
    }

    private static final String UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";

    /** JavaScript's encodeURIComponent (lone surrogates become U+FFFD instead of throwing). */
    public static String encodeURIComponent(String s) {
        StringBuilder out = new StringBuilder();
        for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
            char c = (char) (b & 0xff);
            if (c < 128 && UNRESERVED.indexOf(c) >= 0) out.append(c);
            else out.append('%').append(Character.toUpperCase(Character.forDigit((b >> 4) & 0xf, 16))).append(Character.toUpperCase(Character.forDigit(b & 0xf, 16)));
        }
        return out.toString();
    }

    /** Replace every match with the result of `fn` (like String.replace with a function). */
    public static String replace(String s, Pattern p, java.util.function.Function<Matcher, String> fn) {
        Matcher m = p.matcher(s);
        StringBuilder b = new StringBuilder();
        int last = 0;
        while (m.find()) {
            b.append(s, last, m.start()).append(fn.apply(m));
            last = m.end();
        }
        return b.append(s.substring(last)).toString();
    }

    public static String padEnd(String s, int n) {
        StringBuilder b = new StringBuilder(s);
        while (b.length() < n) b.append(' ');
        return b.toString();
    }

    public static String padStart(String s, int n, char c) {
        StringBuilder b = new StringBuilder();
        for (int k = s.length(); k < n; k++) b.append(c);
        return b.append(s).toString();
    }
}
