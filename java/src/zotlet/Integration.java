package zotlet;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static zotlet.Json.arr;
import static zotlet.Json.list;
import static zotlet.Json.map;
import static zotlet.Json.obj;

/**
 * Word processor integration (port of src/integration.js): speaks the protocol of Zotero's
 * word-processor plugins, so "Add/Edit Citation", "Add/Edit Bibliography", "Refresh",
 * "Document Preferences" and "Unlink Citations" in LibreOffice and GenOffice work against the
 * zotlet library, and the documents stay usable with Zotero (in Word too).
 *
 * TCP 23116  — the LibreOffice plugin protocol (8-byte header + JSON), used by LibreOffice and GenOffice.
 * HTTP 23119 — the "HTTP citing protocol" (/connector/document/*).
 */
public final class Integration {
    public static final int TCP_PORT = 23116, HTTP_PORT = 23119;
    public static final String SCHEMA = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json";
    public static final String COMPAT_VERSION = "6.0.0";
    private static final String DEFAULT_STYLE = "nature";
    private static final SecureRandom RANDOM = new SecureRandom();

    /** What a document session needs from the app. */
    public interface Ctx {
        List<Map<String, Object>> items() throws IOException;
        List<Citations.Style> styles();
        /** The picker; null = cancelled. */
        Map<String, Object> pick(Map<String, Object> spec) throws Exception;
        /** Download a style a document uses; throws if that fails. */
        void installStyle(String uri) throws Exception;
        Citations citations();
    }

    /** A document RPC on the client ("Document.getFields", …). */
    public interface Rpc {
        Object call(String method, List<Object> args) throws Exception;
    }

    static String rid() {
        byte[] b = new byte[6];
        RANDOM.nextBytes(b);
        String s = Base64.getUrlEncoder().withoutPadding().encodeToString(b).replaceAll("[-_]", "");
        if (s.length() > 8) s = s.substring(0, 8);
        while (s.length() < 8) s += "0";
        return s;
    }

    // Stable Zotero-style item URI for a zotlet item id (unchanged from earlier zotlet versions,
    // so citations already in documents keep matching).
    static String zkey(String s) {
        String a = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
        BigInteger h = BigInteger.ZERO, b31 = BigInteger.valueOf(31), b33 = BigInteger.valueOf(33);
        for (int k = 0; k < s.length(); k++) h = h.add(BigInteger.valueOf(s.charAt(k)).multiply(b31.pow(k)));
        StringBuilder out = new StringBuilder();
        for (int k = 0; k < 8; k++) out.append(a.charAt(h.divide(b33.pow(k)).mod(b33).intValue()));
        return out.toString();
    }

    public static String itemURI(Object id) {
        return "http://zotero.org/users/local/zotlet/items/" + zkey(Json.jsString(id));
    }

    // ---------- styles ----------

    /** Map a style URI stored in a document (or a bare id) to an installed style id, else null. */
    public static String resolveStyle(Object value, List<Citations.Style> styles) {
        if (!(value instanceof String) || ((String) value).isEmpty()) return null;
        String uri = ((String) value).replace("&quot;", "\"").replace("&amp;", "&");
        String suffix = uri.substring(uri.lastIndexOf('/') + 1);
        for (Citations.Style s : styles) if (s.id.equals(suffix)) return s.id;
        for (Citations.Style s : styles) if (s.uri.equals(uri)) return s.id;
        return null;
    }

    static String styleURI(String id, List<Citations.Style> styles) {
        for (Citations.Style s : styles) if (s.id.equals(id) && s.uri != null && !s.uri.isEmpty()) return s.uri;
        return "http://www.zotero.org/styles/" + id;
    }

    // ---------- formatting ----------

    static Map<String, Object> parseCode(Object codeValue) {
        String code = Json.jsString(codeValue);
        int a = code.indexOf('{'), b = code.lastIndexOf('}');
        if (a < 0 || b < a) return null;
        try { return map(Json.parse(code.substring(a, b + 1))); } catch (Json.ParseException e) { return null; }
    }

    private static String escAttr(String s) { return s.replace("&", "&amp;").replace("\"", "&quot;"); }

    static String prefXml(String uri, String fieldType, boolean bibliographyStyleSet, String sessionID, String version) {
        return "<data data-version=\"3\" zotero-version=\"" + version + "\"><session id=\"" + sessionID + "\"/><style id=\"" + escAttr(uri)
            + "\" hasBibliography=\"1\" bibliographyStyleHasBeenSet=\"" + (bibliographyStyleSet ? 1 : 0) + "\"/><prefs><pref name=\"fieldType\" value=\""
            + fieldType + "\"/></prefs></data>";
    }

    static Map<String, Object> readData(Object data) {
        if (!(data instanceof String)) return null;
        try {
            Map<String, Object> parsed = map(Json.parse((String) data));
            if (parsed != null && parsed.get("dataVersion") instanceof Number && ((Number) parsed.get("dataVersion")).doubleValue() == 4) return parsed;
        } catch (Json.ParseException e) { /* old format */ }
        return null;
    }

    private static double d(Object v) { return v instanceof Number ? ((Number) v).doubleValue() : Double.NaN; }

    /** Paragraph settings for Document.setBibliographyStyle, in twips (same rules as Zotero). */
    public static List<Object> bibliographyStyle(List<Object> bib) {
        Map<String, Object> meta = map(bib.get(0));
        List<Object> tabs = new ArrayList<>();
        double first = 0, indent = 0;
        if (Json.truthy(meta.get("hangingindent"))) { indent = 720; first = -720; }
        else if (Json.truthy(meta.get("second-field-align"))) {
            double at = 24 + d(meta.get("maxoffset")) * 120;
            first = -at;
            if ("margin".equals(meta.get("second-field-align"))) tabs.add(0L);
            else { indent = at; tabs.add(Json.normalizeNumber(at)); }
        }
        return arr(Json.normalizeNumber(first), Json.normalizeNumber(indent), Json.normalizeNumber(240 * d(meta.get("linespacing"))),
            Json.normalizeNumber(240 * d(meta.get("entryspacing"))), tabs, (long) tabs.size());
    }

    static String bibRtf(List<Object> bib) {
        Map<String, Object> meta = map(bib.get(0));
        double n = Json.truthy(meta.get("second-field-align")) ? Math.max(480, d(meta.get("maxoffset")) * 150) : 720;
        String ns = Json.number(n);
        String indent = Json.truthy(meta.get("hangingindent")) || Json.truthy(meta.get("second-field-align")) ? "\\li" + ns + "\\fi-" + ns + " " : "";
        List<String> entries = new ArrayList<>();
        for (Object e : list(bib.get(1))) entries.add(Json.jsString(e).replaceAll(Text.WS + "+$", ""));
        return "{\\rtf " + indent + String.join("\\par ", entries) + "}";
    }

    static String doiKey(Object doi) {
        return doi instanceof String ? Text.lower(Text.trim((String) doi)).replaceFirst("^https?://(dx\\.)?doi\\.org/", "") : "";
    }

    static List<Object> unique(List<Object> values) {
        Set<Object> out = new LinkedHashSet<>();
        for (Object v : values) if (Json.truthy(v)) out.add(v);
        return new ArrayList<>(out);
    }

