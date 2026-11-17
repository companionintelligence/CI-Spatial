import ARKit
import Capacitor
import SceneKit
import UIKit
import simd

/// The ScanAR plugin: ARKit for the Scan iOS shell, the native half of the web app's NativeARProvider
/// (src/ar/native.ts). The web side is the contract; keep the event and method names in step with
/// src/ar/native-bridge.ts.
///
/// What it does:
///   - Runs an ARKit world-tracking session and shows the camera in an ARSCNView placed beneath the
///     web view, which is made transparent while the session runs.
///   - Fits the whole camera image inside the web view ("contain"), so the overlay the scanner draws
///     covers exactly the camera's frame. The rect comes back from start() in CSS points.
///   - Streams pose and projection (pose events), feature points, and a grid of hit samples, and
///     answers captureFrame() with a JPEG of the full frame in portrait orientation.
///   - Returns LiDAR depth in metres with captureFrame({ depth: true }) on a device that has it,
///     aligned to the same portrait orientation as the JPEG.
///
/// ARKit world space is in metres, gravity-aligned and Y-up. Its yaw is arbitrary, so heading still
/// comes from the editor's calibration.
///
/// Not compiled or run in the Linux environment this repo is developed in. Verify on a device before
/// relying on it: the Android half is compiled by Gradle; this file is not compiled anywhere yet.
@objc(ScanARPlugin)
public class ScanARPlugin: CAPPlugin, CAPBridgedPlugin, ARSessionDelegate {
    public let identifier = "ScanARPlugin"
    public let jsName = "ScanAR"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "captureFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hitTest", returnType: CAPPluginReturnPromise),
    ]

    /// Event cadence, in seconds. Pose is what the overlay needs each frame; the rest is coarser.
    private let poseInterval: TimeInterval = 1.0 / 30.0
    private let pointsInterval: TimeInterval = 0.2
    private let hitsInterval: TimeInterval = 0.5
    /// Feature points sent per points event, at most.
    private let pointsPerEvent = 1500
    private let jpegQuality: CGFloat = 0.85
    private let nearM: CGFloat = 0.01
    private let farM: CGFloat = 100

    private let ciContext = CIContext()
    private var arView: ARSCNView?
    /// The camera rect in the web view's coordinate space, in points.
    private var cameraRect: CGRect = .zero
    private var hitGridSize = 20
    private var depthRequested = false
    private var lastPoseAt: TimeInterval = 0
    private var lastPointsAt: TimeInterval = 0
    private var lastHitsAt: TimeInterval = 0
    private var savedWebViewOpaque = true
    private var savedWebViewBackground: UIColor?
    private var savedScrollBackground: UIColor?

    // MARK: - Capabilities

    @objc func capabilities(_ call: CAPPluginCall) {
        let supported = ARWorldTrackingConfiguration.isSupported
        var result: [String: Any] = [
            "platform": "ios",
            "engine": supported ? "arkit" : "none",
            "supported": supported,
            "depth": ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth),
        ]
        if !supported {
            result["reason"] = "ARKit world tracking is not available on this device."
        }
        call.resolve(result)
    }

    // MARK: - Session

    @objc func start(_ call: CAPPluginCall) {
        guard ARWorldTrackingConfiguration.isSupported else {
            call.reject("ARKit world tracking is not available on this device.")
            return
        }
        let wantDepth = call.getBool("depth") ?? false
        if wantDepth && !ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
            call.reject("This device has no LiDAR depth sensor, so depth capture is unavailable.")
            return
        }
        let hitGrid = call.getInt("hitGrid") ?? 20

        DispatchQueue.main.async {
            guard let webView = self.bridge?.webView, let container = webView.superview else {
                call.reject("The web view is not ready to place the camera behind.")
                return
            }
            if self.arView != nil {
                call.resolve(self.startResult())
                return
            }

            let configuration = ARWorldTrackingConfiguration()
            configuration.planeDetection = [.horizontal, .vertical]
            if wantDepth {
                configuration.frameSemantics.insert(.sceneDepth)
            }
            let aspect = self.portraitAspect(of: configuration.videoFormat.imageResolution)
            let webBounds = CGRect(origin: .zero, size: webView.bounds.size)
            let rect = self.containedRect(in: webBounds, aspect: aspect)

            let view = ARSCNView(frame: rect.offsetBy(dx: webView.frame.minX, dy: webView.frame.minY))
            view.autoresizingMask = []
            view.automaticallyUpdatesLighting = false
            view.session.delegate = self
            container.insertSubview(view, belowSubview: webView)

            // Let the camera show through the web view while AR runs.
            self.savedWebViewOpaque = webView.isOpaque
            self.savedWebViewBackground = webView.backgroundColor
            self.savedScrollBackground = webView.scrollView.backgroundColor
            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear

            view.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
            self.arView = view
            self.cameraRect = rect
            self.depthRequested = wantDepth
            self.hitGridSize = max(2, min(hitGrid, 40))
            self.lastPoseAt = 0
            self.lastPointsAt = 0
            self.lastHitsAt = 0
            call.resolve(self.startResult())
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.tearDown()
            call.resolve()
        }
    }

    private func startResult() -> [String: Any] {
        let aspect = cameraRect.height > 0 ? cameraRect.width / cameraRect.height : 1
        return [
            "rect": [
                "x": Double(cameraRect.minX),
                "y": Double(cameraRect.minY),
                "width": Double(cameraRect.width),
                "height": Double(cameraRect.height),
            ],
            "cameraAspect": Double(aspect),
        ]
    }

    private func tearDown() {
        guard let view = arView else { return }
        view.session.pause()
        view.removeFromSuperview()
        arView = nil
        if let webView = bridge?.webView {
            webView.isOpaque = savedWebViewOpaque
            webView.backgroundColor = savedWebViewBackground
            webView.scrollView.backgroundColor = savedScrollBackground
        }
    }

    // MARK: - Frames, hits, depth

    @objc func captureFrame(_ call: CAPPluginCall) {
        let wantDepth = call.getBool("depth") ?? false
        DispatchQueue.main.async {
            guard let frame = self.arView?.session.currentFrame else {
                call.reject("AR is not running yet. Call start() and wait for tracking.")
                return
            }
            guard let jpeg = self.portraitJPEG(from: frame.capturedImage) else {
                call.reject("Could not encode the camera frame.")
                return
            }
            // The JPEG is the portrait frame, so its width is the sensor's height.
            let width = CVPixelBufferGetHeight(frame.capturedImage)
            let height = CVPixelBufferGetWidth(frame.capturedImage)
            var result: [String: Any] = [
                "timestamp": frame.timestamp,
                "width": width,
                "height": height,
                "jpegBase64": jpeg.base64EncodedString(),
                "transform": self.matrixArray(frame.camera.transform),
                "projection": self.matrixArray(self.projection(for: frame.camera)),
            ]
            if wantDepth, let depth = frame.sceneDepth, let depthPayload = self.portraitDepth(from: depth.depthMap) {
                result["depth"] = depthPayload
            }
            call.resolve(result)
        }
    }

    @objc func hitTest(_ call: CAPPluginCall) {
        let x = CGFloat(call.getDouble("x") ?? 0.5)
        let y = CGFloat(call.getDouble("y") ?? 0.5)
        DispatchQueue.main.async {
            guard let view = self.arView, let camera = view.session.currentFrame?.camera else {
                call.resolve(["hit": false])
                return
            }
            call.resolve(self.sample(atNormalized: x, y, in: view, from: camera))
        }
    }

    // MARK: - ARSessionDelegate

    public func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        notifyListeners("tracking", data: ["state": ScanARPlugin.describe(camera.trackingState)])
    }

    public func session(_ session: ARSession, didFailWithError error: Error) {
        notifyListeners("error", data: ["message": error.localizedDescription])
    }

    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let now = frame.timestamp
        if now - lastPoseAt >= poseInterval {
            lastPoseAt = now
            notifyListeners("pose", data: [
                "timestamp": now,
                "transform": matrixArray(frame.camera.transform),
                "projection": matrixArray(projection(for: frame.camera)),
                "tracking": ScanARPlugin.describe(frame.camera.trackingState),
            ])
        }
        if now - lastPointsAt >= pointsInterval, let cloud = frame.rawFeaturePoints {
            lastPointsAt = now
            notifyListeners("points", data: ["timestamp": now, "points": flatPoints(cloud.points)])
        }
        if now - lastHitsAt >= hitsInterval, let view = arView {
            lastHitsAt = now
            notifyListeners("hits", data: hitGrid(in: view, from: frame.camera, timestamp: now))
        }
    }

    // MARK: - Helpers

    /// The camera image's aspect in portrait: the sensor is landscape, so its height over its width.
    private func portraitAspect(of resolution: CGSize) -> CGFloat {
        guard resolution.width > 0 else { return 0.75 }
        return resolution.height / resolution.width
    }

    /// The largest rect of the given aspect that fits inside `bounds`, centred. The camera is shown whole.
    private func containedRect(in bounds: CGRect, aspect: CGFloat) -> CGRect {
        guard aspect > 0, bounds.width > 0, bounds.height > 0 else { return bounds }
        var width = bounds.width
        var height = width / aspect
        if height > bounds.height {
            height = bounds.height
            width = height * aspect
        }
        return CGRect(
            x: bounds.minX + (bounds.width - width) / 2,
            y: bounds.minY + (bounds.height - height) / 2,
            width: width,
            height: height
        )
    }

    private func projection(for camera: ARCamera) -> simd_float4x4 {
        let size = cameraRect.size
        return camera.projectionMatrix(for: .portrait, viewportSize: size, zNear: nearM, zFar: farM)
    }

    /// Column-major, so the web side can read it straight into a three.js matrix.
    private func matrixArray(_ m: simd_float4x4) -> [Double] {
        var out: [Double] = []
        for column in [m.columns.0, m.columns.1, m.columns.2, m.columns.3] {
            out += [Double(column.x), Double(column.y), Double(column.z), Double(column.w)]
        }
        return out
    }

    private func flatPoints(_ points: [SIMD3<Float>]) -> [Double] {
        let step = max(1, points.count / pointsPerEvent)
        var out: [Double] = []
        out.reserveCapacity(min(points.count, pointsPerEvent) * 3)
        var index = 0
        while index < points.count {
            let p = points[index]
            out += [Double(p.x), Double(p.y), Double(p.z)]
            index += step
        }
        return out
    }

    /// The full camera frame, rotated to portrait, as a JPEG.
    private func portraitJPEG(from buffer: CVPixelBuffer) -> Data? {
        let image = CIImage(cvPixelBuffer: buffer).oriented(.right)
        guard let cgImage = ciContext.createCGImage(image, from: image.extent) else { return nil }
        return UIImage(cgImage: cgImage).jpegData(compressionQuality: jpegQuality)
    }

    /// The depth map in metres, rotated to portrait like the JPEG, as Float32 little-endian, row-major.
    private func portraitDepth(from buffer: CVPixelBuffer) -> [String: Any]? {
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_DepthFloat32 else { return nil }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        // Rotating 90° clockwise: input (x, y) lands at output column (height - 1 - y), row x.
        var out = Data(count: width * height * MemoryLayout<Float32>.size)
        out.withUnsafeMutableBytes { raw in
            let destination = raw.bindMemory(to: Float32.self)
            for row in 0..<height {
                let source = (base + row * stride).assumingMemoryBound(to: Float32.self)
                for column in 0..<width {
                    destination[column * height + (height - 1 - row)] = source[column]
                }
            }
        }
        return [
            "width": height,
            "height": width,
            "metersBase64": out.base64EncodedString(),
        ]
    }

    /// A raycast from a normalised point of the camera rect. Estimated planes answer where no plane is
    /// detected yet, which is what the overlay needs to place a point on a surface.
    private func sample(atNormalized x: CGFloat, _ y: CGFloat, in view: ARSCNView, from camera: ARCamera) -> [String: Any] {
        let point = CGPoint(x: view.bounds.width * x, y: view.bounds.height * y)
        guard let query = view.raycastQuery(from: point, allowing: .estimatedPlane, alignment: .any),
              let hit = view.session.raycast(query).first else {
            return ["hit": false]
        }
        let column = hit.worldTransform.columns.3
        let position = SIMD3<Float>(column.x, column.y, column.z)
        let cameraPosition = camera.transform.columns.3
        let distance = simd_distance(position, SIMD3<Float>(cameraPosition.x, cameraPosition.y, cameraPosition.z))
        return [
            "hit": true,
            "position": [Double(position.x), Double(position.y), Double(position.z)],
            "rotation": [0.0, 0.0, 0.0, 1.0],
            "distance": Double(distance),
        ]
    }

    private func hitGrid(in view: ARSCNView, from camera: ARCamera, timestamp: TimeInterval) -> [String: Any] {
        let cols = hitGridSize
        let rows = hitGridSize
        var samples: [[String: Any]] = []
        samples.reserveCapacity(cols * rows)
        for row in 0..<rows {
            for col in 0..<cols {
                let x = (CGFloat(col) + 0.5) / CGFloat(cols)
                let y = (CGFloat(row) + 0.5) / CGFloat(rows)
                samples.append(sample(atNormalized: x, y, in: view, from: camera))
            }
        }
        return ["timestamp": timestamp, "cols": cols, "rows": rows, "samples": samples]
    }

    private static func describe(_ state: ARCamera.TrackingState) -> String {
        switch state {
        case .normal:
            return "normal"
        case .notAvailable:
            return "notAvailable"
        case .limited(let reason):
            switch reason {
            case .initializing: return "limited.initializing"
            case .excessiveMotion: return "limited.excessiveMotion"
            case .insufficientFeatures: return "limited.insufficientFeatures"
            case .relocalizing: return "limited.relocalizing"
            @unknown default: return "limited"
            }
        @unknown default:
            return "notAvailable"
        }
    }
}
