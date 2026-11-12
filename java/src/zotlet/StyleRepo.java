package zotlet;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.text.Collator;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

import static zotlet.Json.list;
import static zotlet.Json.map;

/**
 * Citation style repository, like Zotero's "Get additional styles…" (port of src/style-repo.js).
 * The index is Zotero's list of the ~10,000 styles in the official CSL repository. Styles are
 * downloaded from zotero.org (falling back to the CSL repository on GitHub) into ~/.zotlet/styles.
 * A dependent (journal) style needs its parent style, which is installed along with it.
 */
public final class StyleRepo {
    public static final String INDEX_URL = "https://www.zotero.org/styles-files/styles.json";
    private static final long INDEX_MAX_AGE = 24L * 60 * 60 * 1000;
    private static final int MAX_STYLE_BYTES = 1_000_000;

    private final Citations citations;
    private final Path userDir, cacheFile;
    private final Net.Fetcher fetch;
    private final LongSupplier now;
    private Map<String, Object> cached; // { at, entries }

    public StyleRepo(Citations citations, Path cacheFile, Net.Fetcher fetch) {
        this.citations = citations;
        this.userDir = citations.userDir;
        this.cacheFile = cacheFile;
        this.fetch = fetch;
        this.now = System::currentTimeMillis;
    }

    private static List<String> styleURLs(String name) {
        return Arrays.asList("https://www.zotero.org/styles/" + name,
            "https://raw.githubusercontent.com/citation-style-language/styles/master/" + name + ".csl",
            "https://raw.githubusercontent.com/citation-style-language/styles/master/dependent/" + name + ".csl");
    }

    /** Reduce one entry of Zotero's styles.json to what the UI needs. */
    static Map<String, Object> indexEntry(Object rawValue) {
        Map<String, Object> raw = map(rawValue);
        if (raw == null) return null;
        String name = raw.get("name") instanceof String ? (String) raw.get("name") : Citations.styleIdFromURI(raw.get("href"));
        if (name == null || !Citations.SAFE_ID.matcher(name).matches() || !(raw.get("title") instanceof String)) return null;
        Map<String, Object> categories = map(raw.get("categories")) != null ? map(raw.get("categories")) : new HashMap<>();
        List<Object> fields = new ArrayList<>();
        if (categories.get("fields") instanceof List) for (Object f : list(categories.get("fields"))) if (f instanceof String) fields.add(f);
        Object dep = raw.get("dependent");
        double d = dep instanceof Number ? ((Number) dep).doubleValue() : dep instanceof String ? orZero(Metadata.jsNumber(Text.trim((String) dep))) : dep instanceof Boolean && (Boolean) dep ? 1 : 0;
        String updated = raw.get("updated") instanceof String ? (String) raw.get("updated") : "";
        return Json.obj("name", name, "title", Text.trim((String) raw.get("title")),
            "titleShort", raw.get("titleShort") instanceof String ? raw.get("titleShort") : "",
            "dependent", d != 0 && !Double.isNaN(d),
            "format", categories.get("format") instanceof String ? categories.get("format") : "",
            "fields", fields,
            "updated", updated.length() > 10 ? updated.substring(0, 10) : updated);
    }

    private static double orZero(Double d) { return d == null ? Double.NaN : d; }

    private static final Pattern DOCTYPE = Pattern.compile("<!DOCTYPE|<!ENTITY", Pattern.CASE_INSENSITIVE);

    /** Check that `xml` is a usable CSL style. Returns its info. */
    public Citations.Info validateStyle(Object xmlValue) {
        if (!(xmlValue instanceof String) || Text.trim((String) xmlValue).isEmpty()) throw new UserError("The file is empty");
        String xml = (String) xmlValue;
        if (xml.getBytes(StandardCharsets.UTF_8).length > MAX_STYLE_BYTES) throw new UserError("The style file is too large");
        if (DOCTYPE.matcher(xml).find()) throw new UserError("Style files with a DOCTYPE are not supported");
        Citations.Info info = Citations.styleInfo(xml);
        if (info == null) throw new UserError("This is not a CSL style (.csl) file");
        if (info.parent == null) {
            if (!xml.matches("(?s).*<citation\\b.*")) throw new UserError("This style has no <citation> section");
            try { citations.check(xml); } catch (RuntimeException e) { throw new UserError("citeproc cannot read this style: " + e.getMessage()); }
        }
        return info;
    }

