package zotlet;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static zotlet.Json.arr;
import static zotlet.Json.list;

/** Word for Mac: Java owns the session; ordinary AppleScript owns the Apple events.
 * No JXA, NSAppleScript or JavaScript/Objective-C bridge is loaded in this path. */
final class WordMac implements AutoCloseable {
    interface Script { String run(String source) throws Exception; }

    private final String source;
    private final Script script;
    private final Path log;
    private String name, path;
    private List<Object> original;
    private int story, start, end;
    private boolean prepared, finished;
    private final Map<String, String> codes = new HashMap<>();
    private final Map<String, Field> fields = new HashMap<>();
    private static final Pattern FIELD = Pattern.compile("F([0-2]):([1-9][0-9]*)");
    private static final List<List<String>> BUTTONS = Arrays.asList(Arrays.asList("OK"), Arrays.asList("Cancel", "OK"),
        Arrays.asList("No", "Yes"), Arrays.asList("Cancel", "No", "Yes"));

    WordMac(Path wordDir, Path dataDir) throws IOException {
        this(Files.readString(wordDir.resolve("word-mac.applescript"), StandardCharsets.UTF_8), WordMac::osascript,
            dataDir == null ? null : dataDir.resolve("word.log"));
    }

    WordMac(String source, Script script, Path log) { this.source = source; this.script = script; this.log = log; }

