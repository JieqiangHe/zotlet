package zotlet;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reference lists as other programs write them, read into CSL records (which then go through
 * Metadata.normalizeItem like everything else). This is how references without a usable DOI get
 * in, above all Chinese literature: CNKI (知网), Wanfang (万方) and VIP (维普) export EndNote,
 * RefWorks, NoteExpress and BibTeX files and show GB/T 7714 reference text; RIS comes from most
 * other databases.
 */
public final class Refs {
    private Refs() {}

    // ---------- which format ----------

    private static final Pattern ENDNOTE = Pattern.compile("(?m)^%0 \\S"), REFWORKS = Pattern.compile("(?m)^RT \\S"),
        NOTEEXPRESS = Pattern.compile("(?m)^\\{Reference Type\\}:"), RIS = Pattern.compile("(?m)^TY {1,2}- ?\\S"),
        BIBTEX = Pattern.compile("(?m)^\\s*@[A-Za-z]+\\s*\\{"),
        GBT_MARK = Pattern.compile("\\[(J|D|M|C|N|P|R|S|Z|A|G|EB|DB|CP)(?:/(?:OL|CD|MT|DK))?\\]");

    /** "endnote", "refworks", "noteexpress", "ris", "bibtex", "gbt" (GB/T 7714 reference text), or null. */
    public static String detect(String text) {
        if (text == null) return null;
        if (ENDNOTE.matcher(text).find()) return "endnote";
        if (NOTEEXPRESS.matcher(text).find()) return "noteexpress";
        if (RIS.matcher(text).find()) return "ris";
        if (REFWORKS.matcher(text).find()) return "refworks";
        if (BIBTEX.matcher(text).find()) return "bibtex";
        if (GBT_MARK.matcher(text).find()) return "gbt";
        return null;
    }

    /** The CSL records in `text` (not yet normalized); empty if the format is not recognised. */
    public static List<Map<String, Object>> parse(String text) {
        if (text == null) return new ArrayList<>();
        text = text.replace("\ufeff", "").replace("\r\n", "\n").replace('\r', '\n');
        String format = detect(text);
        if (format == null) return new ArrayList<>();
        switch (format) {
            case "endnote": return tagged(text, Pattern.compile("^%(\\S) ?(.*)$"), "0", Refs::fromEndNote);
            case "refworks": return tagged(text, Pattern.compile("^([A-Za-z][A-Za-z0-9]) (.*)$"), "RT", Refs::fromRefWorks);
            case "noteexpress": return tagged(text, Pattern.compile("^\\{([^}]+)\\}: ?(.*)$"), "Reference Type", Refs::fromNoteExpress);
            case "ris": return tagged(text, Pattern.compile("^([A-Z][A-Z0-9]) {1,2}- ?(.*)$"), "TY", Refs::fromRIS);
            case "bibtex": return bibtex(text);
            default: return gbt(text);
        }
    }

    // ---------- tagged formats ----------

    /** One record: tag → values, in the order of the file. */
    static final class Record {
        final Map<String, List<String>> fields = new LinkedHashMap<>();

        void add(String tag, String value) {
            value = Text.squash(value);
            if (!value.isEmpty()) fields.computeIfAbsent(tag, k -> new ArrayList<>()).add(value);
        }
        String first(String... tags) {
            for (String t : tags) { List<String> v = fields.get(t); if (v != null && !v.isEmpty()) return v.get(0); }
            return null;
        }
        List<String> all(String... tags) {
            List<String> out = new ArrayList<>();
            for (String t : tags) { List<String> v = fields.get(t); if (v != null) out.addAll(v); }
            return out;
        }
    }

    private interface Reader { Map<String, Object> read(Record r); }

    /** Lines "TAG value"; a record starts at `first`; a line without a tag continues the value before it. */
    private static List<Map<String, Object>> tagged(String text, Pattern line, String first, Reader reader) {
        List<Record> records = new ArrayList<>();
        Record current = null;
        String lastTag = null;
        StringBuilder value = new StringBuilder();
        for (String raw : text.split("\n")) {
            Matcher m = line.matcher(raw);
            if (m.find()) {
                if (current != null && lastTag != null) current.add(lastTag, value.toString());
                String tag = first.equals("RT") ? m.group(1).toUpperCase(Locale.ROOT) : m.group(1);
                if (tag.equals(first)) { current = new Record(); records.add(current); }
                lastTag = current == null ? null : tag;
                value = new StringBuilder(m.group(2));
            } else if (lastTag != null && !Text.trim(raw).isEmpty()) {
                value.append(' ').append(raw);
            }
        }
        if (current != null && lastTag != null) current.add(lastTag, value.toString());
        List<Map<String, Object>> out = new ArrayList<>();
        for (Record r : records) { Map<String, Object> item = reader.read(r); if (item != null && item.get("title") != null) out.add(item); }
        return out;
    }

