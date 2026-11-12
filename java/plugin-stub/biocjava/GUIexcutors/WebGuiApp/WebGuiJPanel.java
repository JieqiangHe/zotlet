package biocjava.GUIexcutors.WebGuiApp;

import javax.swing.JPanel;

/**
 * Compile-time stand-in for TBtools' browser panel, used when TBtools' main jar is not at hand
 * (scripts/package-java.sh). Only the constructor the plugin calls; never packaged.
 */
public class WebGuiJPanel extends JPanel {
    public WebGuiJPanel(String url, boolean controlMenu) {
    }
}
