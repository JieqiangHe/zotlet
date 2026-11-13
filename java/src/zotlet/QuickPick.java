package zotlet;

import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Desktop;
import java.awt.Dimension;
import java.awt.EventQueue;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.GraphicsDevice;
import java.awt.GraphicsEnvironment;
import java.awt.MouseInfo;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.RenderingHints;
import java.awt.Shape;
import java.awt.Toolkit;
import java.awt.BasicStroke;
import java.awt.event.InputEvent;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.awt.geom.Path2D;
import java.awt.geom.RoundRectangle2D;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.DefaultListModel;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JList;
import javax.swing.JMenuItem;
import javax.swing.JPanel;
import javax.swing.JPopupMenu;
import javax.swing.JScrollBar;
import javax.swing.JScrollPane;
import javax.swing.JTextField;
import javax.swing.KeyStroke;
import javax.swing.ListCellRenderer;
import javax.swing.ListSelectionModel;
import javax.swing.Timer;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;
import javax.swing.plaf.basic.BasicScrollBarUI;

import static zotlet.Json.list;
import static zotlet.Json.map;
import static zotlet.Json.obj;

/**
 * The citation / style pop-up drawn by Java itself (Swing), for Windows and Linux and as the
 * second choice on macOS: a launcher-style card over the word processor (rounded, a large search
 * line, a result list, a bar with the keys; light or dark like the system), with the same
 * request, answer and keys as the macOS one (java/quickformat.jxa.js).
 *
 * Keys: type to search · ↑↓ move · Enter adds the highlighted reference (Enter on an empty search,
 * or Ctrl/⌘ Enter, inserts) · ⌫ on an empty search removes the last reference · double-click
 * inserts · Esc cancels.
 */
public final class QuickPick {
    private QuickPick() {}

    /** What the window shows and what the keys do; no AWT here, so it can be checked anywhere. */
    public static final class Model {
        public final boolean cite;
        private final Map<String, Object> spec;
        private final List<Map<String, Object>> all = new ArrayList<>();
        public List<Map<String, Object>> rows = new ArrayList<>();
        public final List<String> chosen = new ArrayList<>();
        public int cursor = -1;

        public Model(Map<String, Object> spec) {
            this.spec = spec;
            cite = !"style".equals(spec.get("mode"));
            List<Object> source = list(spec.get(cite ? "items" : "styles"));
            if (source != null) for (Object o : source) all.add(map(o));
            if (cite && list(spec.get("selected")) != null) {
                for (Object id : list(spec.get("selected"))) if (byId(Json.jsString(id)) != null && !chosen.contains(Json.jsString(id))) chosen.add(Json.jsString(id));
            }
            filter("");
            if (!cite) for (int i = 0; i < rows.size(); i++) if (rows.get(i).get("id").equals(spec.get("style"))) cursor = i;
        }

        private Map<String, Object> byId(String id) {
            for (Map<String, Object> i : all) if (id.equals(i.get("id"))) return i;
            return null;
        }

        /** Rows that contain every word of the query; the first one is highlighted. */
        public void filter(String query) {
            List<String> words = new ArrayList<>();
            for (String w : Text.lower(query == null ? "" : query).split("[\\s\\u3000]+")) if (!w.isEmpty()) words.add(w);
            rows = new ArrayList<>();
            for (Map<String, Object> r : all) {
                String hay = cite ? Json.jsString(r.get("search")) : Text.lower(Json.jsString(r.get("label")) + " " + Json.jsString(r.get("id")));
                boolean ok = true;
                for (String w : words) if (!hay.contains(w)) { ok = false; break; }
                if (ok) rows.add(r);
            }
            cursor = rows.isEmpty() ? -1 : 0;
        }

        public void move(int by) {
            if (!rows.isEmpty()) cursor = Math.max(0, Math.min(rows.size() - 1, cursor + by));
        }

        public Map<String, Object> highlighted() {
            return cursor >= 0 && cursor < rows.size() ? rows.get(cursor) : null;
        }

        public boolean isChosen(Map<String, Object> row) {
            return cite && chosen.contains(row.get("id"));
        }

        /** Add the highlighted reference to the citation. */
        public void add() {
            Map<String, Object> h = highlighted();
            if (h != null && !chosen.contains(h.get("id"))) chosen.add((String) h.get("id"));
        }

        public boolean removeLast() {
            if (!cite || chosen.isEmpty()) return false;
            chosen.remove(chosen.size() - 1);
            return true;
        }

        /** What Enter does with this search text: "add" the highlighted reference, or "finish". */
        public String enter(String query, boolean modifier) {
            boolean empty = Text.trim(query == null ? "" : query).isEmpty();
            if (!cite || modifier || empty) return "finish";
            return "add";
        }

        /** The line under the search field. */
        public String status() {
            if (!cite) return "Type to search · ↑↓ choose · Enter sets the style · Esc cancels";
            if (chosen.isEmpty()) return "Type to search · ↑↓ choose · Enter adds · Enter again inserts · Esc cancels";
            List<String> names = new ArrayList<>();
            for (String id : chosen) { Map<String, Object> i = byId(id); names.add(i == null ? id : Json.jsString(i.get("short"))); }
            return "Citing: " + String.join("; ", names) + "   —   Enter inserts · ⌫ removes the last";
        }