    private static final Map<String, String> TYPES = new HashMap<>();
    static {
        String[] a = {"journal article", "article-journal", "journal", "article-journal", "jour", "article-journal", "article", "article-journal",
            "期刊", "article-journal", "期刊论文", "article-journal", "electronic article", "article-journal", "ejour", "article-journal",
            "thesis", "thesis", "thes", "thesis", "dissertation", "thesis", "dissertation/thesis", "thesis", "学位论文", "thesis",
            "phdthesis", "thesis", "mastersthesis", "thesis", "博士", "thesis", "硕士", "thesis",
            "book", "book", "book, whole", "book", "edited book", "book", "图书", "book", "专著", "book",
            "book section", "chapter", "book, section", "chapter", "chap", "chapter", "inbook", "chapter", "incollection", "chapter",
            "conference proceedings", "paper-conference", "conference paper", "paper-conference", "conference proceeding", "paper-conference",
            "conf", "paper-conference", "cpaper", "paper-conference", "inproceedings", "paper-conference", "conference", "paper-conference",
            "会议论文", "paper-conference", "会议", "paper-conference",
            "newspaper article", "article-newspaper", "news", "article-newspaper", "报纸", "article-newspaper",
            "magazine article", "article-magazine", "mgzn", "article-magazine",
            "patent", "patent", "pat", "patent", "专利", "patent", "standard", "standard", "stand", "standard", "标准", "standard",
            "report", "report", "rprt", "report", "techreport", "report", "科技成果", "report", "成果", "report",
            "web page", "webpage", "elec", "webpage", "online", "webpage", "generic", "article", "gen", "article", "misc", "article"};
        for (int k = 0; k < a.length; k += 2) TYPES.put(a[k], a[k + 1]);
    }

    static String type(String value) {
        return value == null ? "article-journal" : TYPES.getOrDefault(Text.lower(Text.trim(value)), "article-journal");
    }

    private static void put(Map<String, Object> item, String key, String value) {
        // CNKI pads issue numbers ("03"); references print 47(3).
        if (value != null && (key.equals("issue") || key.equals("volume")) && Text.trim(value).matches("0+\\d+")) value = Text.trim(value).replaceFirst("^0+", "");
        // The database's own page is not where the article was published: with it, GB/T 7714 would print [J/OL] and the link.
        if (value != null && key.equals("URL") && value.matches("(?i).*\\b(cnki\\.net|cnki\\.com\\.cn|wanfangdata\\.com\\.cn|cqvip\\.com)\\b.*")) return;
        if (value != null && !Text.trim(value).isEmpty() && !item.containsKey(key)) item.put(key, Text.trim(value));
    }

    private static final Pattern YEAR = Pattern.compile("(?<!\\d)(1[5-9]\\d\\d|20\\d\\d)(?!\\d)");
    private static final Pattern FULL_DATE = Pattern.compile("(?<!\\d)(1[5-9]\\d\\d|20\\d\\d)[-/.年](\\d{1,2})(?:[-/.月](\\d{1,2}))?");

    /** A CSL date from "2020", "2020-03-15", "2020/03/15/", "2020年3月". */
    static Map<String, Object> date(String... candidates) {
        for (String c : candidates) {
            if (c == null) continue;
            Matcher full = FULL_DATE.matcher(c);
            if (full.find()) {
                List<Object> parts = new ArrayList<>();
                parts.add((double) Integer.parseInt(full.group(1)));
                int month = Integer.parseInt(full.group(2));
                if (month >= 1 && month <= 12) {
                    parts.add((double) month);
                    if (full.group(3) != null) { int day = Integer.parseInt(full.group(3)); if (day >= 1 && day <= 31) parts.add((double) day); }
                }
                return Json.obj("date-parts", Json.arr(parts));
            }
            Matcher y = YEAR.matcher(c);
            if (y.find()) return Json.obj("date-parts", Json.arr(Json.arr((double) Integer.parseInt(y.group(1)))));
        }
        return null;
    }