    /** Library lookups by zotlet id and by DOI (for citations written by Zotero). */
    static final class Lib {
        List<Map<String, Object>> items;
        Map<String, Map<String, Object>> byId = new HashMap<>(), byDOI = new HashMap<>();
    }

    static Lib libraryIndex(Ctx ctx) throws IOException {
        Lib lib = new Lib();
        lib.items = ctx.items();
        for (Map<String, Object> i : lib.items) lib.byId.put(Json.jsString(i.get("id")), i);
        for (Map<String, Object> i : lib.items) if (!doiKey(i.get("DOI")).isEmpty()) lib.byDOI.put(doiKey(i.get("DOI")), i);
        return lib;
    }

    /**
     * Point a citation item at the zotlet library when possible: by id, else by DOI (a citation
     * inserted by Zotero). Existing URIs are kept first, so Zotero still finds its own items.
     */
    static Map<String, Object> matchCitationItem(Map<String, Object> ci, Lib lib) {
        Map<String, Object> itemData = map(ci.get("itemData"));
        Map<String, Object> found = lib.byId.get(Json.jsString(ci.get("id")));
        if (found == null) found = lib.byDOI.get(doiKey(itemData == null ? null : itemData.get("DOI")));
        if (found != null) {
            ci.put("id", found.get("id"));
            Map<String, Object> data = new LinkedHashMap<>(found);
            data.put("id", found.get("id"));
            ci.put("itemData", data);
            List<Object> uris = new ArrayList<>();
            if (ci.get("uris") instanceof List) uris.addAll(list(ci.get("uris")));
            uris.add(ci.get("uri"));
            uris.add(itemURI(found.get("id")));
            ci.put("uris", unique(uris));
        } else {
            Map<String, Object> data = itemData == null ? new LinkedHashMap<>() : new LinkedHashMap<>(itemData);
            data.put("id", ci.get("id"));
            ci.put("itemData", data);
            if (!(ci.get("uris") instanceof List && !list(ci.get("uris")).isEmpty())) ci.put("uris", unique(arr(ci.get("uri"), itemURI(ci.get("id")))));
        }
        ci.remove("uri");
        return ci;
    }

    /** [formatted in `mode`, plain text], each [{ citationID: text }, bibliography | false]. */
    private static List<List<Object>> render(Ctx ctx, Path file, Map<String, Object> items, List<Map<String, Object>[]> cites, String mode) throws IOException {
        List<Object> citations = new ArrayList<>();
        for (Map<String, Object>[] c : cites) {
            Map<String, Object> j = c[1];
            List<Object> citationItems = new ArrayList<>();
            for (Object o : list(j.get("citationItems"))) {
                Map<String, Object> ci = new LinkedHashMap<>(map(o));
                ci.remove("itemData");
                ci.remove("uris");
                ci.remove("uri");
                ci.put("id", Json.jsString(ci.get("id")));
                citationItems.add(ci);
            }
            citations.add(obj("citationID", j.get("citationID"), "citationItems", citationItems, "properties", obj("noteIndex", 0L)));
        }
        Citations.Collection collection = new Citations.Collection();
        for (Map.Entry<String, Object> e : items.entrySet()) collection.put(e.getKey(), e.getValue());
        return ctx.citations().render(file, collection, citations, mode);
    }

    private static Path styleFile(Ctx ctx, String style) {
        for (Citations.Style s : ctx.styles()) if (s.id.equals(style)) return s.file;
        throw new UserError("Unknown citation style \"" + style + "\"");
    }

    @SuppressWarnings("unchecked")
    static int refresh(Object doc, String style, Rpc call, Map<String, Object> options, Ctx ctx) throws Exception {
        List<Object> fields = list(call.call("Document.getFields", arr(doc, options.get("fieldType"))));
        List<Object> ids = list(fields.get(0)), codes = list(fields.get(1));
        Lib lib = libraryIndex(ctx);
        Map<String, Object> items = new LinkedHashMap<>();
        List<Map<String, Object>[]> cites = new ArrayList<>();
        List<Object> bibs = new ArrayList<>();
        Set<Object> seen = new HashSet<>();
        for (int k = 0; k < ids.size(); k++) {
            Object id = ids.get(k);
            String code = Json.jsString(k < codes.size() ? codes.get(k) : null);
            if (code.startsWith("ITEM")) {
                Map<String, Object> j = parseCode(code);
                if (j == null || !(j.get("citationItems") instanceof List)) continue;
                if (!Json.truthy(j.get("citationID")) || seen.contains(j.get("citationID"))) j.put("citationID", rid());
                seen.add(j.get("citationID"));
                for (Object o : list(j.get("citationItems"))) {
                    Map<String, Object> ci = map(o);
                    // The library copy wins, so edits made in zotlet show up on refresh.
                    matchCitationItem(ci, lib);
                    items.put(Json.jsString(ci.get("id")), ci.get("itemData"));
                }
                cites.add(new Map[]{obj("id", id), j});
            } else if (code.startsWith("BIBL")) bibs.add(id);
        }
        if (cites.isEmpty()) return 0;
        Path file = styleFile(ctx, style);
        String outputFormat = (String) options.get("outputFormat");
        List<List<Object>> rendered = render(ctx, file, items, cites, outputFormat);
        List<Object> formattedOut = rendered.get(0);
        Map<String, Object> formatted = map(formattedOut.get(0));
        Object bibValue = formattedOut.get(1);
        List<Object> bib = bibValue instanceof List ? list(bibValue) : null;
        Map<String, Object> plain = map(rendered.get(1).get(0));
        for (Map<String, Object>[] c : cites) {
            Object id = c[0].get("id");
            Map<String, Object> j = c[1];
            String cid = Json.jsString(j.get("citationID"));
            String r = Json.jsString(formatted.get(cid));
            j.put("properties", obj("formattedCitation", formatted.get(cid), "plainCitation", plain.get(cid), "noteIndex", 0L));
            j.put("schema", SCHEMA);
            String text = "rtf".equals(outputFormat) ? (r.startsWith("{\\rtf") ? r : "{\\rtf " + r + "}") : r;
            call.call("Field.setText", arr(doc, id, text, true));
            call.call("Field.setCode", arr(doc, id, "ITEM CSL_CITATION " + Json.stringify(j)));
        }
        for (Object id : bibs) {
            if (bib != null && Json.truthy(options.get("setBibliographyStyle")) && !Json.truthy(options.get("bibliographyStyleSet"))) {
                List<Object> args = arr(doc);
                args.addAll(bibliographyStyle(bib));
                call.call("Document.setBibliographyStyle", args);
                options.put("bibliographyStyleSet", true);
            }
            String text;
            if (bib == null) text = "";
            else if ("rtf".equals(outputFormat)) text = bibRtf(bib);
            else {
                Map<String, Object> meta = map(bib.get(0));
                StringBuilder b = new StringBuilder(Json.jsString(meta.get("bibstart")));
                for (Object e : list(bib.get(1))) b.append(Json.jsString(e));
                text = b.append(Json.jsString(meta.get("bibend"))).toString();
            }
            call.call("Field.setText", arr(doc, id, text, true));
        }
        return cites.size();
    }

