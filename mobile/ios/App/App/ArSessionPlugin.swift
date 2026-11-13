import ARKit
import Capacitor
import simd

/// ARKit world tracking behind the `ArSession` Capacitor plugin (src/ar/native-provider.ts). Its Android twin is
/// mobile/android/app/src/main/java/com/companionintelligence/scan/ArSessionPlugin.java.
///
/// What this milestone does: the ARSession runs world tracking and pushes each frame's pose to the page. It does
/// not render the camera feed (no ARView or ARSCNView) and does not hand out camera frames, so the web side's
/// captureFrame and hitTest are not wired to it yet. RealityKit is out of scope.
///
/// Events pushed to the page:
/// - `pose`: `{ position: {x, y, z}, rotation: {x, y, z, w}, trackingStatus }`, once for each ARKit frame.
/// - `state`: `{ running, reason? }` when the session starts, stops, is interrupted, resumes or fails.
///
/// ScanBridgeViewController.capacitorDidLoad() puts this plugin on the bridge.
@objc(ArSessionPlugin)
public class ArSessionPlugin: CAPPlugin, CAPBridgedPlugin, ARSessionDelegate {
    public let identifier = "ArSessionPlugin"
    public let jsName = "ArSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private var arSession: ARSession?

    @objc public func isSupported(_ call: CAPPluginCall) {
        call.resolve(["supported": ARWorldTrackingConfiguration.isSupported])
    }

    @objc public func start(_ call: CAPPluginCall) {
        guard ARWorldTrackingConfiguration.isSupported else {
            call.reject("ARKit world tracking is not supported on this device", "UNSUPPORTED")
            return
        }
        if arSession != nil {
            call.resolve()
            return
        }
        let session = ARSession()
        session.delegate = self
        let configuration = ARWorldTrackingConfiguration()
        // The room scanner reads feature points, not detected planes, so plane detection stays off.
        configuration.planeDetection = []
        session.run(configuration)
        arSession = session
        notifyListeners("state", data: ["running": true])
        call.resolve()
    }

    @objc public func stop(_ call: CAPPluginCall) {
        endSession(reason: nil)
        call.resolve()
    }

    private func endSession(reason: String?) {
        arSession?.delegate = nil
        arSession?.pause()
        arSession = nil
        var data: [String: Any] = ["running": false]
        if let reason = reason {
            data["reason"] = reason
        }
        notifyListeners("state", data: data)
    }

    // MARK: - ARSessionDelegate

    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let transform = frame.camera.transform
        let position = transform.columns.3
        let rotationMatrix = simd_float3x3(
            SIMD3<Float>(transform.columns.0.x, transform.columns.0.y, transform.columns.0.z),
            SIMD3<Float>(transform.columns.1.x, transform.columns.1.y, transform.columns.1.z),
            SIMD3<Float>(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)
        )
        let rotation = simd_quatf(rotationMatrix)
        notifyListeners("pose", data: [
            "position": ["x": Double(position.x), "y": Double(position.y), "z": Double(position.z)],
            "rotation": [
                "x": Double(rotation.imag.x),
                "y": Double(rotation.imag.y),
                "z": Double(rotation.imag.z),
                "w": Double(rotation.real),
            ],
            "trackingStatus": trackingStatus(frame.camera.trackingState),
        ])
    }

    public func sessionWasInterrupted(_ session: ARSession) {
        notifyListeners("state", data: ["running": false, "reason": "interrupted"])
    }

    public func sessionInterruptionEnded(_ session: ARSession) {
        notifyListeners("state", data: ["running": true])
    }

    public func session(_ session: ARSession, didFailWithError error: Error) {
        endSession(reason: error.localizedDescription)
    }

    /// ARKit's tracking state in the words the web side uses (src/ar/tracking-quality.ts).
    private func trackingStatus(_ state: ARCamera.TrackingState) -> String {
        switch state {
        case .normal:
            return "NORMAL"
        case .notAvailable:
            return "NOT_AVAILABLE"
        case .limited(let reason):
            return reason == .initializing ? "INITIALIZING" : "LIMITED"
        }
    }
}
