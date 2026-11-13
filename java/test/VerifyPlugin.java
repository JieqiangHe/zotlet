import java.io.File;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Comparator;

/**
 * Loads an unpacked zotlet.plugin the way TBtools does (the first top-level jar in its own class
 * loader, Plugin.PluginInject, generatePanel(), then the loader may be closed) and checks that zotlet
 * serves its page and formats a citation. Prints "OK ..." lines; exits 1 on the first failure.
 *
 *   java -cp <TBtools stand-ins or TBtools' jar>:<this compiled> VerifyPlugin <plugin folder> [reinstall <plugin zip>]
 *
 * With TBtools' stand-ins (java/test/tbtools) it runs anywhere; -Dstub.licenses chooses which browser
 * licence keys work (see WebGuiJPanel there). With TBtools' real jar and no JxBrowser it stops at
 * creating the browser, which the plugin then reports with its fallback panel.
 */
public class VerifyPlugin {
    static void check(boolean ok, String what) {
        if (!ok) { System.out.println("FAIL " + what); System.exit(1); }
        System.out.println("OK " + what);
    }

    static Object[] open(File dir) throws Exception {
        File[] jars = dir.listFiles((d, n) -> n.endsWith(".jar"));
        check(jars != null && jars.length == 1, "one top-level jar in " + dir.getName() + " (TBtools loads the first)");
        URLClassLoader loader = new URLClassLoader(new URL[]{jars[0].toURI().toURL()}, VerifyPlugin.class.getClassLoader());
        Class<?> c = Class.forName("Plugin.PluginInject", true, loader);
        Object plugin = c.getConstructor().newInstance();
        Object name = c.getMethod("getPluginName").invoke(plugin);
        Object panel = c.getMethod("generatePanel").invoke(plugin);
        loader.close(); // TBtools may close the plugin's loader once the panel exists
        return new Object[]{name, panel};
    }

    static String get(String url) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection(Proxy.NO_PROXY);
        if (h.getResponseCode() != 200) return "HTTP " + h.getResponseCode();
        return new String(h.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    }

    static String post(String url, String token, String json) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection(Proxy.NO_PROXY);
        h.setRequestMethod("POST");
        h.setDoOutput(true);
        h.setRequestProperty("Content-Type", "application/json");
        h.setRequestProperty("X-Zotlet-Token", token);
        h.getOutputStream().write(json.getBytes(StandardCharsets.UTF_8));
        return h.getResponseCode() + " " + new String((h.getResponseCode() < 400 ? h.getInputStream() : h.getErrorStream()).readAllBytes(), StandardCharsets.UTF_8);
    }

    public static void main(String[] args) throws Exception {
        String fakeOs = System.getProperty("verify.osName");
        if (fakeOs != null) {
            // Pretend to be another OS (the Intel-build licence test) only after the JDK has set up sockets,
            // fonts and Swing for the real one: with -Dos.name at start a Linux JDK loads macOS-only classes.
            new java.net.ServerSocket(0).close();
            new javax.swing.JLabel("<html>x</html>").getFont().getFamily();
            System.setProperty("os.name", fakeOs);
        }
        File dir = new File(args[0]);
        Object[] first = open(dir);
        check("zotlet".equals(first[0]), "the plugin is named after its folder: " + first[0]);
        String panel = first[1].getClass().getName();
        System.out.println("   panel: " + panel);
        String url = System.getProperty("zotlet.plugin.url");
        check(url != null && url.startsWith("http://127.0.0.1:"), "zotlet started inside this JVM at " + url);
        String html = get(url);
        check(html.contains("zotlet-token"), "the page loads after the plugin's class loader was closed");
        String token = html.replaceAll("(?s).*name=\"zotlet-token\" content=\"([0-9a-f]+)\".*", "$1");
        check(post(url + "api/items/create", token, "{\"fields\":{\"title\":\"A test\",\"author\":[{\"family\":\"Chen\",\"given\":\"C\"}],\"issued\":{\"date-parts\":[[2023]]}}}").startsWith("200"), "a reference can be added");
        String cite = post(url + "api/cite", token, "{\"style\":\"cell\"}");
        check(cite.startsWith("200") && cite.contains("Chen, C. (2023). A test."), "citeproc (Rhino) formats it: " + cite.replaceAll(".*\"text\":\"([^\"]*)\"}}$", "$1"));

        Object[] second = open(dir);
        check(url.equals(System.getProperty("zotlet.plugin.url")), "a second tab uses the same zotlet");

        if (args.length > 2 && args[1].equals("reinstall")) {
            try (var walk = Files.walk(dir.toPath())) { walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete()); }
            check(get(url).startsWith("HTTP 500"), "with the plugin folder removed, the page says its files are missing");
            Process unzip = new ProcessBuilder("unzip", "-q", "-o", args[2], "-d", dir.getParent()).inheritIO().start();
            check(unzip.waitFor() == 0, "the plugin is installed again");
            open(dir);
            String again = System.getProperty("zotlet.plugin.url");
            check(get(again).contains("zotlet-token"), "opening the reinstalled plugin replaces the old zotlet (" + again + ")");
        }
        System.out.println("OK all checks passed");
        System.exit(0);
    }
}
