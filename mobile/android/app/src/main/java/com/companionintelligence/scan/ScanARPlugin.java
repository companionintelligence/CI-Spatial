package com.companionintelligence.scan;

import android.Manifest;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.opengl.GLSurfaceView;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Size;
import android.view.ViewGroup;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.ar.core.ArCoreApk;
import com.google.ar.core.CameraConfig;
import com.google.ar.core.Config;
import com.google.ar.core.Session;
import com.google.ar.core.exceptions.UnavailableException;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.Arrays;

/**
 * The ScanAR plugin on Android: ARCore, the native half of the web app's NativeARProvider
 * (src/ar/native.ts). The web side is the contract, so keep the method and event names in step
 * with src/ar/native-bridge.ts and with mobile/ios/App/App/ScanARPlugin.swift.
 *
 * It runs an ARCore session on a GLSurfaceView placed beneath the WebView (which is made
 * transparent while the session runs). The camera image is fitted whole into the WebView
 * ("contain"), the same rect the web overlay covers. Frames, hits and depth are answered from the
 * GL thread, which is the only thread that may call session.update().
 *
 * Capacitor calls handleOnPause(), handleOnResume() and handleOnDestroy() with the activity, and the
 * AR session follows them. Not yet run on a device. The Gradle build compiles it; a real ARCore phone
 * has not exercised it.
 */
@CapacitorPlugin(
    name = "ScanAR",
    permissions = {
        @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera"),
    }
)
public class ScanARPlugin extends Plugin {
    static final String CAMERA_ALIAS = "camera";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private GLSurfaceView glView;
    private ScanARRenderer renderer;
    private Session session;
    private boolean depthEnabled;
    private WebView savedWebView;
    private Drawable savedWebBackground;
    /** Whether the activity is in front. Starts false, and the first handleOnResume() sets it. */
    private boolean activityResumed;
    /** The origin this AR session placed, or null. Set on the GL thread, and cleared when the session is released. */
    private volatile OriginAnchorStore.Record sessionOrigin;

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /** The activity is leaving the front: stop the GL loop, release the camera, and say so to the web layer. */
    @Override
    protected void handleOnPause() {
        pauseAR();
    }

    /** The activity is back in front: the GL loop runs again, and the next frame resumes the session. */
    @Override
    protected void handleOnResume() {
        resumeAR();
    }

    /** The activity is being destroyed: the AR session is released for good. */
    @Override
    protected void handleOnDestroy() {
        releaseAR();
    }

    /** Parks the GL loop and pauses the session, so the camera is released. Runs on the UI thread. */
    private void pauseAR() {
        activityResumed = false;
        ScanARRenderer current = renderer;
        GLSurfaceView view = glView;
        if (current == null || view == null) {
            return;
        }
        // Returns once the GL thread is parked, so no frame is inside session.update() while the session pauses.
        view.onPause();
        current.pauseSession();
    }

    /** Lets the GL loop run again. The next frame resumes the session. Runs on the UI thread. */
    private void resumeAR() {
        activityResumed = true;
        GLSurfaceView view = glView;
        if (view != null) {
            view.onResume();
        }
    }

