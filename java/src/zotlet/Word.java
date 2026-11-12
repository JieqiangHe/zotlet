package zotlet;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static zotlet.Json.arr;
import static zotlet.Json.list;
import static zotlet.Json.map;
import static zotlet.Json.obj;

/**
 * Microsoft Word, without Zotero. Zotero's Word template (Zotero.dotm, installed into Word's
 * startup folder) adds the Zotero tab; its buttons reach zotlet the way they reach Zotero:
 *
 * macOS   — an HTTP request to 127.0.0.1:23119/integration/macWordCommand (handled in Integration);
 * Windows — WM_COPYDATA to a window of class "ZoteroMessageWindow", opened by the PowerShell helper.
 *
 * zotlet then runs the same document session as for LibreOffice / GenOffice (Integration.runSession),
 * with the document RPCs carried out in Word by a helper process: java/word/word-mac.js (osascript,
 * AppleScript) or java/word/word-win.ps1 (PowerShell, COM). The helper speaks one JSON line per
 * request/answer over stdin/stdout. ZOTLET_WORD_HELPER (a command) and ZOTLET_WORD_MODE (mac|windows)
 * replace the helper and the platform in tests.
 */
public final class Word {
    private Word() {}

    private static final String OS = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT);

    /** "mac", "windows" or "" (no Word on this system). */
    public static String mode() {
        String forced = System.getenv("ZOTLET_WORD_MODE");
        if (forced != null && !forced.isEmpty()) return forced;
        if (OS.startsWith("mac")) return "mac";
        if (OS.startsWith("windows")) return "windows";
        return "";
    }

    // ---------- helper process ----------

    /** One helper process: requests out, answers (and Windows command events) in. */
    static final class Helper implements AutoCloseable {
        private final Process process;
        private final OutputStream in;
        private final Map<Integer, CompletableFuture<Object>> waiting = new ConcurrentHashMap<>();
        private final AtomicInteger ids = new AtomicInteger();
        private final CompletableFuture<Map<String, Object>> ready = new CompletableFuture<>();
        private volatile boolean closed;

        Helper(List<String> command, Map<String, String> env, Consumer<Map<String, Object>> events, Consumer<String> log) throws IOException {
            ProcessBuilder pb = new ProcessBuilder(command);
            pb.environment().putAll(env);
            pb.redirectError(ProcessBuilder.Redirect.INHERIT);
            process = pb.start();
            in = process.getOutputStream();
            Thread reader = new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    for (String line; (line = r.readLine()) != null; ) {
                        line = line.trim();
                        if (!line.startsWith("{")) continue;
                        Map<String, Object> m;
                        try { m = map(Json.parse(line)); } catch (Json.ParseException e) { continue; }
                        if (m == null) continue;
                        if (m.containsKey("event")) {
                            if ("ready".equals(m.get("event"))) ready.complete(m);
                            else if (events != null) events.accept(m);
                            continue;
                        }
                        Object id = m.get("id");
                        CompletableFuture<Object> f = id instanceof Number ? waiting.remove(((Number) id).intValue()) : null;
                        if (f == null) continue;
                        if (m.get("error") != null) f.completeExceptionally(new IOException(Json.jsString(m.get("error"))));
                        else f.complete(m.get("result"));
                    }
                } catch (IOException e) {
                    /* helper gone */
                } finally {
                    closed = true;
                    ready.complete(obj("event", "ready", "warning", "the Word helper stopped"));
                    for (CompletableFuture<Object> f : waiting.values()) f.completeExceptionally(new IOException("The Word helper stopped"));
                    waiting.clear();
                }
            }, "zotlet-word-helper");
            reader.setDaemon(true);
            reader.start();
        }

        /** The helper's first event (Windows: whether the window could be opened). */
        Map<String, Object> awaitReady(long ms) {
            try { return ready.get(ms, TimeUnit.MILLISECONDS); } catch (Exception e) { return obj("event", "ready", "warning", "the Word helper did not start"); }
        }

        Object call(String method, List<Object> args) throws Exception {
            if (closed) throw new IOException("The Word helper stopped");
            int id = ids.incrementAndGet();
            CompletableFuture<Object> f = new CompletableFuture<>();
            waiting.put(id, f);
            byte[] line = (Json.stringify(obj("id", (long) id, "method", method, "args", args)) + "\n").getBytes(StandardCharsets.UTF_8);
            synchronized (in) {
                in.write(line);
                in.flush();
            }
            try { return f.get(); }
            catch (ExecutionException e) { throw e.getCause() instanceof Exception ? (Exception) e.getCause() : e; }
        }

        boolean alive() { return !closed && process.isAlive(); }

        @Override public void close() {
            try { in.close(); } catch (IOException e) { /* gone */ }
            try { if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroy(); } catch (InterruptedException e) { process.destroy(); }
        }
    }

    static List<String> helperCommand(Path wordDir) {
        String custom = System.getenv("ZOTLET_WORD_HELPER");
        if (custom != null && !custom.trim().isEmpty()) return Arrays.asList(custom.trim().split("\\s+"));
        if (mode().equals("windows")) {
            return Arrays.asList("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wordDir.resolve("word-win.ps1").toString());
        }
        return Arrays.asList("/usr/bin/osascript", "-l", "JavaScript", wordDir.resolve("word-mac.js").toString());
    }

    static Map<String, String> helperEnv(Path dataDir) {
        Map<String, String> env = new java.util.HashMap<>();
        if (dataDir != null && System.getenv("ZOTLET_WORD_LOG") == null) env.put("ZOTLET_WORD_LOG", dataDir.resolve("word.log").toString());
        return env;
    }

    // ---------- sessions ----------

    /** Word's buttons, as the session knows them; anything else is not supported. */
    static String sessionCommand(String command) {
        switch (command) {
            case "addCitation": case "editCitation": case "addEditCitation": return "addEditCitation";
            case "addBibliography": case "editBibliography": case "addEditBibliography": return "addEditBibliography";
            case "refresh": case "setDocPrefs": case "removeCodes": return command;
            default: return null;
        }
    }

    /** The session options of Zotero's Word integration (Field / Bookmark, RTF, notes). */
    static Map<String, Object> sessionOptions() {
        return obj("fieldType", "Field", "nativeFieldTypes", arr("Field", "Bookmark"), "bookmarks", true, "outputFormat", "rtf",
            "supportedNotes", arr("footnotes", "endnotes"), "setBibliographyStyle", true, "trackBibliographyStyle", true, "finalCommit", true,
            "version", Integration.COMPAT_VERSION);
    }

    // Button presses run one after another; while one runs, at most one more waits (a double click).
    private static final ExecutorService SESSIONS = Executors.newSingleThreadExecutor(r -> { Thread t = new Thread(r, "zotlet-word-session"); t.setDaemon(true); return t; });
    private static final AtomicInteger queued = new AtomicInteger();

    private static void enqueue(String command, Consumer<String> log, Runnable session) {
        if (queued.incrementAndGet() > 2) { queued.decrementAndGet(); log.accept("Word: busy, ignored " + command); return; }
        SESSIONS.submit(() -> {
            try { session.run(); } finally { queued.decrementAndGet(); }
        });
    }

    /** Run one button press against Word through `helper`. Returns the note for the log. */
    static String run(String command, String documentHint, Helper helper, Integration.Ctx ctx) throws Exception {
        String session = sessionCommand(command);
        Integration.Rpc call = (method, args) -> {
            if (method.equals("Application.getActiveDocument")) {
                Object name = helper.call("init", arr(documentHint == null ? "" : documentHint));
                return arr(3L, name, obj("outputFormat", "rtf", "supportedNotes", arr("footnotes", "endnotes")));
            }
            List<Object> rest = args.isEmpty() ? new ArrayList<>() : new ArrayList<>(args.subList(1, args.size()));
            return helper.call(method, rest);
        };
        if (session == null) {
            call.call("Application.getActiveDocument", arr(3L));
            call.call("Document.displayAlert", arr("doc", "zotlet does not support \"" + command + "\". It inserts citations and bibliographies; notes and annotations need Zotero.", 1L, 0L));
            call.call("Document.complete", arr("doc"));
            return "unsupported: " + command;
        }
        return Integration.runSession(session, call, sessionOptions(), ctx);
    }

    /** macOS: one helper per button press (started when Word calls /integration/macWordCommand). */
    static void runMac(String command, String wordPath, Path wordDir, Path dataDir, Integration.Ctx ctx, Consumer<String> log) {
        enqueue(command, log, () -> {
            Helper helper = null;
            try {
                helper = new Helper(helperCommand(wordDir), helperEnv(dataDir), null, log);
                log.accept(Text.padEnd("Word " + command, 20) + " " + run(command, null, helper, ctx));
            } catch (Throwable e) {
                log.accept("Word error: " + e.getMessage());
            } finally {
                if (helper != null) helper.close();
            }
        });
    }

    /** Windows: a helper that keeps the ZoteroMessageWindow open and runs each button press. */
    static Helper startWindows(Path wordDir, Path dataDir, Integration.Ctx ctx, Consumer<String> log, Consumer<String> warn) {
        Helper[] holder = new Helper[1];
        try {
            holder[0] = new Helper(helperCommand(wordDir), helperEnv(dataDir), (event) -> {
                if (!"command".equals(event.get("event"))) return;
                String command = Json.jsString(event.get("command"));
                String document = event.get("document") == null ? "" : Json.jsString(event.get("document"));
                enqueue(command, log, () -> {
                    try { log.accept(Text.padEnd("Word " + command, 20) + " " + run(command, document, holder[0], ctx)); }
                    catch (Throwable e) { log.accept("Word error: " + e.getMessage()); }
                });
            }, log);
        } catch (IOException e) {
            warn.accept("Word citations are off: PowerShell could not be started (" + e.getMessage() + ").");
            return null;
        }
        Map<String, Object> ready = holder[0].awaitReady(30000);
        if (ready.get("warning") != null) warn.accept("Word citations: " + Json.jsString(ready.get("warning")));
        return holder[0];
    }

    // ---------- installing the Zotero template into Word ----------

    public static final class Install {
        public final boolean ok;
        public final String message;
        Install(boolean ok, String message) { this.ok = ok; this.message = message; }
    }

    static Path macStartupFolder() {
        return Paths.get(System.getProperty("user.home"), "Library", "Group Containers", "UBF8T346G9.Office",
            "User Content.localized", "Startup.localized", "Word");
    }

    static Path macScriptFolder() {
        return Paths.get(System.getProperty("user.home"), "Library", "Application Scripts", "com.microsoft.Word");
    }

    static Path windowsStartupFolder() {
        String appData = System.getenv("APPDATA");
        return appData == null ? null : Paths.get(appData, "Microsoft", "Word", "STARTUP");
    }

    /**
     * Put Zotero's Word template where Word loads it at start (and, on macOS, the script it calls).
     * An existing Zotero.dotm (from Zotero, or from an earlier zotlet) is left alone.
     * `interactive`: when macOS refuses the copy, show the two folders so the user can drag the file.
     */
    public static Install install(Home home, boolean interactive) {
        String mode = mode();
        Path source = home.word.resolve(mode.equals("windows") ? "win" : "mac").resolve("Zotero.dotm");
        if (!Files.isRegularFile(source)) return new Install(false, "the Word template is missing from zotlet (" + source + ")");
        if (mode.equals("mac")) {
            Path office = macStartupFolder().getParent().getParent().getParent();
            if (!Files.isDirectory(office)) return new Install(false, "Microsoft Word was not found (open Word once, then start zotlet again)");
            Path script = macScriptFolder().resolve("Zotero.scpt");
            try {
                if (!Files.isRegularFile(script)) {
                    Files.createDirectories(script.getParent());
                    Files.copy(home.word.resolve("mac").resolve("Zotero.scpt"), script);
                }
            } catch (IOException e) {
                return new Install(false, "could not install " + script + " (" + e.getMessage() + ")");
            }
            return copyTemplate(source, macStartupFolder().resolve("Zotero.dotm"), interactive);
        }
        if (mode.equals("windows")) {
            Path folder = windowsStartupFolder();
            if (folder == null || !Files.isDirectory(folder.getParent())) return new Install(false, "Microsoft Word was not found");
            return copyTemplate(source, folder.resolve("Zotero.dotm"), interactive);
        }
        return new Install(false, "Microsoft Word runs on macOS and Windows only");
    }

    private static Install copyTemplate(Path source, Path target, boolean interactive) {
        if (Files.isRegularFile(target)) return new Install(true, "the Zotero tab is already installed in Word (" + target + ")");
        try {
            Files.createDirectories(target.getParent());
            Path temp = target.resolveSibling(".zotlet-" + System.nanoTime() + ".dotm");
            Files.copy(source, temp);
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            return new Install(true, "installed the Zotero tab in Word (" + target + "). Restart Word to see it.");
        } catch (IOException e) {
            if (interactive && mode().equals("mac")) {
                // macOS 15 protects Office's folder: let Finder (which the user controls) do the copy.
                Proc.spawn(Arrays.asList("/usr/bin/open", "-R", source.toString()));
                Proc.spawn(Arrays.asList("/usr/bin/open", target.getParent().toString()));
                return new Install(false, "macOS did not let zotlet copy the Word template. Two Finder windows are open: drag Zotero.dotm into the "
                    + "\"Word\" startup folder, then restart Word.");
            }
            return new Install(false, "could not copy the Word template to " + target + " (" + e.getMessage() + ")");
        }
    }
}
