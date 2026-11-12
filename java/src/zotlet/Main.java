package zotlet;

import java.io.IOException;
import java.net.BindException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;

import static zotlet.Json.list;
import static zotlet.Json.map;

/** zotlet — a minimal, personal reference manager (port of zotlet.js). */
public final class Main {
    private Main() {}

    public static final int DEFAULT_PORT = 23121;
    private static final boolean COLOR = System.console() != null && System.getenv("NO_COLOR") == null && !Picker.WINDOWS;

    private static String color(int code, String s) { return COLOR ? "\u001b[" + code + "m" + s + "\u001b[0m" : s; }
    private static String dim(String s) { return color(2, s); }
    private static String bold(String s) { return color(1, s); }
    private static String green(String s) { return color(32, s); }
    private static String red(String s) { return color(31, s); }
    private static String yellow(String s) { return color(33, s); }

    private static String help() {
        return bold("zotlet") + " " + dim("— a minimal personal reference manager") + "\n\n"
            + bold("Usage") + "\n"
            + "  zotlet web [--port N] [--open]   start the local web app (default port " + DEFAULT_PORT + ")\n"
            + "             [--no-word]           … without the LibreOffice/GenOffice citation service\n"
            + "  zotlet add <DOI|PMID>...         import references from the command line\n"
            + "  zotlet ls [words]                list or search the library\n"
            + "  zotlet help                      show this message\n\n"
            + dim("Data folder: " + Store.dataDir());
    }

