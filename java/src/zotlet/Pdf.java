package zotlet;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/**
 * Read the DOI of an article from its PDF, so a dropped PDF can be imported like a typed DOI
 * (port of src/pdf.js). The PDF is only read in memory; it is never stored.
 */
public final class Pdf {
    private Pdf() {}

    private static final int MAX_INFLATED = 80 * 1024 * 1024;

    // Crossref's recommended pattern, plus cleanup of what PDFs put around it.
    private static final Pattern DOI_RE = Pattern.compile("10\\.\\d{4,9}/[-._;()/:a-z0-9]+", Pattern.CASE_INSENSITIVE);
    private static final Pattern TRAIL = Pattern.compile("[.,;:]+$");
    private static final Pattern GLUED = Pattern.compile("(\\d)(?:Received|Available|Accepted|Published|Copyright|Contents|Keywords|Article|Abstract|E-mail|Email|www)[a-z]*$", Pattern.CASE_INSENSITIVE);
    private static final Pattern VALID = Pattern.compile("^10\\.\\d{4,9}/[^\\t\\n\\x0B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]{2,}$");

    static String cleanDOI(String raw) {
        String doi = TRAIL.matcher(raw).replaceFirst("");
        // Cut at the first ")" without an opening partner (the end of a PDF string, "...)Tj").
        int depth = 0;
        for (int k = 0; k < doi.length(); k++) {
            if (doi.charAt(k) == '(') depth++;
            else if (doi.charAt(k) == ')' && --depth < 0) { doi = doi.substring(0, k); break; }
        }
        doi = TRAIL.matcher(doi).replaceFirst("");
        // Publisher PDFs often glue the next word on ("...111729Received"); a DOI suffix rarely ends in a capitalised word.
        doi = GLUED.matcher(doi).replaceFirst("$1");
        return VALID.matcher(doi).matches() ? doi : null;
    }

    private static final Pattern FLATE = Pattern.compile("/FlateDecode");
    private static final Pattern IMAGE = Pattern.compile("/Subtype" + Text.WS + "*/Image");

    /** Inflate every FlateDecode stream (page contents, object streams, XMP). */
    static List<String> streams(String latin1, byte[] bytes) {
        List<String> out = new ArrayList<>();
        long total = 0;
        int from = 0;
        for (;;) {
            int start = latin1.indexOf("stream", from);
            if (start < 0) break;
            from = start + 6;
            if (start >= 3 && latin1.startsWith("end", start - 3)) continue;
            int dataStart = start + 6;
            if (dataStart < latin1.length() && latin1.charAt(dataStart) == '\r') dataStart++;
            if (dataStart < latin1.length() && latin1.charAt(dataStart) == '\n') dataStart++;
            int end = latin1.indexOf("endstream", dataStart);
            if (end < 0) break;
            int open = start - 1 < 0 ? -1 : latin1.lastIndexOf("<<", start - 1);
            String dict = latin1.substring(Math.max(0, open - 1), start);
            from = end + 9;
            if (!FLATE.matcher(dict).find() || IMAGE.matcher(dict).find()) continue;
            byte[] data = inflate(bytes, dataStart, end);
            if (data == null) continue;
            total += data.length;
            if (total > MAX_INFLATED) break;
            out.add(new String(data, StandardCharsets.ISO_8859_1));
        }
        return out;
    }

    /** zlib inflate that, like Node's Z_SYNC_FLUSH finish, returns what it got from a truncated stream. */
    private static byte[] inflate(byte[] bytes, int from, int to) {
        if (to <= from) return null;
        Inflater inf = new Inflater();
        try {
            inf.setInput(bytes, from, to - from);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            while (!inf.finished()) {
                int n = inf.inflate(buf);
                if (n == 0) break; // needs more input (truncated) or a dictionary: keep what we have
                out.write(buf, 0, n);
                if (out.size() > MAX_INFLATED) break;
            }
            if (out.size() == 0 && !inf.finished()) return null;
            return out.toByteArray();
        } catch (DataFormatException e) {
            return null;
        } finally {
            inf.end();
        }
    }

    private static final Pattern ESCAPED = Pattern.compile("\\\\([()\\\\])");
    private static final Pattern HEX = Pattern.compile("<([0-9a-fA-F\\t\\n\\x0B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]{4,})>");
    private static final Pattern KERN = Pattern.compile("\\)" + Text.WS + "*(-?\\d+(?:\\.\\d+)?)" + Text.WS + "*\\(");
    private static final Pattern PRINTABLE = Pattern.compile("^[\\x20-\\x7e]+$");

