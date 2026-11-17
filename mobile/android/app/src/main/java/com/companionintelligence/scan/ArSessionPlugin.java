package com.companionintelligence.scan;

import android.Manifest;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.ar.core.ArCoreApk;
import com.google.ar.core.Config;
import com.google.ar.core.Session;
import com.google.ar.core.exceptions.CameraNotAvailableException;
import com.google.ar.core.exceptions.UnavailableException;

/**
 * ARCore behind the `ArSession` Capacitor plugin (src/ar/native-provider.ts). Its iOS twin is
 * mobile/ios/App/App/ArSessionPlugin.swift.
 *
 * What this milestone does: isSupported checks the device with ArCoreApk, and start creates the ARCore
 * Session with its config and resumes it. stop pauses and closes it.
 *
 * What it does not do, and this is the limit of the milestone: there is no camera-texture pipeline. The
 * session is never given a GL camera texture, and update() is never called, so there is no frame loop, no
 * camera image and no pose. Nothing here sends a `pose` event. The web side reads a running Android session
 * with no pose (INITIALIZING) and never reports it as tracking. Frames, hit tests and the camera feed are
 * the next milestone's work.
 *
 * Events pushed to the page:
 * - `state`: { running: boolean, reason?: string } when the session starts, stops, pauses for the
 *   app going to the background, resumes, or fails.
 */
@CapacitorPlugin(
    name = "ArSession",
    permissions = {
        @Permission(strings = { Manifest.permission.CAMERA }, alias = ArSessionPlugin.CAMERA)
    }
)
public class ArSessionPlugin extends Plugin {

    static final String CAMERA = "camera";
    private static final String CAMERA_CALLBACK = "cameraPermissionCallback";

    /** The ARCore session while the scan runs. Only touched on the main thread, as ARCore's own samples do. */
    private Session session;
    /** True while the app is in the background and the session is paused. */
    private boolean paused;

    /**
     * Availability runs on the bridge's background thread: checkAvailability can take a while, and it does not
     * touch the session.
     */
    @PluginMethod
    public void isSupported(PluginCall call) {
        getBridge().execute(() -> {
            try {
                ArCoreApk.Availability availability = ArCoreApk.getInstance().checkAvailability(getContext());
                JSObject result = new JSObject();
                // isSupported() is true for SUPPORTED_INSTALLED and for the two states where ARCore must be installed or updated.
                result.put("supported", availability.isSupported());
                result.put("availability", availability.name());
                call.resolve(result);
            } catch (RuntimeException e) {
                // A call that never settles would leave the web side waiting forever.
                call.reject("The ARCore check failed: " + e.getMessage(), "UNAVAILABLE", e);
            }
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (session != null) {
            call.resolve();
            return;
        }
        if (getPermissionState(CAMERA) != PermissionState.GRANTED) {
            requestPermissionForAlias(CAMERA, call, CAMERA_CALLBACK);
            return;
        }
        startSession(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState(CAMERA) != PermissionState.GRANTED) {
            call.reject("The camera permission is needed for AR", "PERMISSION_DENIED");
            return;
        }
        startSession(call);
    }

    private void startSession(PluginCall call) {
        AppCompatActivity activity = getActivity();
        if (activity == null) {
            call.reject("There is no activity to start AR from", "NO_ACTIVITY");
            return;
        }
        try {
            ArCoreApk.Availability availability = ArCoreApk.getInstance().checkAvailability(getContext());
            if (!availability.isSupported()) {
                call.reject("ARCore is not supported on this device", "UNSUPPORTED");
                return;
            }
            // Installs or updates ARCore through Play services. INSTALL_REQUESTED means the install has started
            // and this activity is about to pause, so the scan has to be started again once it finishes.
            if (ArCoreApk.getInstance().requestInstall(activity, true) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                call.reject("ARCore is installing. Start the scan again when the install finishes.", "INSTALL_REQUESTED");
                return;
            }
            Session created = new Session(getContext());
            // Session.isSupported(Config) is not called: ARCore 1.57 marks it @Deprecated. The config is LATEST_CAMERA_IMAGE
            // with plane finding off, set below.
            Config config = new Config(created);
            config.setUpdateMode(Config.UpdateMode.LATEST_CAMERA_IMAGE);
            // The room scanner reads SLAM feature points, not detected planes, so plane finding stays off.
            config.setPlaneFindingMode(Config.PlaneFindingMode.DISABLED);
            created.configure(config);
            try {
                created.resume();
            } catch (CameraNotAvailableException e) {
                created.close();
                throw e;
            }
            session = created;
            paused = false;
            pushState(true, null);
            call.resolve();
        } catch (UnavailableException | CameraNotAvailableException | RuntimeException e) {
            // RuntimeException too: a start that throws without settling its call would leave the web side waiting.
            call.reject("AR could not start: " + e.getMessage(), "UNAVAILABLE", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        closeSession();
        pushState(false, null);
        call.resolve();
    }

    /** Pauses the session when the app goes to the background, so the camera is not held there. */
    @Override
    protected void handleOnPause() {
        if (session == null || paused) return;
        session.pause();
        paused = true;
        pushState(false, "paused");
    }

    /** Resumes the session that handleOnPause paused. If the camera cannot be taken back, the session is closed. */
    @Override
    protected void handleOnResume() {
        if (session == null || !paused) return;
        try {
            session.resume();
            paused = false;
            pushState(true, null);
        } catch (CameraNotAvailableException e) {
            closeSession();
            pushState(false, "The camera is not available for AR: " + e.getMessage());
        }
    }

    @Override
    protected void handleOnDestroy() {
        closeSession();
    }

    private void closeSession() {
        if (session != null) {
            session.pause();
            session.close();
            session = null;
        }
        paused = false;
    }

    private void pushState(boolean running, String reason) {
        JSObject data = new JSObject();
        data.put("running", running);
        if (reason != null) {
            data.put("reason", reason);
        }
        notifyListeners("state", data);
    }
}
