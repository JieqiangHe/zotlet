package zotlet;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

import static zotlet.Json.list;
import static zotlet.Json.map;

/** CSL JSON, BibTeX and RIS export, and the zip with all three (port of src/export.js). */
public final class Export {
    private Export() {}

    public static final class Format {
        public final String extension, mime;
        final java.util.function.BiFunction<List<Map<String, Object>>, String, byte[]> render;
        Format(String extension, String mime, java.util.function.BiFunction<List<Map<String, Object>>, String, byte[]> render) {
            this.extension = extension; this.mime = mime; this.render = render;
        }
        public byte[] render(List<Map<String, Object>> items, String name) { return render.apply(items, name); }
    }

    public static final Map<String, Format> FORMATS = new HashMap<>();
    static {
        FORMATS.put("zip", new Format("zip", "application/zip", Export::toZip));
        FORMATS.put("json", new Format("json", "application/vnd.citationstyles.csl+json", (i, n) -> utf8(toCSLJSON(i))));
        FORMATS.put("bibtex", new Format("bib", "application/x-bibtex", (i, n) -> utf8(toBibTeX(i))));
        FORMATS.put("ris", new Format("ris", "application/x-research-info-systems", (i, n) -> utf8(toRIS(i))));
    }

    private static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }

    static List<Object> dateParts(Map<String, Object> item) {
        Map<String, Object> issued = map(item.get("issued"));
        List<Object> dp = issued == null ? null : list(issued.get("date-parts"));
        List<Object> first = dp == null || dp.isEmpty() ? null : list(dp.get(0));
        return first == null ? new ArrayList<>() : first;
    }

    private static Object part(List<Object> parts, int k) { return k < parts.size() ? parts.get(k) : null; }

    private static final Pattern TAGS = Pattern.compile("<[^>]+>");

    public static String toCSLJSON(List<Map<String, Object>> items) {
        return Json.pretty(items) + "\n";
    }

    // ---------- BibTeX ----------

    private static final Map<String, String> BIBTEX_TYPES = new HashMap<>();
    static {
        String[] a = {"article-journal", "article", "article-magazine", "article", "article-newspaper", "article", "article", "article",
            "book", "book", "chapter", "incollection", "paper-conference", "inproceedings", "report", "techreport",
            "thesis", "phdthesis", "manuscript", "unpublished"};
        for (int k = 0; k < a.length; k += 2) BIBTEX_TYPES.put(a[k], a[k + 1]);
    }
    private static final String[] MONTHS = {"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"};

    private static String escapeTeX(String text) {
        return text.replace("\\", "\\textbackslash ")
            .replaceAll("([{}&%$#_])", "\\\\$1")
            .replace("~", "\\textasciitilde{}")
            .replace("^", "\\textasciicircum{}");
    }

    private static final Pattern RICH = Pattern.compile("(</?(?:i|b|sub|sup)>)", Pattern.CASE_INSENSITIVE);
    private static final Pattern RICH_TAG = Pattern.compile("^<(/?)(i|b|sub|sup)>$", Pattern.CASE_INSENSITIVE);
    private static final Map<String, String> TEX_TAGS = new HashMap<>();
    static {
        TEX_TAGS.put("i", "\\textit{");
        TEX_TAGS.put("b", "\\textbf{");
        TEX_TAGS.put("sub", "\\textsubscript{");
        TEX_TAGS.put("sup", "\\textsuperscript{");
    }

    /** Split like JS String.split with a capturing group: the separators are kept. */
    private static List<String> splitKeep(String s, Pattern p) {
        List<String> out = new ArrayList<>();
        Matcher m = p.matcher(s);
        int last = 0;
        while (m.find()) {
            out.add(s.substring(last, m.start()));
            out.add(m.group(1));
            last = m.end();
        }
        out.add(s.substring(last));
        return out;
    }

    /** Escape TeX specials; CSL rich text (<i>, <b>, <sub>, <sup>) becomes the matching TeX command. */
    public static String bibtexEscape(Object value) {
        StringBuilder out = new StringBuilder();
        int depth = 0;
        for (String part : splitKeep(Json.jsString(value), RICH)) {
            Matcher tag = RICH_TAG.matcher(part);
            if (!tag.matches()) out.append(escapeTeX(TAGS.matcher(part).replaceAll("")));
            else if (tag.group(1).isEmpty()) { out.append(TEX_TAGS.get(Text.lower(tag.group(2)))); depth++; }
            else if (depth > 0) { out.append('}'); depth--; }
        }
        for (int k = 0; k < depth; k++) out.append('}');
        return Text.squash(out.toString().replaceAll(Text.WS + "+", " "));
    }

    private static String s(Map<String, Object> n, String key) {
        Object v = n.get(key);
        return Json.truthy(v) ? Json.jsString(v) : null;
    }

    private static String joinPresent(String sep, String... parts) {
        List<String> keep = new ArrayList<>();
        for (String p : parts) if (p != null && !p.isEmpty()) keep.add(p);
        return String.join(sep, keep);
    }

    private static String bibName(Object o) {
        Map<String, Object> n = map(o) == null ? new HashMap<>() : map(o);
        if (s(n, "literal") != null) return "{" + bibtexEscape(s(n, "literal")) + "}";
        String family = joinPresent(" ", s(n, "non-dropping-particle"), s(n, "family"));
        String given = joinPresent(" ", s(n, "given"), s(n, "dropping-particle"));
        List<String> parts = new ArrayList<>();
        for (String p : new String[]{family, s(n, "suffix"), given}) if (p != null && !p.isEmpty()) parts.add(bibtexEscape(p));
        return String.join(", ", parts);
    }

    private static final Pattern NON_KEY = Pattern.compile("[^A-Za-z0-9_:.-]");

    public static String bibtexKey(Object id, Set<String> used) {
        String key = id == null ? "" : Json.jsString(id);
        key = Normalizer.normalize(key, Normalizer.Form.NFKD).replaceAll("[\\u0300-\\u036f]", "");
        key = NON_KEY.matcher(key).replaceAll("");
        if (key.isEmpty()) key = "ref";
        if (!key.matches("^[A-Za-z].*")) key = "ref" + key;
        String candidate = key;
        for (int n = 2; used.contains(candidate); n++) candidate = key + "_" + n;
        used.add(candidate);
        return candidate;
    }

    private static final Pattern DASHES = Pattern.compile(Text.WS + "*[-–—]+" + Text.WS + "*");

    private static String bibtexEntry(Map<String, Object> item, Set<String> used) {
        String type = BIBTEX_TYPES.getOrDefault(item.get("type") instanceof String ? item.get("type") : "", "misc");
        List<String[]> fields = new ArrayList<>();
        class Adder {
            void add(String name, Object value, boolean raw, boolean protect) {
                if (value == null || "".equals(value)) return;
                String text = raw ? Json.jsString(value) : bibtexEscape(value);
                if (!text.isEmpty()) fields.add(new String[]{name, protect ? "{" + text + "}" : text});
            }
            void add(String name, Object value) { add(name, value, false, false); }
        }
        Adder a = new Adder();
        List<Object> authors = list(item.get("author")), editors = list(item.get("editor"));
        if (authors != null && !authors.isEmpty()) a.add("author", join(authors), true, false);
        if (editors != null && !editors.isEmpty()) a.add("editor", join(editors), true, false);
        a.add("title", item.get("title"), false, true);
        Object container = item.get("container-title");
        if (type.equals("article")) a.add("journal", container);
        else if (type.equals("incollection") || type.equals("inproceedings")) a.add("booktitle", container);
        else if (Json.truthy(container)) a.add("howpublished", container);
        List<Object> parts = dateParts(item);
        a.add("year", part(parts, 0));
        Object month = part(parts, 1);
        if (month instanceof Number && ((Number) month).doubleValue() >= 1 && ((Number) month).doubleValue() <= 12) {
            double m = ((Number) month).doubleValue();
            if (m == Math.rint(m)) fields.add(new String[]{"month", MONTHS[(int) m - 1]});
        }
        a.add("volume", item.get("volume"));
        a.add("number", Json.truthy(item.get("issue")) ? item.get("issue") : type.equals("techreport") ? item.get("number") : null);
        a.add("pages", Json.truthy(item.get("page")) ? DASHES.matcher(Json.jsString(item.get("page"))).replaceAll("--") : item.get("page"));
        if (type.equals("techreport")) a.add("institution", item.get("publisher"));
        else if (type.equals("phdthesis")) a.add("school", item.get("publisher"));
        else a.add("publisher", item.get("publisher"));
        a.add("address", item.get("publisher-place"));
        a.add("edition", item.get("edition"));
        a.add("isbn", item.get("ISBN"));
        a.add("issn", item.get("ISSN"));
        a.add("doi", item.get("DOI"), true, false);
        a.add("url", item.get("URL"), true, false);
        a.add("pmid", item.get("PMID"), true, false);
        a.add("pmcid", item.get("PMCID"), true, false);
        a.add("abstract", item.get("abstract"));
        a.add("note", item.get("note"));
        List<String> body = new ArrayList<>();
        for (String[] f : fields) body.add("  " + Text.padEnd(f[0], 9) + " = {" + f[1] + "}");
        return "@" + type + "{" + bibtexKey(item.get("id"), used) + ",\n" + String.join(",\n", body) + "\n}\n";
    }

    private static String join(List<Object> names) {
        List<String> out = new ArrayList<>();
        for (Object n : names) out.add(bibName(n));
        return String.join(" and ", out);
    }

    public static String toBibTeX(List<Map<String, Object>> items) {
        Set<String> used = new HashSet<>();
        List<String> out = new ArrayList<>();
        for (Map<String, Object> item : items) out.add(bibtexEntry(item, used));
        return String.join("\n", out);
    }

    // ---------- RIS ----------

    private static final Map<String, String> RIS_TYPES = new HashMap<>();
    static {
        String[] a = {"article-journal", "JOUR", "article-magazine", "MGZN", "article-newspaper", "NEWS", "article", "JOUR", "book", "BOOK",
            "chapter", "CHAP", "paper-conference", "CPAPER", "report", "RPRT", "thesis", "THES", "dataset", "DATA", "webpage", "ELEC",
            "patent", "PAT", "manuscript", "UNPB", "software", "COMP"};
        for (int k = 0; k < a.length; k += 2) RIS_TYPES.put(a[k], a[k + 1]);
    }

    private static String risName(Object o) {
        Map<String, Object> n = map(o) == null ? new HashMap<>() : map(o);
        if (s(n, "literal") != null) return s(n, "literal");
        return joinPresent(", ", joinPresent(" ", s(n, "non-dropping-particle"), s(n, "family")), s(n, "given"), s(n, "suffix"));
    }

    private static String risText(Object v) {
        return Text.squash(TAGS.matcher(Json.jsString(v)).replaceAll(""));
    }

    private static String risEntry(Map<String, Object> item) {
        List<String[]> lines = new ArrayList<>();
        lines.add(new String[]{"TY", RIS_TYPES.getOrDefault(item.get("type") instanceof String ? item.get("type") : "", "GEN")});
        java.util.function.BiConsumer<String, Object> add = (tag, value) -> {
            if (value != null && !risText(value).isEmpty()) lines.add(new String[]{tag, risText(value)});
        };
        List<Object> authors = list(item.get("author")), editors = list(item.get("editor"));
        if (authors != null) for (Object n : authors) add.accept("AU", risName(n));
        if (editors != null) for (Object n : editors) add.accept("A2", risName(n));
        add.accept("TI", item.get("title"));
        if ("article-journal".equals(item.get("type")) || "article".equals(item.get("type"))) add.accept("JO", item.get("container-title"));
        add.accept("T2", item.get("container-title"));
        add.accept("J2", item.get("container-title-short"));
        List<Object> parts = dateParts(item);
        Object y = part(parts, 0), m = part(parts, 1), d = part(parts, 2);
        if (Json.truthy(y)) {
            add.accept("PY", y);
            add.accept("DA", Json.jsString(y) + "/" + (Json.truthy(m) ? Text.padStart(Json.jsString(m), 2, '0') : "") + "/" + (Json.truthy(d) ? Text.padStart(Json.jsString(d), 2, '0') : "") + "/");
        }
        add.accept("VL", item.get("volume"));
        add.accept("IS", item.get("issue"));
        if (Json.truthy(item.get("page"))) {
            String[] range = DASHES.split(Json.jsString(item.get("page")), -1);
            add.accept("SP", range[0]);
            add.accept("EP", range.length > 1 ? range[1] : null);
        }
        add.accept("PB", item.get("publisher"));
        add.accept("CY", item.get("publisher-place"));
        add.accept("SN", Json.truthy(item.get("ISSN")) ? item.get("ISSN") : item.get("ISBN"));
        add.accept("DO", item.get("DOI"));
        add.accept("UR", Json.truthy(item.get("URL")) ? item.get("URL") : Json.truthy(item.get("DOI")) ? "https://doi.org/" + Json.jsString(item.get("DOI")) : "");
        if (Json.truthy(item.get("PMID"))) add.accept("AN", "PMID:" + Json.jsString(item.get("PMID")));
        add.accept("AB", item.get("abstract"));
        add.accept("N1", item.get("note"));
        add.accept("ID", item.get("id"));
        lines.add(new String[]{"ER", ""});
        StringBuilder b = new StringBuilder();
        for (int k = 0; k < lines.size(); k++) {
            if (k > 0) b.append("\r\n");
            b.append(lines.get(k)[0]).append("  - ").append(lines.get(k)[1]);
        }
        return b.append("\r\n").toString();
    }

    public static String toRIS(List<Map<String, Object>> items) {
        List<String> out = new ArrayList<>();
        for (Map<String, Object> item : items) out.add(risEntry(item));
        return String.join("\r\n", out);
    }

    // ---------- zip ----------

    /** A minimal zip writer (deflate, UTF-8 names), same layout as the Node version. */
    public static byte[] zip(List<Object[]> files) {
        java.time.LocalDateTime date = java.time.LocalDateTime.now();
        int time = (date.getHour() << 11) | (date.getMinute() << 5) | (date.getSecond() >> 1);
        int day = ((date.getYear() - 1980) << 9) | (date.getMonthValue() << 5) | date.getDayOfMonth();
        ByteArrayOutputStream out = new ByteArrayOutputStream(), central = new ByteArrayOutputStream();
        int offset = 0;
        for (Object[] f : files) {
            byte[] data = f[1] instanceof byte[] ? (byte[]) f[1] : utf8((String) f[1]);
            byte[] name = utf8((String) f[0]);
            Deflater deflater = new Deflater(Deflater.DEFAULT_COMPRESSION, true);
            deflater.setInput(data);
            deflater.finish();
            ByteArrayOutputStream packedOut = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            while (!deflater.finished()) packedOut.write(buf, 0, deflater.deflate(buf));
            deflater.end();
            byte[] packed = packedOut.toByteArray();
            CRC32 crc = new CRC32();
            crc.update(data);
            int c = (int) crc.getValue();
            le32(out, 0x04034b50); le16(out, 20); le16(out, 0x0800); le16(out, 8); le16(out, time); le16(out, day);
            le32(out, c); le32(out, packed.length); le32(out, data.length); le16(out, name.length); le16(out, 0);
            out.write(name, 0, name.length);
            out.write(packed, 0, packed.length);
            le32(central, 0x02014b50); le16(central, 20); le16(central, 20); le16(central, 0x0800); le16(central, 8);
            le16(central, time); le16(central, day); le32(central, c); le32(central, packed.length); le32(central, data.length);
            le16(central, name.length); le16(central, 0); le16(central, 0); le16(central, 0); le16(central, 0); le32(central, 0); le32(central, offset);
            central.write(name, 0, name.length);
            offset += 30 + name.length + packed.length;
        }
        byte[] dir = central.toByteArray();
        out.write(dir, 0, dir.length);
        le32(out, 0x06054b50); le16(out, 0); le16(out, 0); le16(out, files.size()); le16(out, files.size());
        le32(out, dir.length); le32(out, offset); le16(out, 0);
        return out.toByteArray();
    }

    private static void le16(ByteArrayOutputStream o, int v) { o.write(v & 0xff); o.write((v >>> 8) & 0xff); }
    private static void le32(ByteArrayOutputStream o, int v) { le16(o, v & 0xffff); le16(o, (v >>> 16) & 0xffff); }

    private static String readme(String name, int n) {
        return (name + " — " + n + " reference" + (n == 1 ? "" : "s") + " exported from zotlet\n\n"
            + name + ".ris   RIS: Zotero, EndNote, Mendeley, most reference managers\n"
            + name + ".json  CSL JSON: Zotero, and zotlet itself (drop it on the zotlet list)\n"
            + name + ".bib   BibTeX: LaTeX\n\n"
            + "Into Zotero: File → Import… → choose " + name + ".ris (or " + name + ".json).\n"
            + "Documents written with zotlet keep a full copy of every cited reference, so Zotero can\n"
            + "refresh them in Word or LibreOffice even before the references are imported.\n").replace("\n", "\r\n");
    }

    /** Everything at once: one zip with CSL JSON, BibTeX and RIS. */
    public static byte[] toZip(List<Map<String, Object>> items, String name) {
        if (name == null) name = "references";
        return zip(Arrays.asList(
            new Object[]{name + ".ris", toRIS(items)}, new Object[]{name + ".json", toCSLJSON(items)},
            new Object[]{name + ".bib", toBibTeX(items)}, new Object[]{"README.txt", readme(name, items.size())}));
    }
}
