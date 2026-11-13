package zotlet;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static zotlet.Json.list;
import static zotlet.Json.map;
import static zotlet.Json.str;

/**
 * DOI / PMID parsing, lookup and CSL-JSON normalization (port of src/metadata.js).
 *
 * Remote metadata (Crossref, DataCite, PubMed) carries many fields that are not part of a clean
 * CSL item: author objects with `sequence`, `affiliation`, `ORCID`, `role`…, date objects with
 * `timestamp`, titles as arrays, JATS markup in abstracts. Everything that enters the library goes
 * through normalizeItem, so stored items are always plain, valid CSL-JSON.
 */
public final class Metadata {
    private Metadata() {}

    public static final Set<String> CSL_TYPES = new HashSet<>(Arrays.asList(
        "article", "article-journal", "article-magazine", "article-newspaper", "bill", "book", "broadcast", "chapter",
        "classic", "collection", "dataset", "document", "entry", "entry-dictionary", "entry-encyclopedia", "event",
        "figure", "graphic", "hearing", "interview", "legal_case", "legislation", "manuscript", "map", "motion_picture",
        "musical_score", "pamphlet", "paper-conference", "patent", "performance", "periodical", "personal_communication",
        "post", "post-weblog", "regulation", "report", "review", "review-book", "software", "song", "speech", "standard",
        "thesis", "treaty", "webpage"));

    private static final Map<String, String> TYPE_ALIASES = new HashMap<>();
    static {
        String[] a = {"journal-article", "article-journal", "proceedings-article", "paper-conference", "book-chapter", "chapter",
            "book-section", "chapter", "book-part", "chapter", "edited-book", "book", "monograph", "book",
            "reference-book", "book", "posted-content", "article", "dissertation", "thesis", "journal", "periodical",
            "report-component", "report", "component", "article", "peer-review", "review", "reference-entry", "entry",
            "misc", "article", "other", "article"};
        for (int k = 0; k < a.length; k += 2) TYPE_ALIASES.put(a[k], a[k + 1]);
    }

    static final List<String> TEXT_FIELDS = Arrays.asList("title", "container-title", "container-title-short", "collection-title", "volume", "issue", "page",
        "number", "edition", "DOI", "PMID", "PMCID", "URL", "ISSN", "ISBN", "publisher", "publisher-place", "abstract",
        "language", "note", "genre", "event-title", "event-place");
    static final List<String> NAME_FIELDS = Arrays.asList("author", "editor", "container-author", "translator");
    static final List<String> DATE_FIELDS = Arrays.asList("issued", "accessed");
    static final List<String> NAME_KEYS = Arrays.asList("family", "given", "literal", "suffix", "dropping-particle", "non-dropping-particle");

    /** Every field a library item may carry after normalization (plus `id`). */
    public static final Set<String> ITEM_FIELDS = new LinkedHashSet<>();
    static {
        ITEM_FIELDS.add("type");
        ITEM_FIELDS.addAll(TEXT_FIELDS);
        ITEM_FIELDS.addAll(NAME_FIELDS);
        ITEM_FIELDS.addAll(DATE_FIELDS);
    }

    public static Map<String, Object> cleanName(Object name) {
        if (name instanceof String) {
            String s = Text.squash((String) name);
            return s.isEmpty() ? null : Json.obj("literal", s);
        }
        Map<String, Object> n = map(name);
        if (n == null) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        for (String key : NAME_KEYS) {
            Object v = n.get(key);
            if (v instanceof String && !Text.squash((String) v).isEmpty()) out.put(key, Text.squash((String) v));
        }
        if (!out.containsKey("family") && !out.containsKey("literal")) {
            // Organisations arrive as { name: "…" } from Crossref; a lone given name is kept as a literal.
            Object nm = n.get("name");
            String fallback = nm instanceof String && !Text.squash((String) nm).isEmpty() ? Text.squash((String) nm) : (String) out.get("given");
            if (fallback == null || fallback.isEmpty()) return null;
            out.remove("given");
            out.put("literal", fallback);
        }
        if (out.containsKey("literal")) out.keySet().retainAll(Arrays.asList("literal"));
        return out;
    }

    private static final Pattern DATE_STRING = Pattern.compile("^(\\d{4})(?:-(\\d{1,2})(?:-(\\d{1,2}))?)?");