        /** The short note at the left of the bottom bar. */
        public String note() {
            if (!cite) return rows.size() + (rows.size() == 1 ? " style" : " styles");
            if (chosen.isEmpty()) return rows.size() + (rows.size() == 1 ? " reference" : " references");
            return chosen.size() + " in this citation";
        }

        /** The label of a chosen reference (for its chip). */
        public String label(String id) {
            Map<String, Object> i = byId(id);
            return i == null ? id : Json.jsString(i.get("short"));
        }

        public void remove(String id) { chosen.remove(id); }

        /** The answer (the shape Picker.parseResult checks), or null when there is nothing to answer yet. */
        public Map<String, Object> result(String styleId, Boolean bookmarks) {
            if (!cite) {
                Map<String, Object> h = highlighted();
                if (h == null) return null;
                Map<String, Object> out = obj("style", h.get("id"));
                if (bookmarks != null) out.put("bookmarks", bookmarks);
                return out;
            }
            if (chosen.isEmpty()) add();
            if (chosen.isEmpty()) return null;
            Map<String, Object> out = obj("ids", new ArrayList<Object>(chosen));
            if (styleId != null) out.put("style", styleId);
            return out;
        }
    }

    /** A window can be shown here (there is a screen). */
    public static boolean available() {
        try { return !GraphicsEnvironment.isHeadless(); } catch (Throwable e) { return false; }
    }

    private static final long TIMEOUT_MINUTES = 30;
    static final String TITLE = "zotlet citation";

    // ---------- look ----------

    /** The page's palette (public/style.css), light and dark. */
    static final class Theme {
        final boolean dark;
        final Color card, bar, line, text, soft, muted, accent, onAccent, row, key, chip;

        Theme(boolean dark) {
            this.dark = dark;
            card = new Color(dark ? 0x262624 : 0xfcfbf8);
            bar = new Color(dark ? 0x2b2a28 : 0xf7f5f0);
            line = new Color(dark ? 0x3a3936 : 0xe6e2d8);
            text = new Color(dark ? 0xecebe6 : 0x1f1e1c);
            soft = new Color(dark ? 0xc3c1b8 : 0x57554f);
            muted = new Color(dark ? 0x8f8d85 : 0x78756c);
            accent = new Color(dark ? 0xd97757 : 0xb05430);
            onAccent = new Color(dark ? 0x1f1e1d : 0xffffff);
            row = new Color(dark ? 0x32312e : 0xefece4);
            key = new Color(dark ? 0x3a3936 : 0xe9e5db);
            chip = new Color(dark ? 0x4b3329 : 0xf0dbd0);
        }
    }

    /** Dark like the system? ZOTLET_PICKER_THEME=dark|light decides; else the system setting is read. */
    static boolean systemDark() {
        String forced = System.getenv("ZOTLET_PICKER_THEME");
        if ("dark".equals(forced)) return true;
        if ("light".equals(forced)) return false;
        try {
            if (Picker.MAC) return Proc.run(Arrays.asList("/usr/bin/defaults", "read", "-g", "AppleInterfaceStyle"), 1500).toLowerCase(java.util.Locale.ROOT).contains("dark");
            if (Picker.WINDOWS) {
                return Proc.run(Arrays.asList("reg", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "/v", "AppsUseLightTheme"), 1500).contains("0x0");
            }
            return Proc.run(Arrays.asList("gsettings", "get", "org.gnome.desktop.interface", "color-scheme"), 1500).contains("dark");
        } catch (Exception e) {
            return false; // light: the key is absent (macOS in light mode) or the tool is not there
        }
    }

    private static String family;

    /** A screen font that has Latin and Chinese glyphs: PingFang (macOS), Microsoft YaHei UI (Windows), else Java's Sans Serif. */
    private static synchronized String family() {
        if (family == null) {
            family = Font.SANS_SERIF;
            String wanted = Picker.MAC ? "PingFang SC" : Picker.WINDOWS ? "Microsoft YaHei UI" : null;
            try {
                if (wanted != null && Arrays.asList(GraphicsEnvironment.getLocalGraphicsEnvironment().getAvailableFontFamilyNames()).contains(wanted)) family = wanted;
            } catch (RuntimeException e) { /* keep Sans Serif */ }
        }
        return family;
    }

    static Font font(float size, boolean bold) {
        return new Font(family(), bold ? Font.BOLD : Font.PLAIN, 1).deriveFont(size);
    }

    /** `font`, or Java's Sans Serif (which falls back between fonts) when it lacks a character of `text`. */
    static Font fit(Font font, String text) {
        return font.canDisplayUpTo(text) < 0 ? font : new Font(Font.SANS_SERIF, font.getStyle(), 1).deriveFont(font.getSize2D());
    }

    static Graphics2D smooth(Graphics g) {
        Graphics2D g2 = (Graphics2D) g;
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g2.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
        return g2;
    }

    /** `text` cut with an ellipsis to fit `width`. */
    static String clip(String text, FontMetrics fm, int width) {
        if (width <= 0) return "";
        if (fm.stringWidth(text) <= width) return text;
        int n = text.length();
        while (n > 0 && fm.stringWidth(text.substring(0, n) + "…") > width) n--;
        return n == 0 ? "" : text.substring(0, n).trim() + "…";
    }

