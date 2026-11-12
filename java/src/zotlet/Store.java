package zotlet;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

import static zotlet.Json.list;
import static zotlet.Json.map;

/**
 * File-based persistence for the library (CSL-JSON array) and projects (port of src/store.js).
 *
 * library.json   — an array of CSL-JSON items. Item IDs are never changed and fields zotlet does
 *                  not know about are written back untouched.
 * web-state.json — { version, projects: [{ id, name, itemIds, created }], … }. Unknown top-level
 *                  keys and unknown project keys are preserved.
 *
 * Every mutation re-reads the files, applies the change and writes atomically (temp file +
 * rename), serialized by one lock, so edits made by the CLI in between are never lost.
 */
public final class Store {
    public final Path dir, libraryFile, stateFile;
    private final Supplier<Instant> now;
    private final Object lock = new Object();

    private static final DateTimeFormatter ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    public static Path dataDir() {
        String home = System.getenv("ZOTLET_HOME");
        return Paths.get(home != null && !home.isEmpty() ? home : System.getProperty("user.home"), ".zotlet");
    }

    public Store(Path dir) { this(dir, null, Instant::now); }

    public Store(Path dir, Path libraryFile, Supplier<Instant> now) {
        this.dir = dir;
        String env = System.getenv("ZOTLET_LIB");
        this.libraryFile = libraryFile != null ? libraryFile : env != null && !env.isEmpty() ? Paths.get(env) : dir.resolve("library.json");
        this.stateFile = dir.resolve("web-state.json");
        this.now = now;
    }

    public static String isoTime(Instant t) { return ISO.format(t); }