    private Net.Response get(String url) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Accept", "application/json, application/vnd.citationstyles.style+xml, text/xml, */*");
        try { return fetch.get(url, h); }
        catch (Net.NetError e) { throw new UserError("Cannot reach " + Net.host(url) + " (" + e.code + ")", 502); }
    }

    /** The style list, from memory, the network, or (offline) the last saved copy. */
    @SuppressWarnings("unchecked")
    public synchronized List<Map<String, Object>> index(boolean refresh) {
        if (!refresh && cached != null && now.getAsLong() - ((Number) cached.get("at")).longValue() < INDEX_MAX_AGE) return (List<Map<String, Object>>) cached.get("entries");
        Map<String, Object> disk = null;
        try { disk = map(Json.parse(new String(Files.readAllBytes(cacheFile), StandardCharsets.UTF_8))); } catch (Exception e) { /* no cache yet */ }
        if (!refresh && disk != null && disk.get("at") instanceof Number && now.getAsLong() - ((Number) disk.get("at")).longValue() < INDEX_MAX_AGE && disk.get("entries") instanceof List) {
            cached = disk;
            return (List<Map<String, Object>>) cached.get("entries");
        }
        try {
            Net.Response res = get(INDEX_URL);
            if (!res.ok()) throw new UserError("The style list could not be downloaded (HTTP " + res.status + ")", 502);
            Object raw;
            try { raw = Json.parse(res.text()); } catch (Json.ParseException e) { throw new UserError("The style list has an unexpected format", 502); }
            if (!(raw instanceof List)) throw new UserError("The style list has an unexpected format", 502);
            List<Object> entries = new ArrayList<>();
            for (Object o : list(raw)) { Map<String, Object> e = indexEntry(o); if (e != null) entries.add(e); }
            cached = Json.obj("at", now.getAsLong(), "entries", entries);
            try { Store.writeAtomic(cacheFile, Json.stringify(cached).getBytes(StandardCharsets.UTF_8), false); } catch (IOException e) { /* cache only */ }
            return (List<Map<String, Object>>) (List<?>) entries;
        } catch (UserError error) {
            if (disk != null && disk.get("entries") instanceof List) {
                cached = Json.obj("at", now.getAsLong(), "entries", disk.get("entries"));
                return (List<Map<String, Object>>) disk.get("entries");
            }
            throw error;
        }
    }

    private static final Collator COLLATOR = Collator.getInstance(Locale.ENGLISH);

    public Map<String, Object> search(String query, boolean refresh) {
        int limit = 80;
        List<Map<String, Object>> entries = index(refresh);
        Map<String, Citations.Style> installed = new HashMap<>();
        for (Citations.Style s : citations.listStyles()) installed.put(s.id, s);
        List<String> words = new ArrayList<>();
        for (String w : Text.lower(query).split(Text.WS + "+")) if (!w.isEmpty()) words.add(w);
        String q = String.join(" ", words);
        List<Object[]> hits = new ArrayList<>();
        for (Map<String, Object> e : entries) {
            String title = String.valueOf(e.get("title")), name = String.valueOf(e.get("name")), shortTitle = String.valueOf(e.get("titleShort"));
            List<Object> fields = list(e.get("fields"));
            StringBuilder hay = new StringBuilder(title).append(' ').append(shortTitle).append(' ').append(name).append(' ');
            if (fields != null) hay.append(String.join(" ", fields.stream().map(String::valueOf).toArray(String[]::new)));
            hay.append(' ').append(String.valueOf(e.get("format")));
            String h = Text.lower(hay.toString());
            boolean all = true;
            for (String w : words) all &= h.contains(w);
            if (!all) continue;
            String t = Text.lower(title);
            boolean dependent = Boolean.TRUE.equals(e.get("dependent"));
            // Exact and prefix title matches first, then independent styles before journal styles.
            int score = q.isEmpty() ? (dependent ? 1 : 0)
                : t.equals(q) || name.equals(q) || Text.lower(shortTitle).equals(q) ? 0 : t.startsWith(q) ? 1 : dependent ? 3 : 2;
            hits.add(new Object[]{score, e});
        }
        hits.sort((a, b) -> {
            int r = Integer.compare((Integer) a[0], (Integer) b[0]);
            return r != 0 ? r : COLLATOR.compare(String.valueOf(((Map<?, ?>) a[1]).get("title")), String.valueOf(((Map<?, ?>) b[1]).get("title")));
        });
        List<Object> results = new ArrayList<>();
        for (int k = 0; k < Math.min(limit, hits.size()); k++) {
            Map<String, Object> e = new LinkedHashMap<>((Map<String, Object>) hits.get(k)[1]);
            Citations.Style s = installed.get(String.valueOf(e.get("name")));
            e.put("installed", s != null);
            e.put("builtin", s != null && s.builtin);
            results.add(e);
        }
        return Json.obj("total", (long) hits.size(), "results", results);
    }