    static void drawText(Graphics2D g, String text, Font font, Color color, int x, int baseline) {
        g.setFont(fit(font, text));
        g.setColor(color);
        g.drawString(text, x, baseline);
    }

    /** Windows that are open now (tests look here). */
    public static final List<Window> OPEN = new java.util.concurrent.CopyOnWriteArrayList<>();

    /** Show the pop-up and wait. The answer, or null if cancelled; throws if no window can be shown. */
    public static Map<String, Object> show(Map<String, Object> nativeSpec) throws Exception {
        if (!available()) throw new IllegalStateException("no screen");
        Theme theme = new Theme(systemDark());
        CompletableFuture<Map<String, Object>> answer = new CompletableFuture<>();
        Window[] window = new Window[1];
        EventQueue.invokeLater(() -> {
            try { window[0] = new Window(new Model(nativeSpec), answer, theme); window[0].open(); }
            catch (Throwable e) { answer.completeExceptionally(e); }
        });
        try {
            return answer.get(TIMEOUT_MINUTES, TimeUnit.MINUTES);
        } catch (TimeoutException e) {
            return null;
        } catch (java.util.concurrent.ExecutionException e) {
            throw new RuntimeException(String.valueOf(e.getCause() == null ? e : e.getCause()));
        } finally {
            EventQueue.invokeLater(() -> { if (window[0] != null) window[0].close(); });
        }
    }

    // ---------- the window ----------

    /** The Swing window around a Model. Everything here runs on the event thread. */
    public static final class Window {
        static final int WIDTH = 720, HEIGHT = 474, RADIUS = 14, ROW = 40;

        public final Model model;
        final CompletableFuture<Map<String, Object>> answer;
        final Theme t;
        public final JDialog dialog = new JDialog((java.awt.Frame) null, TITLE);
        public final JTextField field;
        final DefaultListModel<Map<String, Object>> listModel = new DefaultListModel<>();
        final JList<Map<String, Object>> list;
        final List<String> styleIds = new ArrayList<>(), styleLabels = new ArrayList<>();
        int style = -1;
        boolean bookmarks, hasBookmarks, bookmarksLocked;
        /** Soft shadow around the card (needs a translucent window). */
        final boolean glass;
        final int pad;
        JComponent head, chips, foot, note;
        Hint primary, second;

        Window(Model model, CompletableFuture<Map<String, Object>> answer, Theme theme) {
            this.model = model;
            this.answer = answer;
            this.t = theme;
            boolean translucent = false;
            try {
                translucent = GraphicsEnvironment.getLocalGraphicsEnvironment().getDefaultScreenDevice()
                    .isWindowTranslucencySupported(GraphicsDevice.WindowTranslucency.PERPIXEL_TRANSLUCENT);
            } catch (RuntimeException e) { /* a plain window */ }
            glass = translucent;
            pad = glass ? 22 : 0;
            field = new Search();
            list = new Rows();
            build();
        }