    /** Is zotlet answering on this port? */
    public static boolean isZotlet(int port) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/ping").openConnection(java.net.Proxy.NO_PROXY);
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            try {
                if (c.getResponseCode() != 200) return false;
                Map<String, Object> body = map(Json.parse(new String(Net.readAll(c.getInputStream(), 65536), StandardCharsets.UTF_8)));
                return body != null && "zotlet".equals(body.get("app"));
            } finally { c.disconnect(); }
        } catch (Exception e) {
            return false;
        }
    }

    private static int intOption(List<String> args, String name, String env, int fallback) {
        int i = args.indexOf(name);
        String v = i >= 0 && i + 1 < args.size() ? args.get(i + 1) : System.getenv(env);
        if (i >= 0 && i + 1 >= args.size()) v = "";
        if (v == null) return fallback;
        try {
            int n = Integer.parseInt(v.trim());
            if (n < 0 || n > 65535) throw new NumberFormatException();
            return n;
        } catch (NumberFormatException e) {
            throw new UserError(name + " needs a number between 0 and 65535");
        }
    }

    private static void web(List<String> args) throws Exception {
        Server.Options o = new Server.Options();
        o.port = intOption(args, "--port", "ZOTLET_PORT", DEFAULT_PORT);
        o.tcpPort = intOption(args, "--tcp-port", "ZOTLET_TCP_PORT", Integration.TCP_PORT);
        o.httpPort = intOption(args, "--http-port", "ZOTLET_HTTP_PORT", Integration.HTTP_PORT);
        boolean open = args.contains("--open");
        o.integration = !args.contains("--no-word") && (System.getenv("ZOTLET_NO_WORD") == null || System.getenv("ZOTLET_NO_WORD").isEmpty());
        String client = System.getenv("ZOTLET_TEST_CLIENT");
        if (client != null && !client.isEmpty()) {
            // Tests: pretend every TCP client is this process (e.g. soffice = LibreOffice).
            o.detectClient = (ends) -> Integration.isOffice(client) ? new Integration.Owner(1, client) : null;
        }
        if ("stdout".equals(System.getenv("ZOTLET_OPEN_LOG"))) {
            // Tests: report the picker URL instead of opening a browser.
            o.openUrl = (url) -> { System.out.println("open: " + url); System.out.flush(); };
        }
        Server server;
        try {
            server = Server.start(o);
        } catch (BindException e) {
            if (isZotlet(o.port)) {
                String url = "http://127.0.0.1:" + o.port + "/";
                System.out.println(yellow("•") + " zotlet is already running at " + url);
                if (open) Picker.openBrowser(url);
                return;
            }
            throw new UserError("Port " + o.port + " is used by another program. Start with --port <number> or set ZOTLET_PORT.");
        }
        Map<String, Object> snap = server.store.snapshot();
        System.out.println(bold("zotlet") + " " + dim("·") + " " + server.url);
        System.out.println(dim(list(snap.get("items")).size() + " references · " + list(snap.get("projects")).size() + " projects · " + map(snap.get("paths")).get("library")));
        Integration word = server.integration;
        if (word != null && (word.tcp != null || word.http != null)) {
            List<String> ports = new ArrayList<>();
            if (word.tcp != null) ports.add(String.valueOf(word.tcp.getLocalPort()));
            if (word.http != null) ports.add(String.valueOf(word.http.getLocalPort()));
            System.out.println(dim("LibreOffice / GenOffice citations: on (ports " + String.join(", ", ports) + ")"));
        }
        System.out.println(dim("Keep this window open while you use zotlet. Press Ctrl+C to stop."));
        System.out.flush();
        if (open) Picker.openBrowser(server.url);
        CountDownLatch stop = new CountDownLatch(1);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println(dim("\nzotlet stopped."));
            server.close();
            stop.countDown();
        }));
        stop.await();
    }

    private static void add(List<String> args) throws IOException {
        List<Metadata.Request> requests = Metadata.parseIdentifiers(String.join("\n", args));
        if (requests.isEmpty()) throw new UserError("Give one or more DOIs or PMIDs");
        Store store = new Store(Store.dataDir());
        Net.Fetcher fetch = Net.defaultFetcher();
        for (Metadata.Request request : requests) {
            if (request.kind.equals("invalid")) { System.out.println(red("✗") + " " + request.input + "  " + dim("not a DOI or PMID")); continue; }
            try {
                Map<String, Object> item = Metadata.lookupIdentifier(request, fetch);
                Map<String, Object> result = store.addItems(Arrays.asList(item), null).get(0);
                boolean added = "added".equals(result.get("status"));
                System.out.println((added ? green("✓") : yellow("•")) + " " + bold(String.valueOf(result.get("id"))) + "  "
                    + (added ? map(result.get("item")).get("title") : dim("already in library")));
            } catch (RuntimeException e) {
                System.out.println(red("✗") + " " + request.input + "  " + dim(String.valueOf(e.getMessage())));
            }
        }
    }

    private static String clip(String s, int n) { return s.length() > n ? s.substring(0, n - 1) + "…" : s; }

    private static void ls(List<String> args) throws IOException {
        List<Map<String, Object>> items = new Store(Store.dataDir()).visibleItems();
        List<String> words = new ArrayList<>();
        for (String w : Text.lower(String.join(" ", args)).split(Text.WS + "+")) if (!w.isEmpty()) words.add(w);
        List<Map<String, Object>> hits = new ArrayList<>();
        for (Map<String, Object> i : items) {
            String t = Text.lower(Json.stringify(i));
            boolean all = true;
            for (String w : words) all &= t.contains(w);
            if (all) hits.add(i);
        }
        int width = 4;
        for (Map<String, Object> i : hits) width = Math.max(width, ((String) i.get("id")).length());
        for (Map<String, Object> i : hits) {
            List<Object> authors = list(i.get("author"));
            Map<String, Object> first = authors != null && !authors.isEmpty() ? map(authors.get(0)) : null;
            String who = first == null ? "" : Json.truthy(first.get("family")) ? Json.jsString(first.get("family")) : first.get("literal") == null ? "" : Json.jsString(first.get("literal"));
            List<Object> parts = Export.dateParts(i);
            String year = parts.isEmpty() || parts.get(0) == null ? "" : Json.jsString(parts.get(0));
            String title = Json.truthy(i.get("title")) ? Json.jsString(i.get("title")).replaceAll("<[^>]+>", "") : "";
            System.out.println(bold(Text.padEnd((String) i.get("id"), width)) + "  " + dim(Text.padEnd(clip(Text.trim(who + " " + year), 22), 22)) + "  " + clip(title, 80));
        }
        System.out.println(dim(hits.size() + " of " + items.size() + " references"));
    }

    public static void main(String[] argv) {
        if (System.getProperty("java.net.useSystemProxies") == null && System.getProperty("https.proxyHost") == null) {
            System.setProperty("java.net.useSystemProxies", "true"); // follow the computer's proxy settings for lookups
        }
        try {
            System.setOut(new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true, "UTF-8"));
        } catch (java.io.UnsupportedEncodingException e) { /* keep the default */ }
        List<String> args = new ArrayList<>(Arrays.asList(argv));
        String cmd = args.isEmpty() ? "help" : args.remove(0);
        try {
            switch (cmd) {
                case "web": web(args); break;
                case "add": add(args); break;
                case "ls": ls(args); break;
                default:
                    System.out.println(help());
                    if (!Arrays.asList("help", "-h", "--help").contains(cmd)) System.exit(1);
            }
        } catch (Exception e) {
            System.err.println(red(e.getMessage() == null ? e.toString() : e.getMessage()));
            System.exit(1);
        }
    }

    // ---------- inside another Java program (the TBtools plugin) ----------

    private static Server embedded;

    /**
     * Start zotlet inside this JVM (once) and return the URL of its page. If a zotlet is already
     * answering on the default port (another TBtools tab, or a zotlet started by hand), that one is used.
     */
    public static synchronized String startEmbedded(String appHome) throws Exception {
        if (embedded != null) return embedded.url;
        if (isZotlet(DEFAULT_PORT)) return "http://127.0.0.1:" + DEFAULT_PORT + "/";
        Server.Options o = new Server.Options();
        if (appHome != null) o.home = Home.at(java.nio.file.Paths.get(appHome));
        o.integration = true;
        o.log = (line) -> System.out.println("zotlet: " + line);
        try {
            embedded = Server.start(o);
        } catch (BindException e) {
            o.port = 0; // the default port belongs to another program
            embedded = Server.start(o);
        }
        System.out.println("zotlet: " + embedded.url + " (data: " + embedded.store.libraryFile + ")");
        return embedded.url;
    }
}
