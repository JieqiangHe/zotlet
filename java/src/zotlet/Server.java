package zotlet;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Pattern;

import static zotlet.Json.list;
import static zotlet.Json.map;
import static zotlet.Json.obj;

/** Local HTTP server: static frontend + JSON API, bound to 127.0.0.1 only (port of src/server.js). */
public final class Server {
    private static final Map<String, String[]> STATIC = new HashMap<>();
    static {
        STATIC.put("/", new String[]{"index.html", "text/html"});
        STATIC.put("/app.js", new String[]{"app.js", "text/javascript"});
        STATIC.put("/theme.js", new String[]{"theme.js", "text/javascript"});
        STATIC.put("/style.css", new String[]{"style.css", "text/css"});
        STATIC.put("/pick.html", new String[]{"pick.html", "text/html"});
        STATIC.put("/pick.js", new String[]{"pick.js", "text/javascript"});
    }
    // A citation picker left open this long is cancelled, so the word processor is released.
    private static final long PICK_TIMEOUT = 30L * 60 * 1000;
    private static final List<String> PICK_FIELDS = Arrays.asList("id", "type", "title", "author", "editor", "issued", "container-title", "container-title-short", "publisher", "DOI", "PMID");
    private static final int MAX_IDENTIFIERS = 100;
    private static final long MAX_PDF_BYTES = 300L * 1024 * 1024;
    private static final int LOOKUP_CONCURRENCY = 4;
    private static final String CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

    /** How the server is set up; the defaults are the real app. */
    public static final class Options {
        public int port = 23121;
        public String host = "127.0.0.1";
        public Home home = Home.find();
        public Path dir = Store.dataDir();
        public Net.Fetcher fetch = Net.defaultFetcher();
        public boolean quiet = false;
        public boolean integration = false;
        public int tcpPort = Integration.TCP_PORT, httpPort = Integration.HTTP_PORT;
        public Integration.Detector detectClient = null;
        public Consumer<String> openUrl = Picker::openPicker;
        public Consumer<String> log = System.out::println;
        public boolean nativePicker = Picker.nativeAvailable();
    }