    static final List<String> COMMANDS = Arrays.asList("addEditCitation", "addEditBibliography", "refresh", "setDocPrefs", "removeCodes");
    private static final Pattern MUTATING = Pattern.compile("^(Field\\.(setText|setCode|removeCode|delete)|Document\\.(insertField|convert|setBibliographyStyle))$");
    private static final Pattern STYLE_ID_ATTR = Pattern.compile("<style id=\"([^\"]+)\"");
    private static final Pattern FIELD_TYPE_PREF = Pattern.compile("<pref name=\"fieldType\" value=\"([^\"]+)\"");
    private static final Pattern SESSION_ID = Pattern.compile("<session id=\"([^\"]+)\"");
    private static final Pattern PREFS = Pattern.compile("<prefs>([\\s\\S]*?)</prefs>");
    private static final Pattern EXISTING_FIELD_PREF = Pattern.compile("<pref name=\"fieldType\" value=\"[^\"]*\"" + Text.WS + "*/>");

    private static String group(Pattern p, String s) {
        Matcher m = p.matcher(s);
        return m.find() ? m.group(1) : null;
    }

    private static String message(Throwable e) {
        while ((e instanceof ExecutionException || e instanceof java.util.concurrent.CompletionException) && e.getCause() != null) e = e.getCause();
        String m = e.getMessage();
        return m == null ? e.getClass().getSimpleName() : m;
    }

    /** The document-level state of one command. */
    private static final class Session {
        final Map<String, Object> options;
        final Object doc;
        final Ctx ctx;
        Rpc call;
        List<Citations.Style> styles;
        Map<String, Object> data;
        String rawData;
        String style, stored, sessionID;

        Session(Map<String, Object> options, Object doc, Ctx ctx) { this.options = options; this.doc = doc; this.ctx = ctx; }

        String serializeData() {
            String uri = styleURI(style, styles);
            if (sessionID == null || sessionID.isEmpty()) sessionID = rid();
            String storedFieldType = (String) options.get("storedFieldType");
            if (data == null) {
                Object version = options.get("version");
                String xml = prefXml(uri, storedFieldType, Json.truthy(options.get("modernData")) ? Json.truthy(options.get("bibliographyStyleSet")) : true,
                    sessionID, Json.truthy(version) ? Json.jsString(version) : "zotlet");
                Matcher prefs = PREFS.matcher(rawData == null ? "" : rawData);
                if (prefs.find()) {
                    String field = "<pref name=\"fieldType\" value=\"" + storedFieldType + "\"/>";
                    String retained = EXISTING_FIELD_PREF.matcher(prefs.group(1)).find()
                        ? EXISTING_FIELD_PREF.matcher(prefs.group(1)).replaceFirst(Matcher.quoteReplacement(field)) : prefs.group(1) + field;
                    xml = xml.replaceFirst("<prefs>[\\s\\S]*?</prefs>", Matcher.quoteReplacement("<prefs>" + retained + "</prefs>"));
                }
                return xml;
            }
            Map<String, Object> styleOut = new LinkedHashMap<>();
            styleOut.put("styleID", uri);
            Map<String, Object> ds = map(data.get("style"));
            if (ds != null && Json.truthy(ds.get("locale"))) styleOut.put("locale", ds.get("locale"));
            styleOut.put("hasBibliography", true);
            styleOut.put("bibliographyStyleHasBeenSet", options.get("bibliographyStyleSet"));
            Map<String, Object> prefs = map(data.get("prefs")) == null ? new LinkedHashMap<>() : new LinkedHashMap<>(map(data.get("prefs")));
            prefs.put("fieldType", storedFieldType);
            prefs.put("noteType", 0L);
            Object version = options.get("version");
            return Json.stringify(obj("style", styleOut, "prefs", prefs, "sessionID", sessionID,
                "zoteroVersion", Json.truthy(version) ? version : "zotlet", "dataVersion", 4L));
        }

        void setStyle(String s) throws Exception {
            if (s.equals(stored) && s.equals(style)) return;
            style = s;
            if (Json.truthy(options.get("setBibliographyStyle"))) options.put("bibliographyStyleSet", false);
            call.call("Document.setDocumentData", arr(doc, serializeData()));
        }

        boolean hasStyle(Object id) {
            for (Citations.Style s : styles) if (s.id.equals(id)) return true;
            return false;
        }
    }

    private static boolean numberIs(Object v, int n) { return v instanceof Number && ((Number) v).doubleValue() == n; }