        private void build() {
            dialog.setUndecorated(true);
            dialog.setAlwaysOnTop(true);
            dialog.setDefaultCloseOperation(JDialog.DISPOSE_ON_CLOSE);
            try { dialog.setType(java.awt.Window.Type.UTILITY); } catch (RuntimeException e) { /* not on this platform */ }

            JPanel card = new Card();
            card.setLayout(new BorderLayout());
            card.setBorder(BorderFactory.createEmptyBorder(pad + 1, pad + 1, pad + 1, pad + 1));

            // Head: the search line (+ the style of a new document), then the references chosen so far.
            field.setFont(font(19, false));
            field.setForeground(t.text);
            field.setCaretColor(t.accent);
            field.setSelectionColor(t.chip);
            field.setSelectedTextColor(t.text);
            field.setOpaque(false);
            field.setBorder(BorderFactory.createEmptyBorder(4, 0, 4, 0));
            JPanel line = new JPanel(new BorderLayout(10, 0));
            line.setOpaque(false);
            line.setBorder(BorderFactory.createEmptyBorder(14, 20, 12, 14));
            line.add(field, BorderLayout.CENTER);
            List<Object> styles = list(model.spec.get("styles"));
            if (model.cite && Json.truthy(model.spec.get("askStyle")) && styles != null && !styles.isEmpty()) {
                for (Object o : styles) {
                    Map<String, Object> s = map(o);
                    styleIds.add(Json.jsString(s.get("id")));
                    styleLabels.add(Json.jsString(s.get("label")));
                    if (s.get("id").equals(model.spec.get("style"))) style = styleIds.size() - 1;
                }
                if (style < 0) style = 0;
                line.add(new StylePill(), BorderLayout.EAST);
            }
            chips = new Chips();
            JPanel headPanel = new JPanel(new BorderLayout());
            headPanel.setOpaque(false);
            headPanel.add(line, BorderLayout.NORTH);
            headPanel.add(chips, BorderLayout.SOUTH);
            head = headPanel;
            card.add(head, BorderLayout.NORTH);

            // Results.
            list.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
            list.setFocusable(false); // typing always goes to the search field
            list.setFixedCellHeight(ROW);
            list.setOpaque(false);
            list.setCellRenderer(new RowView());
            list.addMouseListener(new MouseAdapter() {
                @Override public void mouseClicked(MouseEvent e) {
                    int row = list.locationToIndex(e.getPoint());
                    if (row < 0 || !list.getCellBounds(row, row).contains(e.getPoint())) return;
                    model.cursor = row;
                    if (e.getClickCount() >= 2) { if (model.cite) model.add(); finish(true); }
                    else render();
                }
            });
            JScrollPane scroll = new JScrollPane(list);
            scroll.setOpaque(false);
            scroll.getViewport().setOpaque(false);
            scroll.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 4));
            scroll.setHorizontalScrollBarPolicy(JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
            JScrollBar bar = scroll.getVerticalScrollBar();
            bar.setUI(new ThinBar());
            bar.setOpaque(false);
            bar.setPreferredSize(new Dimension(10, 0));
            bar.setUnitIncrement(ROW);
            card.add(scroll, BorderLayout.CENTER);

            // Bottom bar: a note (or the bookmarks choice) on the left, what the keys do on the right.
            JPanel bottom = new JPanel();
            bottom.setLayout(new BoxLayout(bottom, BoxLayout.X_AXIS));
            bottom.setOpaque(false);
            bottom.setBorder(BorderFactory.createEmptyBorder(0, 18, 0, 12));
            bottom.setPreferredSize(new Dimension(10, 42));
            if (!model.cite && model.spec.get("bookmarks") instanceof Boolean) {
                hasBookmarks = true;
                bookmarks = (Boolean) model.spec.get("bookmarks");
                bookmarksLocked = Json.truthy(model.spec.get("bookmarksLocked"));
                note = new Check("Also open in Microsoft Word with Zotero (bookmarks)");
            } else {
                note = new Note();
            }
            bottom.add(note);
            bottom.add(Box.createHorizontalGlue());
            String mod = Picker.MAC ? "⌘" : "Ctrl";
            second = new Hint("Insert now", new String[]{mod, "↵"}, false, () -> finish(true));
            primary = new Hint("", new String[]{"↵"}, true, () -> key(KeyEvent.VK_ENTER, false));
            bottom.add(new Hint("Cancel", new String[]{"esc"}, false, () -> finish(false)));
            bottom.add(second);
            bottom.add(primary);
            foot = bottom;
            card.add(foot, BorderLayout.SOUTH);

            field.getDocument().addDocumentListener(new DocumentListener() {
                void changed() { model.filter(field.getText()); render(); }
                @Override public void insertUpdate(DocumentEvent e) { changed(); }
                @Override public void removeUpdate(DocumentEvent e) { changed(); }
                @Override public void changedUpdate(DocumentEvent e) { changed(); }
            });
            field.addKeyListener(new KeyAdapter() {
                @Override public void keyPressed(KeyEvent e) { if (key(e.getKeyCode(), (e.getModifiersEx() & (InputEvent.CTRL_DOWN_MASK | InputEvent.META_DOWN_MASK)) != 0)) e.consume(); }
            });
            // Esc works wherever the focus is.
            card.registerKeyboardAction(e -> finish(false), KeyStroke.getKeyStroke(KeyEvent.VK_ESCAPE, 0), JComponent.WHEN_IN_FOCUSED_WINDOW);

            // The window has no title bar: drag it by its background.
            MouseAdapter drag = new MouseAdapter() {
                Point from;
                @Override public void mousePressed(MouseEvent e) { from = e.getPoint(); }
                @Override public void mouseDragged(MouseEvent e) {
                    Point at = e.getLocationOnScreen();
                    if (from != null) dialog.setLocation(at.x - from.x, at.y - from.y);
                }
            };
            card.addMouseListener(drag);
            card.addMouseMotionListener(drag);

            dialog.addWindowListener(new WindowAdapter() {
                @Override public void windowClosed(WindowEvent e) { OPEN.remove(Window.this); answer.complete(null); }
            });
            dialog.setContentPane(card);
            dialog.setSize(WIDTH + 2 * pad, HEIGHT + 2 * pad);
            if (glass) {
                try { dialog.setBackground(new Color(0, 0, 0, 0)); } catch (RuntimeException e) { /* square corners */ }
            } else {
                // No translucency (e.g. Linux without a compositor): cut the corners instead.
                try { dialog.setShape(new RoundRectangle2D.Float(0, 0, WIDTH, HEIGHT, RADIUS * 2, RADIUS * 2)); } catch (RuntimeException e) { /* square corners */ }
            }
            render();
        }

        /** A key pressed in the search field; true when it was used. */
        public boolean key(int code, boolean modifier) {
            switch (code) {
                case KeyEvent.VK_ESCAPE: finish(false); return true;
                case KeyEvent.VK_DOWN: model.move(1); render(); return true;
                case KeyEvent.VK_UP: model.move(-1); render(); return true;
                case KeyEvent.VK_PAGE_DOWN: model.move(8); render(); return true;
                case KeyEvent.VK_PAGE_UP: model.move(-8); render(); return true;
                case KeyEvent.VK_ENTER:
                    if ("add".equals(model.enter(field.getText(), modifier))) { model.add(); field.setText(""); render(); }
                    else finish(true);
                    return true;
                case KeyEvent.VK_BACK_SPACE:
                    if (field.getText().isEmpty() && model.removeLast()) { render(); return true; }
                    return false;
                default: return false;
            }
        }