    private static void putDate(Map<String, Object> item, String... candidates) {
        Map<String, Object> d = date(candidates);
        if (d != null) item.put("issued", d);
    }

    /** ISSN, ISBN or neither, from the one field these formats share. */
    private static void putSerial(Map<String, Object> item, String value) {
        if (value == null) return;
        String digits = value.replaceAll("[^0-9Xx]", "");
        if (digits.length() == 8) put(item, "ISSN", Text.trim(value));
        else if (digits.length() == 10 || digits.length() == 13) put(item, "ISBN", Text.trim(value));
    }

    private static String language(String value) {
        if (value == null) return null;
        String v = Text.lower(Text.trim(value)).replaceAll("[;；,，\\s]+$", "");
        if (v.isEmpty()) return null;
        if (v.contains("中文") || v.startsWith("chi") || v.startsWith("zh") || v.equals("cn") || v.contains("汉")) return "zh-CN";
        if (v.contains("英") || v.startsWith("en")) return "en";
        return v.matches("[a-z]{2,3}(-[a-z0-9]{2,8})*") ? Text.trim(value) : null;
    }

    private static String pages(String start, String end) {
        if (start == null) return null;
        start = Text.trim(start).replace("–", "-").replace("—", "-").replace("~", "-").replace("+", ",").replaceAll("\\s*-+\\s*", "-");
        if (end != null && !Text.trim(end).isEmpty() && !start.contains("-") && !Text.trim(end).equals(start)) return start + "-" + Text.trim(end);
        return start;
    }

    private static void thesis(Map<String, Object> item, String degree) {
        if (!"thesis".equals(item.get("type")) || degree == null) return;
        String d = Text.trim(degree);
        if (d.contains("博士")) put(item, "genre", "博士学位论文");
        else if (d.contains("硕士")) put(item, "genre", "硕士学位论文");
        else if (!d.isEmpty() && !Text.lower(d).equals("thesis")) put(item, "genre", d);
    }

