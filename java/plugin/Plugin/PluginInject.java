package Plugin;

import biocjava.GUIexcutors.WebGuiApp.WebGuiJPanel;
import java.awt.AWTEvent;
import java.awt.Component;
import java.awt.Container;
import java.awt.Dialog;
import java.awt.Dimension;
import java.awt.EventQueue;
import java.awt.FileDialog;
import java.awt.Frame;
import java.awt.Toolkit;
import java.awt.Window;
import java.awt.event.HierarchyEvent;
import java.awt.event.HierarchyListener;
import java.awt.event.InputMethodEvent;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Proxy;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.text.AttributedCharacterIterator;
import java.text.CharacterIterator;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Optional;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;

/**
 * zotlet as a TBtools plugin: starts zotlet (lib/zotlet.jar, with Rhino for citeproc-js) inside
 * TBtools' Java, once, and shows its page in TBtools' built-in browser (JxBrowser) as a tab.
 * The browser's file chooser and downloads are replaced by native Open / Save dialogs, so
 * "Add .csl file" and Export work. Adapted from svguest's TBtools plugin (jh-html-to-tbtools-plugin).
 *
 * TBtools loads only this jar (the first *.jar in the plugin folder) and may close its class
 * loader after generatePanel(), so zotlet itself runs from lib/ in a class loader of its own.
 */
public class PluginInject {

    private interface Handler { void on(Object params, Object tell) throws Exception; }

    private interface Saver { void to(Path file) throws Exception; }

    private static final String CB = "com.teamdev.jxbrowser.browser.callback.";
    private static final String URL_PROPERTY = "zotlet.plugin.url";
    private static File lastDir;
    private static boolean queued;
    private final File dir;