        void render() {
            if (listModel.size() != model.rows.size() || !Arrays.asList(listModel.toArray()).equals(model.rows)) {
                listModel.clear();
                for (Map<String, Object> r : model.rows) listModel.addElement(r);
            }
            if (model.cursor >= 0) { list.setSelectedIndex(model.cursor); list.ensureIndexIsVisible(model.cursor); }
            else list.clearSelection();
            boolean searching = !Text.trim(field.getText()).isEmpty();
            primary.label = !model.cite ? "Use this style" : searching ? "Add to citation" : "Insert citation";
            primary.setVisible(model.highlighted() != null || (model.cite && !model.chosen.isEmpty()));
            second.setVisible(model.cite && searching && model.highlighted() != null);
            chips.setVisible(model.cite && !model.chosen.isEmpty());
            for (JComponent c : new JComponent[]{primary, second, note, chips}) { c.revalidate(); c.repaint(); }
            dialog.getContentPane().repaint();
        }

        void finish(boolean ok) {
            if (ok) {
                Map<String, Object> result = model.result(style >= 0 ? styleIds.get(style) : null, hasBookmarks ? Boolean.valueOf(bookmarks) : null);
                if (result == null) return;
                answer.complete(result);
            } else {
                answer.complete(null);
            }
            close();
        }

        void open() {
            // Centered, in the upper part of the screen the pointer is on (where the word processor is).
            Rectangle screen;
            try { screen = MouseInfo.getPointerInfo().getDevice().getDefaultConfiguration().getBounds(); }
            catch (RuntimeException e) { screen = new Rectangle(Toolkit.getDefaultToolkit().getScreenSize()); }
            dialog.setLocation(screen.x + (screen.width - dialog.getWidth()) / 2, screen.y + Math.max(40, (int) (screen.height * 0.4) - dialog.getHeight() / 2));
            OPEN.add(this);
            dialog.setVisible(true);
            toFront();
            String keys = System.getenv("ZOTLET_PICK_KEYS");
            if (keys != null && !keys.isEmpty()) play(keys.split(";"), 0);
            // Windows may refuse the keyboard to a program in the background: ask once more, through the shell.
            if (Picker.WINDOWS) {
                Timer timer = new Timer(350, e -> {
                    if (dialog.isShowing() && !dialog.isFocused()) {
                        Proc.spawn(Arrays.asList("powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
                            "(New-Object -ComObject WScript.Shell).AppActivate('" + TITLE + "')"));
                    }
                });
                timer.setRepeats(false);
                timer.start();
            }
        }

        /** Tests (ZOTLET_PICK_KEYS="type:apple;enter;enter"): press these keys in the window, one after another. */
        private void play(String[] steps, int at) {
            if (at >= steps.length || !dialog.isDisplayable()) return;
            Timer timer = new Timer(120, e -> {
                String step = steps[at].trim();
                if (step.startsWith("type:")) field.setText(step.substring(5));
                else if (step.equals("enter")) key(KeyEvent.VK_ENTER, false);
                else if (step.equals("down")) key(KeyEvent.VK_DOWN, false);
                else if (step.equals("up")) key(KeyEvent.VK_UP, false);
                else if (step.equals("backspace")) key(KeyEvent.VK_BACK_SPACE, false);
                else if (step.equals("esc")) key(KeyEvent.VK_ESCAPE, false);
                play(steps, at + 1);
            });
            timer.setRepeats(false);
            timer.start();
        }

        private void toFront() {
            try {
                Desktop d = Desktop.isDesktopSupported() ? Desktop.getDesktop() : null;
                if (d != null && d.isSupported(Desktop.Action.APP_REQUEST_FOREGROUND)) d.requestForeground(false);
            } catch (RuntimeException e) { /* best effort */ }
            dialog.toFront();
            dialog.requestFocus();
            field.requestFocusInWindow();
        }

        void close() {
            OPEN.remove(this);
            if (dialog.isDisplayable()) dialog.dispose();
        }

        // ---------- parts ----------

        /** The rounded card: shadow, background, the lines under the head and over the bottom bar. */
        private final class Card extends JPanel {
            Card() { setOpaque(false); }

            @Override protected void paintComponent(Graphics g0) {
                Graphics2D g = smooth(g0.create());
                int w = getWidth() - 2 * pad, h = getHeight() - 2 * pad;
                if (glass) {
                    for (int i = 0; i < pad; i++) {
                        g.setColor(new Color(0, 0, 0, t.dark ? 7 : 4));
                        g.fill(new RoundRectangle2D.Float(i, i + 5, getWidth() - 2 * i, getHeight() - 2 * i, 2 * (RADIUS + pad - i), 2 * (RADIUS + pad - i)));
                    }
                } else {
                    g.setColor(t.card);
                    g.fillRect(0, 0, getWidth(), getHeight());
                }
                Shape body = new RoundRectangle2D.Float(pad, pad, w, h, 2 * RADIUS, 2 * RADIUS);
                g.setColor(t.card);
                g.fill(body);
                Shape old = g.getClip();
                g.clip(body);
                if (foot != null) {
                    g.setColor(t.bar);
                    g.fillRect(pad, foot.getY(), w, foot.getHeight() + 2);
                    g.setColor(t.line);
                    g.fillRect(pad, foot.getY(), w, 1);
                }
                if (head != null) {
                    g.setColor(t.line);
                    g.fillRect(pad, head.getY() + head.getHeight(), w, 1);
                }
                g.setClip(old);
                g.setColor(t.dark ? new Color(0x4b4945) : new Color(0xd5d0c3));
                g.setStroke(new BasicStroke(1f));
                g.draw(new RoundRectangle2D.Float(pad + 0.5f, pad + 0.5f, w - 1, h - 1, 2 * RADIUS, 2 * RADIUS));
                g.dispose();
            }
        }

