import Capacitor
import UIKit

/// The app's Capacitor bridge view controller. Main.storyboard names this class as the root view controller.
///
/// The bridge registers the npm plugins that its capacitor.config.json lists. The app's own plugin is not in that
/// list, so it is registered here, with registerPluginInstance. capacitorDidLoad() runs after the bridge is created
/// and before the page loads, which is when a plugin has to be on the bridge.
@objc(ScanBridgeViewController)
class ScanBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ArSessionPlugin())
    }
}
