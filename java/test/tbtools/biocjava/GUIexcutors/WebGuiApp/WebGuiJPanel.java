package biocjava.GUIexcutors.WebGuiApp;

import javax.swing.JPanel;

/**
 * Test stand-in for TBtools' browser panel, with the behaviour that matters to the plugin: the
 * constructor sets jxbrowser.license.key from GetLicense and needs the shared engine; getEngine()
 * keeps one engine. With -Dstub.licenses=KEY1,KEY2 only those keys create an engine (else
 * InvalidLicenseException, as TBtools' Intel build on a Mac); "none" makes every key fail.
 */
public class WebGuiJPanel extends JPanel {
    private static Object engine;
    public static String lastUrl;

    public static synchronized Object getEngine() {
        if (engine == null) {
            String key = System.getProperty("jxbrowser.license.key");
            String allowed = System.getProperty("stub.licenses", "MAC-KEY,OTHER-KEY");
            if (!("," + allowed + ",").contains("," + key + ",")) throw new RuntimeException(new com.teamdev.jxbrowser.engine.InvalidLicenseException("Invalid license"));
            engine = new Object();
        }
        return engine;
    }

    public WebGuiJPanel(String url, boolean controlMenu) {
        System.setProperty("jxbrowser.license.key", toolsKit.LicenseHub.GetLicense.getJxBroswerLicense());
        getEngine();
        lastUrl = url;
    }
}