    public static Map<String, Object> cleanDate(Object date) {
        if (date instanceof String || date instanceof Number) {
            String s = Text.trim(Json.jsString(date));
            Matcher m = DATE_STRING.matcher(s);
            if (m.find()) {
                List<Object> parts = new ArrayList<>();
                for (int g = 1; g <= 3; g++) if (m.group(g) != null && !m.group(g).isEmpty()) parts.add(Long.parseLong(m.group(g)));
                return Json.obj("date-parts", Json.arr(parts));
            }
            return s.isEmpty() ? null : Json.obj("literal", s);
        }
        Map<String, Object> d = map(date);
        if (d == null) return null;
        List<Object> dp = list(d.get("date-parts"));
        List<Object> first = dp != null && !dp.isEmpty() ? list(dp.get(0)) : null;
        if (first != null) {
            List<Object> parts = new ArrayList<>();
            for (Object part : first) {
                Double n = part instanceof String ? jsNumber(Text.trim((String) part)) : part instanceof Number ? ((Number) part).doubleValue() : null;
                if (n == null || n != Math.rint(n) || Double.isInfinite(n) || n <= 0) break;
                parts.add(Json.normalizeNumber(n));
            }
            if (!parts.isEmpty() && num(parts.get(0)) >= 1 && num(parts.get(0)) <= 9999) {
                if (parts.size() > 1 && num(parts.get(1)) > 12) parts = new ArrayList<>(parts.subList(0, 1));
                if (parts.size() > 2 && num(parts.get(2)) > 31) parts = new ArrayList<>(parts.subList(0, 2));
                return Json.obj("date-parts", Json.arr(parts));
            }
        }
        if (d.get("literal") instanceof String && !Text.trim((String) d.get("literal")).isEmpty()) return Json.obj("literal", Text.trim((String) d.get("literal")));
        if (d.get("raw") instanceof String) return cleanDate(d.get("raw"));
        if (d.get("date-time") instanceof String) return cleanDate(d.get("date-time"));
        return null;
    }

    private static double num(Object o) { return ((Number) o).doubleValue(); }

    private static final Pattern JS_NUMBER = Pattern.compile("^[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?$");

    /** Number(s) for an already trimmed string; null for NaN. */
    static Double jsNumber(String s) {
        if (s.isEmpty()) return 0.0;
        if (JS_NUMBER.matcher(s).matches()) return Double.parseDouble(s);
        if (s.matches("^0[xX][0-9a-fA-F]+$")) return (double) Long.parseLong(s.substring(2), 16);
        return null;
    }

    private static final Pattern ENTITY = Pattern.compile("&(#x[0-9a-f]+|#\\d+|amp|lt|gt|quot|apos|nbsp);", Pattern.CASE_INSENSITIVE);

    static String decodeEntities(String s) {
        return Text.replace(s, ENTITY, (m) -> {
            String c = Text.lower(m.group(1));
            if (c.charAt(0) == '#') {
                try {
                    long n = c.charAt(1) == 'x' ? Long.parseLong(c.substring(2), 16) : Long.parseLong(c.substring(1), 10);
                    if (n < 0 || n > 0x10ffff) return m.group();
                    return new String(Character.toChars((int) n));
                } catch (NumberFormatException e) { return m.group(); }
            }
            switch (c) {
                case "amp": return "&";
                case "lt": return "<";
                case "gt": return ">";
                case "quot": return "\"";
                case "apos": return "'";
                default: return " ";
            }
        });
    }

    private static final Pattern ABSTRACT_TITLE = Pattern.compile("<(?:jats:)?title>" + Text.WS + "*(?:abstract|summary)" + Text.WS + "*</(?:jats:)?title>", Pattern.CASE_INSENSITIVE);
    private static final Pattern BLOCK_END = Pattern.compile("</(?:jats:)?(?:p|sec|title)>", Pattern.CASE_INSENSITIVE);
    private static final Pattern TAG = Pattern.compile("<[^>]+>");

    /** Strip JATS / HTML markup from abstracts. */
    public static String plainText(String value) {
        String s = ABSTRACT_TITLE.matcher(value).replaceAll("");
        s = BLOCK_END.matcher(s).replaceAll("\n");
        s = TAG.matcher(s).replaceAll(" ");
        return Text.squash(decodeEntities(s));
    }

