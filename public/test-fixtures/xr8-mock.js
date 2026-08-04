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
 */
;(function () {
  'use strict'

  // ── Synthetic scene (palette colours match cv-palette.ts) ────────────────
  var SCENE_OBJECTS = [
    { label: 'sofa', color: 'rgb(255,109,0)', x: 0.32, y: 0.46, w: 0.24, h: 0.16 },
    { label: 'tv', color: 'rgb(0,184,212)', x: 0.08, y: 0.50, w: 0.18, h: 0.14 },
    { label: 'table', color: 'rgb(109,76,65)', x: 0.66, y: 0.52, w: 0.16, h: 0.10 },
    { label: 'plant', color: 'rgb(0,200,83)', x: 0.87, y: 0.42, w: 0.07, h: 0.22 },
  ]
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
  var feedCanvas = null
  var feedCtx = null
  // When true the session keeps emitting frames but tickCount stops advancing,
  // so every emitted frame is identical.  See freezeAt() below.
  var frozen = false
  var frozenPoints = null

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

  function drawScene(ctx, w, h) {
    // Wall gradient
    var grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, 'rgb(205,205,209)')
    grad.addColorStop(0.72, 'rgb(176,176,180)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
    // Floor
    ctx.fillStyle = 'rgb(58,62,72)'
    ctx.fillRect(0, h * 0.72, w, h * 0.28)
    // Furniture (palette colours the mock inference engine detects)
    for (var i = 0; i < SCENE_OBJECTS.length; i++) {
      var o = SCENE_OBJECTS[i]
      ctx.fillStyle = o.color
      ctx.fillRect(o.x * w, o.y * h, o.w * w, o.h * h)
    }
  }

  function tick() {
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
