package toolsKit.LicenseHub;

/** Test stand-in for TBtools' license chooser: like the real one, it only looks at "is this a Mac". */
public class GetLicense {
    public static String getJxBroswerLicense() {
        return System.getProperty("os.name").toLowerCase().contains("mac") ? "MAC-KEY" : "OTHER-KEY";
    }
}
