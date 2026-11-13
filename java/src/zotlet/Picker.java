package zotlet;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import static zotlet.Json.list;
import static zotlet.Json.map;
import static zotlet.Json.obj;

/**
 * The citation / style picker outside the page: the native macOS pop-up (java/quickformat.jxa.js,
 * like Zotero's quick format bar), Java's own pop-up window for Windows and Linux (QuickPick.java),
 * and, when no window can be shown, the browser picker.
 */
public final class Picker {
    private Picker() {}

    private static final String OS = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT);
    static final boolean MAC = OS.startsWith("mac"), WINDOWS = OS.startsWith("windows");

    // ---------- native picker (macOS) ----------

    private static final Pattern TAGS = Pattern.compile("<[^>]+>");

    static String plain(Object s) {
        return Text.squash(TAGS.matcher(s == null ? "" : Json.jsString(s)).replaceAll(""));
    }

    private static Object yearOf(Map<String, Object> i) {
        Map<String, Object> issued = map(i.get("issued"));
        if (issued == null) return "";
        List<Object> dp = list(issued.get("date-parts"));
        List<Object> first = dp == null || dp.isEmpty() ? null : list(dp.get(0));
        if (first != null && !first.isEmpty() && first.get(0) != null) return first.get(0);
        return issued.get("literal") != null ? issued.get("literal") : "";
    }

    private static String nameOf(Object o) {
        Map<String, Object> n = map(o);
        if (n == null) return "";
        if (Json.truthy(n.get("literal"))) return Json.jsString(n.get("literal"));
        // Chinese names are written whole: 张三, not 张.
        if (hanOnly(n.get("family")) && hanOnly(n.get("given"))) return Json.jsString(n.get("family")) + Json.jsString(n.get("given"));
        List<String> parts = new ArrayList<>();
        for (String k : new String[]{"non-dropping-particle", "family"}) if (Json.truthy(n.get(k))) parts.add(Json.jsString(n.get(k)));
        return String.join(" ", parts);
    }

    private static boolean hanOnly(Object o) {
        return o instanceof String && !((String) o).isEmpty() && ((String) o).codePoints().allMatch(Metadata::isHan);
    }

    private static String authorsShort(Map<String, Object> item) {
        List<Object> a = list(item.get("author"));
        if (a == null || a.isEmpty()) a = list(item.get("editor"));
        if (a == null || a.isEmpty()) return "";
        String first = nameOf(a.get(0));
        boolean han = Metadata.hasHan(first);
        if (a.size() == 1) return first;
        if (a.size() == 2) return first + (han ? "\u3001" : " & ") + nameOf(a.get(1));
        return first + (han ? " \u7b49" : " et al.");
    }

    private static String joinTruthy(String sep, List<Object> parts) {
        List<String> keep = new ArrayList<>();
        for (Object p : parts) if (Json.truthy(p)) keep.add(Json.jsString(p));
        return String.join(sep, keep);
    }

    /** The picker request in the plain shape the native script needs (labels prepared here). */
    public static Map<String, Object> nativeSpec(Map<String, Object> spec, List<Citations.Style> styles, List<Object> projects) {
        List<Object> styleList = new ArrayList<>();
        for (Citations.Style s : styles) styleList.add(obj("id", s.id, "label", s.label));
        Map<String, Object> out = obj("mode", "style".equals(spec.get("mode")) ? "style" : "cite", "style", spec.get("style"),
            "askStyle", Json.truthy(spec.get("askStyle")), "styles", styleList);
        if ("style".equals(out.get("mode"))) {
            if (spec.get("bookmarks") instanceof Boolean) { out.put("bookmarks", spec.get("bookmarks")); out.put("bookmarksLocked", Json.truthy(spec.get("bookmarksLocked"))); }
            return out;
        }
        Map<String, List<Object>> inProjects = new HashMap<>();
        if (projects != null) for (Object o : projects) {
            Map<String, Object> p = map(o);
            List<Object> ids = list(p.get("itemIds"));
            if (ids != null) for (Object id : ids) inProjects.computeIfAbsent(Json.jsString(id), k -> new ArrayList<>()).add(p.get("name"));
        }
        // Newest first, like the library list.
        List<Object> items = list(spec.get("items")) == null ? new ArrayList<>() : new ArrayList<>(list(spec.get("items")));
        Collections.reverse(items);
        List<Object> outItems = new ArrayList<>();
        for (Object o : items) {
            Map<String, Object> item = map(o);
            String id = Json.jsString(item.get("id")), who = authorsShort(item), year = Json.jsString(yearOf(item));
            Object j = Json.truthy(item.get("container-title")) ? item.get("container-title") : Json.truthy(item.get("publisher")) ? item.get("publisher") : "";
            String journal = plain(j);
            String title = plain(item.get("title"));
            List<Object> search = new ArrayList<>(Arrays.asList(id, title, journal, year, item.get("DOI"), item.get("PMID")));
            List<Object> authors = list(item.get("author"));
            if (authors != null) for (Object n : authors) {
                Map<String, Object> m = map(n);
                Object given = m != null && Json.truthy(m.get("given")) ? m.get("given") : "";
                search.add(Json.jsString(given) + " " + nameOf(n));
            }
            search.addAll(inProjects.getOrDefault(id, new ArrayList<>()));
            String shortWho = who.isEmpty() ? (title.length() > 24 ? title.substring(0, 24) : title) : who;
            outItems.add(obj("id", id, "title", title.isEmpty() ? "(untitled)" : title,
                "detail", joinTruthy(" ", Arrays.asList(who, year)),
                "journal", journal,
                "short", joinTruthy(" ", Arrays.asList(shortWho, year)),
                "search", Text.lower(joinTruthy(" ", search))));
        }
        out.put("items", outItems);
        List<Object> selected = new ArrayList<>();
        if (list(spec.get("selected")) != null) for (Object s : list(spec.get("selected"))) selected.add(Json.jsString(s));
        out.put("selected", selected);
        return out;
    }

    /** Check what the native picker returned against the request. null = cancelled. */
    public static Map<String, Object> parseResult(String stdout, Map<String, Object> spec, List<String> styleIds) {
        String text = Text.trim(stdout == null ? "" : stdout);
        if (text.isEmpty()) return null;
        Map<String, Object> value;
        try { value = map(Json.parse(text)); }
        catch (Json.ParseException e) { throw new RuntimeException("The picker returned something unexpected: " + (text.length() > 120 ? text.substring(0, 120) : text)); }
        String style = value != null && value.get("style") instanceof String && styleIds.contains(value.get("style")) ? (String) value.get("style") : null;
        if ("style".equals(spec.get("mode"))) {
            if (style == null) return null;
            return value.get("bookmarks") instanceof Boolean ? obj("style", style, "bookmarks", value.get("bookmarks")) : obj("style", style);
        }
        Set<String> known = new HashSet<>();
        if (list(spec.get("items")) != null) for (Object i : list(spec.get("items"))) known.add(Json.jsString(map(i).get("id")));
        List<Object> ids = new ArrayList<>();
        if (value != null && value.get("ids") instanceof List) for (Object id : list(value.get("ids"))) if (known.contains(Json.jsString(id))) ids.add(Json.jsString(id));
        if (ids.isEmpty()) return null;
        return style != null ? obj("ids", ids, "style", style) : obj("ids", ids);
    }

    /**
     * Which picker to use, from ZOTLET_PICKER: "auto" (the macOS pop-up on a Mac, else Java's own
     * pop-up window, the browser only when neither can be shown), "window" (Java's pop-up, also on
     * a Mac) or "web" (always the browser picker).
     */
    public static String mode() {
        String m = System.getenv("ZOTLET_PICKER");
        return "web".equals(m) ? "web" : "window".equals(m) || "swing".equals(m) ? "window" : "auto";
    }

    /** Java's own pop-up window (QuickPick). The choice, or null if cancelled; throws if no window can be shown. */
    public static Map<String, Object> windowPick(Map<String, Object> spec, List<Citations.Style> styles, List<Object> projects) throws Exception {
        Map<String, Object> answer = QuickPick.show(nativeSpec(spec, styles, projects));
        if (answer == null) return null;
        List<String> ids = new ArrayList<>();
        for (Citations.Style s : styles) ids.add(s.id);
        return parseResult(Json.stringify(answer), spec, ids);
    }

    private static final SecureRandom RANDOM = new SecureRandom();

    /** Show the native picker. The choice, or null if cancelled; throws if it cannot run. */
    public static Map<String, Object> nativePick(Path script, Map<String, Object> spec, List<Citations.Style> styles, List<Object> projects) throws Exception {
        byte[] r = new byte[8];
        RANDOM.nextBytes(r);
        StringBuilder hex = new StringBuilder();
        for (byte b : r) hex.append(String.format("%02x", b & 0xff));
        Path file = Paths.get(System.getProperty("java.io.tmpdir")).resolve("zotlet-pick-" + hex + ".json");
        try {
            Files.write(file, Json.stringify(nativeSpec(spec, styles, projects)).getBytes(StandardCharsets.UTF_8));
            try { Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------")); } catch (UnsupportedOperationException e) { /* fine */ }
            String out = Proc.run(Arrays.asList("/usr/bin/osascript", "-l", "JavaScript", script.toString(), file.toString()), 30L * 60 * 1000);
            List<String> ids = new ArrayList<>();
            for (Citations.Style s : styles) ids.add(s.id);
            return parseResult(out, spec, ids);
        } finally {
            Files.deleteIfExists(file);
        }
    }

    // ---------- browser picker window ----------

    private static final String[] MAC_BROWSERS = {"Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Vivaldi"};
    private static final String[][] WIN_BROWSERS = {{"Google", "Chrome", "Application", "chrome.exe"}, {"Microsoft", "Edge", "Application", "msedge.exe"},
        {"BraveSoftware", "Brave-Browser", "Application", "brave.exe"}};
    private static final String[] LINUX_BROWSERS = {"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"};

    /** The command that opens `url` as an app window of a Chromium-based browser, or null. */
    static List<String> popupCommand(String url) {
        String[] args = {"--app=" + url, "--window-size=780,560"};
        if (MAC) {
            String home = System.getProperty("user.home");
            for (String app : MAC_BROWSERS) {
                if (Files.exists(Paths.get("/Applications", app + ".app")) || Files.exists(Paths.get(home, "Applications", app + ".app"))) {
                    List<String> cmd = new ArrayList<>(Arrays.asList("open", "-na", app, "--args"));
                    cmd.addAll(Arrays.asList(args));
                    return cmd;
                }
            }
        } else if (WINDOWS) {
            for (String base : new String[]{System.getenv("PROGRAMFILES"), System.getenv("PROGRAMFILES(X86)"), System.getenv("LOCALAPPDATA")}) {
                if (base == null || base.isEmpty()) continue;
                for (String[] parts : WIN_BROWSERS) {
                    Path exe = Paths.get(base, parts);
                    if (Files.exists(exe)) { List<String> cmd = new ArrayList<>(); cmd.add(exe.toString()); cmd.addAll(Arrays.asList(args)); return cmd; }
                }
            }
        } else {
            String path = System.getenv("PATH");
            if (path != null) for (String dir : path.split(java.io.File.pathSeparator)) {
                if (dir.isEmpty()) continue;
                for (String name : LINUX_BROWSERS) {
                    Path exe = Paths.get(dir, name);
                    if (Files.isExecutable(exe)) { List<String> cmd = new ArrayList<>(); cmd.add(exe.toString()); cmd.addAll(Arrays.asList(args)); return cmd; }
                }
            }
        }
        return null;
    }

    /** Open a URL in the default browser without blocking or failing the caller. */
    public static void openBrowser(String url) {
        List<String> cmd = MAC ? Arrays.asList("open", url) : WINDOWS ? Arrays.asList("cmd", "/c", "start", "", url) : Arrays.asList("xdg-open", url);
        if (!Proc.spawn(cmd)) System.out.println("Open " + url + " in your browser.");
    }

    /** Open the picker: a pop-up app window when possible, else a browser tab. */
    public static String openPicker(String url) {
        List<String> cmd = popupCommand(url);
        if (cmd != null && Proc.spawn(cmd)) return "window";
        openBrowser(url);
        return "tab";
    }

    /**
     * A message box of zotlet's own (macOS: osascript, which needs no permission for its own alert;
     * elsewhere a Swing dialog), for failures the user would otherwise never see. Does not wait.
     */
    public static void alert(String title, String text) {
        if ("stdout".equals(System.getenv("ZOTLET_OPEN_LOG"))) { System.out.println("alert: " + title + " | " + text.replace('\n', ' ')); System.out.flush(); return; }
        if (MAC) {
            String q = "\"" + title.replace("\\", "\\\\").replace("\"", "\\\"") + "\" message \"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
            if (Proc.spawn(Arrays.asList("/usr/bin/osascript", "-e", "tell me to activate", "-e", "display alert " + q + " as warning"))) return;
        }
        if (QuickPick.available()) {
            java.awt.EventQueue.invokeLater(() -> {
                javax.swing.JOptionPane pane = new javax.swing.JOptionPane(text, javax.swing.JOptionPane.WARNING_MESSAGE);
                javax.swing.JDialog d = pane.createDialog(null, title);
                d.setAlwaysOnTop(true);
                d.setModal(false);
                d.setVisible(true);
            });
        }
    }

    private static final Pattern BUNDLE = Pattern.compile("\"CFBundleIdentifier\"" + Text.WS + "*=" + Text.WS + "*\"([^\"]+)\"");

    /** macOS: the bundle id of the app in front (no permission prompt: uses lsappinfo). */
    public static String frontApp() {
        if (!MAC) return null;
        try {
            String asn = Text.trim(Proc.run(Arrays.asList("/usr/bin/lsappinfo", "front"), 1500));
            String info = Proc.run(Arrays.asList("/usr/bin/lsappinfo", "info", "-only", "bundleid", asn), 1500);
            java.util.regex.Matcher m = BUNDLE.matcher(info);
            return m.find() ? m.group(1) : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** macOS: bring an app back to the front by bundle id (`open -b`, no Apple events). */
    public static void activateApp(String bundleId) {
        if (!MAC || bundleId == null || !bundleId.matches("^[\\w.-]+$")) return;
        Proc.spawn(Arrays.asList("open", "-b", bundleId));
    }
}
