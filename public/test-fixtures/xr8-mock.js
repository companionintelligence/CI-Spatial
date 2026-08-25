/**
 * XR8 mock — drop-in replacement for the 8th Wall OSS engine (public/xr.js)
 * used by automated tests.  Loaded by index.html when ?mock=xr8 is set.
 *
 * Implements the API surface src/ar/eighthwall.ts consumes:
 *   addCameraPipelineModules, run, stop, loadChunk,
 *   GlTextureRenderer.pipelineModule, XrController.pipelineModule + hitTest,
 *   CameraPixelArray.pipelineModule, XrConfig.device
 *
 * Behaviour: a scripted camera glides through a synthetic 6×6 m room,
 * emitting SLAM poses, world feature points, and a fake camera feed that
 * shows CV-palette-coloured furniture — so the full
 * capture → /infer (INFERENCE_MODE=mock) → resolve → store → export
 * pipeline runs deterministically with no device, no SLAM binary, no model.
 *
 * Equivalent of the 8th Wall desktop simulator / forum "mocks for online
 * testing" pattern, reduced to what CI needs.
 *
 * NOTE: furniture colours mirror src/shared/cv-palette.ts — keep in sync.
 * This is a classic (non-module) script loaded via a plain <script> tag, so
 * it cannot import CV_PALETTE directly; sync.test.ts (repo root) reads this
 * file as text and asserts the SCENE_OBJECTS colours below haven't drifted
 * from src/shared/cv-palette.ts.
 */