    public PluginInject() throws Exception {
        File jar = new File(PluginInject.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        dir = jar.getParentFile();
        try (JarFile j = new JarFile(jar)) {
            for (Enumeration<JarEntry> e = j.entries(); e.hasMoreElements(); ) {
                String n = e.nextElement().getName();
                if (n.endsWith(".class")) Class.forName(n.substring(0, n.length() - 6).replace('/', '.'), false, PluginInject.class.getClassLoader());
            }
        } catch (Throwable e) {
            e.printStackTrace();
        }
    }

    /** Start zotlet once per TBtools process (later tabs reuse it) and return its page. */
    private static synchronized String start(File dir) throws Exception {
        String url = System.getProperty(URL_PROPERTY);
        if (url != null) return url;
        List<URL> jars = new ArrayList<>();
        File[] files = new File(dir, "lib").listFiles((d, n) -> n.endsWith(".jar"));
        if (files == null || files.length == 0) throw new IllegalStateException("lib/ is missing from the zotlet plugin folder " + dir);
        for (File f : files) jars.add(f.toURI().toURL());
        // Never closed, and independent of TBtools' classes and of this plugin's class loader.
        ClassLoader loader = new URLClassLoader(jars.toArray(new URL[0]), ClassLoader.getPlatformClassLoader());
        Class<?> main = Class.forName("zotlet.Main", true, loader);
        url = (String) main.getMethod("startEmbedded", String.class).invoke(null, dir.getAbsolutePath());
        System.setProperty(URL_PROPERTY, url);
        return url;
    }

    public JPanel generatePanel() {
        String url;
        try {
            url = start(dir);
        } catch (Throwable e) {
            e.printStackTrace();
            Throwable c = e.getCause() != null ? e.getCause() : e;
            JPanel p = new JPanel(new java.awt.BorderLayout());
            p.add(new JLabel("<html><body style='padding:24px'>zotlet could not start: " + escape(String.valueOf(c.getMessage())) + "</body></html>", SwingConstants.CENTER));
            p.setPreferredSize(new Dimension(1100, 720));
            return p;
        }
        JPanel p;
        try {
            p = browserPanel(url);
        } catch (Throwable e) {
            // TBtools' built-in browser could not start (seen: JxBrowser InvalidLicenseException in
            // WebGuiJPanel.getEngine). zotlet itself is running, so register the plugin anyway and
            // show the page in the system browser.
            e.printStackTrace();
            return fallbackPanel(url, e);
        }
        p.setPreferredSize(new Dimension(1100, 720));
        if (!hook(p)) p.addHierarchyListener(new HierarchyListener() {
            public void hierarchyChanged(HierarchyEvent e) {
                if ((e.getChangeFlags() & HierarchyEvent.SHOWING_CHANGED) == 0 || !p.isShowing()) return;
                if (hook(p)) p.removeHierarchyListener(this);
                else System.err.println("PluginInject: no JxBrowser Browser found in the panel; file dialogs left to TBtools");
            }
        });
        return p;
    }

    public String getPluginName() {
        return dir.getName();
    }

    /**
     * TBtools' browser panel. If its engine refuses the license, try once more after giving JxBrowser
     * TBtools' own key explicitly (the alternative recorded in svguest's TBtools plugin notes).
     */
    private static JPanel browserPanel(String url) throws Throwable {
        try {
            return new WebGuiJPanel(url, false);
        } catch (Throwable first) {
            if (!mentions(first, "License")) throw first;
            try {
                Class<?> hub = Class.forName("toolsKit.LicenseHub.GetLicense", true, PluginInject.class.getClassLoader());
                Object key = hub.getMethod("getJxBroswerLicense").invoke(null);
                if (!(key instanceof String) || ((String) key).isEmpty()) throw first;
                System.setProperty("jxbrowser.license.key", (String) key);
                System.err.println("zotlet: retrying TBtools' browser with its license key set explicitly");
            } catch (Throwable notAvailable) {
                throw first;
            }
            return new WebGuiJPanel(url, false);
        }
    }

    private static boolean mentions(Throwable e, String word) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t.getClass().getName().contains(word) || String.valueOf(t.getMessage()).contains(word)) return true;
            if (t.getCause() == t) break;
        }
        return false;
    }

    private static String rootMessage(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null && t.getCause() != t) t = t.getCause();
        String m = t.getMessage();
        return t.getClass().getSimpleName() + (m == null ? "" : ": " + m);
    }

    /** zotlet runs, but without TBtools' browser: a note and a button that opens the page in the system browser. */
    private static JPanel fallbackPanel(String url, Throwable why) {
        JPanel p = new JPanel(new java.awt.GridBagLayout());
        javax.swing.JButton open = new javax.swing.JButton("Open zotlet in the web browser");
        open.addActionListener(e -> openInBrowser(url));
        JPanel box = new JPanel();
        box.setLayout(new javax.swing.BoxLayout(box, javax.swing.BoxLayout.Y_AXIS));
        JLabel text = new JLabel("<html><body style='width:460px'><b>zotlet is running</b> at " + escape(url)
            + "<br><br>TBtools' built-in browser could not start (" + escape(rootMessage(why)) + "), so zotlet opens in your web browser instead."
            + " Citing from GenOffice / LibreOffice works as usual while TBtools is open.</body></html>");
        text.setAlignmentX(Component.LEFT_ALIGNMENT);
        open.setAlignmentX(Component.LEFT_ALIGNMENT);
        box.add(text);
        box.add(javax.swing.Box.createVerticalStrut(16));
        box.add(open);
        p.add(box);
        p.setPreferredSize(new Dimension(1100, 720));
        // Open the page once, the first time the tab is shown.
        p.addHierarchyListener(new HierarchyListener() {
            public void hierarchyChanged(HierarchyEvent e) {
                if ((e.getChangeFlags() & HierarchyEvent.SHOWING_CHANGED) == 0 || !p.isShowing()) return;
                p.removeHierarchyListener(this);
                openInBrowser(url);
            }
        });
        return p;
    }

    private static void openInBrowser(String url) {
        try {
            if (java.awt.Desktop.isDesktopSupported() && java.awt.Desktop.getDesktop().isSupported(java.awt.Desktop.Action.BROWSE)) {
                java.awt.Desktop.getDesktop().browse(new java.net.URI(url));
                return;
            }
        } catch (Throwable e) { /* try the command line */ }
        String os = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT);
        String[] cmd = os.startsWith("mac") ? new String[]{"open", url} : os.startsWith("windows") ? new String[]{"rundll32", "url.dll,FileProtocolHandler", url} : new String[]{"xdg-open", url};
        try { new ProcessBuilder(cmd).start(); } catch (Throwable e) { System.err.println("zotlet: open " + url + " in your web browser"); }
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private static boolean hook(JPanel p) {
        try {
            Class<?> B = Class.forName("com.teamdev.jxbrowser.browser.Browser", false, PluginInject.class.getClassLoader());
            Object found = browser(B, p);
            for (Class<?> k = p.getClass(); found == null && k != JPanel.class; k = k.getSuperclass())
                for (Field f : k.getDeclaredFields())
                    if (found == null && B.isAssignableFrom(f.getType())) { f.setAccessible(true); found = f.get(p); }
            if (found == null) return false;
            p.putClientProperty(PluginInject.class, found);
            if (System.getProperty("os.name", "").startsWith("Mac")) ime();
            set(found, "OpenFileCallback", (pa, tell) -> load(p, tell));
            set(found, "StartDownloadCallback", (pa, tell) -> save(p, (String) call(call(call(pa, "download"), "target"), "suggestedFileName"), tell, f -> call(tell, "download", f)));
        } catch (Throwable e) {
            e.printStackTrace();
        }
        return true;
    }

    // macOS: full-width punctuation committed by an input method without a composition never
    // reaches JxBrowser's off-screen view; insert it into the focused field directly.
    private static synchronized void ime() {
        if (queued) return;
        queued = true;
        Toolkit.getDefaultToolkit().getSystemEventQueue().push(new EventQueue() {
            private boolean composing;

            protected void dispatchEvent(AWTEvent e) {
                if (e instanceof InputMethodEvent && e.getID() == InputMethodEvent.INPUT_METHOD_TEXT_CHANGED) try {
                    InputMethodEvent m = (InputMethodEvent) e;
                    String s = text(m.getText());
                    boolean was = composing;
                    composing = s.length() > m.getCommittedCharacterCount();
                    if (!was && !composing && !s.isEmpty() && insert(m.getSource(), s)) return;
                } catch (Throwable x) {
                    x.printStackTrace();
                }
                super.dispatchEvent(e);
            }
        });
    }

    private static String text(AttributedCharacterIterator it) {
        if (it == null) return "";
        StringBuilder b = new StringBuilder();
        for (char c = it.first(); c != CharacterIterator.DONE; c = it.next()) b.append(c);
        it.first();
        return b.toString();
    }

    private static boolean insert(Object source, String s) throws Exception {
        Object b = null, f = null;
        for (Object c = source; b == null && c instanceof Component; c = ((Component) c).getParent())
            if (c instanceof JComponent) b = ((JComponent) c).getClientProperty(PluginInject.class);
        if (b == null) return false;
        for (String w : new String[]{"focusedFrame", "mainFrame"}) if (f == null) try {
            f = call(b, w);
            if (f instanceof Optional) f = ((Optional<?>) f).orElse(null);
        } catch (NoSuchMethodException x) {
        }
        if (f == null) return false;
        StringBuilder js = new StringBuilder("document.execCommand('insertText',false,'");
        for (char c : s.toCharArray()) js.append(String.format("\\u%04x", (int) c));
        return Boolean.TRUE.equals(call(f, "executeJavaScript", js.append("')").toString()));
    }

    private static Object browser(Class<?> B, Component c) {
        try {
            Object b = c.getClass().getMethod("getBrowser").invoke(c);
            if (B.isInstance(b)) return b;
        } catch (Exception e) {
        }
        if (c instanceof Container) for (Component x : ((Container) c).getComponents()) {
            Object b = browser(B, x);
            if (b != null) return b;
        }
        return null;
    }

    private static boolean set(Object browser, String name, Handler h) throws Exception {
        ClassLoader cl = PluginInject.class.getClassLoader();
        Class<?> c;
        try {
            c = Class.forName(CB + name, false, cl);
        } catch (ClassNotFoundException e) {
            return false;
        }
        call(browser, "set", c, Proxy.newProxyInstance(cl, new Class<?>[]{c}, (px, m, a) -> {
            if (m.getDeclaringClass() == Object.class)
                return m.getName().equals("equals") ? px == a[0] : m.getName().equals("hashCode") ? System.identityHashCode(px) : "PluginInject." + name;
            if (a != null && a.length == 2) try {
                h.on(a[0], a[1]);
            } catch (Throwable e) {
                e.printStackTrace();
                cancel(a[1]);
            }
            return null;
        }));
        return true;
    }

    private static void save(Component owner, String name, Object tell, Saver s) {
        SwingUtilities.invokeLater(() -> {
            try {
                Window w = SwingUtilities.getWindowAncestor(owner);
                FileDialog d = w instanceof Dialog ? new FileDialog((Dialog) w, "Save", FileDialog.SAVE) : new FileDialog(w instanceof Frame ? (Frame) w : null, "Save", FileDialog.SAVE);
                if (lastDir != null) d.setDirectory(lastDir.getPath());
                d.setFile(name);
                d.setVisible(true);
                if (d.getFile() == null) { cancel(tell); return; }
                lastDir = new File(d.getDirectory());
                s.to(new File(lastDir, d.getFile()).toPath());
            } catch (Throwable e) {
                e.printStackTrace();
                cancel(tell);
            }
        });
    }

    private static void load(Component owner, Object tell) {
        SwingUtilities.invokeLater(() -> {
            try {
                Window w = SwingUtilities.getWindowAncestor(owner);
                FileDialog d = w instanceof Dialog ? new FileDialog((Dialog) w, "Open", FileDialog.LOAD) : new FileDialog(w instanceof Frame ? (Frame) w : null, "Open", FileDialog.LOAD);
                if (lastDir != null) d.setDirectory(lastDir.getPath());
                d.setVisible(true);
                if (d.getFile() == null) { cancel(tell); return; }
                lastDir = new File(d.getDirectory());
                call(tell, "open", new File(lastDir, d.getFile()).toPath());
            } catch (Throwable e) {
                e.printStackTrace();
                cancel(tell);
            }
        });
    }

    private static void cancel(Object tell) {
        try {
            call(tell, "cancel");
        } catch (Throwable e) {
            e.printStackTrace();
        }
    }

    private static Object call(Object o, String name, Object... a) throws Exception {
        Method m = null;
        for (Class<?> k = o.getClass(); m == null && k != null; k = k.getSuperclass())
            for (Class<?> i : k.getInterfaces()) if (m == null && Modifier.isPublic(i.getModifiers())) m = find(i.getMethods(), name, a);
        if (m == null && (m = find(o.getClass().getMethods(), name, a)) != null) m.setAccessible(true);
        if (m == null) throw new NoSuchMethodException(o.getClass().getName() + "." + name);
        return m.invoke(o, a);
    }

    private static Method find(Method[] ms, String name, Object[] a) {
        for (Method m : ms) {
            if (!m.getName().equals(name) || m.getParameterCount() != a.length) continue;
            boolean ok = true;
            for (int i = 0; i < a.length; i++) ok &= m.getParameterTypes()[i].isInstance(a[i]);
            if (ok) return m;
        }
        return null;
    }
}
