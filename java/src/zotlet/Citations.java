package zotlet;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.Collator;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Citation styles and formatting with citeproc-js (port of src/citations.js). */
public final class Citations {
    public final Path builtinDir, userDir;
    public final Js js;
    /** A second citeproc, so the plain-text pass of a document refresh runs at the same time as the formatted one. */
    public final Js plainJs;
    private final Map<String, String> engineKeys = new HashMap<>(); // purpose|file → key of the cached engine

    public Citations(Home home, Path userDir) {
        this.builtinDir = home.styles;
        this.userDir = userDir;
        this.js = new Js(home.citeproc, home.locale);
        this.plainJs = new Js(home.citeproc, home.locale);
    }

    // Order of the style menu; anything else follows alphabetically.
    private static final List<String> PREFERRED = Arrays.asList("nature", "science", "cell", "gb-t-7714-2015-numeric-bilingual", "gb-t-7714-2015-author-date-bilingual", "pnas", "the-lancet", "plos", "apa", "chicago-author-date",
        "harvard-cite-them-right", "elsevier-harvard", "american-medical-association", "nlm-citation-sequence", "ieee");
    private static final Map<String, String> LABELS = new HashMap<>();
    static {
        String[] a = {"nature", "Nature", "science", "Science", "cell", "Cell",
            "gb-t-7714-2015-numeric-bilingual", "GB/T 7714 (\u987a\u5e8f\u7f16\u7801)", "gb-t-7714-2015-author-date-bilingual", "GB/T 7714 (\u8457\u8005-\u51fa\u7248\u5e74)", "pnas", "PNAS", "the-lancet", "The Lancet", "plos", "PLOS",
            "apa", "APA 7th", "chicago-author-date", "Chicago (author-date)", "harvard-cite-them-right", "Harvard",
            "elsevier-harvard", "Elsevier Harvard", "american-medical-association", "AMA", "nlm-citation-sequence", "Vancouver", "ieee", "IEEE"};
        for (int k = 0; k < a.length; k += 2) LABELS.put(a[k], a[k + 1]);
    }
    public static final Pattern SAFE_ID = Pattern.compile("^[a-z0-9][a-z0-9_-]{0,119}$", Pattern.CASE_INSENSITIVE);

    static String decode(String s) {
        return s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'");
    }

    /** What the <info> block of a CSL style says. `parent` is set for dependent styles. */
    public static final class Info {
        public String title, uri, parent, format;
    }

    private static final Pattern STYLE_TAG = Pattern.compile("<style\\b[^>]*xmlns=\"http://purl\\.org/net/xbiblio/csl\"");
    private static final Pattern INFO = Pattern.compile("<info>([\\s\\S]*?)</info>");
    private static final Pattern TITLE = Pattern.compile("<info>[\\s\\S]*?<title>([^<]+)</title>");
    private static final Pattern ID = Pattern.compile("<id>([^<]+)</id>");
    private static final Pattern LINK = Pattern.compile("<link\\b[^>]*>");
    private static final Pattern HREF = Pattern.compile("\\bhref=\"([^\"]+)\"");
    private static final Pattern FORMAT = Pattern.compile("<category\\b[^>]*citation-format=\"([^\"]+)\"");

    public static Info styleInfo(String xml) {
        if (xml == null || !STYLE_TAG.matcher(xml).find()) return null;
        Matcher im = INFO.matcher(xml);
        String info = im.find() ? im.group(1) : "";
        Info out = new Info();
        Matcher t = TITLE.matcher(xml);
        out.title = t.find() ? decode(Text.trim(t.group(1))) : null;
        Matcher id = ID.matcher(info);
        if (id.find()) { String u = Text.trim(id.group(1)); out.uri = u.isEmpty() ? null : decode(u); }
        Matcher link = LINK.matcher(info);
        while (link.find()) {
            String l = link.group();
            if (l.matches("(?s).*\\brel=\"independent-parent\".*")) {
                Matcher h = HREF.matcher(l);
                String p = decode(h.find() ? h.group(1) : "");
                out.parent = p.isEmpty() ? null : p;
            }
        }
        Matcher f = FORMAT.matcher(info);
        out.format = f.find() ? f.group(1) : null;
        return out;
    }

