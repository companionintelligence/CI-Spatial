package com.companionintelligence.scan;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.media.Image;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.os.SystemClock;
import android.util.Base64;
import android.view.Surface;

import com.getcapacitor.JSObject;
import com.google.ar.core.Anchor;
import com.google.ar.core.Camera;
import com.google.ar.core.Coordinates2d;
import com.google.ar.core.Frame;
import com.google.ar.core.HitResult;
import com.google.ar.core.Plane;
import com.google.ar.core.Point;
import com.google.ar.core.PointCloud;
import com.google.ar.core.Pose;
import com.google.ar.core.Session;
import com.google.ar.core.TrackingFailureReason;
import com.google.ar.core.TrackingState;
import com.google.ar.core.exceptions.CameraNotAvailableException;
import com.google.ar.core.exceptions.NotYetAvailableException;

import org.json.JSONArray;
import org.json.JSONException;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.Arrays;
import java.util.List;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * The GL side of the ScanAR plugin. It owns the frame loop: session.update() runs here, the camera
 * image is drawn full-bleed behind the WebView, and pose, points, and hit samples are sent as events.
 * Captures and hit tests are queued onto this thread with GLSurfaceView.queueEvent(), so they see
 * the same frame the loop last produced and never race session.update().
 */
class ScanARRenderer implements GLSurfaceView.Renderer {

    interface Callback {
        void done(JSObject result, String error);
    }

    /** A placed origin: its position (x, y, z) and rotation (x, y, z, w), or an error. */
    interface OriginCallback {
        void done(double[] position, double[] rotation, String error);
    }

    private static final float NEAR_M = 0.01f;
    private static final float FAR_M = 100f;
    private static final long POSE_INTERVAL_MS = 33;
    private static final long POINTS_INTERVAL_MS = 200;
    private static final long HITS_INTERVAL_MS = 500;
    private static final int POINTS_PER_EVENT = 1500;
    private static final int JPEG_QUALITY = 85;

    private static final String VERTEX_SHADER =
        "attribute vec4 a_Position;\n" +
        "attribute vec2 a_TexCoord;\n" +
        "varying vec2 v_TexCoord;\n" +
        "void main() {\n" +
        "  gl_Position = a_Position;\n" +
        "  v_TexCoord = a_TexCoord;\n" +
        "}\n";

    private static final String FRAGMENT_SHADER =
        "#extension GL_OES_EGL_image_external : require\n" +
        "precision mediump float;\n" +
        "uniform samplerExternalOES u_Texture;\n" +
        "varying vec2 v_TexCoord;\n" +
        "void main() {\n" +
        "  gl_FragColor = texture2D(u_Texture, v_TexCoord);\n" +
        "}\n";

    /** Full-screen quad as a triangle strip, in normalised device coordinates. */
    private static final float[] QUAD_COORDS = { -1f, -1f, +1f, -1f, -1f, +1f, +1f, +1f };

    private final ScanARPlugin plugin;
    private final GLSurfaceView view;
    private final Session session;
    private final boolean depthEnabled;
    private final int hitGrid;
    private final int sensorOrientation;
    private final int viewWidth;
    private final int viewHeight;

    private int textureId = -1;
    private int program;
    private int positionAttribute;
    private int texCoordAttribute;
    private final FloatBuffer quadVertices;
    private final float[] quadTexCoordsTransformed = new float[8];
    private volatile boolean sessionResumed;
    private Frame lastFrame;
    private boolean everTracked;
    private TrackingState lastTrackingState;
    private String lastTrackingName = "";
    private long lastPoseMs;
    private long lastPointsMs;
    private long lastHitsMs;
    /** The origin anchor. Touched on the GL thread only, and detached when a new origin replaces it. */
    private Anchor origin;
    /** The origin's pose as ARCore last refined it, as x, y, z, qx, qy, qz, qw. Read from other threads. */
    private volatile double[] originPose;
    /** True while a camera failure is being reported, so it is reported once rather than on every frame. */
    private boolean cameraFailureReported;

