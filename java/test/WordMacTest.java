package zotlet;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import static zotlet.Json.arr;

/** Tests the real Mac adapter at the osascript boundary, without loading JXA or needing Word. */
public class WordMacTest {
    static void eq(Object actual, Object expected) {
        if (!Json.stringify(actual).equals(Json.stringify(expected)))
            throw new AssertionError("expected " + Json.stringify(expected) + ", got " + Json.stringify(actual));
    }
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    interface Checked { void run() throws Exception; }
    static void fails(Checked action, String message) throws Exception {
        try { action.run(); throw new AssertionError("expected " + message); }
        catch (IOException e) { check(e.getMessage().contains(message), e.getMessage()); }
    }

    static final class Fake implements WordMac.Script {
        final Map<String, Object> answers = new HashMap<>();
        final List<String> calls = new ArrayList<>();
        String fail;
        Fake() { answers.put("zInit", arr("Paper \"中\".docx", "/Users/me/Paper \"中\".docx", true, true, true, false, 0L, 17L, 20L)); }
        public String run(String source) throws Exception {
            String expression = source.substring(source.lastIndexOf("\nreturn ") + 8, source.lastIndexOf("\nend timeout"));
            calls.add(expression);
            String handler = expression.substring(0, expression.indexOf('('));
            if (handler.equals(fail)) { fail = null; throw new IOException("test error (-1743)"); }
            return WordMac.literal(answers.get(handler)) + "\n";
        }
        String last() { return calls.get(calls.size() - 1); }
        WordMac mac(String source) { return new WordMac(source, this, null); }
    }