    public final Options options;
    public final Store store;
    public final Citations citations;
    public final StyleRepo repository;
    public final String token;
    public String url;
    public Integration integration;
    private ServerSocket socket;
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> { Thread t = new Thread(r, "zotlet-http"); t.setDaemon(true); return t; });
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r, "zotlet-timer"); t.setDaemon(true); return t; });

    private Server(Options options) {
        this.options = options;
        this.store = new Store(options.dir);
        this.citations = new Citations(options.home, options.dir.resolve("styles"));
        this.repository = new StyleRepo(citations, options.dir.resolve("style-index.json"), options.fetch);
        byte[] t = new byte[24];
        new SecureRandom().nextBytes(t);
        this.token = hex(t);
    }

    static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x & 0xff));
        return s.toString();
    }

    public int port() { return socket.getLocalPort(); }

    public static Server start(Options options) throws IOException {
        options.home.check();
        Server server = new Server(options);
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(!Picker.WINDOWS);
        s.bind(new InetSocketAddress(InetAddress.getByName(options.host), options.port));
        server.socket = s;
        server.url = "http://127.0.0.1:" + s.getLocalPort() + "/";
        Thread accept = new Thread(() -> {
            while (!s.isClosed()) {
                try {
                    Socket c = s.accept();
                    server.pool.submit(() -> server.handle(c));
                } catch (IOException e) {
                    if (s.isClosed()) break;
                }
            }
        }, "zotlet-accept");
        accept.setDaemon(true);
        accept.start();
        if (options.integration) server.startIntegration();
        server.citations.warm();
        return server;
    }

    public void close() {
        if (integration != null) integration.close();
        for (Pick entry : new ArrayList<>(picks.values())) entry.done(null);
        try { socket.close(); } catch (IOException e) { /* ignore */ }
        pool.shutdownNow();
        timers.shutdownNow();
        citations.js.close();
        citations.plainJs.close();
    }

    // ---------- picker ----------

    private final class Pick {
        final String id;
        final Map<String, Object> spec;
        final CompletableFuture<Map<String, Object>> result = new CompletableFuture<>();
        ScheduledFuture<?> timer;
        Runnable back;

        Pick(String id, Map<String, Object> spec) { this.id = id; this.spec = spec; }

        void done(Map<String, Object> value) {
            if (timer != null) timer.cancel(false);
            picks.remove(id);
            if (result.complete(value) && back != null) back.run();
        }
    }

    private final Map<String, Pick> picks = new ConcurrentHashMap<>();

    /**
     * The citation / style picker. On macOS a native pop-up (like Zotero's quick format bar);
     * elsewhere, or if that fails, the browser picker (public/pick.html). Blocks until answered.
     */
    public Map<String, Object> pick(Map<String, Object> spec) throws Exception {
        // Remember the word processor in front, to switch back to it when the picker is done.
        CompletableFuture<String> front = CompletableFuture.supplyAsync(Picker::frontApp, Proc.POOL);
        Runnable back = () -> front.thenAccept(app -> { if (app != null) Picker.activateApp(app); });
        if (options.nativePicker) {
            try {
                Map<String, Object> result = Picker.nativePick(options.home.quickformat, spec, citations.listStyles(), list(store.snapshot().get("projects")));
                back.run();
                return result;
            } catch (Exception e) {
                if (!options.quiet) options.log.accept("Native picker unavailable (" + e.getMessage() + "); using the browser picker.");
            }
        }
        byte[] r = new byte[12];
        new SecureRandom().nextBytes(r);
        Pick entry = new Pick(hex(r), spec);
        entry.back = back;
        entry.timer = timers.schedule(() -> entry.done(null), PICK_TIMEOUT, TimeUnit.MILLISECONDS);
        picks.put(entry.id, entry);
        String target = url + "pick.html?id=" + entry.id;
        front.whenComplete((a, b) -> options.openUrl.accept(target));
        return entry.result.get();
    }

    private Pick pending(Object id) {
        Pick entry = id instanceof String ? picks.get(id) : null;
        if (entry == null) throw new UserError("This request is no longer active. Start it again from your word processor.", 410);
        return entry;
    }

    // ---------- integration ----------

    private void startIntegration() {
        Server self = this;
        Integration.Ctx ctx = new Integration.Ctx() {
            public List<Map<String, Object>> items() throws IOException { return store.visibleItems(); }
            public List<Citations.Style> styles() { return citations.listStyles(); }
            public Map<String, Object> pick(Map<String, Object> spec) throws Exception { return self.pick(spec); }
            public void installStyle(String uri) throws Exception { repository.install(Citations.styleIdFromURI(uri)); }
            public Citations citations() { return citations; }
        };
        SimpleDateFormat clock = new SimpleDateFormat("HH:mm:ss");
        Consumer<String> log = options.quiet ? (line) -> {} : (line) -> options.log.accept(clock.format(new Date()) + "  " + line);
        Consumer<String> warn = options.quiet ? (line) -> {} : options.log;
        integration = Integration.start(ctx, options.host, options.tcpPort, options.httpPort, log, warn, options.detectClient,
            Word.mode().isEmpty() ? null : options.home.word, options.dir);
        if (!Word.mode().isEmpty() && !"0".equals(System.getenv("ZOTLET_WORD_INSTALL"))) installWordPlugin(warn);
    }

    /**
     * Put the Zotero tab into Word if it is not there. The first time a copy is refused (macOS 15
     * protects Office's folder), Finder shows the file and the folder so the user can drag it.
     */
    private void installWordPlugin(Consumer<String> warn) {
        Thread t = new Thread(() -> {
            Path asked = options.dir.resolve(".word-install-asked");
            Word.Install result = Word.install(options.home, !Files.exists(asked));
            if (!result.ok) {
                try { Files.createDirectories(options.dir); Files.write(asked, new byte[0]); } catch (IOException e) { /* only a reminder */ }
            }
            if (!options.quiet && (!result.ok || !result.message.startsWith("the Zotero tab is already"))) warn.accept("Word: " + result.message);
        }, "zotlet-word-install");
        t.setDaemon(true);
        t.start();
    }

    // ---------- request handling ----------

    private static final class Reply {
        int status = 200;
        String type = "application/json";
        byte[] body = new byte[0];
        final Map<String, String> headers = new LinkedHashMap<>();
    }

    private static Reply json(int status, Object value) {
        Reply r = new Reply();
        r.status = status;
        r.body = Json.stringify(value).getBytes(StandardCharsets.UTF_8);
        return r;
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(120000);
            s.setTcpNoDelay(true);
            HttpLite.Request request = HttpLite.readHead(s.getInputStream());
            if (request == null) return;
            Reply reply;
            try {
                reply = route(request);
            } catch (UserError e) {
                reply = json(e.status, obj("error", e.getMessage()));
            } catch (HttpLite.TooLarge e) {
                reply = json(413, obj("error", "Request is too large"));
            } catch (Throwable e) {
                if (!options.quiet) e.printStackTrace();
                reply = json(500, obj("error", e.getMessage() != null ? e.getMessage() : "Unexpected error"));
            }
            write(s.getOutputStream(), reply, request.method.equals("HEAD"));
        } catch (IOException e) {
            /* client went away */
        }
    }

    private static void write(OutputStream out, Reply r, boolean head) throws IOException {
        StringBuilder h = new StringBuilder("HTTP/1.1 " + r.status + " " + HttpLite.reason(r.status) + "\r\n");
        boolean binary = r.headers.containsKey("Content-Type");
        if (!binary) h.append("Content-Type: ").append(r.type).append("; charset=utf-8\r\n");
        for (Map.Entry<String, String> e : r.headers.entrySet()) h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        h.append("Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n");
        h.append("Content-Security-Policy: ").append(CSP).append("\r\n");
        h.append("Content-Length: ").append(r.body.length).append("\r\nConnection: close\r\n\r\n");
        byte[] header = h.toString().getBytes(StandardCharsets.UTF_8);
        byte[] all = new byte[header.length + (head ? 0 : r.body.length)];
        System.arraycopy(header, 0, all, 0, header.length);
        if (!head) System.arraycopy(r.body, 0, all, header.length, r.body.length);
        out.write(all); // one write: no wait for a delayed ACK between head and body
        out.flush();
    }

    private Reply route(HttpLite.Request req) throws Exception {
        int actual = port();
        String host = req.header("host");
        if (!("127.0.0.1:" + actual).equals(host) && !("localhost:" + actual).equals(host)) return json(403, obj("error", "Invalid Host header"));
        String pathname = req.path, query = "";
        int q = pathname.indexOf('?');
        if (q >= 0) { query = pathname.substring(q + 1); pathname = pathname.substring(0, q); }
        int hash = pathname.indexOf('#');
        if (hash >= 0) pathname = pathname.substring(0, hash);

        if (req.method.equals("GET") && pathname.equals("/api/ping")) return json(200, obj("app", "zotlet"));
        if (req.method.equals("GET") && STATIC.containsKey(pathname)) {
            String[] file = STATIC.get(pathname);
            Path source = options.home.pub.resolve(file[0]);
            if (!Files.isRegularFile(source)) {
                // Seen when the TBtools plugin folder was removed or replaced while TBtools kept running.
                Reply r = new Reply();
                r.status = 500;
                r.type = "text/plain";
                r.body = ("zotlet's files are missing (" + source + ").\n\nIf zotlet runs in TBtools and the plugin was removed or "
                    + "reinstalled, quit TBtools and open it again. Otherwise reinstall zotlet.\n").getBytes(StandardCharsets.UTF_8);
                return r;
            }
            String content = new String(Files.readAllBytes(source), StandardCharsets.UTF_8);
            if (file[0].endsWith(".html")) content = content.replaceFirst("__ZOTLET_TOKEN__", token);
            Reply r = new Reply();
            r.type = file[1];
            r.body = content.getBytes(StandardCharsets.UTF_8);
            return r;
        }
        if (!pathname.startsWith("/api/")) return json(404, obj("error", "Not found"));

        // Every API call needs the per-process token embedded in the page (blocks other sites).
        String supplied = req.header("x-zotlet-token");
        if (supplied == null || !MessageDigest.isEqual(supplied.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8))) {
            return json(403, obj("error", "The page is out of date. Reload it."));
        }

        if (req.method.equals("POST") && pathname.equals("/api/export")) return exportFile(readBody(req));
        if (req.method.equals("POST") && pathname.equals("/api/pdf/import")) return json(200, importPdf(req, query));
        String route = req.method + " " + pathname;
        if (!API.contains(route)) return json(404, obj("error", "Not found"));
        Map<String, Object> body = req.method.equals("POST") ? readBody(req) : new LinkedHashMap<>();
        return json(200, api(route, body));
    }

    private static final java.util.Set<String> API = new java.util.HashSet<>(Arrays.asList(
        "GET /api/state", "POST /api/styles/search", "POST /api/styles/install", "POST /api/styles/add", "POST /api/styles/remove",
        "POST /api/import", "POST /api/import-csl", "POST /api/items/create", "POST /api/items/update", "POST /api/items/delete",
        "POST /api/projects/create", "POST /api/projects/rename", "POST /api/projects/delete", "POST /api/projects/add", "POST /api/projects/remove",
        "POST /api/pick/get", "POST /api/pick/done", "POST /api/cite"));

    private static final Pattern JSON_TYPE = Pattern.compile("^application/json\\b", Pattern.CASE_INSENSITIVE);

    private static Map<String, Object> readBody(HttpLite.Request req) throws IOException {
        String type = req.header("content-type");
        if (type == null || !JSON_TYPE.matcher(type).find()) throw new UserError("Expected application/json", 415);
        byte[] bytes;
        try { bytes = HttpLite.readBody(req, 2_000_000L); } catch (HttpLite.TooLarge e) { throw new UserError("Request is too large", 413); }
        String text = new String(bytes, StandardCharsets.UTF_8);
        Object body;
        try { body = Json.parse(text.isEmpty() ? "{}" : text); } catch (Json.ParseException e) { throw new UserError("Invalid JSON"); }
        if (!(body instanceof Map)) throw new UserError("Expected a JSON object");
        return map(body);
    }

    private static List<String> stringList(Object value, String what) {
        if (!(value instanceof List)) throw new UserError("Expected a list of " + what);
        List<String> out = new ArrayList<>();
        for (Object v : list(value)) {
            if (!(v instanceof String)) throw new UserError("Expected a list of " + what);
            out.add((String) v);
        }
        return out;
    }

    private static List<String> stringList(Object value) { return stringList(value, "ids"); }

    private static boolean empty(Object v) {
        return v == null || (v instanceof String && Text.trim((String) v).isEmpty()) || (v instanceof List && ((List<?>) v).isEmpty());
    }

    /** Validate a manual/edited reference. Returns a clean patch (null = remove that field). */
    public static Map<String, Object> validateFields(Object fieldsValue, boolean creating) {
        Map<String, Object> fields = map(fieldsValue);
        if (fields == null) throw new UserError("Expected reference fields");
        for (String key : fields.keySet()) if (!Metadata.ITEM_FIELDS.contains(key)) throw new UserError("Unsupported field: " + key);
        Map<String, Object> present = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : fields.entrySet()) if (!empty(e.getValue())) present.put(e.getKey(), e.getValue());
        if ((creating || fields.containsKey("title")) && !(present.get("title") instanceof String)) throw new UserError("A title is required");
        // Same normalization as imported metadata, so manual items obey identical rules.
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("title", "untitled");
        raw.putAll(present);
        Map<String, Object> clean = Metadata.normalizeItem(raw);
        Map<String, Object> patch = new LinkedHashMap<>();
        for (String key : fields.keySet()) patch.put(key, present.containsKey(key) && clean.containsKey(key) ? clean.get(key) : null);
        if (creating || fields.containsKey("type")) patch.put("type", clean.get("type"));
        return patch;
    }

    private List<Map<String, Object>> selectItems(Object ids) throws IOException {
        List<Map<String, Object>> all = store.visibleItems();
        if (!(ids instanceof List)) return all;
        Map<String, Map<String, Object>> byId = new HashMap<>();
        for (Map<String, Object> i : all) byId.put((String) i.get("id"), i);
        List<Map<String, Object>> out = new ArrayList<>();
        for (String id : stringList(ids)) if (byId.containsKey(id)) out.add(byId.get(id));
        return out;
    }

    private static String projectId(Object value) {
        return value instanceof String && !((String) value).isEmpty() ? (String) value : null;
    }

    private Map<String, Object> state() throws IOException {
        Map<String, Object> out = store.snapshot();
        out.put("styles", citations.styleList());
        return out;
    }

    private Object api(String route, Map<String, Object> body) throws Exception {
        switch (route) {
            case "GET /api/state": return state();
            case "POST /api/styles/search":
                return repository.search(body.get("query") instanceof String ? (String) body.get("query") : "", Json.truthy(body.get("refresh")));
            case "POST /api/styles/install":
                if (!(body.get("name") instanceof String)) throw new UserError("Missing style name");
                return obj("installed", repository.install((String) body.get("name")), "styles", citations.styleList());
            case "POST /api/styles/add":
                if (!(body.get("xml") instanceof String)) throw new UserError("Choose a .csl file");
                return obj("installed", repository.addFile(body.get("xml")), "styles", citations.styleList());
            case "POST /api/styles/remove":
                if (!(body.get("id") instanceof String)) throw new UserError("Missing style id");
                return obj("removed", repository.remove((String) body.get("id")), "styles", citations.styleList());
            case "POST /api/import": return importIdentifiers(body);
            case "POST /api/import-csl": return importCSL(body);
            case "POST /api/items/create": {
                Map<String, Object> fields = new LinkedHashMap<>();
                for (Map.Entry<String, Object> e : validateFields(body.get("fields"), true).entrySet()) if (e.getValue() != null) fields.put(e.getKey(), e.getValue());
                Map<String, Object> result = store.addItems(Arrays.asList(fields), projectId(body.get("projectId"))).get(0);
                if ("duplicate".equals(result.get("status"))) throw new UserError("That DOI/PMID is already in the library as \"" + result.get("id") + "\"", 409);
                return result;
            }
            case "POST /api/items/update":
                if (!(body.get("id") instanceof String)) throw new UserError("Missing reference id");
                return obj("item", store.updateItem((String) body.get("id"), validateFields(body.get("fields"), false)));
            case "POST /api/items/delete": return store.deleteItems(stringList(body.get("ids")));
            case "POST /api/projects/create": return store.createProject(body.get("name"));
            case "POST /api/projects/rename": return store.renameProject(body.get("id"), body.get("name"));
            case "POST /api/projects/delete": return store.deleteProject(body.get("id"));
            case "POST /api/projects/add": return store.addToProject(body.get("id"), stringList(body.get("itemIds")));
            case "POST /api/projects/remove": return store.removeFromProject(body.get("id"), stringList(body.get("itemIds")));
            case "POST /api/pick/get": {
                Map<String, Object> spec = pending(body.get("id")).spec;
                List<Object> items = new ArrayList<>();
                if (list(spec.get("items")) != null) for (Object o : list(spec.get("items"))) {
                    Map<String, Object> item = map(o), out = new LinkedHashMap<>();
                    for (String k : PICK_FIELDS) if (item.containsKey(k)) out.put(k, item.get(k));
                    items.add(out);
                }
                List<Object> projects = new ArrayList<>();
                for (Object o : list(store.snapshot().get("projects"))) {
                    Map<String, Object> p = map(o);
                    projects.add(obj("id", p.get("id"), "name", p.get("name"), "itemIds", p.get("itemIds")));
                }
                Map<String, Object> out = obj("mode", spec.get("mode"), "style", spec.get("style"), "askStyle", Json.truthy(spec.get("askStyle")),
                    "selected", spec.get("selected") != null ? spec.get("selected") : new ArrayList<>(), "items", items);
                if (spec.get("bookmarks") != null) out.put("bookmarks", spec.get("bookmarks"));
                out.put("bookmarksLocked", Json.truthy(spec.get("bookmarksLocked")));
                out.put("projects", projects);
                out.put("styles", citations.styleList());
                return out;
            }
            case "POST /api/pick/done": {
                Pick entry = pending(body.get("id"));
                if (Json.truthy(body.get("cancel"))) { entry.done(null); return obj("ok", true); }
                String style = body.get("style") instanceof String && citations.find((String) body.get("style")) != null ? (String) body.get("style") : null;
                if ("style".equals(entry.spec.get("mode"))) {
                    if (style == null) throw new UserError("Choose a citation style");
                    entry.done(body.get("bookmarks") instanceof Boolean ? obj("style", style, "bookmarks", body.get("bookmarks")) : obj("style", style));
                } else {
                    List<String> ids = stringList(body.get("ids"));
                    if (ids.isEmpty()) throw new UserError("Choose at least one reference");
                    Map<String, Object> result = obj("ids", new ArrayList<Object>(ids));
                    if (style != null) result.put("style", style);
                    entry.done(result);
                }
                return obj("ok", true);
            }
            case "POST /api/cite": {
                List<Map<String, Object>> items = selectItems(body.get("ids"));
                if (items.isEmpty()) throw new UserError("No references to format");
                Object style = body.get("style");
                return citations.formatCitations(Json.truthy(style) ? Json.jsString(style) : "nature", items);
            }
            default: throw new UserError("Not found", 404);
        }
    }

    private Map<String, Object> importIdentifiers(Map<String, Object> body) throws Exception {
        if (!(body.get("text") instanceof String)) throw new UserError("Paste one or more DOIs or PMIDs");
        List<Metadata.Request> requests = Metadata.parseIdentifiers(body.get("text"));
        if (requests.isEmpty()) throw new UserError("Paste one or more DOIs or PMIDs");
        if (requests.size() > MAX_IDENTIFIERS) throw new UserError("Import at most " + MAX_IDENTIFIERS + " identifiers at a time");
        String projectId = projectId(body.get("projectId"));
        ExecutorService lookups = Executors.newFixedThreadPool(Math.min(LOOKUP_CONCURRENCY, requests.size()), r -> { Thread t = new Thread(r, "zotlet-lookup"); t.setDaemon(true); return t; });
        List<Future<Object[]>> futures = new ArrayList<>();
        try {
            for (Metadata.Request request : requests) {
                futures.add(lookups.submit(() -> {
                    if (request.kind.equals("invalid")) return new Object[]{request, null, "Not a DOI or PMID"};
                    try { return new Object[]{request, Metadata.lookupIdentifier(request, options.fetch), null}; }
                    catch (RuntimeException e) { return new Object[]{request, null, e.getMessage()}; }
                }));
            }
            List<Object[]> looked = new ArrayList<>();
            for (Future<Object[]> f : futures) looked.add(f.get());
            List<Map<String, Object>> found = new ArrayList<>();
            for (Object[] r : looked) if (r[1] != null) found.add(Json.map(r[1]));
            List<Map<String, Object>> saved = found.isEmpty() ? new ArrayList<>() : store.addItems(found, projectId);
            List<Object> results = new ArrayList<>();
            int k = 0;
            for (Object[] r : looked) {
                Metadata.Request request = (Metadata.Request) r[0];
                if (r[1] != null) {
                    Map<String, Object> s = saved.get(k++);
                    results.add(obj("input", request.input, "status", s.get("status"), "id", s.get("id"), "title", map(s.get("item")).get("title")));
                } else results.add(obj("input", request.input, "status", "error", "message", r[2]));
            }
            return obj("results", results);
        } finally {
            lookups.shutdown();
        }
    }

    // A CSL JSON file (e.g. exported from Zotero, or from zotlet). Same normalization as DOI imports.
    private Map<String, Object> importCSL(Map<String, Object> body) throws IOException {
        List<Object> items = list(body.get("items"));
        if (items == null) throw new UserError("Expected a CSL JSON array of references");
        if (items.size() > 20000) throw new UserError("That file is too large");
        List<Map<String, Object>> clean = new ArrayList<>();
        long skipped = 0;
        for (Object raw : items) {
            Map<String, Object> m = map(raw);
            if (m == null || (!(m.get("title") instanceof String) && !(m.get("title") instanceof List))) { skipped++; continue; }
            try { clean.add(Metadata.normalizeItem(m)); } catch (RuntimeException e) { skipped++; }
        }
        if (clean.isEmpty()) throw new UserError("No references found in this file (expected CSL JSON)");
        List<Map<String, Object>> saved = store.addItems(clean, projectId(body.get("projectId")));
        long added = 0, duplicates = 0;
        List<Object> ids = new ArrayList<>();
        for (Map<String, Object> r : saved) {
            if ("added".equals(r.get("status"))) added++;
            if ("duplicate".equals(r.get("status"))) duplicates++;
            ids.add(r.get("id"));
        }
        return obj("added", added, "duplicates", duplicates, "skipped", skipped, "ids", ids);
    }

    private static Map<String, String> query(String q) {
        Map<String, String> out = new LinkedHashMap<>();
        for (String part : q.split("&")) {
            if (part.isEmpty()) continue;
            int eq = part.indexOf('=');
            String k = eq < 0 ? part : part.substring(0, eq), v = eq < 0 ? "" : part.substring(eq + 1);
            try {
                k = Text.decodeURIComponent(k.replace('+', ' '));
                v = Text.decodeURIComponent(v.replace('+', ' '));
            } catch (IllegalArgumentException e) { continue; }
            out.putIfAbsent(k, v);
        }
        return out;
    }

    /** A PDF dropped on the page: read its DOI and import it like a typed DOI. The PDF is not kept. */
    private Map<String, Object> importPdf(HttpLite.Request req, String query) throws IOException {
        String type = req.header("content-type");
        if (type == null || !Pattern.compile("^application/pdf\\b", Pattern.CASE_INSENSITIVE).matcher(type).find()) throw new UserError("Expected a PDF", 415);
        byte[] bytes;
        try { bytes = HttpLite.readBody(req, MAX_PDF_BYTES); } catch (HttpLite.TooLarge e) { throw new UserError("The PDF is too large (300 MB at most)", 413); }
        String head = new String(bytes, 0, Math.min(1024, bytes.length), StandardCharsets.ISO_8859_1);
        if (!head.contains("%PDF-")) throw new UserError("This file is not a PDF");
        String name = "";
        try { name = Text.decodeURIComponent(req.header("x-file-name") == null ? "" : req.header("x-file-name")); } catch (IllegalArgumentException e) { /* keep empty */ }
        Pdf.Found found = Pdf.extractDOI(bytes);
        List<Metadata.Request> requests = found != null ? Metadata.parseIdentifiers(found.doi) : new ArrayList<>();
        if (requests.isEmpty() || !requests.get(0).kind.equals("doi")) return obj("file", name, "status", "no-doi");
        Metadata.Request request = requests.get(0);
        Map<String, Object> out = obj("file", name, "doi", request.value);
        Map<String, Object> item;
        try { item = Metadata.lookupIdentifier(request, options.fetch); }
        catch (RuntimeException e) { out.put("status", "error"); out.put("message", e.getMessage()); return out; }
        String projectId = query(query).get("projectId");
        Map<String, Object> saved = store.addItems(Arrays.asList(item), projectId == null || projectId.isEmpty() ? null : projectId).get(0);
        out.put("status", saved.get("status"));
        out.put("id", saved.get("id"));
        out.put("title", map(saved.get("item")).get("title"));
        return out;
    }

    private static String contentDisposition(String name) {
        StringBuilder ascii = new StringBuilder();
        for (char c : name.toCharArray()) ascii.append(c < 0x20 || c > 0x7e || c == '"' || c == '\\' ? '_' : c);
        return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + Text.encodeURIComponent(name);
    }

    public static String safeFileName(Object name) {
        String s = Json.truthy(name) ? Json.jsString(name) : "library";
        s = s.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]+", " ").replaceAll(Text.WS + "+", " ");
        s = Text.trim(s);
        if (s.length() > 80) s = s.substring(0, 80);
        return s.isEmpty() ? "library" : s;
    }

    private Reply exportFile(Map<String, Object> body) throws IOException {
        Export.Format format = body.get("format") instanceof String ? Export.FORMATS.get(body.get("format")) : null;
        if (format == null) throw new UserError("Choose zip, CSL JSON, BibTeX or RIS");
        List<Map<String, Object>> items = selectItems(body.get("ids"));
        if (items.isEmpty()) throw new UserError("Nothing to export");
        String base = safeFileName(body.get("name")), name = base + "." + format.extension;
        boolean binary = format.extension.equals("zip");
        Reply r = new Reply();
        r.headers.put("Content-Type", binary ? format.mime : format.mime + "; charset=utf-8");
        r.headers.put("Content-Disposition", contentDisposition(name));
        r.headers.put("X-Item-Count", String.valueOf(items.size()));
        r.body = format.render(items, base);
        return r;
    }
}