    /**
     * Run one plugin command against a document. `call` performs a document RPC on the client.
     * Returns a short note for the server log.
     */
    public static String runSession(String cmd, Rpc call0, Map<String, Object> sessionOptions, Ctx ctx) throws Exception {
        List<Citations.Style> styles = ctx.styles();
        List<Object> active = list(call0.call("Application.getActiveDocument", arr(3L)));
        Object doc = active != null && active.size() > 1 ? active.get(1) : null;
        Map<String, Object> options = obj("fieldType", "ReferenceMark", "outputFormat", "rtf", "supportedNotes", new ArrayList<>());
        options.putAll(sessionOptions);
        if (active != null && active.size() > 2 && map(active.get(2)) != null) options.putAll(map(active.get(2)));
        Session s = new Session(options, doc, ctx);
        s.styles = styles;
        boolean[] mutated = {false};
        s.call = Json.truthy(options.get("finalCommit")) ? (method, args) -> {
            Object value = call0.call(method, args);
            if (MUTATING.matcher(method).matches()) mutated[0] = true;
            return value;
        } : call0;
        Rpc call = (method, args) -> s.call.call(method, args);
        Consumer<String> alertQuiet = (msg) -> { try { call.call("Document.displayAlert", arr(doc, msg, 0L, 0L)); } catch (Exception e) { /* ignore */ } };
        String note = "";
        String ret = null;
        boolean serializable = false;
        try {
            if (Json.truthy(options.get("modernData")) && !COMMANDS.contains(cmd)) throw new UserError("zotlet does not support \"" + cmd + "\" yet");
            if (!"rtf".equals(options.get("outputFormat")) && !"html".equals(options.get("outputFormat"))) throw new UserError("Unsupported output format: " + Json.jsString(options.get("outputFormat")));
            Object rawData = call.call("Document.getDocumentData", arr(doc));
            if (Json.truthy(options.get("modernData")) && !(rawData instanceof String)) throw new UserError("Invalid document data: expected a string");
            s.rawData = rawData instanceof String ? (String) rawData : null;
            String raw = s.rawData == null ? "" : s.rawData;
            s.data = Json.truthy(options.get("modernData")) ? readData(rawData) : null;
            Object storedURI = s.data != null ? (map(s.data.get("style")) == null ? null : map(s.data.get("style")).get("styleID")) : group(STYLE_ID_ATTR, raw);
            s.stored = resolveStyle(storedURI, styles);
            if (Json.truthy(storedURI) && s.stored == null) {
                // The document uses a style zotlet does not have (e.g. one that is no longer built in):
                // download it instead of silently switching the document to another style.
                Throwable reason = null;
                try { ctx.installStyle(Json.jsString(storedURI)); } catch (Throwable e) { reason = e; }
                styles = ctx.styles();
                s.styles = styles;
                s.stored = resolveStyle(storedURI, styles);
                if (s.stored == null && !cmd.equals("setDocPrefs")) {
                    String name = Json.jsString(storedURI);
                    name = name.substring(name.lastIndexOf('/') + 1);
                    throw new UserError("This document uses the citation style \"" + name + "\", which is not installed"
                        + (reason != null ? " and could not be downloaded (" + message(reason) + ")" : "")
                        + ". Install it under Styles in zotlet, or choose another style in Document Preferences.");
                }
            }
            // The field type stored in the document must survive: Zotero refuses a document whose type
            // does not match the word processor (Word: Field/Bookmark, LibreOffice: ReferenceMark/Bookmark).
            Map<String, Object> prefsData = s.data == null ? null : map(s.data.get("prefs"));
            Object docFieldType = prefsData != null && Json.truthy(prefsData.get("fieldType")) ? prefsData.get("fieldType") : group(FIELD_TYPE_PREF, raw);
            options.put("storedFieldType", Json.truthy(docFieldType) ? docFieldType : options.get("fieldType"));
            List<Object> nativeTypes = list(options.get("nativeFieldTypes"));
            if (Json.truthy(docFieldType) && nativeTypes != null && nativeTypes.contains(docFieldType)) options.put("fieldType", docFieldType);
            else if ("Bookmark".equals(docFieldType) && Json.truthy(options.get("bookmarks"))) options.put("fieldType", "Bookmark");
            Map<String, Object> dataStyle = s.data == null ? null : map(s.data.get("style"));
            options.put("bibliographyStyleSet", s.data != null ? dataStyle != null && Json.truthy(dataStyle.get("bibliographyStyleHasBeenSet")) : raw.contains("bibliographyStyleHasBeenSet=\"1\""));
            s.style = s.stored != null ? s.stored : s.hasStyle(DEFAULT_STYLE) ? DEFAULT_STYLE : styles.isEmpty() ? null : styles.get(0).id;
            if (s.style == null) throw new UserError("No citation styles are installed");
            Object sid = s.data != null && Json.truthy(s.data.get("sessionID")) ? s.data.get("sessionID") : group(SESSION_ID, raw);
            s.sessionID = sid == null ? null : Json.jsString(sid);
            serializable = true;

            if (cmd.equals("setDocPrefs")) {
                // Bookmarks open in both Word and LibreOffice/GenOffice with Zotero. Existing citations
                // cannot be converted, so the type can only be chosen while the document has none.
                List<Object> fieldIds = list(list(call.call("Document.getFields", arr(doc, options.get("fieldType")))).get(0));
                Map<String, Object> spec = obj("mode", "style", "style", s.style);
                if (Json.truthy(options.get("bookmarks"))) spec.put("bookmarks", "Bookmark".equals(options.get("storedFieldType")));
                spec.put("bookmarksLocked", !fieldIds.isEmpty());
                Map<String, Object> r = ctx.pick(spec);
                if (r == null || !Json.truthy(r.get("style")) || !s.hasStyle(r.get("style"))) { note = "cancelled"; ret = note; }
                else {
                    Object wanted = Json.truthy(options.get("bookmarks")) && fieldIds.isEmpty() && r.get("bookmarks") instanceof Boolean
                        ? ((Boolean) r.get("bookmarks") ? "Bookmark" : "ReferenceMark") : options.get("storedFieldType");
                    if (!wanted.equals(options.get("storedFieldType"))) {
                        options.put("storedFieldType", wanted);
                        options.put("fieldType", wanted);
                        call.call("Document.setDocumentData", arr(doc, s.serializeData()));
                    }
                    s.setStyle((String) r.get("style"));
                }
            } else if (cmd.equals("addEditCitation")) {
                List<Object> cur = list(call.call("Document.cursorInField", arr(doc, options.get("fieldType"))));
                Map<String, Object> old = cur != null && cur.size() > 1 && Json.jsString(cur.get(1)).startsWith("ITEM") ? parseCode(cur.get(1)) : null;
                List<Object> oldItems = old != null && old.get("citationItems") instanceof List ? list(old.get("citationItems")) : new ArrayList<>();
                Lib lib = libraryIndex(ctx);
                List<Map<String, Object>> pool = new ArrayList<>(lib.items);
                for (Object o : oldItems) {
                    Map<String, Object> ci = map(o);
                    matchCitationItem(ci, lib);
                    boolean present = false;
                    for (Map<String, Object> it : pool) present |= Json.jsString(it.get("id")).equals(Json.jsString(ci.get("id")));
                    if (!present) {
                        Map<String, Object> extra = new LinkedHashMap<>(map(ci.get("itemData")));
                        extra.put("id", Json.jsString(ci.get("id")));
                        pool.add(extra);
                    }
                }
                if (pool.isEmpty()) throw new UserError("Your zotlet library is empty. Add references in zotlet first.");
                // The style menu is only offered for the first citation of a new document.
                List<Object> selected = new ArrayList<>();
                for (Object o : oldItems) selected.add(Json.jsString(map(o).get("id")));
                Map<String, Object> r = ctx.pick(obj("mode", "cite", "style", s.style, "askStyle", s.stored == null, "items", new ArrayList<Object>(pool), "selected", selected));
                Map<String, Map<String, Object>> byId = new HashMap<>();
                for (Map<String, Object> it : pool) byId.put(Json.jsString(it.get("id")), it);
                List<Map<String, Object>> chosen = new ArrayList<>();
                if (r != null && r.get("ids") instanceof List) for (Object id : list(r.get("ids"))) { Map<String, Object> it = byId.get(Json.jsString(id)); if (it != null) chosen.add(it); }
                if (chosen.isEmpty()) { note = "cancelled"; ret = note; }
                else {
                    if (Json.truthy(r.get("style")) && s.hasStyle(r.get("style"))) s.setStyle((String) r.get("style"));
                    Object fieldId = old != null ? cur.get(0) : list(call.call("Document.insertField", arr(doc, options.get("fieldType"), 0L))).get(0);
                    List<Object> citationItems = new ArrayList<>();
                    for (Map<String, Object> it : chosen) {
                        // Keep locator/prefix/suffix of items that were already in this citation.
                        Map<String, Object> prev = null;
                        for (Object o : oldItems) if (Json.jsString(map(o).get("id")).equals(Json.jsString(it.get("id")))) { prev = map(o); break; }
                        Map<String, Object> ci = prev == null ? new LinkedHashMap<>() : new LinkedHashMap<>(prev);
                        Object prevUris = ci.remove("uris");
                        ci.remove("itemData");
                        ci.remove("uri");
                        ci.put("id", it.get("id"));
                        List<Object> uris = new ArrayList<>();
                        if (prevUris instanceof List) uris.addAll(list(prevUris));
                        uris.add(itemURI(it.get("id")));
                        ci.put("uris", unique(uris));
                        ci.put("itemData", it);
                        citationItems.add(ci);
                    }
                    Map<String, Object> j = obj("citationID", old != null && Json.truthy(old.get("citationID")) ? old.get("citationID") : rid(),
                        "properties", obj("noteIndex", 0L), "citationItems", citationItems, "schema", SCHEMA);
                    call.call("Field.setCode", arr(doc, fieldId, "ITEM CSL_CITATION " + Json.stringify(j)));
                    List<String> names = new ArrayList<>();
                    for (Map<String, Object> it : chosen) names.add(Json.jsString(it.get("id")));
                    note = String.join(", ", names);
                }
            } else if (cmd.equals("addEditBibliography")) {
                List<Object> codes = list(list(call.call("Document.getFields", arr(doc, options.get("fieldType")))).get(1));
                boolean has = false;
                for (Object c : codes) has |= Json.jsString(c).startsWith("BIBL");
                if (!has) {
                    Object id = list(call.call("Document.insertField", arr(doc, options.get("fieldType"), 0L))).get(0);
                    call.call("Field.setCode", arr(doc, id, "BIBL {\"uncited\":[],\"omitted\":[],\"custom\":[]} CSL_BIBLIOGRAPHY"));
                }
            } else if (cmd.equals("removeCodes")) {
                Object answer = call.call("Document.displayAlert", arr(doc, "Convert all citations to plain text? They can no longer be refreshed or edited.", 0L, 1L));
                if (!numberIs(answer, 1)) { note = "cancelled"; ret = note; }
                else {
                    List<Object> ids = list(list(call.call("Document.getFields", arr(doc, options.get("fieldType")))).get(0));
                    for (Object id : ids) call.call("Field.removeCode", arr(doc, id));
                    note = ids.size() + " fields unlinked";
                    ret = note;
                }
            }
            if (ret == null) {
                if (s.stored == null) s.setStyle(s.style);
                int n = refresh(doc, s.style, call, options, ctx);
                String summary = n + " citation" + (n == 1 ? "" : "s") + " · " + s.style;
                note = note.isEmpty() ? summary : note + "  " + summary;
            }
        } catch (Throwable e) {
            note = "error: " + message(e);
            ret = null;
            alertQuiet.accept("zotlet: " + message(e));
        } finally {
            if (Json.truthy(options.get("finalCommit")) && mutated[0] && serializable) {
                try { call.call("Document.setDocumentData", arr(doc, s.serializeData())); }
                catch (Throwable error) { note = "error: " + message(error); alertQuiet.accept("zotlet: " + message(error)); }
            }
            try { call.call("Document.complete", arr(doc)); } catch (Throwable e) { /* ignore */ }
        }
        return ret != null ? ret : note;
    }