    ScanARRenderer(ScanARPlugin plugin, GLSurfaceView view, Session session, boolean depthEnabled, int hitGrid,
                   int sensorOrientation, int viewWidth, int viewHeight) {
        this.plugin = plugin;
        this.view = view;
        this.session = session;
        this.depthEnabled = depthEnabled;
        this.hitGrid = Math.max(2, Math.min(hitGrid, 40));
        this.sensorOrientation = sensorOrientation;
        this.viewWidth = viewWidth;
        this.viewHeight = viewHeight;
        this.quadVertices = ByteBuffer.allocateDirect(QUAD_COORDS.length * 4)
            .order(ByteOrder.nativeOrder()).asFloatBuffer();
        this.quadVertices.put(QUAD_COORDS).position(0);
    }

    // ── GLSurfaceView.Renderer ───────────────────────────────────────────────

    @Override
    public void onSurfaceCreated(GL10 unused, EGLConfig config) {
        int[] textures = new int[1];
        GLES20.glGenTextures(1, textures, 0);
        textureId = textures[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        session.setCameraTextureName(textureId);
        program = buildProgram(VERTEX_SHADER, FRAGMENT_SHADER);
        positionAttribute = GLES20.glGetAttribLocation(program, "a_Position");
        texCoordAttribute = GLES20.glGetAttribLocation(program, "a_TexCoord");
        GLES20.glClearColor(0f, 0f, 0f, 0f);
    }

    @Override
    public void onSurfaceChanged(GL10 unused, int width, int height) {
        GLES20.glViewport(0, 0, width, height);
        // The app is portrait-only, so the display is in its natural rotation.
        session.setDisplayGeometry(Surface.ROTATION_0, width, height);
    }

    @Override
    public void onDrawFrame(GL10 unused) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT | GLES20.GL_DEPTH_BUFFER_BIT);
        if (!sessionResumed) {
            try {
                session.resume();
                sessionResumed = true;
                cameraFailureReported = false;
            } catch (CameraNotAvailableException e) {
                reportCameraFailure("The camera is not available to AR: " + e.getMessage());
                return;
            }
        }
        Frame frame;
        try {
            frame = session.update();
        } catch (CameraNotAvailableException e) {
            reportCameraFailure("The camera was lost: " + e.getMessage());
            return;
        }
        cameraFailureReported = false;
        lastFrame = frame;
        drawBackground(frame);

        Camera camera = frame.getCamera();
        TrackingState state = camera.getTrackingState();
        if (state == TrackingState.TRACKING) {
            everTracked = true;
        }
        String name = trackingName(camera);
        if (state != lastTrackingState || !name.equals(lastTrackingName)) {
            lastTrackingState = state;
            lastTrackingName = name;
            JSObject tracking = new JSObject();
            tracking.put("state", name);
            plugin.emit("tracking", tracking);
        }

        if (origin != null && origin.getTrackingState() == TrackingState.TRACKING) {
            originPose = poseVector(origin.getPose());
        }

