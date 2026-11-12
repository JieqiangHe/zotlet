package zotlet;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.RhinoException;
import org.mozilla.javascript.Scriptable;

/**
 * citeproc-js inside Rhino (a JavaScript engine written in Java, so no Node is needed).
 * Everything runs on one thread with a large stack; callers wait for the result.
 */
public final class Js {
    private final Path citeproc, locale;
    private final ExecutorService thread;
    private Scriptable scope;
    private Context cx;

    public Js(Path citeproc, Path locale) {
        this.citeproc = citeproc;
        this.locale = locale;
        this.thread = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(null, r, "zotlet-citeproc", 256L * 1024 * 1024);
            t.setDaemon(true);
            return t;
        });
    }

    /** A JavaScript error, with citeproc's message. */
    public static final class JsError extends RuntimeException {
        JsError(String message) { super(message); }
    }

    private void init() throws IOException {
        if (scope != null) return;
        cx = Context.enter();
        cx.setLanguageVersion(Context.VERSION_ES6);
        cx.setOptimizationLevel(9);
        scope = cx.initStandardObjects();
        cx.evaluateString(scope, "var module = { exports: {} }, exports = module.exports;"
            + "var console = { log: function () {}, warn: function () {}, error: function () {}, info: function () {} };", "prelude", 1, null);
        cx.evaluateString(scope, new String(Files.readAllBytes(citeproc), StandardCharsets.UTF_8), "citeproc.js", 1, null);
        cx.evaluateString(scope, "var CSL = module.exports;", "prelude", 1, null);
        String glue;
        try (InputStream in = Js.class.getResourceAsStream("engine.js")) {
            if (in == null) throw new IOException("engine.js is missing from the zotlet jar");
            glue = new String(Net.readAll(in, 1 << 20), StandardCharsets.UTF_8);
        }
        cx.evaluateString(scope, glue, "engine.js", 1, null);
        call0("zlSetLocale", new String(Files.readAllBytes(locale), StandardCharsets.UTF_8));
    }

    private String call0(String name, Object... args) {
        Function f = (Function) scope.get(name, scope);
        Object r = f.call(cx, scope, scope, args);
        return Context.toString(r);
    }

    /** Run a function of engine.js; all arguments are strings. */
    public String call(String name, Object... args) {
        return run(() -> {
            init();
            try {
                return call0(name, args);
            } catch (RhinoException e) {
                String m = e.details();
                throw new JsError(m == null || m.isEmpty() ? e.getMessage() : m);
            }
        });
    }

    public <T> T run(Callable<T> task) {
        Future<T> f = thread.submit(task);
        try {
            return f.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException(e);
        } catch (ExecutionException e) {
            Throwable c = e.getCause();
            if (c instanceof RuntimeException) throw (RuntimeException) c;
            if (c instanceof StackOverflowError) throw new JsError("citeproc ran out of stack space");
            throw new RuntimeException(c.getMessage(), c);
        }
    }

    /** Load citeproc in the background, so the first citation does not pay for it. */
    public void warm() {
        thread.submit(() -> {
            try { init(); } catch (Throwable e) { /* reported on first real use */ }
        });
    }

    public void close() {
        thread.submit(() -> { if (cx != null) Context.exit(); });
        thread.shutdown();
    }
}
