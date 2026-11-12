package zotlet;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Running small external programs (osascript, lsappinfo, lsof, open). */
final class Proc {
    private Proc() {}

    /** Threads for blocking work (network lookups, process output); the common pool is too small for that. */
    static final java.util.concurrent.ExecutorService POOL = java.util.concurrent.Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "zotlet-worker");
        t.setDaemon(true);
        return t;
    });

    static final class Failed extends IOException {
        Failed(String message) { super(message); }
    }

    /** Run and wait; returns stdout. Throws Failed (with the last line of stderr) on a non-zero exit or timeout. */
    static String run(List<String> command, long timeoutMs) throws IOException, InterruptedException {
        Process p = new ProcessBuilder(command).redirectInput(ProcessBuilder.Redirect.from(nullFile())).start();
        CompletableFuture<String> out = drain(p.getInputStream()), err = drain(p.getErrorStream());
        if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
            p.destroyForcibly();
            throw new Failed(command.get(0) + " timed out");
        }
        String stdout = out.join(), stderr = err.join();
        if (p.exitValue() != 0) {
            String[] lines = Text.trim(stderr.isEmpty() ? command.get(0) + " failed" : stderr).split("\n");
            throw new Failed(lines[lines.length - 1]);
        }
        return stdout;
    }

    /** Start without waiting; false if it could not be started. */
    static boolean spawn(List<String> command) {
        try {
            Process p = new ProcessBuilder(command).redirectInput(ProcessBuilder.Redirect.from(nullFile()))
                .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD).start();
            return p != null;
        } catch (IOException e) {
            return false;
        }
    }

    private static java.io.File nullFile() {
        return new java.io.File(System.getProperty("os.name", "").startsWith("Windows") ? "NUL" : "/dev/null");
    }

    private static CompletableFuture<String> drain(InputStream in) {
        return CompletableFuture.supplyAsync(() -> {
            try { return new String(Net.readAll(in, 16 * 1024 * 1024), StandardCharsets.UTF_8); } catch (IOException e) { return ""; }
        }, POOL);
    }
}
