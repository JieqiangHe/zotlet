package zotlet;

import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Desktop;
import java.awt.Dimension;
import java.awt.EventQueue;
import java.awt.Font;
import java.awt.GraphicsEnvironment;
import java.awt.MouseInfo;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.Toolkit;
import java.awt.event.InputEvent;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
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
import javax.swing.DefaultListCellRenderer;
import javax.swing.DefaultListModel;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTextField;
import javax.swing.KeyStroke;
import javax.swing.ListSelectionModel;
import javax.swing.Timer;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;

import static zotlet.Json.list;
import static zotlet.Json.map;
import static zotlet.Json.obj;

/**
 * The citation / style pop-up drawn by Java itself (Swing), for Windows and Linux and as the
 * second choice on macOS: a small always-on-top window over the word processor, with the same
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

    // The page's light palette (public/style.css).
    private static final Color BG = new Color(0xf4f2ec), FIELD = new Color(0xfcfbf8), LINE = new Color(0xd5d0c3), TEXT = new Color(0x1f1e1c),
        MUTED = new Color(0x66635b), ACCENT = new Color(0xb05430), SELECTED = new Color(0xf0dbd0);

    /** Windows that are open now (tests look here). */
    public static final List<Window> OPEN = new java.util.concurrent.CopyOnWriteArrayList<>();

    /** Show the pop-up and wait. The answer, or null if cancelled; throws if no window can be shown. */
    public static Map<String, Object> show(Map<String, Object> nativeSpec) throws Exception {
        if (!available()) throw new IllegalStateException("no screen");
        CompletableFuture<Map<String, Object>> answer = new CompletableFuture<>();
        Window[] window = new Window[1];
        EventQueue.invokeLater(() -> {
            try { window[0] = new Window(new Model(nativeSpec), answer); window[0].open(); }
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

    /** The Swing window around a Model. Everything here runs on the event thread. */
    public static final class Window {
        public final Model model;
        final CompletableFuture<Map<String, Object>> answer;
        public final JDialog dialog = new JDialog((java.awt.Frame) null, TITLE);
        public final JTextField field = new JTextField();
        final JLabel status = new JLabel(" ");
        final DefaultListModel<Map<String, Object>> listModel = new DefaultListModel<>();
        final JList<Map<String, Object>> list = new JList<Map<String, Object>>(listModel) {
            // Rows are as wide as the window: long titles are cut with an ellipsis, authors and year stay visible.
            @Override public boolean getScrollableTracksViewportWidth() { return true; }
        };
        JComboBox<String> styleMenu;
        JCheckBox bookmarks;
        final List<String> styleIds = new ArrayList<>();

        Window(Model model, CompletableFuture<Map<String, Object>> answer) {
            this.model = model;
            this.answer = answer;
            build();
        }

        private static Font font(float size) { return new Font(Font.SANS_SERIF, Font.PLAIN, 1).deriveFont(size); }

        private void build() {
            dialog.setUndecorated(true);
            dialog.setAlwaysOnTop(true);
            dialog.setDefaultCloseOperation(JDialog.DISPOSE_ON_CLOSE);
            try { dialog.setType(java.awt.Window.Type.UTILITY); } catch (RuntimeException e) { /* not on this platform */ }

            JPanel root = new JPanel(new BorderLayout(0, 8));
            root.setBackground(BG);
            root.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createLineBorder(LINE), BorderFactory.createEmptyBorder(14, 14, 12, 14)));

            // Search field (+ the style menu for a new document's first citation).
            field.setFont(font(16));
            field.setForeground(TEXT);
            field.setBackground(FIELD);
            field.setCaretColor(ACCENT);
            field.setSelectionColor(SELECTED);
            field.setSelectedTextColor(TEXT);
            field.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createLineBorder(ACCENT), BorderFactory.createEmptyBorder(6, 9, 6, 9)));
            field.setToolTipText(model.cite ? "Search title, author, year, journal…" : "Citation style for this document");
            JPanel top = new JPanel(new BorderLayout(8, 0));
            top.setOpaque(false);
            top.add(field, BorderLayout.CENTER);
            List<Object> styles = list(model.spec.get("styles"));
            if (model.cite && Json.truthy(model.spec.get("askStyle")) && styles != null && !styles.isEmpty()) {
                styleMenu = new JComboBox<>();
                styleMenu.setFont(font(12));
                styleMenu.setFocusable(false);
                for (Object o : styles) {
                    Map<String, Object> s = map(o);
                    styleIds.add(Json.jsString(s.get("id")));
                    styleMenu.addItem(Json.jsString(s.get("label")));
                    if (s.get("id").equals(model.spec.get("style"))) styleMenu.setSelectedIndex(styleIds.size() - 1);
                }
                styleMenu.setPreferredSize(new Dimension(190, 30));
                styleMenu.setToolTipText("Citation style of this document");
                top.add(styleMenu, BorderLayout.EAST);
            }
            status.setFont(font(12));
            status.setForeground(MUTED);
            JPanel head = new JPanel(new BorderLayout(0, 6));
            head.setOpaque(false);
            head.add(top, BorderLayout.NORTH);
            head.add(status, BorderLayout.SOUTH);
            root.add(head, BorderLayout.NORTH);

            // Results.
            list.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
            list.setFocusable(false); // typing always goes to the search field
            list.setFixedCellHeight(28);
            list.setBackground(FIELD);
            list.setCellRenderer(new Row());
            list.setVisibleRowCount(model.cite ? 9 : 10);
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
            scroll.setBorder(BorderFactory.createLineBorder(LINE));
            scroll.setHorizontalScrollBarPolicy(JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
            root.add(scroll, BorderLayout.CENTER);

            // Foot: the bookmarks choice (style mode) and the two buttons.
            JPanel foot = new JPanel();
            foot.setLayout(new BoxLayout(foot, BoxLayout.X_AXIS));
            foot.setOpaque(false);
            if (!model.cite && model.spec.get("bookmarks") instanceof Boolean) {
                bookmarks = new JCheckBox("Also open in Microsoft Word with Zotero (store citations as bookmarks)", (Boolean) model.spec.get("bookmarks"));
                bookmarks.setFont(font(12));
                bookmarks.setForeground(TEXT);
                bookmarks.setOpaque(false);
                bookmarks.setFocusable(false);
                bookmarks.setEnabled(!Json.truthy(model.spec.get("bookmarksLocked")));
                foot.add(bookmarks);
            }
            foot.add(Box.createHorizontalGlue());
            foot.add(button("Cancel", false, () -> finish(false)));
            foot.add(Box.createHorizontalStrut(6));
            foot.add(button(model.cite ? "Insert" : "OK", true, () -> finish(true)));
            root.add(foot, BorderLayout.SOUTH);

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
            root.registerKeyboardAction(e -> finish(false), KeyStroke.getKeyStroke(KeyEvent.VK_ESCAPE, 0), JComponent.WHEN_IN_FOCUSED_WINDOW);

            // The window has no title bar: drag it by its background.
            MouseAdapter drag = new MouseAdapter() {
                Point from;
                @Override public void mousePressed(MouseEvent e) { from = e.getPoint(); }
                @Override public void mouseDragged(MouseEvent e) {
                    Point at = e.getLocationOnScreen();
                    if (from != null) dialog.setLocation(at.x - from.x, at.y - from.y);
                }
            };
            root.addMouseListener(drag);
            root.addMouseMotionListener(drag);

            dialog.addWindowListener(new WindowAdapter() {
                @Override public void windowClosed(WindowEvent e) { OPEN.remove(Window.this); answer.complete(null); }
            });
            dialog.setContentPane(root);
            render();
            dialog.pack();
            dialog.setSize(660, dialog.getHeight());
        }

        private JButton button(String text, boolean primary, Runnable action) {
            JButton b = new JButton(text);
            b.setFont(font(12));
            b.setFocusable(false);
            b.setFocusPainted(false);
            b.setContentAreaFilled(false);
            b.setOpaque(true);
            b.setBackground(primary ? ACCENT : FIELD);
            b.setForeground(primary ? Color.WHITE : TEXT);
            b.setBorder(BorderFactory.createCompoundBorder(BorderFactory.createLineBorder(primary ? ACCENT : LINE), BorderFactory.createEmptyBorder(5, 14, 5, 14)));
            b.addActionListener(e -> action.run());
            return b;
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
            status.setText(model.status());
            list.repaint();
        }

        void finish(boolean ok) {
            if (ok) {
                String style = styleMenu != null && styleMenu.getSelectedIndex() >= 0 ? styleIds.get(styleMenu.getSelectedIndex()) : null;
                Map<String, Object> result = model.result(style, bookmarks == null ? null : bookmarks.isSelected());
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
            dialog.setLocation(screen.x + (screen.width - dialog.getWidth()) / 2, screen.y + Math.max(40, (int) (screen.height * 0.38) - dialog.getHeight() / 2));
            OPEN.add(this);
            dialog.setVisible(true);
            toFront();
            String keys = System.getenv("ZOTLET_PICK_KEYS");
            if (keys != null && !keys.isEmpty()) play(keys.split(";"), 0);
            // Windows may refuse the keyboard to a program in the background: ask once more, through the shell.
            if (Picker.WINDOWS) {
                Timer t = new Timer(350, e -> {
                    if (dialog.isShowing() && !dialog.isFocused()) {
                        Proc.spawn(Arrays.asList("powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
                            "(New-Object -ComObject WScript.Shell).AppActivate('" + TITLE + "')"));
                    }
                });
                t.setRepeats(false);
                t.start();
            }
        }

        /** Tests (ZOTLET_PICK_KEYS="type:apple;enter;enter"): press these keys in the window, one after another. */
        private void play(String[] steps, int at) {
            if (at >= steps.length || !dialog.isDisplayable()) return;
            Timer t = new Timer(120, e -> {
                String step = steps[at].trim();
                if (step.startsWith("type:")) field.setText(step.substring(5));
                else if (step.equals("enter")) key(KeyEvent.VK_ENTER, false);
                else if (step.equals("down")) key(KeyEvent.VK_DOWN, false);
                else if (step.equals("up")) key(KeyEvent.VK_UP, false);
                else if (step.equals("backspace")) key(KeyEvent.VK_BACK_SPACE, false);
                else if (step.equals("esc")) key(KeyEvent.VK_ESCAPE, false);
                play(steps, at + 1);
            });
            t.setRepeats(false);
            t.start();
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

        /** One result: title on the left (✓ when already in the citation), authors and year on the right. */
        private final class Row extends DefaultListCellRenderer {
            private final JPanel panel = new JPanel(new BorderLayout(12, 0));
            private final JLabel title = new JLabel(), detail = new JLabel();

            Row() {
                panel.setBorder(BorderFactory.createEmptyBorder(0, 9, 0, 9));
                title.setFont(font(13));
                detail.setFont(font(12));
                panel.add(title, BorderLayout.CENTER);
                panel.add(detail, BorderLayout.EAST);
            }

            @Override public Component getListCellRendererComponent(JList<?> l, Object value, int index, boolean selected, boolean focus) {
                Map<String, Object> row = map(value);
                boolean chosen = model.isChosen(row);
                title.setText((chosen ? "✓ " : "") + Json.jsString(row.get(model.cite ? "title" : "label")));
                title.setForeground(chosen ? ACCENT : TEXT);
                detail.setText(model.cite ? Json.jsString(row.get("detail")) : "");
                detail.setForeground(MUTED);
                panel.setBackground(selected ? SELECTED : FIELD);
                return panel;
            }
        }
    }
}