    // EndNote tagged (.enw / .txt): CNKI's "EndNote" export.
    private static Map<String, Object> fromEndNote(Record r) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("type", type(r.first("0")));
        put(item, "title", r.first("T"));
        putNames(item, "author", r.all("A"));
        putNames(item, "editor", r.all("E"));
        put(item, "container-title", r.first("J", "B"));
        putDate(item, r.first("8"), r.first("D"));
        put(item, "volume", r.first("V"));
        put(item, "issue", r.first("N"));
        put(item, "page", pages(r.first("P"), null));
        putSerial(item, r.first("@"));
        put(item, "DOI", r.first("R"));
        put(item, "URL", r.first("U"));
        put(item, "abstract", r.first("X"));
        put(item, "publisher", r.first("I"));
        put(item, "publisher-place", r.first("C"));
        put(item, "language", language(r.first("G")));
        thesis(item, r.first("9"));
        return item;
    }

    // RefWorks tagged: CNKI's "RefWorks" export. Authors come in one line, separated by semicolons.
    private static Map<String, Object> fromRefWorks(Record r) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("type", type(r.first("RT")));
        put(item, "title", r.first("T1"));
        putNames(item, "author", r.all("A1"));
        putNames(item, "editor", r.all("A2"));
        put(item, "container-title", r.first("JF", "JO", "T2"));
        putDate(item, r.first("FD"), r.first("YR"));
        put(item, "volume", r.first("VO"));
        put(item, "issue", r.first("IS"));
        String op = r.first("OP"), sp = r.first("SP");
        put(item, "page", op != null && op.matches(".*\\d.*[-–~+,].*") ? pages(op, null) : pages(sp, op));
        putSerial(item, r.first("SN"));
        put(item, "DOI", r.first("DO"));
        put(item, "URL", r.first("LK", "UL"));
        put(item, "abstract", r.first("AB"));
        put(item, "publisher", r.first("PB"));
        put(item, "publisher-place", r.first("PP"));
        put(item, "language", language(r.first("LA")));
        thesis(item, r.first("U1", "DG", "NO"));
        return item;
    }

    // NoteExpress (.net): CNKI's "NoteExpress" export.
    private static Map<String, Object> fromNoteExpress(Record r) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("type", type(r.first("Reference Type")));
        put(item, "title", r.first("Title"));
        putNames(item, "author", r.all("Author"));
        putNames(item, "editor", r.all("Secondary Author", "Editor"));
        put(item, "container-title", r.first("Journal", "Secondary Title", "Book Title", "Conference Name"));
        putDate(item, r.first("Date"), r.first("Year"));
        put(item, "volume", r.first("Volume"));
        put(item, "issue", r.first("Issue"));
        put(item, "page", pages(r.first("Pages"), null));
        putSerial(item, r.first("ISBN/ISSN", "ISSN", "ISBN"));
        put(item, "DOI", r.first("DOI"));
        put(item, "URL", r.first("URL"));
        put(item, "abstract", r.first("Abstract"));
        put(item, "publisher", r.first("Publisher"));
        put(item, "publisher-place", r.first("Place Published"));
        put(item, "language", language(r.first("Language")));
        thesis(item, r.first("Type of Work", "Degree"));
        return item;
    }

    private static Map<String, Object> fromRIS(Record r) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("type", type(r.first("TY")));
        put(item, "title", r.first("TI", "T1"));
        putNames(item, "author", r.all("AU", "A1"));
        putNames(item, "editor", r.all("ED", "A2"));
        put(item, "container-title", r.first("JO", "JF", "T2", "JA", "BT"));
        putDate(item, r.first("DA"), r.first("PY", "Y1"));
        put(item, "volume", r.first("VL"));
        put(item, "issue", r.first("IS"));
        put(item, "page", pages(r.first("SP"), r.first("EP")));
        putSerial(item, r.first("SN"));
        put(item, "DOI", r.first("DO"));
        put(item, "URL", r.first("UR"));
        put(item, "abstract", r.first("AB", "N2"));
        put(item, "publisher", r.first("PB"));
        put(item, "publisher-place", r.first("CY"));
        put(item, "language", language(r.first("LA")));
        thesis(item, r.first("M3"));
        return item;
    }

    // ---------- BibTeX ----------

    private static List<Map<String, Object>> bibtex(String text) {
        List<Map<String, Object>> out = new ArrayList<>();
        Matcher start = Pattern.compile("@([A-Za-z]+)\\s*\\{").matcher(text);
        int from = 0;
        while (start.find(from)) {
            String kind = Text.lower(start.group(1));
            int at = start.end(), depth = 1, k = at;
            for (; k < text.length() && depth > 0; k++) {
                char c = text.charAt(k);
                if (c == '\\') k++;
                else if (c == '{') depth++;
                else if (c == '}') depth--;
            }
            from = Math.max(k, start.end());
            if (kind.equals("comment") || kind.equals("string") || kind.equals("preamble")) continue;
            Map<String, String> f = bibFields(text.substring(at, Math.max(at, k - 1)));
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("type", type(kind));
            put(item, "title", f.get("title"));
            if (f.get("author") != null) putNames(item, "author", Arrays.asList(f.get("author").split("\\s+and\\s+")));
            if (f.get("editor") != null) putNames(item, "editor", Arrays.asList(f.get("editor").split("\\s+and\\s+")));
            put(item, "container-title", f.get("journal") != null ? f.get("journal") : f.get("booktitle"));
            putDate(item, f.get("date"), f.get("year"));
            put(item, "volume", f.get("volume"));
            put(item, "issue", f.get("number"));
            put(item, "page", pages(f.get("pages"), null));
            put(item, "ISSN", f.get("issn"));
            put(item, "ISBN", f.get("isbn"));
            put(item, "DOI", f.get("doi"));
            put(item, "URL", f.get("url"));
            put(item, "abstract", f.get("abstract"));
            put(item, "publisher", f.get("publisher") != null ? f.get("publisher") : f.get("school") != null ? f.get("school") : f.get("institution"));
            put(item, "publisher-place", f.get("address"));
            put(item, "language", language(f.get("language")));
            if (kind.equals("phdthesis")) put(item, "genre", "PhD thesis");
            if (kind.equals("mastersthesis")) put(item, "genre", "Master's thesis");
            if (item.get("title") != null) out.add(item);
        }
        return out;
    }

    /** `key, name = {value}, name = "value", name = 2020` → name → plain value. */
    private static Map<String, String> bibFields(String body) {
        Map<String, String> out = new HashMap<>();
        int k = body.indexOf(',');
        if (k < 0) return out;
        k++;
        while (k < body.length()) {
            int eq = body.indexOf('=', k);
            if (eq < 0) break;
            String name = Text.lower(Text.trim(body.substring(k, eq)));
            int v = eq + 1;
            while (v < body.length() && Character.isWhitespace(body.charAt(v))) v++;
            if (v >= body.length()) break;
            int end;
            String value;
            char open = body.charAt(v);
            if (open == '{' || open == '"') {
                int depth = 0;
                end = v;
                for (; end < body.length(); end++) {
                    char c = body.charAt(end);
                    if (c == '\\') { end++; continue; }
                    if (c == '{') depth++;
                    else if (c == '}') { depth--; if (open == '{' && depth == 0) break; }
                    else if (c == '"' && open == '"' && depth == 0 && end > v) break;
                }
                value = body.substring(Math.min(v + 1, body.length()), Math.min(end, body.length()));
                end++;
            } else {
                end = v;
                while (end < body.length() && body.charAt(end) != ',') end++;
                value = body.substring(v, end);
            }
            if (name.matches("[a-z][a-z0-9_-]*")) out.put(name, untex(value));
            int comma = body.indexOf(',', Math.min(end, body.length()));
            if (comma < 0) break;
            k = comma + 1;
        }
        return out;
    }

    private static String untex(String s) {
        s = s.replaceAll("\\\\(?:textit|emph)\\s*\\{([^{}]*)\\}", "<i>$1</i>").replaceAll("\\\\textbf\\s*\\{([^{}]*)\\}", "<b>$1</b>");
        s = s.replaceAll("\\\\([&%$#_{}])", "$1").replace("--", "-").replace("~", " ");
        return Text.squash(s.replaceAll("[{}]", ""));
    }

    // ---------- GB/T 7714 reference text ----------

    private static final Pattern GBT_LINE = Pattern.compile("^\\s*(?:[\\[\\uff3b]\\d+[\\]\\uff3d]|\\d+[.\\u3001]|\\(\\d+\\))?\\s*(.*?)[.\\uff0e]\\s*(.+?)\\s*"
        + "\\[(J|D|M|C|N|P|R|S|Z|A|G|EB|DB|CP)(?:/(?:OL|CD|MT|DK))?\\]\\s*[.\\uff0e/]{0,2}\\s*(.*)$");
    private static final Pattern GBT_JOURNAL = Pattern.compile("^(.+?),\\s*(\\d{4})\\s*(?:,\\s*([^():,]+?))?\\s*(?:\\(([^)]+)\\))?\\s*(?::\\s*([^\\s.]+))?\\s*\\.?\\s*$");
    private static final Pattern GBT_NEWS = Pattern.compile("^(.+?),\\s*(\\d{4}-\\d{1,2}-\\d{1,2})\\s*(?:\\((\\w+)\\))?");
    private static final Pattern GBT_PUBLISHER = Pattern.compile("^(?:([^:,]+):\\s*)?([^:,]+?),\\s*(\\d{4})");
    private static final Pattern DOI_IN_TEXT = Pattern.compile("(?i)\\.?\\s*(?:doi\\s*[:\\uff1a]?\\s*|https?://(?:dx\\.)?doi\\.org/)(10\\.\\d{4,9}/\\S+?)[.\\s]*$");
    private static final Map<String, String> GBT_TYPES = new HashMap<>();
    static {
        String[] a = {"J", "article-journal", "D", "thesis", "M", "book", "C", "paper-conference", "N", "article-newspaper", "P", "patent",
            "R", "report", "S", "standard", "A", "chapter", "G", "book", "EB", "webpage", "DB", "dataset", "CP", "software", "Z", "article"};
        for (int k = 0; k < a.length; k += 2) GBT_TYPES.put(a[k], a[k + 1]);
    }

    /** One reference per line, as CNKI shows them: `[1]张三,李四.题名[J].刊名,2020,47(3):12-18.` */
    private static List<Map<String, Object>> gbt(String text) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (String raw : text.split("\n")) {
            String line = Text.squash(raw);
            if (line.isEmpty()) continue;
            String doi = null;
            Matcher d = DOI_IN_TEXT.matcher(line);
            if (d.find()) { doi = d.group(1); line = line.substring(0, d.start()) + "."; }
            Matcher m = GBT_LINE.matcher(line);
            if (!m.find()) continue;
            Map<String, Object> item = new LinkedHashMap<>();
            String kind = m.group(3);
            item.put("type", GBT_TYPES.getOrDefault(kind, "article-journal"));
            put(item, "title", m.group(2));
            List<String> names = new ArrayList<>();
            for (String n : m.group(1).split("[,\\uff0c;\\uff1b\\u3001]")) {
                String name = Text.trim(n);
                if (name.isEmpty() || name.equals("等") || Text.lower(name).matches("et\\.? ?al\\.?")) continue;
                names.add(name);
            }
            putNames(item, "author", names, true);
            String rest = m.group(4).replace('\uff0c', ',').replace('\uff1a', ':').replace('\uff08', '(').replace('\uff09', ')').replace('\uff0e', '.');
            Matcher j = GBT_JOURNAL.matcher(rest);
            Matcher p = GBT_PUBLISHER.matcher(rest);
            Matcher news = GBT_NEWS.matcher(rest);
            if (kind.equals("N") && news.find()) {
                put(item, "container-title", news.group(1));
                putDate(item, news.group(2));
                put(item, "page", news.group(3));
            } else if ((kind.equals("J") || kind.equals("N")) && j.find()) {
                put(item, "container-title", j.group(1));
                putDate(item, j.group(2));
                put(item, "volume", j.group(3));
                put(item, "issue", j.group(4));
                put(item, "page", pages(j.group(5), null));
            } else if (!kind.equals("J") && p.find()) {
                put(item, "publisher-place", p.group(1));
                put(item, "publisher", p.group(2));
                putDate(item, p.group(3));
                Matcher page = Pattern.compile(":\\s*(\\d[\\d+,-]*)\\s*\\.?\\s*$").matcher(rest);
                if (page.find() && (kind.equals("C") || kind.equals("A"))) put(item, "page", pages(page.group(1), null));
            } else {
                putDate(item, rest);
            }
            put(item, "DOI", doi);
            out.add(item);
        }
        return out;
    }

    // ---------- names ----------

    private static void putNames(Map<String, Object> item, String key, List<String> values) { putNames(item, key, values, false); }

    /** `familyFirst`: Western names are written "HE J" (GB/T 7714), not "John Smith". */
    private static void putNames(Map<String, Object> item, String key, List<String> values, boolean familyFirst) {
        List<Object> names = new ArrayList<>();
        for (String value : values) {
            // CNKI writes several authors in one field, separated by semicolons.
            for (String part : value.split("[;\\uff1b]")) {
                Map<String, Object> n = name(part, familyFirst);
                if (n != null) names.add(n);
            }
        }
        if (!names.isEmpty()) item.put(key, names);
    }

    /** A person from "张三", "欧阳修", "Smith, John", "John Smith" or (family first) "HE J". */
    static Map<String, Object> name(String value, boolean familyFirst) {
        String s = Text.squash(value == null ? "" : value).replaceAll("[,\\uff0c]+$", "");
        if (s.isEmpty() || s.equals("等") || Text.lower(s).matches("et\\.? ?al\\.?")) return null;
        Map<String, Object> han = Metadata.hanName(s);
        if (han != null) return han;
        if (s.contains(",") || s.contains("\uff0c")) {
            String[] parts = s.split("[,\\uff0c]", 2);
            String family = Text.trim(parts[0]), given = Text.trim(parts[1]);
            if (family.isEmpty()) return given.isEmpty() ? null : Json.obj("literal", given);
            return given.isEmpty() ? Json.obj("family", family) : Json.obj("family", family, "given", given);
        }
        String[] words = s.split(" ");
        if (words.length == 1 || Metadata.hasHan(s)) return Json.obj("literal", s);
        if (familyFirst) {
            String family = words[0].equals(words[0].toUpperCase(Locale.ROOT)) && words[0].length() > 1
                ? words[0].substring(0, 1) + words[0].substring(1).toLowerCase(Locale.ROOT) : words[0];
            return Json.obj("family", family, "given", String.join(" ", Arrays.copyOfRange(words, 1, words.length)));
        }
        return Json.obj("family", words[words.length - 1], "given", String.join(" ", Arrays.copyOfRange(words, 0, words.length - 1)));
    }
}
