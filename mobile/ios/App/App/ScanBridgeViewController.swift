import Capacitor
import UIKit

/// The Scan shell's bridge view controller. Capacitor finds npm plugins from the generated config, but
/// a plugin written in this app target has to be registered here, so this subclass registers ScanAR
/// when the bridge loads.
class ScanBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ScanARPlugin())
    }

    /// Portrait only. The native camera view is fitted to the portrait overlay rect, and a rotation
    /// mid-scan would change the frame under the overlay.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        .portrait
    }
}