        long now = SystemClock.uptimeMillis();
        if (now - lastPoseMs >= POSE_INTERVAL_MS) {
            lastPoseMs = now;
            plugin.emit("pose", poseEvent(frame, camera, name));
        }
        if (now - lastPointsMs >= POINTS_INTERVAL_MS) {
            lastPointsMs = now;
            JSObject points = pointsEvent(frame);
            if (points != null) {
                plugin.emit("points", points);
            }
        }
        if (now - lastHitsMs >= HITS_INTERVAL_MS) {
            lastHitsMs = now;
            plugin.emit("hits", hitsEvent(frame));
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Pauses the ARCore session, which releases the camera, and reports tracking as notAvailable. The
     * caller has already parked the GL loop, so no frame is inside update(). The next resumed frame
     * reports the tracking state again.
     */
    void pauseSession() {
        if (sessionResumed) {
            session.pause();
            sessionResumed = false;
        }
        lastFrame = null;
        lastTrackingState = TrackingState.STOPPED;
        lastTrackingName = "notAvailable";
        JSObject tracking = new JSObject();
        tracking.put("state", "notAvailable");
        plugin.emit("tracking", tracking);
    }

    /** The origin's pose as ARCore last refined it, as x, y, z, qx, qy, qz, qw, or null when no origin is set. */
    double[] liveOriginPose() {
        return originPose;
    }

    /** Reports a camera failure once, and again only after a frame gets through. */
    private void reportCameraFailure(String message) {
        if (cameraFailureReported) {
            return;
        }
        cameraFailureReported = true;
        plugin.fail(message);
    }

    /** A pose as x, y, z, qx, qy, qz, qw. */
    private static double[] poseVector(Pose pose) {
        return new double[] { pose.tx(), pose.ty(), pose.tz(), pose.qx(), pose.qy(), pose.qz(), pose.qw() };
    }

    // ── Captures and hits (queued onto the GL thread) ────────────────────────

    void capture(boolean wantDepth, Callback callback) {
        view.queueEvent(() -> {
            Frame frame = lastFrame;
            if (frame == null) {
                callback.done(null, "AR has no frame yet. Wait for tracking and try again.");
                return;
            }
            try {
                callback.done(captureNow(frame, wantDepth), null);
            } catch (NotYetAvailableException e) {
                callback.done(null, "The camera image is not ready yet. Try again in a moment.");
            } catch (Exception e) {
                callback.done(null, "Could not capture the frame: " + e.getMessage());
            }
        });
    }

    void hitAt(double x, double y, Callback callback) {
        view.queueEvent(() -> {
            Frame frame = lastFrame;
            if (frame == null) {
                callback.done(null, null);
                return;
            }
            callback.done(sample(frame, (float) (x * viewWidth), (float) (y * viewHeight)), null);
        });
    }

    /**
     * Places the origin on the first feature point or plane under the point (x, y) of the overlay rect,
     * with x and y from 0 to 1. Queued onto the GL thread like the captures, so it sees the frame the
     * loop last produced. The previous origin, if there is one, is detached.
     */
    void placeOrigin(double x, double y, OriginCallback callback) {
        view.queueEvent(() -> {
            Frame frame = lastFrame;
            if (frame == null) {
                callback.done(null, null, "AR has no frame yet. Wait for tracking and try again.");
                return;
            }
            HitResult hit = surfaceHit(frame, (float) (x * viewWidth), (float) (y * viewHeight));
            if (hit == null) {
                callback.done(null, null, "No feature point or plane is under that point. Aim at a surface and try again.");
                return;
            }
            Anchor anchor;
            try {
                anchor = hit.createAnchor();
            } catch (Exception e) {
                callback.done(null, null, "ARCore could not anchor that point: " + e.getMessage());
                return;
            }
            Anchor previous = origin;
            origin = anchor;
            if (previous != null) {
                previous.detach();
            }
            double[] pose = poseVector(anchor.getPose());
            originPose = pose;
            callback.done(Arrays.copyOfRange(pose, 0, 3), Arrays.copyOfRange(pose, 3, 7), null);
        });
    }

    private JSObject captureNow(Frame frame, boolean wantDepth) throws NotYetAvailableException {
        Image image = frame.acquireCameraImage();
        byte[] jpeg;
        int width;
        int height;
        try {
            int w = image.getWidth();
            int h = image.getHeight();
            YuvImage yuv = new YuvImage(toNv21(image), ImageFormat.NV21, w, h, null);
            ByteArrayOutputStream raw = new ByteArrayOutputStream();
            yuv.compressToJpeg(new Rect(0, 0, w, h), JPEG_QUALITY, raw);
            Bitmap bitmap = BitmapFactory.decodeByteArray(raw.toByteArray(), 0, raw.size());
            Matrix rotate = new Matrix();
            rotate.postRotate(sensorOrientation);
            Bitmap portrait = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), rotate, true);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            portrait.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
            jpeg = out.toByteArray();
            width = portrait.getWidth();
            height = portrait.getHeight();
            bitmap.recycle();
            portrait.recycle();
        } finally {
            image.close();
        }