    private void log(String line) {
        if (log == null) return;
        try {
            Files.createDirectories(log.toAbsolutePath().getParent());
            Files.writeString(log, java.time.Instant.now() + "  " + line + "\n", StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) { /* only a log */ }
    }

    private Object execute(String handler, List<Object> args) throws Exception {
        List<String> values = new ArrayList<>();
        for (Object arg : args) values.add(literal(arg));
        String call = handler + "(" + String.join(", ", values) + ")";
        try {
            return parseResult(script.run(source + "\nwith timeout of 600 seconds\nreturn " + call + "\nend timeout\n"));
        } catch (Exception e) {
            // Do not write document contents, clipboard data or field codes into the log.
            log(handler + " failed: " + e.getMessage());
            throw new IOException("Word AppleScript (" + handler + "): " + e.getMessage(), e);
        }
    }

    private Object word(String handler, Object... args) throws Exception {
        if (original == null) throw new IOException("The Word document session has not started");
        if (finished) throw new IOException("The Word document session has finished");
        List<Object> all = arr(name, path);
        all.addAll(Arrays.asList(args));
        return execute(handler, all);
    }

    private Object init() throws Exception {
        if (original != null) throw new IOException("The Word document session has already started");
        List<Object> r = tuple(execute("zInit", arr()), 9, "Word document");
        name = string(r.get(0)); path = string(r.get(1));
        for (int i = 2; i <= 5; i++) if (!(r.get(i) instanceof Boolean)) throw new IOException("Invalid Word view settings");
        story = number(r.get(6)); start = number(r.get(7)); end = number(r.get(8));
        if (story < 0 || story > 2 || start < 0 || end < start) throw new IOException("Invalid Word selection");
        original = r; // Remember the settings before the first mutation, even if zBegin fails.
        word("zBegin");
        log("init Word document (AppleScript)");
        return name;
    }

    Object call(String method, List<Object> a) throws Exception {
        switch (method) {
            case "init": return init();
            case "Document.getDocumentData": return getProperty("ZOTERO_PREF");
            case "Document.setDocumentData": setProperty("ZOTERO_PREF", string(a.get(0))); return null;
            case "Document.getFields": return getFields(string(a.get(0)));
            case "Document.cursorInField": return cursor(string(a.get(0)));
            case "Document.insertField": return insert(string(a.get(0)));
            case "Document.setBibliographyStyle":
                List<Object> tabs = new ArrayList<>();
                if (a.get(4) != null) for (Object tab : list(a.get(4))) tabs.add(points(tab));
                word("zBibliographyStyle", points(a.get(0)), points(a.get(1)), points(a.get(2)), points(a.get(3)), tabs);
                return null;
            case "Document.displayAlert":
                int icon = number(a.get(1)), buttons = number(a.get(2));
                List<String> labels = BUTTONS.get(buttons < 0 || buttons >= BUTTONS.size() ? 0 : buttons);
                Object pressed;
                try {
                    pressed = word("zAlert", string(a.get(0)), new Raw(icon == 1 ? "informational" : icon == 2 ? "warning" : "critical"), labels);
                } catch (IOException e) {
                    // Standard Additions raises -128 for Escape/the Cancel button.
                    if (e.getMessage().contains("(-128)") && labels.contains("Cancel")) return (long) labels.indexOf("Cancel");
                    throw e;
                }
                int answer = labels.indexOf(string(pressed));
                if (answer < 0) throw new IOException("Unexpected Word dialog answer");
                return (long) answer;
            case "Document.activate": word("zActivate"); return null;
            case "Document.complete": complete(); return null;
            case "Field.setCode":
                String id = string(a.get(0)), code = string(a.get(1));
                if (bookmark(id)) setProperty(mark(id), "ZOTERO_" + code + " ");
                else { Field f = field(id); word("zSetCode", f.story, f.index, " ADDIN ZOTERO_" + code + " "); }
                codes.put(id, code);
                return null;
            case "Field.getText":
                List<Object> get = rangeArgs(string(a.get(0)));
                return string(word("zGetText", get.toArray()));
            case "Field.setText":
                id = string(a.get(0));
                String text = string(a.get(1));
                boolean rich = Json.truthy(a.get(2));
                List<Object> args = rangeArgs(id);
                args.add(rich ? rtf(text) : text); args.add(rich);
                args.add(rich && codes.getOrDefault(id, "").startsWith("BIBL"));
                word("zSetText", args.toArray());
                return null;
            case "Field.select": word("zSelect", rangeArgs(string(a.get(0))).toArray()); return null;
            case "Field.removeCode": remove(string(a.get(0)), false); return null;
            case "Field.delete": remove(string(a.get(0)), true); return null;
            default: throw new IOException("Unknown Word method " + method);
        }
    }

    private static double points(Object n) throws IOException {
        if (!(n instanceof Number) || !Double.isFinite(((Number) n).doubleValue())) throw new IOException("Invalid Word paragraph setting");
        return ((Number) n).doubleValue() / 20.0;
    }

    private String getProperty(String key) throws Exception { return string(word("zGetProperty", key)); }

    private void setProperty(String key, String value) throws Exception {
        List<String> chunks = new ArrayList<>();
        // Word's custom property limit is 255 UTF-16 units; never split a surrogate pair.
        for (int i = 0; i < value.length();) {
            int j = Math.min(i + 255, value.length());
            if (j < value.length() && Character.isHighSurrogate(value.charAt(j - 1))) j--;
            chunks.add(value.substring(i, j)); i = j;
        }
        word("zSetProperty", key, chunks);
    }

    private void prepare() throws Exception {
        if (!prepared) { word("zPrepare"); prepared = true; }
    }

    private static final class Field {
        final int story; int index;
        Field(int story, int index) { this.story = story; this.index = index; }
    }

    private Field field(String id) throws IOException {
        Field f = fields.get(id);
        if (f != null) {
            if (f.index < 1) throw new IOException("The Word field has already been removed");
            return f;
        }
        Matcher m = FIELD.matcher(id);
        if (!m.matches()) throw new IOException("Unknown Word field " + id);
        try { f = new Field(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2))); }
        catch (NumberFormatException e) { throw new IOException("Invalid Word field index", e); }
        fields.put(id, f);
        return f;
    }

    private static boolean bookmark(String id) { return id.startsWith("B:"); }
    private static String mark(String id) throws IOException {
        String name = id.substring(2);
        if (!name.matches("ZOTERO_[A-Za-z0-9_]{1,33}")) throw new IOException("Unknown Word bookmark");
        return name;
    }

    private List<Object> rangeArgs(String id) throws IOException {
        if (bookmark(id)) return arr(0L, 0L, mark(id));
        Field f = field(id);
        return arr(f.story, f.index, "");
    }

    private static final class Row {
        final String id, code; final int pos, notePos, note;
        Row(String id, String code, int pos, int notePos, int note) { this.id = id; this.code = code; this.pos = pos; this.notePos = notePos; this.note = note; }
    }

    private Object getFields(String type) throws Exception {
        prepare();
        List<Row> rows = new ArrayList<>();
        fields.clear();
        if ("Bookmark".equals(type)) {
            for (Object value : tuple(word("zBookmarks"), -1, "Word bookmarks")) {
                List<Object> r = tuple(value, 2, "Word bookmark");
                String name = string(r.get(0)), code = stripBookmarkCode(getProperty(name));
                if (code != null) rows.add(new Row("B:" + name, code, number(r.get(1)), 0, 0));
            }
        } else {
            for (int kind = 0; kind < 3; kind++) for (Object value : tuple(word("zStoryFields", kind), -1, "Word fields")) {
                List<Object> r = tuple(value, 4, "Word field");
                String code = stripFieldCode(string(r.get(1)));
                if (code == null) continue;
                String id = "F" + kind + ":" + number(r.get(0));
                fields.put(id, new Field(kind, number(r.get(0))));
                rows.add(new Row(id, code, number(r.get(2)), kind == 0 ? 0 : number(r.get(3)), kind == 0 ? 0 : 1));
            }
        }
        rows.sort(Comparator.comparingInt((Row r) -> r.pos).thenComparingInt(r -> r.notePos));
        List<Object> ids = arr(), values = arr(), notes = arr();
        for (Row row : rows) { ids.add(row.id); values.add(row.code); notes.add((long) row.note); codes.put(row.id, row.code); }
        return arr(ids, values, notes);
    }

    private Object cursor(String type) throws Exception {
        prepare();
        if ("Bookmark".equals(type)) {
            if (story != 0) return null;
            String name = string(word("zCursorBookmark", start, end));
            if (name.isEmpty()) return null;
            String code = stripBookmarkCode(getProperty(name));
            if (code == null) return null;
            codes.put("B:" + name, code);
            return arr("B:" + name, code, 0L);
        }
        List<Object> r = tuple(word("zCursor", story, start, end), -1, "Word cursor");
        if (r.isEmpty()) return null;
        r = tuple(r, 2, "Word cursor field");
        String code = stripFieldCode(string(r.get(1)));
        if (code == null) return null;
        String id = "F" + story + ":" + number(r.get(0));
        field(id); codes.put(id, code);
        return arr(id, code, story == 0 ? 0L : 1L);
    }

    private Object insert(String type) throws Exception {
        if ("Bookmark".equals(type)) {
            if (story != 0) throw new IOException("Bookmark citations must be inserted in the main document text");
            String name = "ZOTERO_BREF_" + UUID.randomUUID().toString().replace("-", "").substring(0, 24);
            word("zInsertBookmark", name, start, end);
            codes.put("B:" + name, "");
            return arr("B:" + name, "", 0L);
        }
        int index = number(word("zInsert", story, start, end));
        if (index < 1) throw new IOException("Invalid new Word field index");
        String id = "F" + story + ":" + index;
        fields.put(id, new Field(story, index)); codes.put(id, "TEMP");
        return arr(id, "TEMP", story == 0 ? 0L : 1L);
    }

    private void remove(String id, boolean delete) throws Exception {
        List<Object> args = rangeArgs(id); args.add(delete);
        word("zRemove", args.toArray());
        if (bookmark(id)) setProperty(mark(id), "");
        else {
            Field removed = field(id);
            int index = removed.index;
            // Unlink/delete shrinks Word's field collection. Keep the remaining session handles valid,
            // including when unrelated Word fields occur between two Zotero fields.
            for (Field f : fields.values()) if (f.story == removed.story && f.index > index) f.index--;
            removed.index = 0;
        }
        codes.remove(id);
    }

    private void complete() throws Exception {
        if (original == null || finished) return;
        word("zComplete", original.get(2), original.get(3), original.get(4), original.get(5));
        finished = true;
    }

    @Override public void close() throws Exception { complete(); }

    static String stripFieldCode(String raw) {
        for (String prefix : Arrays.asList(" ADDIN ZOTERO_", " CSL_")) {
            int i = raw.indexOf(prefix);
            if (i >= 0) return stripSpace(raw.substring(i + prefix.length()));
        }
        return null;
    }
    static String stripBookmarkCode(String raw) {
        for (String prefix : Arrays.asList("ZOTERO_", "CSL_")) if (raw.startsWith(prefix)) return stripSpace(raw.substring(prefix.length()));
        return null;
    }
    private static String stripSpace(String s) { return s.endsWith(" ") ? s.substring(0, s.length() - 1) : s; }
    private static String string(Object o) throws IOException {
        if (o == null) return "";
        if (!(o instanceof String)) throw new IOException("Expected Word text, got " + Json.stringify(o));
        return (String) o;
    }
    private static int number(Object o) throws IOException {
        if (!(o instanceof Number)) throw new IOException("Expected a Word integer");
        double n = ((Number) o).doubleValue();
        if (!Double.isFinite(n) || n != Math.rint(n) || n < Integer.MIN_VALUE || n > Integer.MAX_VALUE) throw new IOException("Invalid Word integer");
        return (int) n;
    }
    private static List<Object> tuple(Object o, int size, String what) throws IOException {
        if (!(o instanceof List) || (size >= 0 && list(o).size() != size)) throw new IOException("Invalid " + what + " result");
        return list(o);
    }

    private static final class Raw {
        final String value;
        Raw(String value) { this.value = value; }
    }
    private static Raw rtf(String text) {
        char[] hex = "0123456789ABCDEF".toCharArray();
        StringBuilder out = new StringBuilder("«data RTF ");
        for (byte b : text.getBytes(StandardCharsets.UTF_8)) { out.append(hex[(b & 255) >> 4]); out.append(hex[b & 15]); }
        return new Raw(out.append('»').toString());
    }

    static String literal(Object value) throws IOException {
        if (value == null) return "missing value";
        if (value instanceof Raw) return ((Raw) value).value;
        if (value instanceof String) return "\"" + ((String) value).replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\r", "\\r").replace("\n", "\\n").replace("\t", "\\t") + "\"";
        if (value instanceof Boolean) return value.toString();
        if (value instanceof Number && Double.isFinite(((Number) value).doubleValue())) return Json.stringify(value);
        if (value instanceof List) {
            List<String> parts = new ArrayList<>();
            for (Object item : (List<?>) value) parts.add(literal(item));
            return "{" + String.join(", ", parts) + "}";
        }
        throw new IOException("Unsupported AppleScript argument");
    }

    /** osascript -s s returns source-form strings/lists, so commas/newlines in field JSON are safe.
     * Parse data only; never evaluate an osascript response as code. */
    static Object parseResult(String text) throws IOException { return new Result(text).parse(); }
    private static final class Result {
        final String s; int p;
        Result(String s) { this.s = s; }
        void ws() { while (p < s.length() && Character.isWhitespace(s.charAt(p))) p++; }
        IOException bad() { return new IOException("Invalid AppleScript result at character " + p); }
        Object parse() throws IOException {
            ws(); if (p == s.length()) return null;
            Object value = value(0); ws(); if (p != s.length()) throw bad();
            return value;
        }
        Object value(int depth) throws IOException {
            ws(); if (depth > 32 || p >= s.length()) throw bad();
            char c = s.charAt(p++);
            if (c == '{') {
                List<Object> values = arr(); ws();
                if (p < s.length() && s.charAt(p) == '}') { p++; return values; }
                for (;;) {
                    values.add(value(depth + 1)); ws(); if (p >= s.length()) throw bad();
                    c = s.charAt(p++); if (c == '}') return values; if (c != ',') throw bad();
                }
            }
            if (c == '"') {
                StringBuilder out = new StringBuilder();
                while (p < s.length()) {
                    c = s.charAt(p++); if (c == '"') return out.toString();
                    if (c == '\\') {
                        if (p >= s.length()) throw bad();
                        c = s.charAt(p++);
                        switch (c) {
                            case 'n': c = '\n'; break;
                            case 'r': c = '\r'; break;
                            case 't': c = '\t'; break;
                            case '\\': case '"': break;
                            default: throw bad();
                        }
                    }
                    out.append(c);
                }
                throw bad();
            }
            int begin = --p;
            while (p < s.length() && s.charAt(p) != ',' && s.charAt(p) != '}') p++;
            String token = s.substring(begin, p).trim();
            switch (token) {
                case "missing value": return null;
                case "true": return true;
                case "false": return false;
                default:
                    if (!token.matches("-?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?")) throw bad();
                    try {
                        if (!token.contains(".") && !token.toLowerCase(java.util.Locale.ROOT).contains("e")) return Long.parseLong(token);
                        double n = Double.parseDouble(token); if (!Double.isFinite(n)) throw bad(); return n;
                    } catch (NumberFormatException e) { throw bad(); }
            }
        }
    }

    private static CompletableFuture<String> drain(InputStream in) {
        return CompletableFuture.supplyAsync(() -> {
            try (InputStream stream = in) { return new String(Net.readAll(stream, 16 * 1024 * 1024), StandardCharsets.UTF_8); }
            catch (IOException e) { throw new java.util.concurrent.CompletionException(e); }
        }, Proc.POOL);
    }

    private static String osascript(String source) throws Exception {
        // An executable override lets the tests exercise this path without a Mac or Word.
        String executable = System.getenv("ZOTLET_WORD_OSASCRIPT");
        if (executable == null || executable.isEmpty()) executable = "/usr/bin/osascript";
        Process process = new ProcessBuilder(executable, "-l", "AppleScript", "-s", "s", "-").start();
        CompletableFuture<String> out = drain(process.getInputStream()), err = drain(process.getErrorStream());
        try {
            try (java.io.OutputStream input = process.getOutputStream()) { input.write(source.getBytes(StandardCharsets.UTF_8)); }
            if (!process.waitFor(610, TimeUnit.SECONDS)) throw new IOException("osascript timed out; click the Word button to retry");
            String stdout = out.get(), stderr = err.get().trim();
            if (process.exitValue() != 0) throw new IOException("osascript exited " + process.exitValue() + (stderr.isEmpty() ? "" : ": " + stderr));
            return stdout;
        } finally {
            if (process.isAlive()) process.destroyForcibly();
        }
    }
}