        /** The search line: no box, a placeholder while empty. */
        private final class Search extends JTextField {
            @Override protected void paintComponent(Graphics g) {
                smooth(g);
                super.paintComponent(g);
                if (!getText().isEmpty()) return;
                String hint = model.cite ? "Search references…" : "Search citation styles…";
                FontMetrics fm = g.getFontMetrics(getFont());
                drawText((Graphics2D) g, hint, getFont(), t.muted, getInsets().left + 2, (getHeight() - fm.getHeight()) / 2 + fm.getAscent());
            }
        }

        /** The list; says so when nothing matches. */
        private final class Rows extends JList<Map<String, Object>> {
            Rows() { super(listModel); }

            // Rows are as wide as the window: long titles are cut with an ellipsis, authors and year stay visible.
            @Override public boolean getScrollableTracksViewportWidth() { return true; }
            @Override public boolean getScrollableTracksViewportHeight() { return getModel().getSize() == 0; }

            @Override protected void paintComponent(Graphics g0) {
                super.paintComponent(g0);
                if (getModel().getSize() > 0) return;
                Graphics2D g = smooth(g0);
                String text = model.cite ? "No references match" : "No styles match";
                Font f = font(14, false);
                FontMetrics fm = g.getFontMetrics(f);
                drawText(g, text, f, t.muted, (getWidth() - fm.stringWidth(text)) / 2, getHeight() / 2);
            }
        }

        /** One result: a mark (in the citation or not), the title, the journal, and authors + year on the right. */
        private final class RowView extends JComponent implements ListCellRenderer<Map<String, Object>> {
            Map<String, Object> row;
            boolean selected;

            @Override public Component getListCellRendererComponent(JList<? extends Map<String, Object>> l, Map<String, Object> value, int index, boolean isSelected, boolean focus) {
                row = value;
                selected = isSelected;
                return this;
            }