    // ---------- TCP transport (LibreOffice, GenOffice) ----------

    private static final Set<String> OFFICE_NAMES = new HashSet<>(Arrays.asList("soffice", "soffice.bin", "libreoffice", "libreofficedev", "uno", "uno.bin"));
    static String bareHost(String value) { return value.replaceAll("^\\[|\\]$", "").replaceFirst("(?i)^::ffff:", ""); }
    static boolean isOffice(String name) { return OFFICE_NAMES.contains(Text.lower(name)); }

    static Map<String, Object> libreOfficeSession() {
        return obj("modernData", true, "nativeFieldTypes", arr("ReferenceMark", "Bookmark"), "bookmarks", true,
            "setBibliographyStyle", true, "finalCommit", true, "supportedNotes", arr("footnote", "endnote"), "version", COMPAT_VERSION);
    }

    /** A process at the other end of a socket. */
    public static final class Owner {
        public final long pid;
        public final String command;
        public Owner(long pid, String command) { this.pid = pid; this.command = command; }
    }

    /** The ends of a TCP connection, as Node reports them. */
    public static final class Ends {
        final String remoteAddress, localAddress;
        final int remotePort, localPort;
        public Ends(String remoteAddress, int remotePort, String localAddress, int localPort) {
            this.remoteAddress = remoteAddress; this.remotePort = remotePort; this.localAddress = localAddress; this.localPort = localPort;
        }
        static Ends of(Socket s) {
            return new Ends(s.getInetAddress().getHostAddress(), s.getPort(), s.getLocalAddress().getHostAddress(), s.getLocalPort());
        }
    }

    private static final Pattern LSOF_PEER = Pattern.compile("^(\\[[^\\]]+\\]|[^:]+):(\\d+)->(\\[[^\\]]+\\]|[^:]+):(\\d+)(?:\\s|$)");

    /** Find the process owning the client end of `socket` in `lsof -Fpcn` output. */
    public static Owner lsofClient(String output, Ends socket) {
        long pid = 0;
        String command = "";
        Map<Long, Owner> owners = new LinkedHashMap<>();
        for (String line : output.split("\n")) {
            if (line.isEmpty()) continue;
            char c = line.charAt(0);
            if (c == 'p') { try { pid = Long.parseLong(line.substring(1)); } catch (NumberFormatException e) { pid = -1; } command = ""; }
            else if (c == 'c') command = line.substring(1);
            else if (c == 'n') {
                Matcher peer = LSOF_PEER.matcher(line.substring(1));
                if (peer.find() && bareHost(peer.group(1)).equals(bareHost(socket.remoteAddress)) && Integer.parseInt(peer.group(2)) == socket.remotePort
                    && bareHost(peer.group(3)).equals(bareHost(socket.localAddress)) && Integer.parseInt(peer.group(4)) == socket.localPort && pid > 0) owners.put(pid, new Owner(pid, command));
            }
        }
        if (owners.size() != 1) throw new IllegalStateException("TCP peer has no unique process owner");
        return owners.values().iterator().next();
    }

    private static String[] procEndpoint(String value) {
        String[] parts = value.split(":");
        byte[] bytes = new byte[parts[0].length() / 2];
        for (int k = 0; k < bytes.length; k++) bytes[k] = (byte) Integer.parseInt(parts[0].substring(2 * k, 2 * k + 2), 16);
        if (ByteOrder.nativeOrder() == ByteOrder.LITTLE_ENDIAN) {
            for (int i = 0; i + 4 <= bytes.length; i += 4) {
                byte t = bytes[i]; bytes[i] = bytes[i + 3]; bytes[i + 3] = t;
                t = bytes[i + 1]; bytes[i + 1] = bytes[i + 2]; bytes[i + 2] = t;
            }
        }
        boolean mapped = bytes.length == 16;
        for (int k = 0; mapped && k < 12; k++) mapped = bytes[k] == (k < 10 ? 0 : (byte) 0xff);
        String address;
        if (bytes.length == 4 || mapped) {
            int o = bytes.length - 4;
            address = (bytes[o] & 0xff) + "." + (bytes[o + 1] & 0xff) + "." + (bytes[o + 2] & 0xff) + "." + (bytes[o + 3] & 0xff);
        } else {
            StringBuilder b = new StringBuilder();
            for (byte x : bytes) b.append(String.format("%02x", x & 0xff));
            address = b.toString();
        }
        return new String[]{address, String.valueOf(Integer.parseInt(parts[1], 16))};
    }