;(function () {
  'use strict'

  // ── Synthetic scene (palette colours match cv-palette.ts) ────────────────
  //
  // x/y/w/h is each object's normalised bounding box in the feed. The box is the
  // DETECTION contract — the mock engine's blob bounds land inside it — while
  // drawObject() below paints a furniture silhouette within that box.
  //
  // Every painted pixel that must stay detectable is within PALETTE_TOLERANCE
  // (±28 per channel, cv-palette.ts:30) of `color`, so shading and seams do not
  // change which label a pixel classifies as. Two rules follow from how the
  // detector works (union-find over 4-connected same-label grid cells,
  // inference.ts _inferMock) and both are load-bearing:
  //
  //   1. Each object needs ONE connected core in the exact palette colour.
  //      Highlights and seams sit on top of that core, never replace it.
  //   2. Nothing drawn INSIDE an object's core may fall outside tolerance — a
  //      non-palette line through the middle splits one object into two blobs
  //      and the panel would list the same label twice. Non-palette detail
  //      (legs, pot, TV stand) is therefore drawn outside the core.
  var SCENE_OBJECTS = [
    { label: 'sofa', color: 'rgb(255,109,0)', x: 0.32, y: 0.46, w: 0.24, h: 0.16 },
    { label: 'tv', color: 'rgb(0,184,212)', x: 0.08, y: 0.50, w: 0.18, h: 0.14 },
    { label: 'table', color: 'rgb(109,76,65)', x: 0.66, y: 0.52, w: 0.16, h: 0.10 },
    { label: 'plant', color: 'rgb(0,200,83)', x: 0.87, y: 0.42, w: 0.07, h: 0.22 },
  ]

  // Shades used for silhouette detail, all verified inside ±28 per channel of
  // the palette entry they sit on.
  var SHADE = {
    sofa: { dark: 'rgb(232,90,0)', light: 'rgb(255,131,24)' },
    tv: { dark: 'rgb(0,163,191)', light: 'rgb(18,202,228)' },
    table: { dark: 'rgb(90,60,50)', light: 'rgb(127,94,83)' },
    plant: { dark: 'rgb(0,178,66)', light: 'rgb(22,220,100)' },
  }

  // Set dressing. Neutral by construction: each is >28 away on at least one
  // channel from every palette entry, so none of it registers as an object.
  var NEUTRAL = {
    floor: 'rgb(58,62,72)',
    rug: 'rgb(86,92,104)',
    frame: 'rgb(120,124,134)',
    art: 'rgb(150,154,163)',
    metal: 'rgb(44,48,58)',
    pot: 'rgb(170,90,60)',
    skirting: 'rgb(196,196,200)',
  }
  var FEED_W = 480
  var FEED_H = 360
  var ROOM = { w: 6, h: 2.6, d: 6 }
  var TICK_MS = 33

  // Deterministic PRNG for world feature points
  function lcg(seed) {
    var s = seed >>> 0
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 4294967296
    }
  }

  var modules = []
  var runCanvas = null
  var tickHandle = null
  var tickCount = 0
  /** Lazily built once so repeated xrScene() calls return the same scene. */
  var xrSceneCache = null
  var feedCanvas = null
  var feedCtx = null
  // When true the session keeps emitting frames but tickCount stops advancing,
  // so every emitted frame is identical.  See freezeAt() below.
  var frozen = false
  var frozenPoints = null
  var startFired = false
  var pendingStartTicks = 0

  function currentPose() {
    // Slow sinusoidal walk along X at eye height, looking down -Z
    var t = tickCount / 30
    return {
      position: { x: Math.sin(t * 0.4) * 1.2, y: 1.5 + Math.sin(t * 1.3) * 0.03, z: 2.4 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    }
  }

  function trackingStatus() {
    return tickCount < 12 ? 'LIMITED' : 'NORMAL'
  }

  function worldPoints() {
    if (!frozen) return batchAt(tickCount)
    // A frozen session re-emits ONE batch forever, and the voxel grid dedupes it,
    // so the map would sit at 24 points however long the capture waited. Hand over
    // the whole walk instead — every batch the session would have emitted up to
    // the frozen tick — so the map is a pure function of the frozen tick: it fills
    // on the scanner's first 750 ms harvest and never changes again.
    if (!frozenPoints) {
      frozenPoints = []
      for (var t = 1; t <= tickCount; t++) {
        var batch = batchAt(t)
        for (var j = 0; j < batch.length; j++) frozenPoints.push(batch[j])
      }
    }
    return frozenPoints
  }

  function batchAt(t) {
    // Fresh batch each tick: room floor/walls sprinkled with noise
    var rand = lcg(0xC0FFEE + t)
    var pts = []
    for (var i = 0; i < 24; i++) {
      var which = rand()
      var p
      if (which < 0.5) {
        p = { x: (rand() - 0.5) * ROOM.w, y: rand() * 0.04, z: (rand() - 0.5) * ROOM.d }
      } else if (which < 0.75) {
        p = { x: -ROOM.w / 2 + rand() * 0.04, y: rand() * ROOM.h, z: (rand() - 0.5) * ROOM.d }
      } else {
        p = { x: (rand() - 0.5) * ROOM.w, y: rand() * ROOM.h, z: -ROOM.d / 2 + rand() * 0.04 }
      }
      pts.push(p)
    }
    return pts
  }

  /** Fill a rect given in normalised scene coords. */
  function fillN(ctx, w, h, color, x, y, rw, rh) {
    ctx.fillStyle = color
    ctx.fillRect(x * w, y * h, rw * w, rh * h)
  }

  /** Fill an ellipse given in normalised scene coords. */
  function fillEllipseN(ctx, w, h, color, cx, cy, rx, ry) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.ellipse(cx * w, cy * h, rx * w, ry * h, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  /**
   * Paint one piece of furniture inside its bounding box.
   *
   * Each branch lays the exact-palette core down FIRST and then adds detail in
   * near-palette shades, so the connected core the detector needs survives every
   * embellishment. See the SCENE_OBJECTS comment for the two invariants.
   */
  function drawObject(ctx, w, h, o) {
    var x = o.x, y = o.y, ow = o.w, oh = o.h
    var s = SHADE[o.label]

    if (o.label === 'sofa') {
      // Legs first, under the body and outside the palette core.
      fillN(ctx, w, h, NEUTRAL.metal, x + ow * 0.08, y + oh * 0.94, ow * 0.06, oh * 0.12)
      fillN(ctx, w, h, NEUTRAL.metal, x + ow * 0.86, y + oh * 0.94, ow * 0.06, oh * 0.12)
      // Back cushion, seat, arms and skirt — overlapping rects in the base
      // colour form one connected core. The arms stand proud of the backrest so
      // the silhouette reads as a sofa rather than as a filled rectangle.
      fillN(ctx, w, h, o.color, x + ow * 0.1, y + oh * 0.26, ow * 0.8, oh * 0.46)
      fillN(ctx, w, h, o.color, x + ow * 0.1, y + oh * 0.6, ow * 0.8, oh * 0.34)
      fillN(ctx, w, h, o.color, x, y + oh * 0.14, ow * 0.15, oh * 0.86)
      fillN(ctx, w, h, o.color, x + ow * 0.85, y + oh * 0.14, ow * 0.15, oh * 0.86)
      fillN(ctx, w, h, o.color, x + ow * 0.06, y + oh * 0.86, ow * 0.88, oh * 0.14)
      // Seams: arm joins, the back/seat break and the cushion split. All inside
      // tolerance, so they shade the silhouette without cutting the blob.
      fillN(ctx, w, h, s.dark, x + ow * 0.15, y + oh * 0.2, ow * 0.014, oh * 0.72)
      fillN(ctx, w, h, s.dark, x + ow * 0.835, y + oh * 0.2, ow * 0.014, oh * 0.72)
      fillN(ctx, w, h, s.dark, x + ow * 0.16, y + oh * 0.6, ow * 0.68, oh * 0.016)
      fillN(ctx, w, h, s.dark, x + ow * 0.49, y + oh * 0.62, ow * 0.014, oh * 0.24)
      // Lit tops on the backrest and both arms.
      fillN(ctx, w, h, s.light, x + ow * 0.16, y + oh * 0.27, ow * 0.68, oh * 0.05)
      fillN(ctx, w, h, s.light, x + ow * 0.01, y + oh * 0.15, ow * 0.13, oh * 0.05)
      fillN(ctx, w, h, s.light, x + ow * 0.86, y + oh * 0.15, ow * 0.13, oh * 0.05)
      return
    }

    if (o.label === 'tv') {
      // Stand below the panel, outside the core.
      fillN(ctx, w, h, NEUTRAL.metal, x + ow * 0.44, y + oh * 1.0, ow * 0.12, oh * 0.12)
      fillN(ctx, w, h, NEUTRAL.metal, x + ow * 0.3, y + oh * 1.1, ow * 0.4, oh * 0.05)
      // Bezel then screen — the screen is the core, the bezel is a darker teal
      // so the whole panel still classifies as one blob.
      fillN(ctx, w, h, s.dark, x, y, ow, oh)
      fillN(ctx, w, h, o.color, x + ow * 0.05, y + oh * 0.07, ow * 0.9, oh * 0.86)
      // A soft diagonal sheen across the screen.
      ctx.save()
      ctx.beginPath()
      ctx.moveTo((x + ow * 0.05) * w, (y + oh * 0.93) * h)
      ctx.lineTo((x + ow * 0.5) * w, (y + oh * 0.07) * h)
      ctx.lineTo((x + ow * 0.72) * w, (y + oh * 0.07) * h)
      ctx.lineTo((x + ow * 0.27) * w, (y + oh * 0.93) * h)
      ctx.closePath()
      ctx.fillStyle = s.light
      ctx.fill()
      ctx.restore()
      return
    }

    if (o.label === 'table') {
      // Top slab is the core; legs hang off it and stay in the palette colour so
      // the piece reads as one object to the detector.
      fillN(ctx, w, h, o.color, x, y, ow, oh * 0.3)
      fillN(ctx, w, h, o.color, x + ow * 0.08, y + oh * 0.3, ow * 0.09, oh * 0.7)
      fillN(ctx, w, h, o.color, x + ow * 0.83, y + oh * 0.3, ow * 0.09, oh * 0.7)
      // Lit top face and a shadowed edge under the slab.
      fillN(ctx, w, h, s.light, x, y, ow, oh * 0.09)
      fillN(ctx, w, h, s.dark, x, y + oh * 0.24, ow, oh * 0.06)
      return
    }

    if (o.label === 'plant') {
      // Terracotta pot — deliberately not a palette colour, so the pot is set
      // dressing and only the foliage is detected.
      fillN(ctx, w, h, NEUTRAL.pot, x + ow * 0.18, y + oh * 0.74, ow * 0.64, oh * 0.26)
      fillN(ctx, w, h, 'rgb(150,78,52)', x + ow * 0.14, y + oh * 0.72, ow * 0.72, oh * 0.06)
      // Stem plus overlapping leaf masses — one connected green core.
      fillN(ctx, w, h, o.color, x + ow * 0.44, y + oh * 0.34, ow * 0.12, oh * 0.42)
      fillEllipseN(ctx, w, h, o.color, x + ow * 0.5, y + oh * 0.3, ow * 0.42, oh * 0.2)
      fillEllipseN(ctx, w, h, s.dark, x + ow * 0.28, y + oh * 0.42, ow * 0.3, oh * 0.14)
      fillEllipseN(ctx, w, h, s.dark, x + ow * 0.74, y + oh * 0.44, ow * 0.28, oh * 0.13)
      fillEllipseN(ctx, w, h, s.light, x + ow * 0.56, y + oh * 0.16, ow * 0.3, oh * 0.13)
      fillEllipseN(ctx, w, h, o.color, x + ow * 0.34, y + oh * 0.2, ow * 0.26, oh * 0.12)
      return
    }

    fillN(ctx, w, h, o.color, x, y, ow, oh)
  }

  function drawScene(ctx, w, h) {
    var HORIZON = 0.72

    // Wall gradient
    var grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, 'rgb(205,205,209)')
    grad.addColorStop(HORIZON, 'rgb(176,176,180)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)

    // Framed picture on the back wall — gives the room a scale cue.
    fillN(ctx, w, h, NEUTRAL.frame, 0.53, 0.13, 0.15, 0.21)
    fillN(ctx, w, h, NEUTRAL.art, 0.545, 0.145, 0.12, 0.18)

    // Floor, with a receding rug and a skirting board at the wall join.
    fillN(ctx, w, h, NEUTRAL.floor, 0, HORIZON, 1, 1 - HORIZON)
    fillN(ctx, w, h, NEUTRAL.skirting, 0, HORIZON - 0.016, 1, 0.016)
    ctx.fillStyle = NEUTRAL.rug
    ctx.beginPath()
    ctx.moveTo(0.22 * w, 0.78 * h)
    ctx.lineTo(0.78 * w, 0.78 * h)
    ctx.lineTo(0.94 * w, 1.0 * h)
    ctx.lineTo(0.06 * w, 1.0 * h)
    ctx.closePath()
    ctx.fill()

    // Furniture (palette colours the mock inference engine detects)
    for (var i = 0; i < SCENE_OBJECTS.length; i++) {
      drawObject(ctx, w, h, SCENE_OBJECTS[i])
    }
  }

  /** Dispatch every module's onStart exactly once. */
  function fireOnStart() {
    if (startFired) return
    startFired = true
    for (var i = 0; i < modules.length; i++) {
      var startMod = modules[i]
      if (startMod && typeof startMod.onStart === 'function') {
        try {
          startMod.onStart({ canvas: runCanvas, GLctx: null, isWebXR: false })
        } catch (err) {
          console.warn('[xr8-mock] onStart threw for module', startMod.name, err)
        }
      }
    }
  }

  function tick() {
    if (!startFired) {
      if (pendingStartTicks > 0) { pendingStartTicks--; return }
      fireOnStart()
    }
    if (!frozen) tickCount++

    var processGpuResult = {}
    var processCpuResult = {
      reality: {
        position: currentPose().position,
        rotation: currentPose().rotation,
        trackingStatus: trackingStatus(),
        intrinsics: { fy: 400, height: FEED_H },
        worldPoints: trackingStatus() === 'NORMAL' ? worldPoints() : [],
      },
    }

    // Camera pixel array (RGBA) from the synthetic feed
    if (feedCtx) {
      drawScene(feedCtx, FEED_W, FEED_H)
      var imageData = feedCtx.getImageData(0, 0, FEED_W, FEED_H)
      processGpuResult.camerapixelarray = {
        pixels: new Uint8Array(imageData.data.buffer.slice(0)),
        rows: FEED_H,
        cols: FEED_W,
      }
    }

    // Paint the on-screen canvas so the page looks like a live AR session
    if (runCanvas) {
      var ctx = runCanvas.getContext('2d')
      if (ctx) drawScene(ctx, runCanvas.width, runCanvas.height)
    }

    for (var m = 0; m < modules.length; m++) {
      var mod = modules[m]
      try {
        if (typeof mod.onProcessCpu === 'function') mod.onProcessCpu({ processGpuResult: processGpuResult })
        if (typeof mod.onUpdate === 'function') mod.onUpdate({ processCpuResult: processCpuResult })
      } catch (e) {
        console.error('[xr8-mock] module error:', e)
      }
    }
  }

  window.XR8 = {
    isMock: true,

    addCameraPipelineModule: function (mod) { modules.push(mod) },
    addCameraPipelineModules: function (mods) { modules = modules.concat(mods) },

    loadChunk: function () { return Promise.resolve() },

    run: function (opts) {
      runCanvas = opts && opts.canvas ? opts.canvas : null
      feedCanvas = document.createElement('canvas')
      feedCanvas.width = FEED_W
      feedCanvas.height = FEED_H
      feedCtx = feedCanvas.getContext('2d', { willReadFrequently: true })

      // `?mockFreeze=<tick>` pins the session before the first frame is emitted,
      // which is the only point early enough to be race-free — RoomScanner starts
      // its own 750 ms accumulation interval moments later (src/ar/scanner.ts:49),
      // and a single scanner tick against a moving pose is enough to make the
      // captured point count differ between runs.
      var freeze = new URLSearchParams(location.search).get('mockFreeze')
      if (freeze !== null) window.XR8.freezeAt(freeze)

      // Fire each registered module's onStart once, as the real engine does.
      // Without this the mock never ran onStart at all, so eighthwall.ts's
      // `self._scene = XR8.Threejs.xrScene().scene` never executed and
      // provider.getScene() returned null — meaning no calibration decal,
      // anchor marker or floor grid was ever created under the mock, and any
      // test asserting on them silently passed against an empty scene.
      //
      // `?mockSceneDelay=<ticks>` defers them, which is the *real* engine's
      // timing and not an artificial hazard: `provider.start()` resolves as
      // soon as it has called XR8.run(), while 8th Wall creates its Three.js
      // scene on the first frame. Firing onStart synchronously here made the
      // mock strictly more forgiving than the device, and hid a bug where
      // calibration captured a null scene once and then silently rendered
      // nothing — no floor grid, no markers — for the whole session.
      var delay = new URLSearchParams(location.search).get('mockSceneDelay')
      pendingStartTicks = delay === null ? 0 : Math.max(0, Number(delay) || 0)
      if (pendingStartTicks === 0) fireOnStart()

      tickHandle = setInterval(tick, TICK_MS)
      console.log(
        '[xr8-mock] running — scripted SLAM session at ' + Math.round(1000 / TICK_MS) + ' fps' +
        (frozen ? ' (FROZEN at tick ' + tickCount + ')' : ''),
      )
    },

    stop: function () {
      if (tickHandle) clearInterval(tickHandle)
      tickHandle = null
    },

    /**
     * Determinism hook — used by the product-video capture, video/capture.config.mjs.
     *
     * Everything this mock emits is a pure function of `tickCount`: currentPose(),
     * worldPoints(), trackingStatus() and hitTest() derive from it and nothing
     * else. But run() advances it on a WALL-CLOCK setInterval, so "wait 2500 ms,
     * then shoot" photographs a different pose on every run — which is why the
     * captured point count, quality verdict and per-object coordinates drifted
     * between two runs against an unchanged UI.
     *
     * freezeAt() pins the session to an exact tick and leaves it there. Frames
     * keep flowing at TICK_MS — they must, because a capture is only fulfilled by
     * the NEXT onProcessCpu (src/ar/eighthwall.ts:196) and RoomScanner harvests
     * points on its own interval — but every frame is now identical, so the app's
     * accumulated state converges to one value instead of tracking wall time.
     * The voxel grid dedupes the repeated points, so the count settles and stops.
     *
     * Jumping straight to the target rather than replaying the intervening ticks
     * is deliberate: nothing downstream needs those frames, and each one costs a
     * full-feed getImageData(). worldPoints() reconstructs the accumulated map
     * from the tick index alone.
     */
    freezeAt: function (target) {
      var want = Number(target)
      if (!isFinite(want) || want < 0) {
        throw new Error('[xr8-mock] freezeAt() needs a non-negative tick index, got ' + target)
      }
      tickCount = want
      frozen = true
      return tickCount
    },

    GlTextureRenderer: {
      pipelineModule: function () { return { name: 'mock-gltexturerenderer' } },
    },

    /**
     * The real engine's Three.js integration. Absent from this mock until now,
     * which broke every mock-xr8 spec outright rather than subtly: eighthwall.ts
     * calls XR8.Threejs.pipelineModule() unconditionally in start(), so the
     * missing key threw "Cannot read properties of undefined (reading
     * 'pipelineModule')", start() rejected, and the AR loop never began — no
     * pose stream, no points, no calibration overlay. The specs reported it as
     * "#scan-stats never fills", several layers downstream of the cause.
     *
     * `window.THREE` is assigned by eighthwall.ts immediately before the
     * pipeline modules are constructed (the real XR8.Threejs requires the same
     * global), so it is guaranteed to be present by the time xrScene() runs.
     *
     * The renderer is null: the provider only ever reads `.scene` off this, and
     * standing up a real WebGLRenderer headlessly buys nothing but flakiness.
     */
    Threejs: {
      pipelineModule: function () { return { name: 'mock-threejs' } },
      xrScene: function () {
        if (!xrSceneCache) {
          var T = window.THREE
          if (!T) throw new Error('[xr8-mock] window.THREE is not set — xrScene() needs it')
          xrSceneCache = {
            scene: new T.Scene(),
            camera: new T.PerspectiveCamera(60, 1, 0.01, 100),
            renderer: null,
          }
        }
        return xrSceneCache
      },
    },

    CameraPixelArray: {
      pipelineModule: function () { return { name: 'mock-camerapixelarray' } },
    },

    XrConfig: {
      device: function () { return { ANY: 'any' } },
    },

    XrController: {
      pipelineModule: function () { return { name: 'mock-xrcontroller' } },
      /**
       * Deterministic hit-test: projects the screen point onto the room's
       * floor/back-wall from the current pose.  Good enough for the spatial
       * resolver's median sampling.
       */
      hitTest: function (x, y) {
        if (trackingStatus() !== 'NORMAL') return []
        var pose = currentPose()
        var px = pose.position.x + (x - 0.5) * 4.0
        var py = Math.max(0, 1.5 - y * 1.8)
        var pz = pose.position.z - 2.2 - (1 - y) * 1.2
        return [{
          type: 'FEATURE_POINT',
          position: { x: px, y: py, z: pz },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          distance: Math.hypot(px - pose.position.x, py - pose.position.y, pz - pose.position.z),
        }]
      },
    },
  }

  window.dispatchEvent(new CustomEvent('xrloaded'))
  console.log('[xr8-mock] XR8 mock installed')
})()