    public static String styleIdFromURI(Object uri) {
        String s = uri == null ? "" : Json.jsString(uri);
        s = s.replaceAll("[?#].*$", "").replaceAll("/+$", "");
        int k = s.lastIndexOf('/');
        return k < 0 ? s : s.substring(k + 1);
    }

    /** An installed style. `file` is what to render with (a dependent style's parent), `path` its own file. */
    public static final class Style {
        public String id, title, label, uri, format, parent;
        public Path file, path;
        public boolean builtin;

        Style copy() {
            Style s = new Style();
            s.id = id; s.title = title; s.label = label; s.uri = uri; s.format = format; s.parent = parent;
            s.file = file; s.path = path; s.builtin = builtin;
            return s;
        }

        public Map<String, Object> listEntry() {
            return Json.obj("id", id, "title", title, "label", label, "builtin", builtin, "parent", parent, "format", format);
        }
    }

    private static final Collator COLLATOR = Collator.getInstance(Locale.ENGLISH);

    /**
     * Installed styles: bundled ones first, then ~/.zotlet/styles. Dependents whose parent is not
     * installed are left out.
     */
    public List<Style> listStyles() {
        Map<String, Style> found = new LinkedHashMap<>();
        List<Style> dependents = new ArrayList<>();
        for (Path dir : new Path[]{builtinDir, userDir}) {
            if (dir == null) continue;
            List<String> names = new ArrayList<>();
            try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
                for (Path p : ds) names.add(p.getFileName().toString());
            } catch (IOException e) { continue; }
            java.util.Collections.sort(names); // readdir order is not defined; Node's is usually sorted
            for (String name : names) {
                if (!name.endsWith(".csl")) continue;
                String id = name.substring(0, name.length() - 4);
                if (!SAFE_ID.matcher(id).matches() || found.containsKey(id) || dependents.stream().anyMatch(d -> d.id.equals(id))) continue;
                Path file = dir.resolve(name);
                try {
                    Info info = styleInfo(new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
                    if (info == null) continue;
                    Style s = new Style();
                    s.id = id;
                    s.title = info.title != null && !info.title.isEmpty() ? info.title : id;
                    s.label = LABELS.getOrDefault(id, s.title);
                    s.file = file;
                    s.path = file;
                    s.builtin = dir == builtinDir;
                    s.uri = info.uri != null ? info.uri : "http://www.zotero.org/styles/" + id;
                    s.format = info.format;
                    if (info.parent != null) { s.parent = info.parent; dependents.add(s); }
                    else found.put(id, s);
                } catch (IOException e) { /* unreadable style: skip */ }
            }
        }
        for (Style dep : dependents) {
            Style parent = found.get(styleIdFromURI(dep.parent));
            if (parent == null) for (Style s : found.values()) if (s.uri.equals(dep.parent)) { parent = s; break; }
            if (parent != null) {
                Style s = dep.copy();
                s.file = parent.file;
                s.parent = parent.id;
                s.format = dep.format != null ? dep.format : parent.format;
                found.put(dep.id, s);
            }
        }
        List<Style> out = new ArrayList<>(found.values());
        out.sort((a, b) -> {
            int r = Integer.compare(rank(a.id), rank(b.id));
            return r != 0 ? r : COLLATOR.compare(a.title, b.title);
        });
        return out;
    }

    private static int rank(String id) {
        int k = PREFERRED.indexOf(id);
        return k < 0 ? PREFERRED.size() : k;
    }

    public Style find(String id) {
        for (Style s : listStyles()) if (s.id.equals(id)) return s;
        return null;
    }

    public List<Object> styleList() {
        List<Object> out = new ArrayList<>();
        for (Style s : listStyles()) out.add(s.listEntry());
        return out;
    }

    /** The cache key of the engine for this file; an engine for an older version of the file is dropped. */
    private synchronized String engineKey(String purpose, Path file) throws IOException {
        String stamp = Files.getLastModifiedTime(file).toMillis() + ":" + Files.size(file);
        String slot = purpose + "|" + file.toAbsolutePath();
        String key = slot + "|" + stamp;
        String old = engineKeys.put(slot, key);
        if (old != null && !old.equals(key)) { js.call("zlForget", old); plainJs.call("zlForget", old); }
        return key;
    }