    private String download(String name) {
        if (name == null || !Citations.SAFE_ID.matcher(name).matches()) throw new UserError("Invalid style name");
        RuntimeException last = null;
        for (String url : styleURLs(name)) {
            try {
                Net.Response res = get(url);
                if (!res.ok()) { last = new UserError("Style \"" + name + "\" was not found (HTTP " + res.status + ")", res.status == 404 ? 404 : 502); continue; }
                String xml = res.text();
                if (Citations.styleInfo(xml) == null) { last = new UserError("The download for \"" + name + "\" is not a CSL style", 502); continue; }
                return xml;
            } catch (RuntimeException e) { last = e; }
        }
        throw last != null ? last : new UserError("Style \"" + name + "\" could not be downloaded", 502);
    }

    private void save(String id, String xml) throws IOException {
        Store.writeAtomic(userDir.resolve(id + ".csl"), xml.getBytes(StandardCharsets.UTF_8), false);
    }

    private Map<String, Object> result(Citations.Style s) {
        return Json.obj("id", s.id, "title", s.title, "parent", s.parent);
    }

    /** Download and install a style (and its parent, for a journal style). */
    public synchronized Map<String, Object> install(String name) throws IOException {
        String xml = download(name);
        Citations.Info info = validateStyle(xml);
        if (info.parent != null) {
            String parentId = Citations.styleIdFromURI(info.parent);
            boolean have = false;
            for (Citations.Style s : citations.listStyles()) have |= s.id.equals(parentId) && s.parent == null;
            if (!have) {
                if (!Citations.SAFE_ID.matcher(parentId).matches()) throw new UserError("The parent of this style has an invalid name", 502);
                String parentXml = download(parentId);
                Citations.Info parentInfo = validateStyle(parentXml);
                if (parentInfo.parent != null) throw new UserError("The parent of this style is itself a dependent style", 502);
                save(parentId, parentXml);
            }
        }
        save(name, xml);
        Citations.Style style = citations.find(name);
        if (style == null) throw new UserError("\"" + name + "\" was saved but could not be loaded", 500);
        return result(style);
    }

    /** Install a .csl file the user picked. Its id comes from the style's <id>, else its title. */
    public synchronized Map<String, Object> addFile(Object xmlValue) throws IOException {
        Citations.Info info = validateStyle(xmlValue);
        String xml = (String) xmlValue;
        String fromUri = Citations.styleIdFromURI(info.uri);
        String id = Citations.SAFE_ID.matcher(fromUri).matches() ? fromUri
            : slug(info.title == null ? "" : info.title);
        if (!Citations.SAFE_ID.matcher(id).matches()) throw new UserError("Cannot derive a file name for this style; give it an <id> or <title>");
        Citations.Style existing = citations.find(id);
        if (existing != null && existing.builtin) throw new UserError("\"" + existing.title + "\" is a built-in style and cannot be replaced", 409);
        if (info.parent != null) {
            String parentId = Citations.styleIdFromURI(info.parent);
            boolean have = false;
            for (Citations.Style s : citations.listStyles()) have |= (s.id.equals(parentId) || s.uri.equals(info.parent)) && s.parent == null;
            if (!have) throw new UserError("This journal style needs its parent style \"" + parentId + "\". Install that first (search for it above).");
        }
        save(id, xml);
        Citations.Style style = citations.find(id);
        if (style == null) throw new UserError("The style was saved but could not be loaded", 500);
        return result(style);
    }

    private static String slug(String title) {
        String s = Normalizer.normalize(Text.lower(title), Normalizer.Form.NFKD).replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        return s.length() > 100 ? s.substring(0, 100) : s;
    }

    /** Remove a style installed by the user. A parent still used by a journal style is kept. */
    public synchronized Map<String, Object> remove(String id) throws IOException {
        List<Citations.Style> styles = citations.listStyles();
        Citations.Style style = null;
        for (Citations.Style s : styles) if (s.id.equals(id)) style = s;
        if (style == null) throw new UserError("That style is not installed", 404);
        if (style.builtin) throw new UserError("Built-in styles cannot be removed");
        List<String> users = new ArrayList<>();
        for (Citations.Style s : styles) if (id.equals(s.parent)) users.add("\"" + s.title + "\"");
        if (!users.isEmpty()) throw new UserError("Used by " + String.join(", ", users) + ". Remove " + (users.size() == 1 ? "that style" : "those styles") + " first.", 409);
        Files.deleteIfExists(style.path);
        return Json.obj("id", id);
    }
}