    /** Join the pieces of a text-showing array: [(10.1016/j.)-250(plaphy)] → 10.1016/j.plaphy */
    static String joinText(String s) {
        s = ESCAPED.matcher(s).replaceAll("$1");
        s = Text.replace(s, HEX, (m) -> {
            String clean = m.group(1).replaceAll(Text.WS + "+", "");
            if (clean.length() % 2 != 0) return m.group();
            StringBuilder t = new StringBuilder();
            for (int k = 0; k < clean.length(); k += 2) t.append((char) Integer.parseInt(clean.substring(k, k + 2), 16));
            String text = t.toString();
            return PRINTABLE.matcher(text).matches() ? "(" + text + ")" : m.group();
        });
        // Kerning inside TJ arrays: a large negative number is a word gap, anything else joins.
        return Text.replace(s, KERN, (m) -> Double.parseDouble(m.group(1)) <= -150 ? " " : "");
    }

    private static final Pattern[] META_PATTERNS = {
        Pattern.compile("<(?:prism|pdfx|crossmark):doi>" + Text.WS + "*(?:doi:" + Text.WS + "*|https?://(?:dx\\.)?doi\\.org/)?(10\\.[^<\\t\\n\\x0B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+)" + Text.WS + "*</", Pattern.CASE_INSENSITIVE),
        Pattern.compile("<dc:identifier>" + Text.WS + "*(?:<rdf:Bag>" + Text.WS + "*<rdf:li>)?" + Text.WS + "*(?:doi:" + Text.WS + "*|info:doi/|https?://(?:dx\\.)?doi\\.org/)(10\\.[^<\\t\\n\\x0B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+)", Pattern.CASE_INSENSITIVE),
        Pattern.compile("/(?:doi|DOI)" + Text.WS + "*\\((10\\.[^)]+)\\)"),
        Pattern.compile("prism:doi=\"(10\\.[^\"]+)\"", Pattern.CASE_INSENSITIVE),
    };

    public static final class Found {
        public final String doi, source;
        Found(String doi, String source) { this.doi = doi; this.source = source; }
    }

    private static final class Count { String doi; int count; int first; }

    /**
     * Find the DOI of the article in a PDF. Metadata (XMP, document info) wins; otherwise the DOI
     * that occurs most often (journals print it in the header or footer of each page), with the
     * earliest one breaking ties. Returns null when there is none.
     */
    public static Found extractDOI(byte[] bytes) {
        String latin1 = new String(bytes, StandardCharsets.ISO_8859_1);
        List<String> texts = new ArrayList<>();
        texts.add(latin1);
        texts.addAll(streams(latin1, bytes));
        Map<String, Count> meta = new LinkedHashMap<>(), seen = new LinkedHashMap<>();
        int order = 0;
        for (String raw : texts) {
            for (Pattern re : META_PATTERNS) {
                Matcher m = re.matcher(raw);
                while (m.find()) {
                    String doi = cleanDOI(m.group(1));
                    if (doi == null) continue;
                    String key = Text.lower(doi);
                    Count c = meta.get(key);
                    Count next = new Count(); // Map.set keeps the key's first position, with the latest spelling
                    next.doi = doi;
                    next.count = (c == null ? 0 : c.count) + 1;
                    meta.put(key, next);
                }
            }
            String text = joinText(raw);
            Matcher m = DOI_RE.matcher(text);
            while (m.find()) {
                String doi = cleanDOI(m.group());
                if (doi == null) continue;
                String key = Text.lower(doi);
                Count entry = seen.get(key);
                if (entry == null) { entry = new Count(); entry.doi = doi; entry.first = order++; seen.put(key, entry); }
                entry.count++;
            }
        }
        if (!meta.isEmpty()) {
            Count best = null;
            for (Count c : metaOrder(meta)) if (best == null || c.count > best.count) best = c;
            return new Found(best.doi, "metadata");
        }
        if (seen.isEmpty()) return null;
        Count best = null;
        for (Count c : seen.values()) if (best == null || c.count > best.count || (c.count == best.count && c.first < best.first)) best = c;
        return new Found(best.doi, "text");
    }

    private static List<Count> metaOrder(Map<String, Count> meta) { return new ArrayList<>(meta.values()); }
}