        Camera camera = frame.getCamera();
        JSObject result = new JSObject();
        result.put("timestamp", frame.getTimestamp() / 1e9);
        result.put("width", width);
        result.put("height", height);
        result.put("jpegBase64", Base64.encodeToString(jpeg, Base64.NO_WRAP));
        result.put("transform", transformOf(camera.getPose()));
        result.put("projection", projectionOf(camera));
        if (wantDepth && depthEnabled) {
            JSObject depth = depthOf(frame);
            if (depth != null) {
                result.put("depth", depth);
            }
        }
        return result;
    }

    /** The depth map in metres, rotated to portrait like the JPEG. Null when ARCore has none yet. */
    private JSObject depthOf(Frame frame) {
        Image depthImage;
        try {
            depthImage = frame.acquireDepthImage16Bits();
        } catch (NotYetAvailableException e) {
            return null;
        }
        try {
            int w = depthImage.getWidth();
            int h = depthImage.getHeight();
            Image.Plane plane = depthImage.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer().order(ByteOrder.LITTLE_ENDIAN);
            int stride = plane.getRowStride();
            float[] meters = new float[w * h];
            for (int row = 0; row < h; row++) {
                for (int col = 0; col < w; col++) {
                    int index = row * stride + col * 2;
                    int millimetres = (buffer.get(index) & 0xff) | ((buffer.get(index + 1) & 0xff) << 8);
                    meters[row * w + col] = millimetres * 0.001f;
                }
            }
            float[] rotated = rotateFloats(meters, w, h, sensorOrientation);
            int outWidth = (sensorOrientation == 90 || sensorOrientation == 270) ? h : w;
            int outHeight = (sensorOrientation == 90 || sensorOrientation == 270) ? w : h;
            ByteBuffer bytes = ByteBuffer.allocate(rotated.length * 4).order(ByteOrder.LITTLE_ENDIAN);
            for (float value : rotated) {
                bytes.putFloat(value);
            }
            JSObject depth = new JSObject();
            depth.put("width", outWidth);
            depth.put("height", outHeight);
            depth.put("metersBase64", Base64.encodeToString(bytes.array(), Base64.NO_WRAP));
            return depth;
        } finally {
            depthImage.close();
        }
    }

    private JSObject poseEvent(Frame frame, Camera camera, String tracking) {
        JSObject event = new JSObject();
        event.put("timestamp", frame.getTimestamp() / 1e9);
        event.put("transform", transformOf(camera.getPose()));
        event.put("projection", projectionOf(camera));
        event.put("tracking", tracking);
        return event;
    }

    private JSObject pointsEvent(Frame frame) {
        PointCloud cloud = null;
        try {
            cloud = frame.acquirePointCloud();
            FloatBuffer points = cloud.getPoints();
            int count = points.remaining() / 4;
            int step = Math.max(1, count / POINTS_PER_EVENT);
            JSONArray flat = new JSONArray();
            for (int i = 0; i < count; i += step) {
                putNumber(flat, points.get(i * 4));
                putNumber(flat, points.get(i * 4 + 1));
                putNumber(flat, points.get(i * 4 + 2));
            }
            JSObject event = new JSObject();
            event.put("timestamp", frame.getTimestamp() / 1e9);
            event.put("points", flat);
            return event;
        } catch (Exception e) {
            return null;
        } finally {
            if (cloud != null) {
                cloud.release();
            }
        }
    }

    private JSObject hitsEvent(Frame frame) {
        JSONArray samples = new JSONArray();
        for (int row = 0; row < hitGrid; row++) {
            for (int col = 0; col < hitGrid; col++) {
                float x = (col + 0.5f) / hitGrid * viewWidth;
                float y = (row + 0.5f) / hitGrid * viewHeight;
                samples.put(sample(frame, x, y));
            }
        }
        JSObject event = new JSObject();
        event.put("timestamp", frame.getTimestamp() / 1e9);
        event.put("cols", hitGrid);
        event.put("rows", hitGrid);
        event.put("samples", samples);
        return event;
    }

    /** One hit sample at view pixels (x, y): the nearest feature point or plane, or a miss. */
    private JSObject sample(Frame frame, float x, float y) {
        HitResult hit = surfaceHit(frame, x, y);
        if (hit == null) {
            JSObject miss = new JSObject();
            miss.put("hit", false);
            return miss;
        }
        Pose pose = hit.getHitPose();
        JSObject sample = new JSObject();
        sample.put("hit", true);
        JSONArray position = new JSONArray();
        putNumber(position, pose.tx());
        putNumber(position, pose.ty());
        putNumber(position, pose.tz());
        JSONArray rotation = new JSONArray();
        putNumber(rotation, pose.qx());
        putNumber(rotation, pose.qy());
        putNumber(rotation, pose.qz());
        putNumber(rotation, pose.qw());
        sample.put("position", position);
        sample.put("rotation", rotation);
        sample.put("distance", hit.getDistance());
        return sample;
    }

    /** The first feature point or plane hit at view pixels (x, y), or null when there is none. */
    private HitResult surfaceHit(Frame frame, float x, float y) {
        if (viewWidth <= 0 || viewHeight <= 0) {
            return null;
        }
        List<HitResult> hits = frame.hitTest(x, y);
        for (HitResult hit : hits) {
            if (hit.getTrackable() instanceof Point || hit.getTrackable() instanceof Plane) {
                return hit;
            }
        }
        return null;
    }

    // ── Background ───────────────────────────────────────────────────────────

    private void drawBackground(Frame frame) {
        frame.transformCoordinates2d(
            Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES, QUAD_COORDS,
            Coordinates2d.TEXTURE_NORMALIZED, quadTexCoordsTransformed);
        FloatBuffer texCoords = ByteBuffer.allocateDirect(quadTexCoordsTransformed.length * 4)
            .order(ByteOrder.nativeOrder()).asFloatBuffer();
        texCoords.put(quadTexCoordsTransformed).position(0);

        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        GLES20.glDepthMask(false);
        GLES20.glUseProgram(program);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glVertexAttribPointer(positionAttribute, 2, GLES20.GL_FLOAT, false, 0, quadVertices);
        GLES20.glVertexAttribPointer(texCoordAttribute, 2, GLES20.GL_FLOAT, false, 0, texCoords);
        GLES20.glEnableVertexAttribArray(positionAttribute);
        GLES20.glEnableVertexAttribArray(texCoordAttribute);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(positionAttribute);
        GLES20.glDisableVertexAttribArray(texCoordAttribute);
        GLES20.glDepthMask(true);
        GLES20.glEnable(GLES20.GL_DEPTH_TEST);
    }

    private static int buildProgram(String vertexSource, String fragmentSource) {
        int vertex = compileShader(GLES20.GL_VERTEX_SHADER, vertexSource);
        int fragment = compileShader(GLES20.GL_FRAGMENT_SHADER, fragmentSource);
        int id = GLES20.glCreateProgram();
        GLES20.glAttachShader(id, vertex);
        GLES20.glAttachShader(id, fragment);
        GLES20.glLinkProgram(id);
        int[] status = new int[1];
        GLES20.glGetProgramiv(id, GLES20.GL_LINK_STATUS, status, 0);
        if (status[0] == 0) {
            String log = GLES20.glGetProgramInfoLog(id);
            GLES20.glDeleteProgram(id);
            throw new RuntimeException("camera shader did not link: " + log);
        }
        return id;
    }

    private static int compileShader(int type, String source) {
        int shader = GLES20.glCreateShader(type);
        GLES20.glShaderSource(shader, source);
        GLES20.glCompileShader(shader);
        int[] status = new int[1];
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0);
        if (status[0] == 0) {
            String log = GLES20.glGetShaderInfoLog(shader);
            GLES20.glDeleteShader(shader);
            throw new RuntimeException("camera shader did not compile: " + log);
        }
        return shader;
    }

    // ── Conversions ──────────────────────────────────────────────────────────

    /** The YUV_420_888 planes as NV21 (Y, then interleaved V and U), honouring each plane's strides. */
    static byte[] toNv21(Image image) {
        int width = image.getWidth();
        int height = image.getHeight();
        byte[] out = new byte[width * height + width * height / 2];
        Image.Plane[] planes = image.getPlanes();

        ByteBuffer yBuffer = planes[0].getBuffer();
        int yRow = planes[0].getRowStride();
        int yPixel = planes[0].getPixelStride();
        int pos = 0;
        for (int row = 0; row < height; row++) {
            for (int col = 0; col < width; col++) {
                out[pos++] = yBuffer.get(row * yRow + col * yPixel);
            }
        }

        ByteBuffer uBuffer = planes[1].getBuffer();
        ByteBuffer vBuffer = planes[2].getBuffer();
        int uRow = planes[1].getRowStride();
        int uPixel = planes[1].getPixelStride();
        int vRow = planes[2].getRowStride();
        int vPixel = planes[2].getPixelStride();
        for (int row = 0; row < height / 2; row++) {
            for (int col = 0; col < width / 2; col++) {
                out[pos++] = vBuffer.get(row * vRow + col * vPixel);
                out[pos++] = uBuffer.get(row * uRow + col * uPixel);
            }
        }
        return out;
    }

    /** Rotates a row-major float grid clockwise by a multiple of 90 degrees. */
    static float[] rotateFloats(float[] src, int w, int h, int degrees) {
        int turns = ((degrees % 360) + 360) % 360 / 90;
        if (turns == 0) {
            return src;
        }
        float[] out = new float[src.length];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                float value = src[y * w + x];
                switch (turns) {
                    case 1: // 90 clockwise: (x, y) -> (h-1-y, x), output width h
                        out[x * h + (h - 1 - y)] = value;
                        break;
                    case 2: // 180: (x, y) -> (w-1-x, h-1-y)
                        out[(h - 1 - y) * w + (w - 1 - x)] = value;
                        break;
                    default: // 270 clockwise: (x, y) -> (y, w-1-x), output width h
                        out[(w - 1 - x) * h + y] = value;
                        break;
                }
            }
        }
        return out;
    }

    private static String trackingName(Camera camera) {
        switch (camera.getTrackingState()) {
            case TRACKING:
                return "normal";
            case STOPPED:
                return "notAvailable";
            case PAUSED:
                if (camera.getTrackingFailureReason() == TrackingFailureReason.EXCESSIVE_MOTION) {
                    return "limited.excessiveMotion";
                }
                if (camera.getTrackingFailureReason() == TrackingFailureReason.INSUFFICIENT_FEATURES) {
                    return "limited.insufficientFeatures";
                }
                return "limited.initializing";
            default:
                return "limited";
        }
    }

    /** Column-major 4×4 of a pose, as the web side reads it. */
    private static JSONArray transformOf(Pose pose) {
        float[] matrix = new float[16];
        pose.toMatrix(matrix, 0);
        return toJson(matrix);
    }

    private static JSONArray projectionOf(Camera camera) {
        float[] matrix = new float[16];
        camera.getProjectionMatrix(matrix, 0, NEAR_M, FAR_M);
        return toJson(matrix);
    }

    private static JSONArray toJson(float[] values) {
        JSONArray array = new JSONArray();
        for (float value : values) {
            putNumber(array, value);
        }
        return array;
    }

    /** JSON cannot carry NaN or infinity, so a non-finite number is sent as 0. */
    private static void putNumber(JSONArray array, double value) {
        double safe = Double.isFinite(value) ? value : 0.0;
        try {
            array.put(safe);
        } catch (JSONException e) {
            // Unreachable for a finite double; the array is left as it is.
        }
    }
}