    private static Owner linuxClient(Ends socket) throws IOException {
        Set<String> inodes = new HashSet<>();
        for (String file : new String[]{"/proc/net/tcp", "/proc/net/tcp6"}) {
            List<String> lines;
            try { lines = Files.readAllLines(Paths.get(file), StandardCharsets.UTF_8); } catch (NoSuchFileException e) { continue; }
            for (String line : lines) {
                String[] columns = Text.trim(line).split("\\s+");
                if (columns.length < 10 || !columns[3].equals("01")) continue;
                String[] local, remote;
                try { local = procEndpoint(columns[1]); remote = procEndpoint(columns[2]); } catch (RuntimeException e) { continue; }
                if (local[0].equals(bareHost(socket.remoteAddress)) && Integer.parseInt(local[1]) == socket.remotePort
                    && remote[0].equals(bareHost(socket.localAddress)) && Integer.parseInt(remote[1]) == socket.localPort && !columns[9].equals("0")) inodes.add(columns[9]);
            }
        }
        if (inodes.isEmpty()) return null;
        try (DirectoryStream<Path> procs = Files.newDirectoryStream(Paths.get("/proc"))) {
            for (Path proc : procs) {
                String pid = proc.getFileName().toString();
                if (!pid.matches("^\\d+$")) continue;
                try {
                    String command = Text.trim(new String(Files.readAllBytes(proc.resolve("comm")), StandardCharsets.UTF_8));
                    if (!isOffice(command)) continue;
                    try (DirectoryStream<Path> fds = Files.newDirectoryStream(proc.resolve("fd"))) {
                        for (Path fd : fds) {
                            String target;
                            try { target = Files.readSymbolicLink(fd).toString(); } catch (IOException e) { continue; }
                            Matcher m = Pattern.compile("^socket:\\[(\\d+)\\]$").matcher(target);
                            if (m.find() && inodes.contains(m.group(1))) return new Owner(Long.parseLong(pid), command);
                        }
                    }
                } catch (IOException | SecurityException e) { /* gone or not ours */ }
            }
        }
        return null;
    }

    private static final String OS = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    static final boolean MAC = OS.startsWith("mac"), LINUX = OS.startsWith("linux"), WINDOWS = OS.startsWith("windows");

    /** LibreOffice speaks a newer dialect over the same socket; detect it from the peer process. */
    public static Owner libreOfficeClient(Ends socket) throws Exception {
        if (LINUX) return linuxClient(socket);
        if (MAC) {
            String out = Proc.run(Arrays.asList("/usr/sbin/lsof", "-nP", "-a", "-iTCP:" + socket.localPort, "-sTCP:ESTABLISHED", "-Fpcn"), 3000);
            Owner owner = lsofClient(out, socket);
            return isOffice(owner.command) ? owner : null;
        }
        return null;
    }

    public interface Detector { Owner detect(Ends socket) throws Exception; }

    private static void writeFrame(OutputStream out, int id, byte[] body) throws IOException {
        // One write per frame (with TCP_NODELAY): a separate small header write waits for the
        // peer's delayed ACK, about 40 ms per document RPC.
        ByteBuffer frame = ByteBuffer.allocate(8 + body.length).order(ByteOrder.BIG_ENDIAN);
        frame.putInt(id).putInt(body.length).put(body);
        synchronized (out) {
            out.write(frame.array());
            out.flush();
        }
    }

