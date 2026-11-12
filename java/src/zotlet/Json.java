package zotlet;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JSON in plain Java collections: objects are LinkedHashMap (key order kept), arrays ArrayList,
 * numbers Long (integers) or Double, plus String, Boolean and null. Output matches JavaScript's
 * JSON.stringify (with or without 2-space indentation), so files written by the Node version
 * and by this one look the same.
 */
public final class Json {
    private Json() {}

    public static final class ParseException extends RuntimeException {
        ParseException(String message) { super(message); }
    }

    // ---------- parsing ----------

    public static Object parse(String text) {
        Parser p = new Parser(text);
        p.ws();
        Object v = p.value(0);
        p.ws();
        if (p.i != text.length()) throw new ParseException("Unexpected text after JSON at position " + p.i);
        return v;
    }

    private static final class Parser {
        final String s;
        int i;
        Parser(String s) { this.s = s; }

        void ws() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
                else break;
            }
        }

        ParseException err() {
            return new ParseException(i < s.length() ? "Unexpected token in JSON at position " + i : "Unexpected end of JSON input");
        }

        Object value(int depth) {
            if (depth > 2000) throw new ParseException("JSON is nested too deeply");
            if (i >= s.length()) throw err();
            char c = s.charAt(i);
            switch (c) {
                case '{': {
                    i++;
                    Map<String, Object> m = new LinkedHashMap<>();
                    ws();
                    if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
                    for (;;) {
                        ws();
                        if (i >= s.length() || s.charAt(i) != '"') throw err();
                        String k = string();
                        ws();
                        if (i >= s.length() || s.charAt(i) != ':') throw err();
                        i++;
                        ws();
                        Object v = value(depth + 1);
                        m.remove(k); // JSON.parse: a repeated key takes the last value (and the last position)
                        m.put(k, v);
                        ws();
                        if (i >= s.length()) throw err();
                        char d = s.charAt(i++);
                        if (d == '}') return m;
                        if (d != ',') { i--; throw err(); }
                    }
                }
                case '[': {
                    i++;
                    List<Object> a = new ArrayList<>();
                    ws();
                    if (i < s.length() && s.charAt(i) == ']') { i++; return a; }
                    for (;;) {
                        ws();
                        a.add(value(depth + 1));
                        ws();
                        if (i >= s.length()) throw err();
                        char d = s.charAt(i++);
                        if (d == ']') return a;
                        if (d != ',') { i--; throw err(); }
                    }
                }
                case '"': return string();
                case 't': return word("true", Boolean.TRUE);
                case 'f': return word("false", Boolean.FALSE);
                case 'n': return word("null", null);
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return number();
                    throw err();
            }
        }

        Object word(String w, Object v) {
            if (!s.startsWith(w, i)) throw err();
            i += w.length();
            return v;
        }

        String string() {
            i++; // opening quote
            StringBuilder b = null;
            int start = i;
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == '"') {
                    String out = b == null ? s.substring(start, i) : b.append(s, start, i).toString();
                    i++;
                    return out;
                }
                if (c < 0x20) throw err();
                if (c == '\\') {
                    if (b == null) b = new StringBuilder();
                    b.append(s, start, i);
                    i++;
                    if (i >= s.length()) throw err();
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"': b.append('"'); break;
                        case '\\': b.append('\\'); break;
                        case '/': b.append('/'); break;
                        case 'b': b.append('\b'); break;
                        case 'f': b.append('\f'); break;
                        case 'n': b.append('\n'); break;
                        case 'r': b.append('\r'); break;
                        case 't': b.append('\t'); break;
                        case 'u':
                            if (i + 4 > s.length()) throw err();
                            try { b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); } catch (NumberFormatException x) { throw err(); }
                            i += 4;
                            break;
                        default: i--; throw err();
                    }
                    start = i;
                } else i++;
            }
            throw err();
        }

        Object number() {
            int start = i;
            if (s.charAt(i) == '-') i++;
            if (i >= s.length()) throw err();
            if (s.charAt(i) == '0') i++;
            else if (s.charAt(i) >= '1' && s.charAt(i) <= '9') { while (i < s.length() && Character.isDigit(s.charAt(i)) && s.charAt(i) < 128) i++; }
            else throw err();
            boolean integer = true;
            if (i < s.length() && s.charAt(i) == '.') {
                integer = false;
                i++;
                int d = i;
                while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
                if (d == i) throw err();
            }
            if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
                integer = false;
                i++;
                if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) i++;
                int d = i;
                while (i < s.length() && s.charAt(i) >= '0' && s.charAt(i) <= '9') i++;
                if (d == i) throw err();
            }
            String t = s.substring(start, i);
            if (integer && t.length() < 16) return Long.parseLong(t);
            return normalizeNumber(Double.parseDouble(t));
        }
    }

    /** A double that is a safe integer becomes a Long, like the same number would print in JS. */
    public static Object normalizeNumber(double d) {
        if (d == Math.rint(d) && Math.abs(d) <= 9007199254740991.0 && !(d == 0 && 1 / d < 0)) return (long) d;
        return d;
    }

    // ---------- writing ----------

    public static String stringify(Object v) {
        StringBuilder b = new StringBuilder();
        write(b, v, null, "");
        return b.toString();
    }

    /** JSON.stringify(v, null, 2) */
    public static String pretty(Object v) {
        StringBuilder b = new StringBuilder();
        write(b, v, "  ", "");
        return b.toString();
    }

    private static void write(StringBuilder b, Object v, String indent, String current) {
        if (v == null) { b.append("null"); return; }
        if (v instanceof String) { quote(b, (String) v); return; }
        if (v instanceof Boolean) { b.append(v.toString()); return; }
        if (v instanceof Number) { b.append(number((Number) v)); return; }
        if (v instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) v;
            if (m.isEmpty()) { b.append("{}"); return; }
            String inner = indent == null ? null : current + indent;
            b.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) b.append(',');
                first = false;
                if (inner != null) b.append('\n').append(inner);
                quote(b, String.valueOf(e.getKey()));
                b.append(inner != null ? ": " : ":");
                write(b, e.getValue(), indent, inner);
            }
            if (inner != null) b.append('\n').append(current);
            b.append('}');
            return;
        }
        if (v instanceof List) {
            List<?> a = (List<?>) v;
            if (a.isEmpty()) { b.append("[]"); return; }
            String inner = indent == null ? null : current + indent;
            b.append('[');
            for (int k = 0; k < a.size(); k++) {
                if (k > 0) b.append(',');
                if (inner != null) b.append('\n').append(inner);
                write(b, a.get(k), indent, inner);
            }
            if (inner != null) b.append('\n').append(current);
            b.append(']');
            return;
        }
        quote(b, v.toString());
    }

    public static String quote(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2);
        quote(b, s);
        return b.toString();
    }

    private static void quote(StringBuilder b, String s) {
        b.append('"');
        for (int k = 0; k < s.length(); k++) {
            char c = s.charAt(k);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\b': b.append("\\b"); break;
                case '\f': b.append("\\f"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else if (Character.isSurrogate(c)) {
                        // Well-formed JSON.stringify: pairs are written as is, lone surrogates escaped.
                        boolean pair = Character.isHighSurrogate(c) && k + 1 < s.length() && Character.isLowSurrogate(s.charAt(k + 1));
                        if (pair) { b.append(c).append(s.charAt(++k)); }
                        else b.append(String.format("\\u%04x", (int) c));
                    } else b.append(c);
            }
        }
        b.append('"');
    }

    /** Number formatting of JavaScript (String(n)). */
    public static String number(Number n) {
        if (n instanceof Long || n instanceof Integer || n instanceof Short || n instanceof Byte) return n.toString();
        double d = n.doubleValue();
        if (Double.isNaN(d) || Double.isInfinite(d)) return "null";
        if (d == 0) return "0";
        if (d == Math.rint(d) && Math.abs(d) < 1e21) return new BigDecimal(d).toPlainString();
        BigDecimal x = new BigDecimal(Double.toString(d)).stripTrailingZeros();
        String digits = x.unscaledValue().abs().toString();
        int k = digits.length(), e = k - x.scale(); // value = 0.digits × 10^e
        String sign = d < 0 ? "-" : "";
        if (e > 0 && e <= 21) {
            if (k <= e) return sign + digits + "0".repeat(e - k);
            return sign + digits.substring(0, e) + "." + digits.substring(e);
        }
        if (e <= 0 && e > -6) return sign + "0." + "0".repeat(-e) + digits;
        String exp = (e - 1 >= 0 ? "+" : "-") + Math.abs(e - 1);
        return sign + digits.charAt(0) + (k > 1 ? "." + digits.substring(1) : "") + "e" + exp;
    }

    // ---------- helpers ----------

    @SuppressWarnings("unchecked")
    public static Object copy(Object v) {
        if (v instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) out.put(e.getKey(), copy(e.getValue()));
            return out;
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object x : (List<Object>) v) out.add(copy(x));
            return out;
        }
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> map(Object v) {
        return v instanceof Map ? (Map<String, Object>) v : null;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> list(Object v) {
        return v instanceof List ? (List<Object>) v : null;
    }

    public static String str(Object v) {
        return v instanceof String ? (String) v : null;
    }

    public static Map<String, Object> obj(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int k = 0; k + 1 < kv.length; k += 2) m.put((String) kv[k], kv[k + 1]);
        return m;
    }

    public static List<Object> arr(Object... values) {
        List<Object> a = new ArrayList<>();
        for (Object v : values) a.add(v);
        return a;
    }

    /** JavaScript truthiness. */
    public static boolean truthy(Object v) {
        if (v == null) return false;
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof String) return !((String) v).isEmpty();
        if (v instanceof Number) { double d = ((Number) v).doubleValue(); return d != 0 && !Double.isNaN(d); }
        return true;
    }

    /** JavaScript String(v) for JSON values. */
    public static String jsString(Object v) {
        if (v == null) return "null";
        if (v instanceof String) return (String) v;
        if (v instanceof Number) return number((Number) v);
        if (v instanceof Boolean) return v.toString();
        if (v instanceof List) {
            StringBuilder b = new StringBuilder();
            List<?> a = (List<?>) v;
            for (int k = 0; k < a.size(); k++) {
                if (k > 0) b.append(',');
                Object x = a.get(k);
                if (x != null) b.append(jsString(x));
            }
            return b.toString();
        }
        return "[object Object]";
    }

    /** Deep equality as JSON values (numbers by value). */
    public static boolean same(Object a, Object b) {
        return stringify(a).equals(stringify(b));
    }
}