            @Override protected void paintComponent(Graphics g0) {
                Graphics2D g = smooth(g0.create());
                int w = getWidth(), h = getHeight();
                if (selected) {
                    g.setColor(t.row);
                    g.fill(new RoundRectangle2D.Float(0, 1, w - 4, h - 2, 16, 16));
                }
                boolean chosen = model.isChosen(row);
                int x = 14;
                if (model.cite) {
                    int cy = h / 2;
                    if (chosen) {
                        g.setColor(t.accent);
                        g.fillOval(x, cy - 8, 16, 16);
                        Path2D tick = new Path2D.Float();
                        tick.moveTo(x + 4.4, cy + 0.3); tick.lineTo(x + 7.1, cy + 3); tick.lineTo(x + 11.8, cy - 2.9);
                        g.setColor(t.onAccent);
                        g.setStroke(new BasicStroke(1.7f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
                        g.draw(tick);
                    } else {
                        g.setColor(t.dark ? new Color(0x5a5853) : new Color(0xc9c4b6));
                        g.setStroke(new BasicStroke(1.3f));
                        g.drawOval(x + 1, cy - 7, 14, 14);
                    }
                    x += 28;
                }
                Font titleFont = font(14, false), small = font(12.5f, false);
                String detail = model.cite ? Json.jsString(row.get("detail")) : "";
                String journal = model.cite && row.get("journal") != null ? Json.jsString(row.get("journal")) : "";
                String title = Json.jsString(row.get(model.cite ? "title" : "label"));
                FontMetrics tm = g.getFontMetrics(fit(titleFont, title)), sm = g.getFontMetrics(fit(small, detail + journal));
                int right = w - 18;
                int baseline = (h - tm.getHeight()) / 2 + tm.getAscent();
                if (!detail.isEmpty()) {
                    int dw = sm.stringWidth(detail);
                    drawText(g, detail, small, t.muted, right - dw, baseline);
                    right -= dw + 16;
                }
                int room = right - x;
                int journalRoom = journal.isEmpty() ? 0 : Math.min(sm.stringWidth(journal) + 12, room / 3);
                String shown = clip(title, tm, room - journalRoom);
                drawText(g, shown, titleFont, t.text, x, baseline);
                if (!journal.isEmpty()) {
                    int jx = x + tm.stringWidth(shown) + 12;
                    String j = clip(journal, sm, right - jx);
                    if (j.length() > 3) drawText(g, j, small, t.muted, jx, baseline);
                }
                g.dispose();
            }
        }

        /** The references chosen so far, as chips; a click removes one. */
        private final class Chips extends JComponent {
            final List<Rectangle> boxes = new ArrayList<>();
            final Font f = font(12.5f, false);

            Chips() {
                setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
                setToolTipText("Click a reference to take it out of the citation");
                addMouseListener(new MouseAdapter() {
                    @Override public void mouseClicked(MouseEvent e) {
                        for (int i = 0; i < boxes.size(); i++) {
                            if (boxes.get(i).contains(e.getPoint()) && i < model.chosen.size()) { model.remove(model.chosen.get(i)); render(); return; }
                        }
                    }
                });
            }

            @Override public Dimension getPreferredSize() { return new Dimension(10, 36); }

            @Override protected void paintComponent(Graphics g0) {
                Graphics2D g = smooth(g0.create());
                boxes.clear();
                int x = 20, limit = getWidth() - 20;
                for (int i = 0; i < model.chosen.size(); i++) {
                    String label = model.label(model.chosen.get(i));
                    FontMetrics fm = g.getFontMetrics(fit(f, label));
                    int rest = model.chosen.size() - i;
                    String more = "+" + rest;
                    int reserve = rest > 1 ? fm.stringWidth("+99") + 10 : 0;
                    int width = fm.stringWidth(label) + 20;
                    if (x + width > limit - reserve) {
                        drawText(g, more, f, t.muted, x + 2, 6 + (24 - fm.getHeight()) / 2 + fm.getAscent());
                        break;
                    }
                    Rectangle box = new Rectangle(x, 4, width, 24);
                    boxes.add(box);
                    g.setColor(t.chip);
                    g.fill(new RoundRectangle2D.Float(box.x, box.y, box.width, box.height, 24, 24));
                    drawText(g, label, f, t.dark ? t.text : t.accent.darker(), x + 10, box.y + (24 - fm.getHeight()) / 2 + fm.getAscent());
                    x += width + 6;
                }
                g.dispose();
            }
        }

        /** The style of a new document: a quiet pill that opens a menu. */
        private final class StylePill extends JComponent {
            final Font f = font(12.5f, false);
            boolean hover;

            StylePill() {
                setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
                setToolTipText("Citation style of this document");
                addMouseListener(new MouseAdapter() {
                    @Override public void mouseEntered(MouseEvent e) { hover = true; repaint(); }
                    @Override public void mouseExited(MouseEvent e) { hover = false; repaint(); }
                    @Override public void mousePressed(MouseEvent e) { menu(); }
                });
            }

            String label() { return style >= 0 ? styleLabels.get(style) : ""; }

            void menu() {
                JPopupMenu menu = new JPopupMenu();
                menu.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createLineBorder(t.line), BorderFactory.createEmptyBorder(4, 0, 4, 0)));
                menu.setBackground(t.card);
                for (int i = 0; i < styleLabels.size(); i++) {
                    int index = i;
                    JMenuItem item = new JMenuItem((i == style ? "• " : "   ") + styleLabels.get(i));
                    item.setFont(fit(f, styleLabels.get(i)));
                    item.setBackground(t.card);
                    item.setForeground(t.text);
                    item.setBorder(BorderFactory.createEmptyBorder(5, 10, 5, 16));
                    item.addActionListener(e -> { style = index; revalidate(); repaint(); field.requestFocusInWindow(); });
                    menu.add(item);
                }
                menu.show(this, 0, getHeight() + 4);
            }

            @Override public Dimension getPreferredSize() {
                FontMetrics fm = getFontMetrics(fit(f, label()));
                return new Dimension(Math.min(230, fm.stringWidth(label()) + 40), 30);
            }

