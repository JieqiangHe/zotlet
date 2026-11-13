import java.util.*;
import zotlet.*;

/**
 * Unit checks of the parts the end-to-end tests cannot reach (the macOS picker's request/answer,
 * lsof parsing, JSON number formatting). Run by test/unit.test.js:
 *   java -cp java/build/lib/zotlet.jar java/test/UnitTest.java
 */
public class UnitTest {
    static int failures = 0;

    static void check(boolean ok, String what) {
        if (!ok) { failures++; System.out.println("FAIL " + what); }
    }

    static void eq(Object actual, Object expected, String what) {
        check(Json.stringify(actual).equals(Json.stringify(expected)), what + ": expected " + Json.stringify(expected) + ", got " + Json.stringify(actual));
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        List<Object> items = Json.list(Json.parse("[{\"id\":\"he2023\",\"type\":\"article-journal\",\"title\":\"4-methylumbelliferone (4-MU) enhances drought tolerance of apple\","
            + "\"container-title\":\"Horticulture Research\",\"author\":[{\"family\":\"He\",\"given\":\"Jieqiang\"},{\"family\":\"Ma\",\"given\":\"Fengwang\"},{\"family\":\"Li\",\"given\":\"C\"}],"
            + "\"issued\":{\"date-parts\":[[2023]]},\"DOI\":\"10.1093/hr/uhad099\"},"
            + "{\"id\":\"zhi2025\",\"type\":\"article-journal\",\"title\":\"<i>MdKIN10</i>-mediated phosphorylation of MdMIEL1\",\"container-title\":\"The Plant Cell\","
            + "\"author\":[{\"family\":\"Zhi\",\"given\":\"Fang\"}],\"issued\":{\"date-parts\":[[2025]]}}]"));
        Citations.Style nature = new Citations.Style(), cell = new Citations.Style();
        nature.id = "nature"; nature.label = "Nature"; cell.id = "cell"; cell.label = "Cell";
        List<Citations.Style> styles = Arrays.asList(nature, cell);

        // The native picker's request: plain labels, newest first, searchable by project name.
        Map<String, Object> spec = Picker.nativeSpec(Json.obj("mode", "cite", "style", "nature", "askStyle", true, "items", items, "selected", Json.arr("he2023")),
            styles, Json.arr(Json.obj("name", "Cold paper", "itemIds", Json.arr("zhi2025"))));
        List<Object> out = Json.list(spec.get("items"));
        eq(Json.map(out.get(0)).get("id"), "zhi2025", "newest first");
        eq(Json.map(out.get(0)).get("title"), "MdKIN10-mediated phosphorylation of MdMIEL1", "plain title");
        eq(Json.map(out.get(0)).get("detail"), "Zhi 2025", "detail");
        eq(Json.map(out.get(1)).get("short"), "He et al. 2023", "short label");
        check(((String) Json.map(out.get(0)).get("search")).contains("cold paper"), "project names are searchable");
        check(((String) Json.map(out.get(1)).get("search")).contains("10.1093/hr/uhad099"), "DOIs are searchable");
        eq(spec.get("selected"), Json.arr("he2023"), "selected");
        eq(Picker.nativeSpec(Json.obj("mode", "style", "style", "cell", "bookmarks", false, "bookmarksLocked", true), styles, null),
            Json.obj("mode", "style", "style", "cell", "askStyle", false, "styles", Json.arr(Json.obj("id", "nature", "label", "Nature"), Json.obj("id", "cell", "label", "Cell")),
                "bookmarks", false, "bookmarksLocked", true), "style mode");

        // Its answers are checked against the request.
        Map<String, Object> cite = Json.obj("mode", "cite", "items", items);
        List<String> natureOnly = Arrays.asList("nature");
        check(Picker.parseResult("", cite, natureOnly) == null, "empty answer = cancelled");
        eq(Picker.parseResult("{\"ids\":[\"zhi2025\",\"ghost\"],\"style\":\"nature\"}\n", cite, natureOnly), Json.obj("ids", Json.arr("zhi2025"), "style", "nature"), "unknown ids dropped");
        eq(Picker.parseResult("{\"ids\":[\"he2023\"],\"style\":\"apa\"}", cite, natureOnly), Json.obj("ids", Json.arr("he2023")), "unknown style ignored");
        check(Picker.parseResult("{\"ids\":[]}", cite, natureOnly) == null, "no ids = cancelled");
        eq(Picker.parseResult("{\"style\":\"cell\",\"bookmarks\":true}", Json.obj("mode", "style"), Arrays.asList("cell")), Json.obj("style", "cell", "bookmarks", true), "style answer");
        try { Picker.parseResult("execution error: -1743", cite, new ArrayList<>()); check(false, "garbage must throw"); }
        catch (RuntimeException e) { check(e.getMessage().contains("unexpected"), "garbage message"); }

        // Java's own pop-up (QuickPick): what the keys do, without a window.
        QuickPick.Model m = new QuickPick.Model(spec);
        eq(m.chosen, Arrays.asList("he2023"), "the citation being edited is preselected");
        check(m.rows.size() == 2 && m.cursor == 0, "all rows, first highlighted");
        m.filter("plant  CELL");
        check(m.rows.size() == 1 && "zhi2025".equals(m.highlighted().get("id")), "every word must match");
        eq(m.enter("plant cell", false), "add", "Enter with a search adds");
        m.add(); m.add();
        eq(m.chosen, Arrays.asList("he2023", "zhi2025"), "added once");
        m.filter("");
        eq(m.enter("", false), "finish", "Enter on an empty search inserts");
        eq(m.enter("apple", true), "finish", "Ctrl/Cmd Enter inserts");
        check(m.status().startsWith("Citing: He et al. 2023; Zhi 2025"), "status names the citation: " + m.status());
        eq(m.result("cell", null), Json.obj("ids", Json.arr("he2023", "zhi2025"), "style", "cell"), "answer");
        check(m.removeLast() && m.removeLast() && !m.removeLast(), "backspace removes the last, then nothing");
        m.filter("nothing matches this");
        check(m.highlighted() == null && m.result(null, null) == null, "nothing to insert");
        m.filter("4-mu"); m.move(5); m.move(-9);
        eq(m.result(null, null), Json.obj("ids", Json.arr("he2023")), "Enter with nothing chosen takes the highlighted reference");
        QuickPick.Model sm = new QuickPick.Model(Picker.nativeSpec(Json.obj("mode", "style", "style", "cell", "bookmarks", false), styles, null));
        check("cell".equals(sm.highlighted().get("id")), "the document's style is highlighted");
        sm.filter("nat");
        eq(sm.result(null, true), Json.obj("style", "nature", "bookmarks", true), "style answer");
        eq(Picker.mode(), System.getenv("ZOTLET_PICKER") == null ? "auto" : Picker.mode(), "picker mode");

        // LibreOffice is recognised from lsof output (macOS).
        String lsof = "p101\ncsoffice\nn127.0.0.1:50000->127.0.0.1:23116\np7\nczotlet\nn127.0.0.1:23116->127.0.0.1:50000\n";
        Integration.Owner owner = Integration.lsofClient(lsof, new Integration.Ends("127.0.0.1", 50000, "127.0.0.1", 23116));
        check(owner.pid == 101 && owner.command.equals("soffice"), "lsof owner");

        // JSON numbers print like JavaScript.
        eq(Json.number(1e21), "1e+21", "1e21");
        eq(Json.number(0.1 + 0.2), "0.30000000000000004", "0.1+0.2");
        eq(Json.number(1.5e-7), "1.5e-7", "1.5e-7");
        eq(Json.stringify(Json.parse("{\"a\":[1,2.5,-0,1e3]}")), "{\"a\":[1,2.5,0,1000]}", "round trip");

        System.out.println(failures == 0 ? "ok" : failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }
}