    private static Object readJSON(Path file, Object fallback) throws IOException {
        String text;
        try { text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8); }
        catch (NoSuchFileException e) { return fallback; }
        if (text.startsWith("﻿")) text = text.substring(1);
        if (Text.trim(text).isEmpty()) return fallback;
        try { return Json.parse(text); }
        catch (Json.ParseException e) { throw new IOException(file + " is not valid JSON. Fix or move it, then reload."); }
    }

    static void writeAtomic(Path file, byte[] bytes, boolean privateFile) throws IOException {
        Path target = file;
        try { target = file.toRealPath(); } catch (NoSuchFileException e) { /* new file */ }
        Path parent = target.toAbsolutePath().getParent();
        Files.createDirectories(parent);
        Path temp = parent.resolve("." + target.getFileName() + "." + UUID.randomUUID() + ".tmp");
        try {
            Files.write(temp, bytes);
            if (privateFile) {
                try { Files.setPosixFilePermissions(temp, PosixFilePermissions.fromString("rw-------")); } catch (UnsupportedOperationException e) { /* Windows */ }
            }
            try { Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
            catch (AtomicMoveNotSupportedException e) { Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING); }
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    private static void writeJSON(Path file, Object value) throws IOException {
        writeAtomic(file, (Json.pretty(value) + "\n").getBytes(StandardCharsets.UTF_8), true);
    }

    static boolean sameDOI(Object a, Object b) {
        return Json.truthy(a) && Json.truthy(b) && Text.lower(Metadata.normalizeDOI(a)).equals(Text.lower(Metadata.normalizeDOI(b)));
    }

    public static Map<String, Object> findDuplicate(List<Object> items, Map<String, Object> item) {
        for (Object o : items) {
            Map<String, Object> entry = map(o);
            if (entry == null) continue;
            if (Json.truthy(item.get("DOI")) && sameDOI(entry.get("DOI"), item.get("DOI"))) return entry;
            if (Json.truthy(item.get("PMID")) && Json.truthy(entry.get("PMID")) && Json.jsString(entry.get("PMID")).equals(Json.jsString(item.get("PMID")))) return entry;
        }
        return null;
    }

    private static String cleanName(Object name) {
        if (!(name instanceof String) || Text.trim((String) name).isEmpty()) throw new UserError("Enter a project name");
        String value = Text.squash((String) name);
        if (value.length() > 120) throw new UserError("Project names are limited to 120 characters");
        return value;
    }

    /** The two files, loaded. */
    public static final class Data {
        public List<Object> items;
        public Map<String, Object> state;
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> projects() { return (List<Map<String, Object>>) (List<?>) list(state.get("projects")); }
    }

    private Data load() throws IOException {
        Object items = readJSON(libraryFile, new ArrayList<>());
        if (!(items instanceof List)) throw new IOException(libraryFile + " must contain a JSON array of CSL items");
        Object state = readJSON(stateFile, new LinkedHashMap<>());
        if (!(state instanceof Map)) throw new IOException(stateFile + " must contain a JSON object");
        Map<String, Object> s = map(state);
        if (s.get("version") == null) s.put("version", 1L);
        List<Object> projects = new ArrayList<>();
        if (s.get("projects") instanceof List) for (Object p : list(s.get("projects"))) if (map(p) != null && map(p).get("id") instanceof String) projects.add(p);
        s.put("projects", projects);
        for (Object o : projects) {
            Map<String, Object> p = map(o);
            if (!(p.get("name") instanceof String) || Text.trim((String) p.get("name")).isEmpty()) p.put("name", "Untitled");
            List<Object> ids = new ArrayList<>();
            if (p.get("itemIds") instanceof List) {
                Set<String> seen = new LinkedHashSet<>();
                for (Object id : list(p.get("itemIds"))) if (id instanceof String) seen.add((String) id);
                ids.addAll(seen);
            }
            p.put("itemIds", ids);
        }
        // When each reference was imported: { itemId: ISO time }. Kept here so library.json stays CSL-JSON.
        if (s.containsKey("added") && !(s.get("added") instanceof Map)) s.put("added", new LinkedHashMap<>());
        Data d = new Data();
        d.items = list(items);
        d.state = s;
        return d;
    }

    public interface Change<T> { T apply(Data d) throws IOException; }

    /** Runs `change` against freshly loaded data and writes back only what changed. */
    public <T> T mutate(Change<T> change) throws IOException {
        synchronized (lock) {
            Data d = load();
            String beforeItems = Json.stringify(d.items), beforeState = Json.stringify(d.state);
            T result = change.apply(d);
            if (!Json.stringify(d.items).equals(beforeItems)) writeJSON(libraryFile, d.items);
            if (!Json.stringify(d.state).equals(beforeState)) writeJSON(stateFile, d.state);
            return result;
        }
    }

    static Set<String> usedIds(List<Object> items) {
        Set<String> ids = new HashSet<>();
        for (Object o : items) {
            Map<String, Object> i = map(o);
            if (i != null && i.get("id") != null) ids.add(Json.jsString(i.get("id")));
        }
        return ids;
    }

    private static Map<String, Object> project(Data d, Object id) {
        for (Map<String, Object> p : d.projects()) if (p.get("id").equals(id)) return p;
        throw new UserError("Project not found", 404);
    }

    private Map<String, Object> snapshotOf(Data d) {
        // Items without a usable id cannot be addressed; give them a view-only key.
        Set<String> ids = usedIds(d.items);
        List<Object> visible = new ArrayList<>();
        Set<String> known = new HashSet<>();
        for (Object o : d.items) {
            Map<String, Object> item = map(o);
            if (item == null) continue;
            if (!(item.get("id") instanceof String) || ((String) item.get("id")).isEmpty()) {
                Map<String, Object> copy = new LinkedHashMap<>(item);
                copy.put("id", item.get("id") != null ? Json.jsString(item.get("id")) : Metadata.citationKey(item, ids));
                item = copy;
            }
            visible.add(item);
            known.add((String) item.get("id"));
        }
        List<Object> projects = new ArrayList<>();
        for (Map<String, Object> p : d.projects()) {
            List<Object> itemIds = new ArrayList<>();
            for (Object id : list(p.get("itemIds"))) if (known.contains(id)) itemIds.add(id);
            projects.add(Json.obj("id", p.get("id"), "name", p.get("name"), "created", Json.truthy(p.get("created")) ? p.get("created") : null, "itemIds", itemIds));
        }
        Map<String, Object> added = new LinkedHashMap<>();
        Map<String, Object> stored = map(d.state.get("added"));
        if (stored != null) for (Map.Entry<String, Object> e : stored.entrySet()) if (known.contains(e.getKey()) && e.getValue() instanceof String) added.put(e.getKey(), e.getValue());
        return Json.obj("items", visible, "projects", projects, "added", added,
            "paths", Json.obj("library", libraryFile.toString(), "state", stateFile.toString()));
    }

    public Map<String, Object> snapshot() throws IOException {
        synchronized (lock) { return snapshotOf(load()); }
    }

    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> visibleItems() throws IOException {
        return (List<Map<String, Object>>) (List<?>) list(snapshot().get("items"));
    }

    /** Add normalized items; duplicates (same DOI or PMID) are reported, not added. Each result: { status, id, item }. */
    public List<Map<String, Object>> addItems(List<Map<String, Object>> newItems, String projectId) throws IOException {
        return mutate(d -> {
            Map<String, Object> target = projectId != null ? project(d, projectId) : null;
            Set<String> ids = usedIds(d.items);
            List<Map<String, Object>> out = new ArrayList<>();
            for (Map<String, Object> incoming : newItems) {
                Map<String, Object> duplicate = findDuplicate(d.items, incoming);
                Map<String, Object> item = duplicate;
                if (item == null) {
                    Map<String, Object> fields = new LinkedHashMap<>(incoming);
                    fields.remove("id");
                    item = new LinkedHashMap<>();
                    item.put("id", Metadata.citationKey(fields, ids));
                    item.putAll(fields);
                    ids.add((String) item.get("id"));
                    d.items.add(item);
                    Map<String, Object> added = map(d.state.get("added"));
                    Map<String, Object> next = added == null ? new LinkedHashMap<>() : new LinkedHashMap<>(added);
                    next.put((String) item.get("id"), isoTime(now.get()));
                    d.state.put("added", next);
                }
                String id = Json.jsString(item.get("id"));
                if (target != null && !list(target.get("itemIds")).contains(id)) list(target.get("itemIds")).add(id);
                out.add(Json.obj("status", duplicate != null ? "duplicate" : "added", "id", id, "item", item));
            }
            return out;
        });
    }

    /** Merge `fields` into an item. null removes a field; unknown fields are kept. */
    public Map<String, Object> updateItem(String id, Map<String, Object> fields) throws IOException {
        return mutate(d -> {
            int index = -1;
            for (int k = 0; k < d.items.size(); k++) { Map<String, Object> i = map(d.items.get(k)); if (i != null && id.equals(i.get("id"))) { index = k; break; } }
            if (index < 0) throw new UserError("Reference not found", 404);
            Map<String, Object> next = new LinkedHashMap<>(map(d.items.get(index)));
            for (Map.Entry<String, Object> e : fields.entrySet()) {
                if (e.getKey().equals("id")) continue;
                if (e.getValue() == null) next.remove(e.getKey());
                else next.put(e.getKey(), e.getValue());
            }
            List<Object> others = new ArrayList<>(d.items);
            others.remove(index);
            Map<String, Object> duplicate = findDuplicate(others, next);
            if (duplicate != null) throw new UserError("That DOI/PMID already belongs to \"" + Json.jsString(duplicate.get("id")) + "\"", 409);
            d.items.set(index, next);
            return next;
        });
    }

    public Map<String, Object> deleteItems(List<String> ids) throws IOException {
        Set<String> remove = new HashSet<>(ids);
        return mutate(d -> {
            int before = d.items.size();
            for (Iterator<Object> it = d.items.iterator(); it.hasNext(); ) {
                Map<String, Object> i = map(it.next());
                if (i != null && i.get("id") instanceof String && remove.contains(i.get("id"))) it.remove();
            }
            for (Map<String, Object> p : d.projects()) list(p.get("itemIds")).removeIf(remove::contains);
            Map<String, Object> added = map(d.state.get("added"));
            if (added != null) for (String id : remove) added.remove(id);
            return Json.obj("removed", (long) (before - d.items.size()));
        });
    }

    public Map<String, Object> createProject(Object name) throws IOException {
        return mutate(d -> {
            String value = cleanName(name);
            for (Map<String, Object> p : d.projects()) if (Text.lower((String) p.get("name")).equals(Text.lower(value))) throw new UserError("A project named \"" + value + "\" already exists", 409);
            Map<String, Object> p = Json.obj("id", UUID.randomUUID().toString(), "name", value, "itemIds", new ArrayList<>(), "created", isoTime(now.get()));
            list(d.state.get("projects")).add(p);
            return p;
        });
    }

    public Map<String, Object> renameProject(Object id, Object name) throws IOException {
        return mutate(d -> {
            Map<String, Object> p = project(d, id);
            String value = cleanName(name);
            for (Map<String, Object> x : d.projects()) if (x != p && Text.lower((String) x.get("name")).equals(Text.lower(value))) throw new UserError("A project named \"" + value + "\" already exists", 409);
            p.put("name", value);
            return p;
        });
    }

    public Map<String, Object> deleteProject(Object id) throws IOException {
        return mutate(d -> {
            project(d, id);
            list(d.state.get("projects")).removeIf(p -> map(p).get("id").equals(id));
            if (d.state.containsKey("activeProject") && id.equals(d.state.get("activeProject"))) d.state.put("activeProject", null);
            return Json.obj("ok", true);
        });
    }

    public Map<String, Object> addToProject(Object id, List<String> itemIds) throws IOException {
        return mutate(d -> {
            Map<String, Object> p = project(d, id);
            Set<String> known = usedIds(d.items);
            long added = 0;
            for (String itemId : itemIds) if (known.contains(itemId) && !list(p.get("itemIds")).contains(itemId)) { list(p.get("itemIds")).add(itemId); added++; }
            return Json.obj("added", added);
        });
    }

    public Map<String, Object> removeFromProject(Object id, List<String> itemIds) throws IOException {
        return mutate(d -> {
            Map<String, Object> p = project(d, id);
            Set<String> remove = new HashSet<>(itemIds);
            int before = list(p.get("itemIds")).size();
            list(p.get("itemIds")).removeIf(remove::contains);
            return Json.obj("removed", (long) (before - list(p.get("itemIds")).size()));
        });
    }
}