            @Override protected void paintComponent(Graphics g0) {
                Graphics2D g = smooth(g0.create());
                int h = 28, y = (getHeight() - h) / 2;
                g.setColor(hover ? t.key : t.row);
                g.fill(new RoundRectangle2D.Float(0, y, getWidth(), h, 14, 14));
                FontMetrics fm = g.getFontMetrics(fit(f, label()));
                drawText(g, clip(label(), fm, getWidth() - 36), f, t.soft, 12, y + (h - fm.getHeight()) / 2 + fm.getAscent());
                Path2D v = new Path2D.Float();
                int cx = getWidth() - 16, cy = getHeight() / 2;
                v.moveTo(cx - 3.5, cy - 1.5); v.lineTo(cx, cy + 2); v.lineTo(cx + 3.5, cy - 1.5);
                g.setColor(t.muted);
                g.setStroke(new BasicStroke(1.4f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
                g.draw(v);
                g.dispose();
            }
        }

        /** The note at the left of the bottom bar. */
        private final class Note extends JComponent {
            final Font f = font(12.5f, false);

            @Override public Dimension getPreferredSize() {
                return new Dimension(getFontMetrics(fit(f, model.note())).stringWidth(model.note()) + 4, 42);
            }
            @Override public Dimension getMaximumSize() { return getPreferredSize(); }

            @Override protected void paintComponent(Graphics g0) {
                Graphics2D g = smooth(g0.create());
                FontMetrics fm = g.getFontMetrics(fit(f, model.note()));
                drawText(g, model.note(), f, t.muted, 0, (getHeight() - fm.getHeight()) / 2 + fm.getAscent());
                g.dispose();
            }
        }

        /** Document Preferences: store citations as bookmarks (for Word with Zotero). */
        private final class Check extends JComponent {
            final Font f = font(12.5f, false);
            final String label;

            Check(String label) {
                this.label = label;
                if (!bookmarksLocked) setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
                else setToolTipText("This document already has citations, so this cannot be changed any more");
                addMouseListener(new MouseAdapter() {
                    @Override public void mousePressed(MouseEvent e) { if (!bookmarksLocked) { bookmarks = !bookmarks; repaint(); } }
                });
            }

            @Override public Dimension getPreferredSize() { return new Dimension(getFontMetrics(fit(f, label)).stringWidth(label) + 28, 42); }
            @Override public Dimension getMaximumSize() { return getPreferredSize(); }

            @Override protected void paintComponent(Graphics g0) {
                Graphics2D g = smooth(g0.create());
                int cy = getHeight() / 2;
                Shape box = new RoundRectangle2D.Float(0.5f, cy - 7.5f, 15, 15, 5, 5);
                if (bookmarks) {
                    g.setColor(bookmarksLocked ? t.muted : t.accent);
                    g.fill(box);
                    Path2D tick = new Path2D.Float();
                    tick.moveTo(4, cy + 0.3); tick.lineTo(6.8, cy + 3); tick.lineTo(11.6, cy - 3);
                    g.setColor(t.onAccent);
                    g.setStroke(new BasicStroke(1.7f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
                    g.draw(tick);
                } else {
                    g.setColor(t.muted);
                    g.setStroke(new BasicStroke(1.2f));
                    g.draw(box);
                }
                FontMetrics fm = g.getFontMetrics(fit(f, label));
                drawText(g, label, f, bookmarksLocked ? t.muted : t.soft, 24, (getHeight() - fm.getHeight()) / 2 + fm.getAscent());
                g.dispose();
            }
        }

        /** What a key does, at the right of the bottom bar: a label and key caps; it can be clicked. */
        private final class Hint extends JComponent {
            final Font f = font(12.5f, false), k = font(11.5f, false);
            final String[] keys;
            final boolean strong;
            String label;
            boolean hover;

            Hint(String label, String[] keys, boolean strong, Runnable action) {
                this.label = label;
                this.keys = keys;
                this.strong = strong;
                setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
                addMouseListener(new MouseAdapter() {
                    @Override public void mouseEntered(MouseEvent e) { hover = true; repaint(); }
                    @Override public void mouseExited(MouseEvent e) { hover = false; repaint(); }
                    @Override public void mouseClicked(MouseEvent e) { action.run(); }
                });
            }

            int capWidth(String key) { return Math.max(22, getFontMetrics(fit(k, key)).stringWidth(key) + 12); }

            @Override public Dimension getPreferredSize() {
                int w = 10 + getFontMetrics(fit(f, label)).stringWidth(label) + 8;
                for (String key : keys) w += capWidth(key) + 4;
                return new Dimension(w + 6, 42);
            }
            @Override public Dimension getMaximumSize() { return getPreferredSize(); }

            @Override protected void paintComponent(Graphics g0) {
                Graphics2D g = smooth(g0.create());
                int h = 28, y = (getHeight() - h) / 2;
                if (hover) {
                    g.setColor(t.row);
                    g.fill(new RoundRectangle2D.Float(0, y, getWidth(), h, 12, 12));
                }
                FontMetrics fm = g.getFontMetrics(fit(f, label));
                int x = 10;
                drawText(g, label, strong ? font(12.5f, true) : f, strong ? t.text : t.soft, x, y + (h - fm.getHeight()) / 2 + fm.getAscent());
                x += g.getFontMetrics(fit(strong ? font(12.5f, true) : f, label)).stringWidth(label) + 8;
                for (String key : keys) {
                    int cw = capWidth(key);
                    g.setColor(t.key);
                    g.fill(new RoundRectangle2D.Float(x, y + 4, cw, h - 8, 8, 8));
                    FontMetrics km = g.getFontMetrics(fit(k, key));
                    drawText(g, key, k, t.soft, x + (cw - km.stringWidth(key)) / 2, y + 4 + (h - 8 - km.getHeight()) / 2 + km.getAscent());
                    x += cw + 4;
                }
                g.dispose();
            }
        }

        /** A thin scroll bar without buttons. */
        private final class ThinBar extends BasicScrollBarUI {
            private JButton none() {
                JButton b = new JButton();
                b.setPreferredSize(new Dimension(0, 0));
                b.setMinimumSize(new Dimension(0, 0));
                b.setMaximumSize(new Dimension(0, 0));
                return b;
            }
            @Override protected JButton createDecreaseButton(int orientation) { return none(); }
            @Override protected JButton createIncreaseButton(int orientation) { return none(); }
            @Override protected void paintTrack(Graphics g, JComponent c, Rectangle r) { /* none */ }
            @Override protected void paintThumb(Graphics g0, JComponent c, Rectangle r) {
                if (r.isEmpty()) return;
                Graphics2D g = smooth(g0.create());
                g.setColor(t.dark ? new Color(0x5a5853) : new Color(0xcfcabd));
                g.fill(new RoundRectangle2D.Float(r.x + 2, r.y + 2, 6, r.height - 4, 6, 6));
                g.dispose();
            }
        }
    }
}