    private static final Pattern T_I = Pattern.compile("<(/?)(?:jats:|mml:)?(i|italic)>", Pattern.CASE_INSENSITIVE);
    private static final Pattern T_B = Pattern.compile("<(/?)(?:jats:|mml:)?(b|bold)>", Pattern.CASE_INSENSITIVE);
    private static final Pattern T_SUB = Pattern.compile("<(/?)(?:jats:|mml:)?(sub|sup)>", Pattern.CASE_INSENSITIVE);
    private static final Pattern T_OTHER = Pattern.compile("<(?!/?(?:i|b|sub|sup)>)[^>]+>", Pattern.CASE_INSENSITIVE);

    /** Remove markup that citeproc cannot render, keeping its supported inline tags. */
    public static String cleanTitle(String value) {
        String s = T_I.matcher(value).replaceAll("<$1i>");
        s = T_B.matcher(s).replaceAll("<$1b>");
        s = T_SUB.matcher(s).replaceAll("<$1$2>");
        s = T_OTHER.matcher(s).replaceAll("");
        return Text.squash(s);
    }

    private static final Pattern DOI_PREFIX = Pattern.compile("^(?:https?://)?(?:dx\\.)?doi\\.org/", Pattern.CASE_INSENSITIVE);
    private static final Pattern DOI_LABEL = Pattern.compile("^doi:" + Text.WS + "*", Pattern.CASE_INSENSITIVE);
    private static final Pattern DOI_BODY = Pattern.compile("10\\.\\d{4,9}/[^\\t\\n\\x0B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+");
    private static final Pattern DOI_TAIL = Pattern.compile("[.,;:)\\]}>'\"]+$");

    public static String normalizeDOI(Object value) {
        if (!(value instanceof String)) return "";
        String doi = Text.trim((String) value);
        try { doi = Text.decodeURIComponent(doi); } catch (IllegalArgumentException e) { /* keep as typed */ }
        doi = DOI_PREFIX.matcher(doi).replaceFirst("");
        doi = Text.trim(DOI_LABEL.matcher(doi).replaceFirst(""));
        Matcher m = DOI_BODY.matcher(doi);
        return m.find() ? DOI_TAIL.matcher(m.group()).replaceFirst("") : "";
    }

    /**
     * Turn any CSL-ish record into a clean library item (without `id`). Unknown remote fields are
     * dropped; this is only applied to incoming metadata, never to items already in the library.
     */
    public static Map<String, Object> normalizeItem(Object rawValue) {
        Map<String, Object> raw = map(rawValue);
        if (raw == null) throw new UserError("Lookup returned no metadata");
        Map<String, Object> item = new LinkedHashMap<>();
        String type = raw.get("type") instanceof String ? Text.trim((String) raw.get("type")) : "";
        type = TYPE_ALIASES.getOrDefault(type, type);
        item.put("type", CSL_TYPES.contains(type) ? type : "article-journal");

        for (String key : TEXT_FIELDS) {
            Object value = raw.get(key);
            if (value instanceof List) {
                Object found = "";
                for (Object v : (List<?>) value) if (v instanceof String && !Text.trim((String) v).isEmpty()) { found = v; break; }
                value = found;
            }
            if (value instanceof Number) value = Json.jsString(value);
            if (!(value instanceof String)) continue;
            String v = (String) value;
            v = key.equals("abstract") ? plainText(v) : key.equals("title") || key.equals("container-title") ? cleanTitle(decodeEntities(v)) : Text.squash(v);
            if (!v.isEmpty()) item.put(key, v);
        }
        if (!item.containsKey("page") && raw.get("article-number") instanceof String && !Text.trim((String) raw.get("article-number")).isEmpty()) {
            item.put("page", Text.trim((String) raw.get("article-number")));
        }
        if (item.containsKey("DOI")) {
            String d = normalizeDOI(item.get("DOI"));
            if (!d.isEmpty()) item.put("DOI", d);
        }
        if (item.containsKey("PMID")) {
            String p = ((String) item.get("PMID")).replaceAll("\\D", "");
            if (p.isEmpty()) item.remove("PMID");
            else item.put("PMID", p);
        }

        for (String key : NAME_FIELDS) {
            List<Object> names = list(raw.get(key));
            if (names == null) continue;
            List<Object> clean = new ArrayList<>();
            for (Object n : names) { Map<String, Object> c = cleanName(n); if (c != null) clean.add(c); }
            if (!clean.isEmpty()) item.put(key, clean);
        }

        Map<String, Object> issued = null;
        for (String k : new String[]{"issued", "published-print", "published-online", "published", "created"}) {
            issued = cleanDate(raw.get(k));
            if (issued != null) break;
        }
        if (issued != null) item.put("issued", issued);
        Map<String, Object> accessed = cleanDate(raw.get("accessed"));
        if (accessed != null) item.put("accessed", accessed);

        if (!item.containsKey("title")) throw new UserError("The record has no title");
        // Chinese (and Japanese) references say so: styles such as GB/T 7714 choose 等 or et al. by this.
        if (!item.containsKey("language")) {
            String lang = languageOf((String) item.get("title"));
            if (lang != null) item.put("language", lang);
        }
        return item;
    }

