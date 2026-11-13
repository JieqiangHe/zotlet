import java.awt.EventQueue;
import java.awt.Rectangle;
import java.awt.Robot;
import java.awt.event.KeyEvent;
import java.io.File;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import zotlet.Citations;
import zotlet.Json;
import zotlet.Picker;
import zotlet.QuickPick;

/**
 * Java's own citation pop-up with a real window (run under Xvfb by test/unit.test.js):
 * opens it as the server does, presses keys, and checks the answer. With a folder as the first
 * argument it also saves screenshots there.
 */
public class PickWindowTest {
    static int failures = 0;
    static String shots;

    static void check(boolean ok, String what) {
        if (!ok) { failures++; System.out.println("FAIL: " + what); }
    }

    static QuickPick.Window window() throws Exception {
        for (int i = 0; i < 200 && QuickPick.OPEN.isEmpty(); i++) Thread.sleep(50);
        if (QuickPick.OPEN.isEmpty()) throw new IllegalStateException("the pop-up did not open");
        QuickPick.Window w = QuickPick.OPEN.get(0);
        for (int i = 0; i < 100 && !w.dialog.isShowing(); i++) Thread.sleep(50);
        return w;
    }

    static void shot(QuickPick.Window w, String name) throws Exception {
        if (shots == null) return;
        EventQueue.invokeAndWait(() -> {});
        Thread.sleep(300);
        Rectangle r = w.dialog.getBounds();
        r.grow(30, 30);
        javax.imageio.ImageIO.write(new Robot().createScreenCapture(r), "png", new File(shots, name + ".png"));
    }

    interface Step { void run(QuickPick.Window w) throws Exception; }

    static Map<String, Object> pick(Map<String, Object> spec, List<Citations.Style> styles, List<Object> projects, Step steps) throws Exception {
        CompletableFuture<Map<String, Object>> answer = CompletableFuture.supplyAsync(() -> {
            try { return Picker.windowPick(spec, styles, projects); } catch (Exception e) { throw new RuntimeException(e); }
        });
        steps.run(window());
        Map<String, Object> result = answer.get(10, TimeUnit.SECONDS);
        for (int i = 0; i < 100 && !QuickPick.OPEN.isEmpty(); i++) Thread.sleep(20);
        check(QuickPick.OPEN.isEmpty(), "the window is closed afterwards");
        return result;
    }

    static void type(QuickPick.Window w, String text) throws Exception { EventQueue.invokeAndWait(() -> w.field.setText(text)); }
    static void key(QuickPick.Window w, int code) throws Exception { EventQueue.invokeAndWait(() -> w.key(code, false)); }

    public static void main(String[] args) throws Exception {
        shots = args.length > 0 ? args[0] : null;
        StringBuilder json = new StringBuilder("[");
        String[][] refs = {{"he2023", "4-methylumbelliferone (4-MU) enhances drought tolerance of apple", "Horticulture Research", "He", "2023"},
            {"zhi2025", "<i>MdKIN10</i>-mediated phosphorylation of MdMIEL1", "The Plant Cell", "Zhi", "2025"},
            {"wang2024", "苹果抗旱性的分子机制研究进展", "园艺学报", "王", "2024"},
            {"li2022", "A very long title that has to be cut off at the right edge of the pop-up because it does not fit in one line of the list at all", "New Phytologist", "Li", "2022"}};
        for (String[] r : refs) {
            json.append(json.length() > 1 ? "," : "").append("{\"id\":\"" + r[0] + "\",\"title\":" + Json.stringify(r[1]) + ",\"container-title\":" + Json.stringify(r[2])
                + ",\"author\":[{\"family\":" + Json.stringify(r[3]) + ",\"given\":\"A\"},{\"family\":\"Ma\",\"given\":\"F\"},{\"family\":\"Li\",\"given\":\"C\"}],\"issued\":{\"date-parts\":[[" + r[4] + "]]}}");
        }
        List<Object> items = Json.list(Json.parse(json + "]"));
        Citations.Style nature = new Citations.Style(), cell = new Citations.Style();
        nature.id = "nature"; nature.label = "Nature"; cell.id = "cell"; cell.label = "Cell";
        List<Citations.Style> styles = Arrays.asList(nature, cell);

        // First citation of a new document: search, add two references, insert.
        Map<String, Object> cite = Json.obj("mode", "cite", "style", "nature", "askStyle", true, "items", items, "selected", Json.arr());
        Map<String, Object> r = pick(cite, styles, null, w -> {
            check(w.dialog.isAlwaysOnTop() && w.dialog.isUndecorated(), "a bare window that stays over the word processor");
            shot(w, "pick-empty");
            type(w, "mdkin10");
            check(w.model.rows.size() == 1, "search narrows the list");
            key(w, KeyEvent.VK_ENTER);
            check(w.field.getText().isEmpty() && w.model.chosen.equals(Arrays.asList("zhi2025")), "Enter adds and clears the search");
            type(w, "苹果");
            key(w, KeyEvent.VK_ENTER);
            key(w, KeyEvent.VK_DOWN);
            shot(w, "pick-two");
            key(w, KeyEvent.VK_ENTER);
        });
        check(Json.stringify(r).equals("{\"ids\":[\"zhi2025\",\"wang2024\"],\"style\":\"nature\"}"), "cite answer: " + Json.stringify(r));

        // Backspace removes, Esc cancels.
        r = pick(Json.obj("mode", "cite", "style", "nature", "askStyle", false, "items", items, "selected", Json.arr("he2023")), styles, null, w -> {
            key(w, KeyEvent.VK_BACK_SPACE);
            check(w.model.chosen.isEmpty(), "backspace on an empty search removes the last reference");
            key(w, KeyEvent.VK_ESCAPE);
        });
        check(r == null, "Esc cancels");

        // Document Preferences: the style list with the bookmarks choice.
        r = pick(Json.obj("mode", "style", "style", "nature", "bookmarks", false, "bookmarksLocked", false), styles, null, w -> {
            key(w, KeyEvent.VK_DOWN);
            shot(w, "pick-style");
            key(w, KeyEvent.VK_ENTER);
        });
        check(Json.stringify(r).equals("{\"style\":\"cell\",\"bookmarks\":false}"), "style answer: " + Json.stringify(r));

        // Nothing matches; many references (the list scrolls).
        List<Object> many = new java.util.ArrayList<>(items);
        for (int i = 0; i < 30; i++) many.add(Json.parse("{\"id\":\"n" + i + "\",\"title\":\"Reference number " + i + " about apple rootstocks\",\"container-title\":\"Plant Physiology\",\"author\":[{\"family\":\"Author" + i + "\"}],\"issued\":{\"date-parts\":[[" + (1990 + i) + "]]}}"));
        r = pick(Json.obj("mode", "cite", "style", "nature", "askStyle", false, "items", many, "selected", Json.arr()), styles, null, w -> {
            type(w, "rootstocks");
            for (int i = 0; i < 12; i++) key(w, KeyEvent.VK_DOWN);
            shot(w, "pick-many");
            type(w, "zzzz no such thing");
            shot(w, "pick-none");
            key(w, KeyEvent.VK_ENTER);
            check(!QuickPick.OPEN.isEmpty(), "Enter with no match keeps the window open");
            key(w, KeyEvent.VK_ESCAPE);
        });
        check(r == null, "cancelled");

        System.out.println(failures == 0 ? "ok" : failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }
}