    public static void main(String[] args) throws Exception {
        String source = Files.readString(Path.of(args[0]));
        // Source-form lists keep nested lists, field JSON, Unicode, embedded newlines, and numbers typed.
        String code = "ITEM CSL_CITATION {\"title\":\"A, {B}\\C 中😀\"}\nsecond line\r\t";
        Object data = arr(arr("F0:2", code, "", "missing value"), arr(0L, -7L, 12.5, 10000000L), arr(true, false, null), arr());
        eq(WordMac.parseResult(WordMac.literal(data) + "\n"), data);
        eq(WordMac.parseResult("{1, 2.5E+2, missing value, {true, false}}"), arr(1L, 250.0, null, arr(true, false)));
        eq(WordMac.parseResult(""), null);
        for (String bad : Arrays.asList("{1,}", "{1", "{\"oops}", "{x:1}", "1; do shell script \"bad\"", "1e999", "\"\\x\"", "true false"))
            fails(() -> WordMac.parseResult(bad), "Invalid AppleScript result");
        eq(WordMac.stripFieldCode(" ADDIN ZOTERO_" + code + " "), code);
        eq(WordMac.stripFieldCode(" CSL_ITEM X "), "ITEM X");
        eq(WordMac.stripFieldCode(" PAGE "), null);
        eq(WordMac.stripBookmarkCode("CSL_BIBL X "), "BIBL X");

        // Keep noisy clipboard image diagnostics in the log, and expose the actual native error.
        String diagnostic = "*** Error creating a JP2 color space: falling back to sRGB\n"
            + "10:20: execution error: Can't make document \"Document1\" into the expected type. (-1700)\n";
        WordMac.ScriptFailure failure = new WordMac.ScriptFailure(1, diagnostic, "on test()\nreturn 1\nend test\n");
        check(failure.getMessage().contains("expected type. (-1700)"), "the actual AppleScript error is retained");
        check(failure.getMessage().contains("AppleScript line 2"), "source offset mapped to a line");
        check(!failure.getMessage().contains("JP2") && failure.details.contains("JP2"), "clipboard warning kept in diagnostics, not the alert");
        eq(new WordMac.ScriptFailure(139, "", "").getMessage(), "osascript exited 139");
        check(new WordMac.ScriptFailure(1, "Not authorized (-1743)", "").getMessage().contains("-1743"), "unstructured permission errors retained");

        Fake f = new Fake();
        try (WordMac mac = f.mac(source)) {
            eq(mac.call("init", arr()), "Paper \"中\".docx");
            check(f.last().startsWith("zBegin(\"Paper \\\"中\\\".docx\", \"/Users/me/"), "document bound before editing");
            f.answers.put("zGetProperty", code);
            eq(mac.call("Document.getDocumentData", arr()), code);
            f.answers.put("zCursor", arr(2L, " ADDIN ZOTERO_" + code + " "));
            eq(mac.call("Document.cursorInField", arr("Field")), arr("F0:2", code, 0L));
            f.answers.put("zInsert", 3L);
            eq(mac.call("Document.insertField", arr("Field", 0L)), arr("F0:3", "TEMP", 0L));
            check(f.last().endsWith(", 0, 17, 20)"), "insertion uses the pre-picker selection");

            f.answers.put("zStoryFields", arr(arr(2L, " ADDIN ZOTERO_" + code + " ", 30L, 3L), arr(4L, " ADDIN ZOTERO_BIBL X ", 10L, 9L)));
            List<Object> rows = Json.list(mac.call("Document.getFields", arr("Field")));
            eq(rows.get(0), arr("F0:4", "F1:4", "F2:4", "F0:2", "F1:2", "F2:2"));
            eq(rows.get(2), arr(0L, 1L, 1L, 0L, 1L, 1L));
            mac.call("Field.setText", arr("F0:4", "{\\rtf1 test}", true));
            check(f.last().contains("«data RTF 7B5C7274663120746573747D», true, true)"), "bibliography RTF is binary, not a file or JXA");
            mac.call("Field.setText", arr("F0:2", code, false));
            check(f.last().endsWith(WordMac.literal(code) + ", false, false)"), "plain text stays escaped");

            // Unlinking the first field changes ordinals; the second must still be the original field.
            mac.call("Field.removeCode", arr("F0:2"));
            mac.call("Field.removeCode", arr("F0:4"));
            check(f.last().endsWith(", 0, 3, \"\", false)"), "remaining field index adjusted across unrelated Word fields");
            fails(() -> mac.call("Field.getText", arr("F0:2")), "already been removed");
            mac.call("Field.delete", arr("F1:2"));
            mac.call("Field.select", arr("F1:4"));
            check(f.last().endsWith(", 1, 3, \"\")"), "delete adjusts only its own story");

            String longValue = "a".repeat(254) + "😀中" + "b".repeat(260);
            mac.call("Document.setDocumentData", arr(longValue));
            check(f.last().contains(WordMac.literal(arr("a".repeat(254), "😀中" + "b".repeat(252), "b".repeat(8)))), "255-unit chunks keep surrogate pairs intact");
            mac.call("Document.setBibliographyStyle", arr(-360L, 720L, 240L, 120L, arr(720L, 1440L)));
            check(f.last().endsWith(", -18, 36, 12, 6, {36, 72})"), "twips become points");
            f.answers.put("zAlert", "Yes");
            eq(mac.call("Document.displayAlert", arr("Proceed?", 2L, 2L)), 1L);
            check(f.last().endsWith(", \"Proceed?\", warning, {\"No\", \"Yes\"})"), "dialog options");
            fails(() -> mac.call("Field.select", arr("F9:1")), "Unknown Word field");
            fails(() -> mac.call("Field.select", arr("B:bad\"name")), "Unknown Word bookmark");
            fails(() -> mac.call("bogus", arr()), "Unknown Word method");
            mac.call("Document.complete", arr());
            check(f.last().endsWith(", true, true, true, false)"), "all original revision/view settings restored");
            int n = f.calls.size();
            mac.call("Document.complete", arr());
            eq(f.calls.size(), n);
        }

        f = new Fake();
        try (WordMac mac = f.mac(source)) {
            mac.call("init", arr());
            f.answers.put("zBookmarks", arr(arr("ZOTERO_BREF_abc", 7L)));
            f.answers.put("zGetProperty", "ZOTERO_" + code + " ");
            eq(mac.call("Document.getFields", arr("Bookmark")), arr(arr("B:ZOTERO_BREF_abc"), arr(code), arr(0L)));
            mac.call("Field.setCode", arr("B:ZOTERO_BREF_abc", code));
            check(f.last().contains("zSetProperty(") && f.last().contains("ZOTERO_BREF_abc"), "bookmark metadata stored in document properties");
            f.answers.put("zGetText", "plain 中");
            eq(mac.call("Field.getText", arr("B:ZOTERO_BREF_abc")), "plain 中");
            mac.call("Field.removeCode", arr("B:ZOTERO_BREF_abc"));
            check(f.last().endsWith(", \"ZOTERO_BREF_abc\", {})"), "unlink removes bookmark metadata too");
        }

        // Fail after init's first mutation: close still restores the captured settings.
        f = new Fake(); f.fail = "zBegin";
        try (WordMac mac = f.mac(source)) { fails(() -> mac.call("init", arr()), "-1743"); }
        check(f.last().startsWith("zComplete("), "initialization failure restores state");
        f = new Fake(); f.fail = "zInit";
        try (WordMac mac = f.mac(source)) { fails(() -> mac.call("init", arr()), "-1743"); }
        eq(f.calls.size(), 1); // No target document was found: do not touch any other document.
        f = new Fake();
        try (WordMac mac = f.mac(source)) {
            mac.call("init", arr()); f.fail = "zSetText";
            fails(() -> mac.call("Field.setText", arr("F0:1", "{\\rtf1 text}", true)), "-1743");
        }
        check(f.last().startsWith("zComplete("), "paste failure restores revision settings");
        System.out.println("ok");
    }
}