    // ---------- Chinese ----------

    /** A Han character (CJK ideograph)? */
    public static boolean isHan(int cp) {
        return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2ebef) || (cp >= 0xf900 && cp <= 0xfaff);
    }

    public static boolean hasHan(String s) {
        return s != null && s.codePoints().anyMatch(Metadata::isHan);
    }

    /** "zh-CN" for a title in Chinese characters, "ja" when it also has kana, else null (unknown). */
    public static String languageOf(String title) {
        if (!hasHan(title)) return null;
        return title.codePoints().anyMatch(c -> c >= 0x3040 && c <= 0x30ff) ? "ja" : "zh-CN";
    }

    private static final List<String> COMPOUND_SURNAMES = Arrays.asList("欧阳", "司马", "上官", "诸葛", "东方", "皇甫", "尉迟", "公孙", "慕容", "长孙", "宇文",
        "司徒", "令狐", "夏侯", "端木", "轩辕", "独孤", "南宫", "西门", "东郭", "呼延", "澹台", "公冶", "宗政", "濮阳", "淳于", "单于", "太叔", "申屠",
        "赫连", "闻人", "万俟", "钟离", "即墨", "百里", "拓跋");

    /**
     * A Chinese personal name written without a space ("张三", "欧阳修", "王小明") as family + given, so
     * styles can sort and shorten it. null for anything else (also longer names: organisations).
     */
    public static Map<String, Object> hanName(String value) {
        String s = Text.squash(value == null ? "" : value);
        String[] words = s.split(" ");
        if (words.length == 2 && allHan(words[0]) && allHan(words[1]) && s.length() <= 6) return Json.obj("family", words[0], "given", words[1]);
        int n = s.codePointCount(0, s.length());
        if (!allHan(s) || n < 2 || n > 4) return null;
        int cut = n >= 3 && COMPOUND_SURNAMES.contains(s.substring(0, 2)) ? 2 : 1;
        return Json.obj("family", s.substring(0, cut), "given", s.substring(cut));
    }

    private static boolean allHan(String s) {
        return !s.isEmpty() && s.codePoints().allMatch(Metadata::isHan);
    }

    // The pinyin of common surnames, for citation keys (zhang2020 instead of ref2020).
    private static final Map<String, String> PINYIN = new HashMap<>();
    static {
        String table = "王wang 李li 张zhang 刘liu 陈chen 杨yang 黄huang 赵zhao 吴wu 周zhou 徐xu 孙sun 马ma 朱zhu 胡hu 郭guo 何he 高gao 林lin 罗luo "
            + "郑zheng 梁liang 谢xie 宋song 唐tang 许xu 韩han 冯feng 邓deng 曹cao 彭peng 曾zeng 肖xiao 田tian 董dong 袁yuan 潘pan 于yu 蒋jiang 蔡cai "
            + "余yu 杜du 叶ye 程cheng 苏su 魏wei 吕lv 丁ding 任ren 沈shen 姚yao 卢lu 姜jiang 崔cui 钟zhong 谭tan 陆lu 汪wang 范fan 金jin 石shi 廖liao "
            + "贾jia 夏xia 韦wei 付fu 傅fu 方fang 白bai 邹zou 孟meng 熊xiong 秦qin 邱qiu 江jiang 尹yin 薛xue 闫yan 阎yan 段duan 雷lei 侯hou 龙long 史shi "
            + "陶tao 黎li 贺he 顾gu 毛mao 郝hao 龚gong 邵shao 万wan 钱qian 严yan 覃qin 武wu 戴dai 莫mo 孔kong 向xiang 汤tang 常chang 温wen 康kang 施shi "
            + "文wen 牛niu 樊fan 葛ge 邢xing 安an 齐qi 易yi 乔qiao 伍wu 庞pang 颜yan 倪ni 庄zhuang 聂nie 章zhang 鲁lu 岳yue 翟zhai 殷yin 詹zhan 申shen "
            + "耿geng 关guan 兰lan 焦jiao 俞yu 左zuo 柳liu 甘gan 祝zhu 包bao 宁ning 尚shang 符fu 舒shu 阮ruan 柯ke 纪ji 梅mei 童tong 凌ling 毕bi 单shan "
            + "季ji 裴pei 霍huo 涂tu 成cheng 苗miao 谷gu 盛sheng 曲qu 翁weng 冉ran 骆luo 蓝lan 路lu 游you 辛xin 靳jin 管guan 柴chai 蒙meng 鲍bao 华hua "
            + "喻yu 祁qi 蒲pu 房fang 滕teng 屈qu 饶rao 解xie 牟mou 艾ai 尤you 阳yang 时shi 穆mu 农nong 司si 卓zhuo 古gu 吉ji 缪miao 简jian 车che 项xiang "
            + "连lian 芦lu 麦mai 褚chu 娄lou 窦dou 戚qi 岑cen 景jing 党dang 宫gong 费fei 卜bu 冷leng 晏yan 席xi 卫wei 米mi 柏bai 宗zong 瞿qu 桂gui 全quan "
            + "佟tong 应ying 臧zang 闵min 苟gou 邬wu 边bian 卞bian 姬ji 师shi 和he 仇qiu 栾luan 隋sui 商shang 刁diao 沙sha 荣rong 巫wu 寇kou 桑sang 郎lang "
            + "甄zhen 丛cong 仲zhong 虞yu 敖ao 巩gong 明ming 佘she 池chi 查zha 麻ma 苑yuan 迟chi 邝kuang 官guan 封feng 谈tan 匡kuang 鞠ju 惠hui 荆jing "
            + "乐le 冀ji 郁yu 胥xu 南nan 班ban 储chu 原yuan 栗li 燕yan 楚chu 鄢yan 劳lao 谌chen 奚xi 皮pi 粟su 冼xian 蔺lin 楼lou 盘pan 满man 闻wen 位wei "
            + "厉li 伊yi 仝tong 区ou 郜gao 海hai 阚kan 花hua 权quan 强qiang 帅shuai 屠tu 豆dou 朴piao 盖ge 练lian 廉lian 禹yu 井jing 祖zu 漆qi 巴ba 丰feng "
            + "支zhi 卿qing 国guo 狄di 平ping 计ji 索suo 宣xuan 晋jin 相xiang 初chu 门men 云yun 容rong 敬jing 来lai 扈hu 晁chao 芮rui 都du 普pu 阙que 浦pu "
            + "束shu 戈ge 伏fu 鹿lu 薄bo 邸di 雍yong 辜gu 羊yang 阿a 乌wu 母mu 裘qiu 亓qi 修xiu 邰tai 赫he 杭hang 况kuang 那na 宿su 鲜xian 印yin 逯lu 隆long 茹ru "
            + "欧阳ouyang 司马sima 上官shangguan 诸葛zhuge 东方dongfang 皇甫huangfu 尉迟yuchi 公孙gongsun 慕容murong 长孙zhangsun 宇文yuwen 司徒situ "
            + "令狐linghu 夏侯xiahou 端木duanmu 轩辕xuanyuan 独孤dugu 南宫nangong 西门ximen 东郭dongguo 呼延huyan 澹台tantai 濮阳puyang 淳于chunyu "
            + "申屠shentu 赫连helian 闻人wenren 万俟moqi 钟离zhongli 拓跋tuoba";
        for (String entry : table.split(" ")) {
            int k = 0;
            while (k < entry.length() && isHan(entry.charAt(k))) k++;
            PINYIN.put(entry.substring(0, k), entry.substring(k));
        }
    }

    /** The pinyin of the surname a Chinese name starts with ("张三" → "zhang"), or "". */
    static String surnamePinyin(String name) {
        if (name == null || name.isEmpty() || !isHan(name.codePointAt(0))) return "";
        if (name.length() >= 3 && PINYIN.containsKey(name.substring(0, 2)) || name.length() == 2 && COMPOUND_SURNAMES.contains(name)) {
            String p = PINYIN.get(name.substring(0, 2));
            if (p != null) return p;
        }
        return PINYIN.getOrDefault(name.substring(0, 1), "");
    }

    // ---------- identifiers ----------

    public static final class Request {
        public final String input, kind, value;
        Request(String input, String kind, String value) { this.input = input; this.kind = kind; this.value = value; }
    }

    private static final Pattern PMID_LABEL = Pattern.compile("\\bpmid" + Text.WS + "*[:#]?" + Text.WS + "*(?=\\d)", Pattern.CASE_INSENSITIVE);
    private static final Pattern DOI_COLON = Pattern.compile("\\bdoi" + Text.WS + "*:" + Text.WS + "*", Pattern.CASE_INSENSITIVE);
    private static final Pattern SPLIT = Pattern.compile("(?:" + Text.WS + "|[,;])+");
    private static final Pattern PUBMED_URL = Pattern.compile("pubmed\\.ncbi\\.nlm\\.nih\\.gov/(\\d+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern PMID_TOKEN = Pattern.compile("^PMID:(\\d{1,9})$", Pattern.CASE_INSENSITIVE);
    private static final Pattern DIGITS = Pattern.compile("^(\\d{1,9})$");

    /** Split pasted text into DOI / PMID requests, without duplicates. */
    public static List<Request> parseIdentifiers(Object textValue) {
        List<Request> out = new ArrayList<>();
        if (!(textValue instanceof String)) return out;
        String prepared = PMID_LABEL.matcher((String) textValue).replaceAll("PMID:");
        prepared = DOI_COLON.matcher(prepared).replaceAll("doi:");
        Set<String> seen = new HashSet<>();
        for (String token : SPLIT.split(prepared)) {
            String input = Text.trim(token);
            if (input.isEmpty()) continue;
            String kind = "invalid", value = input;
            Matcher pubmed = PUBMED_URL.matcher(input);
            Matcher pmid = PMID_TOKEN.matcher(input);
            Matcher digits = DIGITS.matcher(input);
            if (pubmed.find()) { kind = "pmid"; value = pubmed.group(1); }
            else if (pmid.find()) { kind = "pmid"; value = pmid.group(1); }
            else if (digits.find()) { kind = "pmid"; value = digits.group(1); }
            else if (!normalizeDOI(input).isEmpty()) { kind = "doi"; value = normalizeDOI(input); }
            String key = kind + ":" + Text.lower(value);
            if (!seen.add(key)) continue;
            out.add(new Request(input, kind, value));
        }
        return out;
    }

    // ---------- remote lookup ----------

    /** A lookup failure; status 404 means "not found" (as opposed to unreachable). */
    public static final class LookupError extends RuntimeException {
        public final int status;
        LookupError(String message, int status) { super(message); this.status = status; }
        LookupError(String message) { this(message, 0); }
    }

    static Object getJSON(Net.Fetcher fetch, String url, String accept) {
        Net.Response r;
        try {
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("Accept", accept);
            r = fetch.get(url, headers);
        } catch (Net.NetError e) {
            String host = Net.host(url);
            throw new LookupError(e.timeout ? host + " did not answer in time" : "Cannot reach " + host + " (" + e.code + "). Check your internet connection.");
        }
        if (r.status == 404) throw new LookupError("Not found", 404);
        if (!r.ok()) throw new LookupError("Lookup failed (HTTP " + r.status + ")");
        try { return Json.parse(r.text()); } catch (Json.ParseException e) { throw new LookupError("The lookup service returned something other than JSON"); }
    }

    private static String doiPath(String doi) {
        return String.join("/", Arrays.stream(doi.split("/", -1)).map(Text::encodeURIComponent).toArray(String[]::new));
    }

    static List<String> crossrefURLs(String doi) {
        return Arrays.asList("https://doi.org/" + doiPath(doi),
            "https://api.crossref.org/works/" + doiPath(doi) + "/transform/application/vnd.citationstyles.csl+json");
    }

    private static Map<String, Object> crossrefItem(String url, String doi, Net.Fetcher fetch) {
        Map<String, Object> item = normalizeItem(getJSON(fetch, url, "application/vnd.citationstyles.csl+json"));
        if (!Json.truthy(item.get("DOI"))) item.put("DOI", doi);
        return item;
    }

    /** The raw PubMed CSL record for a PMID, or null. */
    private static Map<String, Object> pubmedRecord(String pmid, Net.Fetcher fetch) {
        Object data = getJSON(fetch, "https://api.ncbi.nlm.nih.gov/lit/ctxp/v1/pubmed/?format=csl&id=" + pmid, "application/json");
        if (data instanceof List) data = ((List<?>) data).isEmpty() ? null : ((List<?>) data).get(0);
        Map<String, Object> m = map(data);
        return m != null && (Json.truthy(m.get("title")) || Json.truthy(m.get("DOI"))) ? m : null;
    }

    private static Map<String, Object> pubmedItem(Map<String, Object> data, String pmid) {
        Map<String, Object> item = normalizeItem(data);
        // PubMed titles end with a period; styles add their own punctuation.
        String title = (String) item.get("title");
        if (title.matches("(?s).*[^.]\\.$")) item.put("title", title.substring(0, title.length() - 1));
        item.put("PMID", pmid);
        if (data.get("PMCID") instanceof String && !Text.trim((String) data.get("PMCID")).isEmpty()) item.put("PMCID", Text.trim((String) data.get("PMCID")));
        return item;
    }

    /**
     * Backup for DOIs when doi.org / Crossref cannot be reached: find the PMID with NCBI E-utilities,
     * then read the PubMed record. Only a record carrying the same DOI is accepted.
     */
    public static Map<String, Object> lookupDOIviaPubMed(String doi, Net.Fetcher fetch) {
        List<String> pmids = new ArrayList<>();
        for (String field : new String[]{"doi", "aid"}) {
            String url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=5&term=" + Text.encodeURIComponent(doi + "[" + field + "]");
            Map<String, Object> data = map(getJSON(fetch, url, "application/json"));
            Map<String, Object> result = data == null ? null : map(data.get("esearchresult"));
            List<Object> ids = result == null ? null : list(result.get("idlist"));
            pmids.clear();
            if (ids != null) for (Object id : ids) { String s = Json.jsString(id); if (s.matches("^\\d{1,9}$")) pmids.add(s); }
            if (!pmids.isEmpty()) break;
        }
        for (String pmid : pmids) {
            Map<String, Object> data = pubmedRecord(pmid, fetch);
            if (data != null && Text.lower(normalizeDOI(data.get("DOI") == null ? "" : data.get("DOI"))).equals(Text.lower(doi))) {
                Map<String, Object> item = pubmedItem(data, pmid);
                item.put("DOI", doi);
                return item;
            }
        }
        throw new LookupError("Not in PubMed", 404);
    }

    private static int status(Throwable e) { return e instanceof LookupError ? ((LookupError) e).status : 0; }

    private static Throwable cause(Throwable e) {
        while (e instanceof java.util.concurrent.CompletionException || e instanceof java.util.concurrent.ExecutionException) e = e.getCause();
        return e;
    }

    /**
     * DOI → CSL item. doi.org first; if that fails, Crossref and PubMed are asked at the same time
     * (so an unreachable Crossref costs one timeout, not two) and Crossref's richer record wins.
     */
    public static Map<String, Object> lookupDOI(String doi, Net.Fetcher fetch) {
        List<String> urls = crossrefURLs(doi);
        RuntimeException first;
        try { return crossrefItem(urls.get(0), doi, fetch); } catch (RuntimeException e) { first = e; }
        CompletableFuture<Map<String, Object>> fromCrossref = CompletableFuture.supplyAsync(() -> crossrefItem(urls.get(1), doi, fetch), Proc.POOL);
        CompletableFuture<Map<String, Object>> fromPubMed = CompletableFuture.supplyAsync(() -> lookupDOIviaPubMed(doi, fetch), Proc.POOL);
        Throwable a = null, b = null;
        Map<String, Object> ra = null, rb = null;
        try { ra = fromCrossref.join(); } catch (Throwable e) { a = cause(e); }
        try { rb = fromPubMed.join(); } catch (Throwable e) { b = cause(e); }
        if (ra != null) return ra;
        if (rb != null) return rb;
        Throwable[] errors = {first, a, b};
        boolean allMissing = true;
        for (Throwable e : errors) allMissing &= status(e) == 404;
        if (allMissing) throw new LookupError("DOI " + doi + " was not found");
        Throwable reason = null;
        for (Throwable e : errors) if (status(e) != 404) { reason = e; break; }
        throw new LookupError(reason.getMessage() + " (also tried Crossref and PubMed)");
    }

    public static Map<String, Object> lookupPMID(String pmid, Net.Fetcher fetch) {
        Map<String, Object> data;
        try {
            data = pubmedRecord(pmid, fetch);
        } catch (LookupError e) {
            if (e.status == 404) throw new LookupError("PMID " + pmid + " was not found");
            throw e;
        }
        if (data == null) throw new LookupError("PMID " + pmid + " was not found");
        Map<String, Object> item = null;
        String doi = normalizeDOI(data.get("DOI") == null ? "" : data.get("DOI"));
        if (!doi.isEmpty()) {
            // Crossref metadata is usually richer (full journal names, pages); keep PubMed IDs on top.
            for (String url : crossrefURLs(doi)) {
                try { item = crossrefItem(url, doi, fetch); break; } catch (RuntimeException e) { /* next, then PubMed itself */ }
            }
        }
        if (item == null) return pubmedItem(data, pmid);
        item.put("PMID", pmid);
        if (data.get("PMCID") instanceof String && !Text.trim((String) data.get("PMCID")).isEmpty()) item.put("PMCID", Text.trim((String) data.get("PMCID")));
        return item;
    }

    public static Map<String, Object> lookupIdentifier(Request r, Net.Fetcher fetch) {
        if (r.kind.equals("doi")) return lookupDOI(r.value, fetch);
        if (r.kind.equals("pmid")) return lookupPMID(r.value, fetch);
        throw new LookupError("Not a DOI or PMID");
    }

    // ---------- citation keys ----------

    static String ascii(String s) {
        String n = Normalizer.normalize(s, Normalizer.Form.NFKD).replaceAll("[\\u0300-\\u036f]", "");
        return Text.lower(n).replaceAll("[^a-z0-9]", "");
    }

    private static String clip(String s, int n) { return s.length() > n ? s.substring(0, n) : s; }

    public static String citationKey(Map<String, Object> item, Set<String> used) {
        List<Object> names = list(item.get("author"));
        if (!Json.truthy(item.get("author"))) names = list(item.get("editor"));
        Map<String, Object> first = names != null && !names.isEmpty() && map(names.get(0)) != null ? map(names.get(0)) : new HashMap<>();
        Object fam = Json.truthy(first.get("family")) ? first.get("family") : first.get("literal");
        String name = clip(ascii(Json.truthy(fam) ? Json.jsString(fam) : ""), 24);
        if (name.isEmpty() && Json.truthy(fam)) name = surnamePinyin(Json.jsString(fam));
        if (name.isEmpty()) name = clip(ascii(Json.truthy(item.get("title")) ? Json.jsString(item.get("title")) : ""), 12);
        if (name.isEmpty()) name = "ref";
        String year = "";
        Map<String, Object> issued = map(item.get("issued"));
        List<Object> dp = issued == null ? null : list(issued.get("date-parts"));
        List<Object> p0 = dp == null || dp.isEmpty() ? null : list(dp.get(0));
        if (p0 != null && !p0.isEmpty() && p0.get(0) != null) year = Json.jsString(p0.get(0));
        String base = name + year;
        if (!used.contains(base)) return base;
        for (int n = 0; ; n++) {
            String suffix = "";
            int k = n;
            do { suffix = (char) (97 + (k % 26)) + suffix; k = k / 26 - 1; } while (k >= 0);
            if (!used.contains(base + suffix)) return base + suffix;
        }
    }
}