    private static String read(Path file) throws IOException {
        return new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
    }

    /**
     * Format `items` (in that order) with the style `styleId`.
     * Returns { style, citation: {html, text}, bibliography: {html, text, entries} }.
     */
    public Map<String, Object> formatCitations(String styleId, List<Map<String, Object>> items) throws IOException {
        Style style = find(styleId);
        if (style == null) throw new UserError("Unknown citation style \"" + styleId + "\"");
        if (items.isEmpty()) throw new UserError("No references to format");
        String result = js.call("zlFormat", engineKey("format", style.file), read(style.file), Json.stringify(items));
        Map<String, Object> out = Json.obj("style", Json.obj("id", style.id, "title", style.title));
        out.putAll(Json.map(Json.parse(result)));
        return out;
    }

    /**
     * rebuildProcessorState for the word processor integration, in `mode` and as plain text (both
     * at once, on two citeproc instances): [[{ citationID: text }, bibliography | false], [{ citationID: plain text }, …]].
     */
    public List<List<Object>> render(Path file, Collection items, List<Object> citations, String mode) throws IOException {
        String key = engineKey("render", file), xml = read(file), itemsJson = Json.stringify(new ArrayList<>(items.values)), citationsJson = Json.stringify(citations);
        java.util.concurrent.CompletableFuture<String> plain = java.util.concurrent.CompletableFuture.supplyAsync(
            () -> plainJs.call("zlRender", key, xml, itemsJson, citationsJson, "text"), Proc.POOL);
        String formatted = js.call("zlRender", key, xml, itemsJson, citationsJson, mode);
        String text;
        try { text = plain.join(); }
        catch (java.util.concurrent.CompletionException e) { throw e.getCause() instanceof RuntimeException ? (RuntimeException) e.getCause() : e; }
        List<List<Object>> out = new ArrayList<>();
        out.add(Json.list(Json.parse(formatted)));
        out.add(Json.list(Json.parse(text)));
        return out;
    }

    /** Items by id, as the integration collects them. */
    public static final class Collection {
        final Map<String, Object> byId = new LinkedHashMap<>();
        final java.util.Collection<Object> values = byId.values();
        public void put(String id, Object item) { byId.put(id, item); }
    }

    /** Check that citeproc can read a style (throws with citeproc's message). */
    public void check(String xml) {
        js.call("zlCheck", xml);
    }

    /** The style ids to prepare at start: the default style and the user's two most recently installed ones. */
    List<Style> warmStyles() {
        List<Style> all = listStyles(), out = new ArrayList<>();
        for (Style s : all) if (s.id.equals("nature")) out.add(s);
        List<Style> user = new ArrayList<>();
        for (Style s : all) if (!s.builtin && s.parent == null) user.add(s);
        user.sort((a, b) -> {
            try { return Files.getLastModifiedTime(b.path).compareTo(Files.getLastModifiedTime(a.path)); } catch (IOException e) { return 0; }
        });
        for (Style s : user.subList(0, Math.min(2, user.size()))) out.add(s);
        return out;
    }

    /**
     * Load citeproc and build engines in the background, so the first citation does not wait for
     * them (building one takes seconds for a large style such as APA).
     */
    public void warm() {
        js.warm();
        plainJs.warm();
        Thread t = new Thread(() -> {
            for (Style s : warmStyles()) {
                try {
                    String xml = read(s.file), render = engineKey("render", s.file);
                    java.util.concurrent.CompletableFuture<String> other = java.util.concurrent.CompletableFuture.supplyAsync(() -> plainJs.call("zlPrepare", render, xml), Proc.POOL);
                    js.call("zlPrepare", render, xml);
                    other.join();
                } catch (Throwable e) { /* reported on first real use */ }
            }
        }, "zotlet-warm");
        t.setDaemon(true);
        t.setPriority(Thread.MIN_PRIORITY);
        t.start();
    }
}