    /** One TCP connection from a word processor. */
    private static final class TcpClient {
        final Socket sock;
        final OutputStream out;
        final Ctx ctx;
        final Consumer<String> log;
        final CompletableFuture<Map<String, Object>> profile;
        final Map<Integer, CompletableFuture<Object>> waiting = new ConcurrentHashMap<>();
        final ExecutorService commands = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r, "zotlet-tcp-command"); t.setDaemon(true); return t; });
        final AtomicInteger tx = new AtomicInteger();
        volatile boolean closed;

        TcpClient(Socket sock, Ctx ctx, Consumer<String> log, Detector detect) throws IOException {
            this.sock = sock;
            sock.setTcpNoDelay(true);
            this.out = sock.getOutputStream();
            this.ctx = ctx;
            this.log = log;
            Ends ends = Ends.of(sock);
            this.profile = CompletableFuture.supplyAsync(() -> {
                try {
                    Owner owner = detect.detect(ends);
                    if (owner != null) log.accept("TCP client " + owner.command + " (PID " + owner.pid + "): LibreOffice mode");
                    return owner != null ? libreOfficeSession() : obj("bookmarks", true);
                } catch (Throwable e) { return obj("bookmarks", true); }
            });
        }

        Object call(String method, List<Object> args) throws Exception {
            if (closed || sock.isClosed() || sock.isOutputShutdown()) throw new IOException("The word processor closed the connection");
            int id = tx.incrementAndGet();
            CompletableFuture<Object> f = new CompletableFuture<>();
            waiting.put(id, f);
            writeFrame(out, id, Json.stringify(arr(method, args)).getBytes(StandardCharsets.UTF_8));
            try { return f.get(); }
            catch (ExecutionException e) { throw e.getCause() instanceof Exception ? (Exception) e.getCause() : e; }
        }

        void read() {
            try (DataInputStream in = new DataInputStream(sock.getInputStream())) {
                for (;;) {
                    int id, length;
                    try { id = in.readInt(); length = in.readInt(); } catch (EOFException e) { break; }
                    if (length < 0 || length > 100_000_000) break;
                    byte[] body = new byte[length];
                    in.readFully(body);
                    String payload = new String(body, StandardCharsets.UTF_8);
                    if (id == 0) {
                        String command;
                        try { command = (String) map(Json.parse(payload)).get("command"); if (command == null) throw new IllegalArgumentException(); }
                        catch (RuntimeException e) { sock.close(); return; }
                        commands.submit(() -> runCommand(command));
                        continue;
                    }
                    CompletableFuture<Object> pending = waiting.remove(id);
                    if (pending == null) continue;
                    if (payload.startsWith("ERR:")) pending.completeExceptionally(new IOException(payload.substring(4)));
                    else {
                        try { pending.complete(Json.parse(payload)); } catch (Json.ParseException e) { pending.completeExceptionally(e); }
                    }
                }
            } catch (IOException e) {
                /* connection gone */
            } finally {
                closed = true;
                for (CompletableFuture<Object> f : waiting.values()) f.completeExceptionally(new IOException("The word processor closed the connection"));
                waiting.clear();
                commands.shutdown();
                try { sock.close(); } catch (IOException e) { /* ignore */ }
            }
        }

        void runCommand(String command) {
            try {
                Map<String, Object> session = profile.get();
                boolean nativeTypes = session.containsKey("nativeFieldTypes");
                Rpc invoke = (method, args) -> {
                    Object value = call(method.replaceFirst("\\.", "_"), args);
                    // LibreOffice needs RTF text set again after a code change to keep italics etc.
                    if (nativeTypes && method.equals("Field.setCode")) {
                        String code = Json.jsString(args.get(2));
                        int start = code.indexOf('{');
                        if (start != -1) {
                            Map<String, Object> j = map(Json.parse(code.substring(start, code.lastIndexOf('}') + 1)));
                            Map<String, Object> props = j == null ? null : map(j.get("properties"));
                            Object text = props == null ? null : props.get("formattedCitation");
                            if (text instanceof String && ((String) text).contains("\\")) {
                                String t = (String) text;
                                call("Field_setText", arr(args.get(0), args.get(1), t.startsWith("{\\rtf") ? t : "{\\rtf " + t + "}", true));
                            }
                        }
                    }
                    return value;
                };
                try {
                    log.accept(Text.padEnd(command, 20) + " " + runSession(command, invoke, session, ctx));
                } finally {
                    if (!nativeTypes) { try { sock.shutdownOutput(); } catch (IOException e) { /* closed */ } }
                }
            } catch (Throwable e) {
                log.accept("error: " + message(e));
            }
        }
    }

    // ---------- HTTP citing protocol ----------

    private static final String BOOKMARKLET_ORIGIN = "https://www.zotero.org";
    private static final Pattern LOCAL_HOST = Pattern.compile("^(?:127\\.0\\.0\\.1|\\[::1\\]|localhost)(?::[0-9]+)?$", Pattern.CASE_INSENSITIVE);
    private static final Map<String, String[][]> PATHS = new HashMap<>();
    static {
        PATHS.put("/connector/ping", new String[][]{{"GET", "POST"}, {"application/json", "text/plain"}});
        PATHS.put("/connector/document/execCommand", new String[][]{{"POST"}, {"application/json"}});
        PATHS.put("/connector/document/respond", new String[][]{{"POST"}, {"application/json"}});
        PATHS.put("/connector/sendToBack", new String[][]{{"GET", "POST"}, {"application/json"}});
    }

    /** Sends one close-delimited HTTP/1.0 response on a connection (the upstream protocol's style). */
    interface Sender { void send(int status, String type, String body); }

    private static Sender sender(Socket socket, HttpLite.Request request) {
        boolean[] done = {false};
        return (status, type, body) -> {
            synchronized (done) {
                if (done[0] || socket.isClosed()) return;
                done[0] = true;
            }
            StringBuilder header = new StringBuilder("HTTP/1.0 " + status + " " + HttpLite.reason(status) + "\r\nX-Zotero-Version: " + COMPAT_VERSION + "\r\nX-Zotero-Connector-API-Version: 3\r\n");
            if (BOOKMARKLET_ORIGIN.equals(request.header("origin")) && LOCAL_HOST.matcher(request.header("host") == null ? "" : request.header("host")).matches()) {
                header.append("Access-Control-Allow-Origin: ").append(BOOKMARKLET_ORIGIN).append("\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\n")
                    .append("Access-Control-Allow-Headers: Content-Type,X-Zotero-Connector-API-Version,X-Zotero-Version\r\n");
            }
            if (type != null) header.append("Content-Type: ").append(type).append("\r\n");
            if (body == null || body.isEmpty()) header.append("Content-Length: 0\r\n");
            header.append("\r\n");
            if (body != null) header.append(body);
            try {
                OutputStream o = socket.getOutputStream();
                o.write(header.toString().getBytes(StandardCharsets.UTF_8));
                o.flush();
            } catch (IOException e) { /* client gone */ }
            try { socket.close(); } catch (IOException e) { /* ignore */ }
        };
    }

    private static List<Object> fieldTuple(Object field) {
        Map<String, Object> f = map(field);
        return f == null ? null : arr(f.get("id"), f.get("code"), f.get("noteIndex"));
    }

    private static List<Object> fieldsTuple(Object fields) {
        List<Object> ids = new ArrayList<>(), codes = new ArrayList<>(), notes = new ArrayList<>(), adjacent = new ArrayList<>();
        List<Object> all = list(fields) == null ? new ArrayList<>() : list(fields);
        for (Object o : all) {
            Map<String, Object> f = map(o) == null ? new HashMap<>() : map(o);
            ids.add(f.get("id")); codes.add(f.get("code")); notes.add(f.get("noteIndex")); adjacent.add(f.get("adjacent"));
        }
        return arr(ids, codes, notes, adjacent);
    }

    /** The command in progress over HTTP: each response carries the next RPC. */
    private static final class Transaction {
        volatile Sender send;
        volatile CompletableFuture<Object> waiting;
        volatile String processorName;
    }

    private static final class HttpIntegration {
        final Ctx ctx;
        final Consumer<String> log;
        volatile Transaction transaction;

        HttpIntegration(Ctx ctx, Consumer<String> log) { this.ctx = ctx; this.log = log; }

        void handle(Socket socket) {
            HttpLite.Request request;
            try {
                socket.setSoTimeout(60000);
                request = HttpLite.readHead(socket.getInputStream());
            } catch (IOException e) {
                try { socket.close(); } catch (IOException x) { /* ignore */ }
                return;
            }
            if (request == null) { try { socket.close(); } catch (IOException x) { /* ignore */ } return; }
            Sender send = sender(socket, request);
            try {
                String host = request.header("host");
                if (host == null || !LOCAL_HOST.matcher(host).matches()) { send.send(400, "text/plain", "Invalid Host header\n"); return; }
                String pathname = request.path.split("\\?", 2)[0];
                String[][] endpoint = PATHS.get(pathname);
                if (endpoint == null) { send.send(404, "text/plain", "No endpoint found\n"); return; }
                String method = request.method;
                if (method.equals("HEAD") || method.equals("OPTIONS")) { send.send(200, null, null); return; }
                if (!Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE").contains(method)) { send.send(501, "text/plain", "Method not implemented\n"); return; }
                String body = "";
                if (!method.equals("GET")) {
                    String length = request.header("content-length");
                    if ((length == null || !length.matches("^[0-9]+$")) && !method.equals("DELETE")) { send.send(400, "text/plain", "Content-length not provided\n"); return; }
                    long n = length == null ? 0 : Long.parseLong(length);
                    if (n > 20_000_000) { send.send(413, "text/plain", "Request is too large\n"); return; }
                    body = new String(HttpLite.readBody(request, (int) n), StandardCharsets.UTF_8);
                }
                socket.setSoTimeout(0); // a document command waits for the user in the picker; never time it out
                if (!Arrays.asList(endpoint[0]).contains(method)) { send.send(400, "text/plain", "Endpoint does not support method\n"); return; }
                // Same rule as Zotero: browsers must send a connector header (blocks cross-site form posts).
                String ua = request.header("user-agent");
                boolean browser = (ua != null && ua.startsWith("Mozilla/")) || request.headers.containsKey("origin");
                if (browser && request.header("x-zotero-connector-api-version") == null && request.header("zotero-allowed-request") == null
                    && !(pathname.equals("/connector/ping") && "navigate".equals(request.header("sec-fetch-mode")))) {
                    socket.close();
                    return;
                }
                Object data = null;
                String ct = request.header("content-type");
                String type = ct == null ? null : ct.split(Text.WS + "*;")[0];
                if (!method.equals("GET") && type != null) {
                    if (!Arrays.asList(endpoint[1]).contains(type)) { send.send(400, "text/plain", "Endpoint does not support content-type\n"); return; }
                    if (type.equals("application/json")) {
                        try { data = Json.parse(body.isEmpty() ? "null" : body); } catch (Json.ParseException e) { send.send(400, "text/plain", "Invalid JSON provided\n"); return; }
                    } else data = body.isEmpty() ? null : body;
                }
                if (pathname.equals("/connector/ping")) {
                    if (method.equals("GET")) send.send(200, "text/html", "<!DOCTYPE html><html><body>Zotero is running</body></html>");
                    else {
                        String emptyHash = md5("");
                        send.send(200, "application/json", Json.stringify(obj("prefs", obj(
                            "automaticSnapshots", false, "downloadAssociatedFiles", false,
                            "supportsAttachmentUpload", false, "supportsTagsAutocomplete", false, "googleDocsAddNoteEnabled", false,
                            "googleDocsAddAnnotationEnabled", false, "canUserAddNote", false, "googleDocsCitationExplorerEnabled", false,
                            "translatorsHash", emptyHash, "sortedTranslatorHash", emptyHash))));
                    }
                    return;
                }
                if (pathname.equals("/connector/sendToBack")) { send.send(200, null, null); return; }
                if (pathname.equals("/connector/document/respond")) {
                    if (data instanceof String) { try { data = Json.parse((String) data); } catch (Json.ParseException e) { /* keep text */ } }
                    Transaction t = transaction;
                    if (t == null || t.waiting == null) { send.send(500, null, null); return; }
                    CompletableFuture<Object> waiting = t.waiting;
                    t.waiting = null;
                    t.send = send;
                    Map<String, Object> d = map(data);
                    if (d != null && Json.truthy(d.get("error"))) {
                        String message = "Alert".equals(d.get("error")) ? Json.jsString(d.get("message")) : "Tab Not Available Error".equals(d.get("error"))
                            ? "The " + (t.processorName != null ? t.processorName : "document") + " tab is no longer available." : "HTTP integration error";
                        waiting.completeExceptionally(new IOException(message));
                    } else waiting.complete(data);
                    return;
                }
                // execCommand
                Map<String, Object> d = map(data);
                if (d == null || !(d.get("command") instanceof String)) { send.send(400, "text/plain", "Missing command\n"); return; }
                String command = (String) d.get("command");
                Transaction current;
                synchronized (this) {
                    if (transaction != null) { send.send(503, "text/plain", "Integration transaction is already in progress"); return; }
                    current = new Transaction();
                    current.send = send;
                    transaction = current;
                }
                Rpc call = (rpc, args) -> {
                    List<Object> rpcArgs = rpc.equals("Application.getActiveDocument") ? new ArrayList<>() : args;
                    String payload = Json.stringify(obj("command", rpc, "arguments", rpcArgs));
                    if (rpc.equals("Document.complete")) {
                        current.send.send(200, "application/json", payload);
                        synchronized (this) { if (transaction == current) transaction = null; }
                        return null;
                    }
                    CompletableFuture<Object> f = new CompletableFuture<>();
                    current.waiting = f;
                    current.send.send(200, "application/json", payload);
                    Object value;
                    try { value = f.get(); }
                    catch (ExecutionException e) { throw e.getCause() instanceof Exception ? (Exception) e.getCause() : e; }
                    if (rpc.equals("Application.getActiveDocument")) {
                        Map<String, Object> v = map(value);
                        current.processorName = v != null && Json.truthy(v.get("processorName")) ? Json.jsString(v.get("processorName")) : "HTTP integration";
                        return arr(3L, v == null ? null : v.get("documentID"), obj(
                            "outputFormat", v != null && Json.truthy(v.get("outputFormat")) ? v.get("outputFormat") : "html",
                            "supportedNotes", v != null && Json.truthy(v.get("supportedNotes")) ? v.get("supportedNotes") : arr("footnotes")));
                    }
                    if (rpc.equals("Document.cursorInField") || rpc.equals("Document.insertField")) return fieldTuple(value);
                    if (rpc.equals("Document.getFields")) return fieldsTuple(value == null ? new ArrayList<>() : value);
                    return value;
                };
                Thread t = new Thread(() -> {
                    try {
                        String note = runSession(command, call, obj("fieldType", "Http", "outputFormat", "html", "supportedNotes", arr("footnotes"),
                            "modernData", true, "setBibliographyStyle", true, "finalCommit", true, "version", COMPAT_VERSION), ctx);
                        log.accept(Text.padEnd(command, 20) + " " + note);
                    } catch (Throwable e) {
                        log.accept("error: " + message(e));
                        current.send.send(500, null, null);
                    } finally {
                        synchronized (this) { if (transaction == current) transaction = null; }
                    }
                }, "zotlet-http-command");
                t.setDaemon(true);
                t.start();
            } catch (Throwable e) {
                log.accept("HTTP error: " + message(e));
                send.send(500, null, null);
            }
        }
    }

    private static String md5(String s) {
        try {
            byte[] h = MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (byte x : h) b.append(String.format("%02x", x & 0xff));
            return b.toString();
        } catch (Exception e) { return ""; }
    }

    // ---------- listeners ----------

    public final ServerSocket tcp, http;
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> { Thread t = new Thread(r, "zotlet-integration"); t.setDaemon(true); return t; });

    private Integration(ServerSocket tcp, ServerSocket http) { this.tcp = tcp; this.http = http; }

    private static ServerSocket listen(String host, int port, Consumer<String> warn) {
        try {
            ServerSocket s = new ServerSocket();
            s.setReuseAddress(!WINDOWS);
            s.bind(new java.net.InetSocketAddress(InetAddress.getByName(host), port));
            return s;
        } catch (java.net.BindException e) {
            warn.accept("Port " + port + " is in use (is Zotero running?). Quit it to cite from LibreOffice/GenOffice with zotlet.");
        } catch (IOException e) {
            warn.accept("Cannot listen on port " + port + ": " + e.getMessage());
        }
        return null;
    }

    /**
     * Start both listeners. A port that is taken (usually by Zotero itself) is skipped with a
     * message instead of failing the whole app.
     */
    public static Integration start(Ctx ctx, String host, int tcpPort, int httpPort, Consumer<String> log, Consumer<String> warn, Detector detect) {
        Integration in = new Integration(listen(host, tcpPort, warn), listen(host, httpPort, warn));
        Detector detector = detect != null ? detect : Integration::libreOfficeClient;
        if (in.tcp != null) in.accept(in.tcp, socket -> {
            try { new TcpClient(socket, ctx, log, detector).read(); } catch (IOException e) { /* gone */ }
        });
        HttpIntegration web = new HttpIntegration(ctx, log);
        if (in.http != null) in.accept(in.http, web::handle);
        return in;
    }

    private void accept(ServerSocket server, Consumer<Socket> handler) {
        Thread t = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket s = server.accept();
                    pool.submit(() -> handler.accept(s));
                } catch (IOException e) {
                    if (server.isClosed()) break;
                }
            }
        }, "zotlet-accept-" + server.getLocalPort());
        t.setDaemon(true);
        t.start();
    }

    public void close() {
        for (ServerSocket s : new ServerSocket[]{tcp, http}) if (s != null) try { s.close(); } catch (IOException e) { /* ignore */ }
        pool.shutdownNow();
        try { pool.awaitTermination(1, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
