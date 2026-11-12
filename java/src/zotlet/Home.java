package zotlet;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Where zotlet's own files are: the web page, the built-in styles, the locale, citeproc-js and the
 * native picker script. In a release (and in the TBtools plugin) they sit next to lib/zotlet.jar;
 * in the source tree they are in the repository (citeproc from node_modules or java/build).
 */
public final class Home {
    public final Path root, pub, styles, locale, citeproc, quickformat;

    private Home(Path root) {
        this.root = root;
        this.pub = root.resolve("public");
        this.styles = root.resolve("styles");
        this.locale = root.resolve("locales").resolve("locales-en-US.xml");
        this.citeproc = first(root.resolve("citeproc").resolve("citeproc_commonjs.js"),
            root.resolve("java").resolve("build").resolve("citeproc").resolve("citeproc_commonjs.js"),
            root.resolve("node_modules").resolve("citeproc").resolve("citeproc_commonjs.js"));
        this.quickformat = first(root.resolve("quickformat.jxa.js"), root.resolve("src").resolve("quickformat.jxa.js"));
    }

    private static Path first(Path... options) {
        for (Path p : options) if (Files.isRegularFile(p)) return p;
        return options[0];
    }

    private static boolean looksLikeHome(Path p) {
        return p != null && Files.isRegularFile(p.resolve("public").resolve("index.html")) && Files.isDirectory(p.resolve("styles"));
    }

    public static Home at(Path root) { return new Home(root.toAbsolutePath().normalize()); }

    /** ZOTLET_APP_HOME / -Dzotlet.home, else found from the location of this class (jar or classes folder). */
    public static Home find() {
        String explicit = System.getProperty("zotlet.home", System.getenv("ZOTLET_APP_HOME"));
        if (explicit != null && !explicit.isEmpty()) return at(Paths.get(explicit));
        try {
            Path p = Paths.get(Home.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            for (Path d = Files.isDirectory(p) ? p : p.getParent(); d != null; d = d.getParent()) if (looksLikeHome(d)) return at(d);
        } catch (Exception e) { /* fall through */ }
        return at(new File(".").toPath());
    }

    public void check() {
        for (Path p : new Path[]{pub.resolve("index.html"), locale, citeproc}) {
            if (!Files.isRegularFile(p)) throw new IllegalStateException("zotlet is incomplete: " + p + " is missing");
        }
    }
}