    // ── Capabilities ─────────────────────────────────────────────────────────

    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");
        ArCoreApk.Availability availability = ArCoreApk.getInstance().checkAvailability(getContext());
        boolean installed = availability == ArCoreApk.Availability.SUPPORTED_INSTALLED;
        result.put("engine", availability.isSupported() ? "arcore" : "none");
        result.put("supported", installed);
        result.put("depth", installed && sessionSupportsDepth());
        if (!installed) {
            result.put("reason", reasonFor(availability));
        }
        call.resolve(result);
    }

    private boolean sessionSupportsDepth() {
        try {
            Session probe = new Session(getContext());
            boolean depth = probe.isDepthModeSupported(Config.DepthMode.AUTOMATIC);
            probe.close();
            return depth;
        } catch (Exception e) {
            return false;
        }
    }

    private static String reasonFor(ArCoreApk.Availability availability) {
        switch (availability) {
            case UNSUPPORTED_DEVICE_NOT_CAPABLE:
                return "This device does not support ARCore.";
            case SUPPORTED_NOT_INSTALLED:
                return "ARCore is not installed. Install or update Google Play Services for AR.";
            case SUPPORTED_APK_TOO_OLD:
                return "ARCore needs an update. Update Google Play Services for AR.";
            default:
                return "ARCore is still checking this device. Try again in a moment.";
        }
    }

    // ── Session ──────────────────────────────────────────────────────────────

    @PluginMethod
    public void start(PluginCall call) {
        if (renderer != null) {
            call.resolve(startResult());
            return;
        }
        ArCoreApk.Availability availability = ArCoreApk.getInstance().checkAvailability(getContext());
        if (availability != ArCoreApk.Availability.SUPPORTED_INSTALLED) {
            call.reject(reasonFor(availability));
            return;
        }
        if (getPermissionState(CAMERA_ALIAS) != PermissionState.GRANTED) {
            requestPermissionForAlias(CAMERA_ALIAS, call, "cameraPermissionCallback");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState(CAMERA_ALIAS) == PermissionState.GRANTED) {
            begin(call);
        } else {
            call.reject("Camera permission was not granted, so AR cannot start.");
        }
    }

    private void begin(PluginCall call) {
        final boolean wantDepth = call.getBoolean("depth", false);
        final int hitGrid = call.getInt("hitGrid", 20);
        getActivity().runOnUiThread(() -> {
            try {
                Session created = new Session(getContext());
                Config config = new Config(created);
                config.setFocusMode(Config.FocusMode.AUTO);
                config.setUpdateMode(Config.UpdateMode.LATEST_CAMERA_IMAGE);
                config.setPlaneFindingMode(Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL);
                if (wantDepth && created.isDepthModeSupported(Config.DepthMode.AUTOMATIC)) {
                    config.setDepthMode(Config.DepthMode.AUTOMATIC);
                }
                created.configure(config);
                depthEnabled = created.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
                    && config.getDepthMode() == Config.DepthMode.AUTOMATIC;

                CameraConfig cameraConfig = created.getCameraConfig();
                Size image = cameraConfig.getImageSize();
                int sensorOrientation = sensorOrientation(cameraConfig.getCameraId());

                WebView web = getBridge().getWebView();
                DisplayMetrics metrics = getContext().getResources().getDisplayMetrics();
                int webWidth = web.getWidth() > 0 ? web.getWidth() : metrics.widthPixels;
                int webHeight = web.getHeight() > 0 ? web.getHeight() : metrics.heightPixels;
                float aspect = portraitAspect(image);
                int[] fitted = containedPixels(webWidth, webHeight, aspect);

                GLSurfaceView view = new GLSurfaceView(getContext());
                view.setEGLContextClientVersion(2);
                view.setPreserveEGLContextOnPause(true);
                view.setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);
                renderer = new ScanARRenderer(this, view, created, depthEnabled, hitGrid, sensorOrientation, fitted[2], fitted[3]);
                view.setRenderer(renderer);
                view.setX(fitted[0]);
                view.setY(fitted[1]);
                ViewGroup parent = (ViewGroup) web.getParent();
                parent.addView(view, 0, new ViewGroup.LayoutParams(fitted[2], fitted[3]));
                // The GL loop runs only while the activity is in front. resumeAR() and pauseAR() keep it so.
                if (activityResumed) {
                    view.onResume();
                } else {
                    view.onPause();
                }

                // Let the camera show through the WebView while AR runs.
                savedWebView = web;
                savedWebBackground = web.getBackground();
                web.setBackgroundColor(Color.TRANSPARENT);

                glView = view;
                session = created;
                call.resolve(startResult(fitted, aspect));
            } catch (UnavailableException e) {
                call.reject("ARCore could not create a session: " + e.getMessage());
            } catch (Exception e) {
                call.reject("AR could not start: " + e.getMessage());
            }
        });
    }

    private JSObject startResult() {
        if (glView == null) {
            return new JSObject();
        }
        int[] fitted = { (int) glView.getX(), (int) glView.getY(), glView.getWidth(), glView.getHeight() };
        return startResult(fitted, glView.getHeight() > 0 ? (float) glView.getWidth() / glView.getHeight() : 1f);
    }

    /** The rect is sent in CSS pixels. The WebView maps one CSS pixel to one density-independent pixel. */
    private JSObject startResult(int[] fitted, float aspect) {
        float density = getContext().getResources().getDisplayMetrics().density;
        JSObject rect = new JSObject();
        rect.put("x", fitted[0] / density);
        rect.put("y", fitted[1] / density);
        rect.put("width", fitted[2] / density);
        rect.put("height", fitted[3] / density);
        JSObject result = new JSObject();
        result.put("rect", rect);
        result.put("cameraAspect", aspect);
        return result;
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            releaseAR();
            call.resolve();
        });
    }

    /** Stops the AR session and gives the WebView its background back. Runs on the UI thread. */
    private void releaseAR() {
        GLSurfaceView view = glView;
        ScanARRenderer current = renderer;
        Session currentSession = session;
        glView = null;
        renderer = null;
        session = null;
        sessionOrigin = null;
        if (view != null) {
            view.onPause();   // parks the GL thread before the session is paused
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) {
                parent.removeView(view);
            }
        }
        if (current != null) {
            current.pauseSession();
        }
        if (currentSession != null) {
            currentSession.close();
        }
        if (savedWebView != null) {
            savedWebView.setBackground(savedWebBackground);
            savedWebView = null;
            savedWebBackground = null;
        }
    }

    // ── Frames, hits ─────────────────────────────────────────────────────────

    @PluginMethod
    public void captureFrame(PluginCall call) {
        ScanARRenderer current = renderer;
        if (current == null) {
            call.reject("AR is not running yet. Call start() and wait for tracking.");
            return;
        }
        current.capture(call.getBoolean("depth", false), (result, error) -> {
            if (error != null) {
                call.reject(error);
            } else {
                call.resolve(result);
            }
        });
    }

    @PluginMethod
    public void hitTest(PluginCall call) {
        ScanARRenderer current = renderer;
        if (current == null) {
            JSObject miss = new JSObject();
            miss.put("hit", false);
            call.resolve(miss);
            return;
        }
        double x = call.getDouble("x", 0.5);
        double y = call.getDouble("y", 0.5);
        current.hitAt(x, y, (result, error) -> call.resolve(result != null ? result : missing()));
    }

    private static JSObject missing() {
        JSObject miss = new JSObject();
        miss.put("hit", false);
        return miss;
    }

    // ── Origin anchor ────────────────────────────────────────────────────────

    /**
     * Places the origin on the first feature point or plane under (x, y), a point of the overlay rect
     * in 0..1, and saves the record on the device. Resolves { anchor }, the origin this session has
     * just placed. Rejects when no surface is under the point.
     */
    @PluginMethod
    public void setOriginAnchor(PluginCall call) {
        ScanARRenderer current = renderer;
        if (current == null) {
            call.reject("AR is not running yet. Call start() and wait for tracking.");
            return;
        }
        Double x = call.getDouble("x");
        Double y = call.getDouble("y");
        if (x == null || y == null) {
            call.reject("setOriginAnchor needs x and y, each from 0 to 1 across the camera rect.");
            return;
        }
        Double heading = call.getDouble("heading");
        current.placeOrigin(x, y, (position, rotation, error) -> {
            if (error != null) {
                call.reject(error);
                return;
            }
            OriginAnchorStore.Record record;
            try {
                record = new OriginAnchorStore.Record(position, rotation, heading);
                OriginAnchorStore.write(originFile(), record);
            } catch (IOException | RuntimeException e) {
                call.reject("The origin could not be saved: " + e.getMessage());
                return;
            }
            sessionOrigin = record;
            call.resolve(anchorReply(anchorJson(record, null)));
        });
    }

    /**
     * The origin this AR session placed, as { anchor }, or { anchor: null } when this session has placed
     * none. Its position is the anchor's pose as ARCore last refined it. A record saved by an earlier
     * session is not returned: v1 does not restore an origin across sessions.
     */
    @PluginMethod
    public void getOriginAnchor(PluginCall call) {
        OriginAnchorStore.Record placed = sessionOrigin;
        if (placed == null) {
            call.resolve(anchorReply(null));
            return;
        }
        ScanARRenderer current = renderer;
        double[] live = current != null ? current.liveOriginPose() : null;
        call.resolve(anchorReply(anchorJson(placed, live)));
    }

    private File originFile() {
        return new File(getContext().getFilesDir(), OriginAnchorStore.FILE_NAME);
    }

    /** The record as the web layer reads it. When `live` is given, its pose replaces the saved one. */
    private static JSObject anchorJson(OriginAnchorStore.Record record, double[] live) {
        JSObject anchor = new JSObject();
        if (live != null) {
            anchor.put("position", numbers(Arrays.copyOfRange(live, 0, 3)));
            anchor.put("rotation", numbers(Arrays.copyOfRange(live, 3, 7)));
        } else {
            anchor.put("position", numbers(record.position));
            anchor.put("rotation", numbers(record.rotation));
        }
        anchor.put("heading", record.heading != null ? record.heading : JSONObject.NULL);
        return anchor;
    }

    /** { anchor } as the web layer reads it, where anchor is null when there is none. */
    private static JSObject anchorReply(JSObject anchor) {
        JSObject reply = new JSObject();
        reply.put("anchor", anchor != null ? anchor : JSONObject.NULL);
        return reply;
    }

    private static JSONArray numbers(double[] values) {
        JSONArray array = new JSONArray();
        try {
            for (double value : values) {
                array.put(value);
            }
        } catch (org.json.JSONException e) {
            // Unreachable: the record holds only finite numbers.
            throw new IllegalStateException("an origin holds a number JSON cannot carry", e);
        }
        return array;
    }

    // ── Events (called from the GL thread, delivered on the main thread) ─────

    void emit(String eventName, JSObject data) {
        mainHandler.post(() -> notifyListeners(eventName, data));
    }

    void fail(String message) {
        JSObject data = new JSObject();
        data.put("message", message);
        emit("error", data);
    }

    // ── Geometry helpers ─────────────────────────────────────────────────────

    /** Width over height of the camera image in portrait: the sensor is landscape, so short over long. */
    static float portraitAspect(Size image) {
        int width = image.getWidth();
        int height = image.getHeight();
        if (width <= 0 || height <= 0) {
            return 0.75f;
        }
        return (float) Math.min(width, height) / Math.max(width, height);
    }

    /** The largest rect of the given aspect that fits inside the WebView, centred: {x, y, width, height} in pixels. */
    static int[] containedPixels(int boundsWidth, int boundsHeight, float aspect) {
        float width = boundsWidth;
        float height = width / aspect;
        if (height > boundsHeight) {
            height = boundsHeight;
            width = height * aspect;
        }
        int w = Math.round(width);
        int h = Math.round(height);
        return new int[] { (boundsWidth - w) / 2, (boundsHeight - h) / 2, w, h };
    }

    private int sensorOrientation(String cameraId) {
        try {
            CameraManager manager = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(cameraId);
            Integer orientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
            return orientation != null ? orientation : 90;
        } catch (Exception e) {
            return 90;
        }
    }

}
