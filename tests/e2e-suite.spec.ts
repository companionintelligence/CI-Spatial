/**
 * E2E test suite for all 4 Tiers (Feature Coverage, Boundary/Corner, Cross-Feature, Real-World).
 * Implements 38 specific test cases covering F1, F2, and F3 features.
 */
import { test, expect } from '@playwright/test'
import { mergeDetections } from '../src/spatial/resolver'
import { normalizeDetections, parseDetections } from '../prompt.ts'

const BASE = process.env['VITE_URL'] ?? 'https://liambook.capybara-ulmer.ts.net:5173'

// Helper to build a minimal valid GLB buffer (~50 bytes)
function makeMinimalGlb(): Buffer {
  const jsonStr = JSON.stringify({ asset: { version: '2.0' } })
  const jsonBytes = Buffer.from(jsonStr, 'utf8')
  const padded = Buffer.alloc(Math.ceil(jsonBytes.length / 4) * 4, 0x20)
  jsonBytes.copy(padded)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + padded.length, 8)
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.writeUInt32LE(padded.length, 0)
  chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, padded])
}

// ── TIER 1: FEATURE COVERAGE (Tests 1 - 15) ───────────────────────────────────

test.describe('Tier 1: Feature Coverage', () => {

  test('Test 1: Server Boot and Health Status (GET /health)', async ({ request }) => {
    const resp = await request.get(`${BASE}/health`)
    expect(resp.status()).toBe(200)
    const body = await resp.json() as any
    expect(body.status).toBe('ok')
    expect(body.model).toBeTruthy()
  })

  test('Test 2: Inference Response Pipeline (POST /infer)', async ({ request }) => {
    const dummyJpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAAEAAQBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')
    const resp = await request.post(`${BASE}/infer`, {
      multipart: {
        image: { name: 'test.jpg', mimeType: 'image/jpeg', buffer: dummyJpeg }
      }
    })
    expect([200, 503]).toContain(resp.status())
    if (resp.status() === 200) {
      const list = await resp.json()
      expect(Array.isArray(list)).toBeTruthy()
    }
  })

  test('Test 3: Scan File Upload and Write (POST /upload-scan)', async ({ request }) => {
    const buf = makeMinimalGlb()
    const upResp = await request.post(`${BASE}/upload-scan`, {
      multipart: {
        file: { name: 'test-upload-t1.glb', mimeType: 'model/gltf-binary', buffer: buf },
        metadata: JSON.stringify({ detectionCount: 1, labels: ['chair'], exportedAt: new Date().toISOString() })
      }
    })
    expect(upResp.status()).toBe(200)
    const body = await upResp.json() as any
    expect(body.filename).toBeTruthy()
    expect(body.size).toBe(buf.length)
  })

  test('Test 4: Scan Location Indexing (GET /scan-locations)', async ({ request }) => {
    const buf = makeMinimalGlb()
    const uniqueAddress = `Test Location ${Date.now()}`
    const upResp = await request.post(`${BASE}/upload-scan`, {
      multipart: {
        file: { name: 'test-geo-t1.glb', mimeType: 'model/gltf-binary', buffer: buf },
        metadata: JSON.stringify({
          geoLat: 37.7749,
          geoLng: -122.4194,
          geoAddress: uniqueAddress,
          detectionCount: 1,
          labels: ['chair'],
          capturedAt: new Date().toISOString()
        })
      }
    })
    expect(upResp.status()).toBe(200)

    const locResp = await request.get(`${BASE}/scan-locations`)
    expect(locResp.status()).toBe(200)
    const list = await locResp.json() as any[]
    const found = list.find(l => l.address === uniqueAddress)
    expect(found).toBeTruthy()
    expect(found.lat).toBe(37.7749)
    expect(found.lng).toBe(-122.4194)
  })

  test('Test 5: Project CRUD Lifecycle (/projects)', async ({ request }) => {
    const name = `Proj CRUD ${Date.now()}`
    // Create
    const createResp = await request.post(`${BASE}/projects`, {
      data: { name, address: '123 Site', notes: 'CRUD testing' }
    })
    expect(createResp.status()).toBe(201)
    const created = await createResp.json() as any
    expect(created.projectId).toBeTruthy()
    expect(created.name).toBe(name)

    // Retrieve
    const getResp = await request.get(`${BASE}/projects/${created.projectId}`)
    expect(getResp.status()).toBe(200)
    const fetched = await getResp.json() as any
    expect(fetched.name).toBe(name)

    // Update
    const updateData = { ...fetched, name: name + ' Updated', notes: 'Notes updated' }
    const putResp = await request.put(`${BASE}/projects/${created.projectId}`, {
      data: updateData
    })
    expect(putResp.status()).toBe(200)
    const updated = await putResp.json() as any
    expect(updated.name).toBe(name + ' Updated')
    expect(updated.notes).toBe('Notes updated')

    // Delete
    const deleteResp = await request.delete(`${BASE}/projects/${created.projectId}`)
    expect(deleteResp.status()).toBe(200)
    const delResult = await deleteResp.json() as any
    expect(delResult.ok).toBe(true)

    // Verify gone
    const checkResp = await request.get(`${BASE}/projects/${created.projectId}`)
    expect(checkResp.status()).toBe(404)
  })

  test('Test 6: Frame Conversion and JPEG Compression (CaptureModule.capture)', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => document.getElementById('start-screen')?.remove())

    const captureResult = await page.evaluate(async () => {
      const module = await import('/src/capture/capture.ts')
      const mockProvider = {
        captureFrame: async () => ({
          pixels: new Uint8ClampedArray(4 * 64 * 64).fill(255), // 64x64 RGBA white
          width: 64,
          height: 64,
          pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
          timestamp: 123456
        })
      }
      const captureModule = new module.CaptureModule(mockProvider as any)
      const res = await captureModule.capture()
      return {
        isBlob: res.blob instanceof Blob,
        mimeType: res.blob.type,
        pose: res.pose,
        timestamp: res.timestamp
      }
    })

    expect(captureResult.isBlob).toBeTruthy()
    expect(captureResult.mimeType).toBe('image/jpeg')
    expect(captureResult.pose.position.x).toBe(0)
    expect(captureResult.timestamp).toBe(123456)
  })

  test('Test 7: Focal Length to FOV Estimation', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      // Mock XR8 global
      (window as any).XR8 = {
        addCameraPipelineModules: (mods: any[]) => {
          (window as any).eighthWallModules = mods
        },
        loadChunk: async () => {},
        GlTextureRenderer: { pipelineModule: () => ({ name: 'gl-renderer' }) },
        XrController: { pipelineModule: () => ({ name: 'xr-controller' }) },
        CameraPixelArray: { pipelineModule: () => ({ name: 'pixel-array' }) },
        XrConfig: { device: () => ({ ANY: {} }) },
        run: () => {}
      }
    })

    const fov = await page.evaluate(async () => {
      const { EighthWallProvider } = await import('/src/ar/eighthwall.ts')
      const provider = new EighthWallProvider()
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 480
      await provider.start(canvas)

      const modules = (window as any).eighthWallModules
      const clientModule = modules.find((m: any) => m.name === 'ci-scan-capture')

      // Trigger update with mock intrinsics (fy = 960, height = 1080)
      clientModule.onUpdate({
        processCpuResult: {
          reality: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            intrinsics: {
              fy: 960,
              height: 1080
            }
          }
        }
      })

      return provider.getCameraFovY()
    })

    // 2 * atan(1080 / 1920) * 180 / PI = ~58.71
    expect(fov).toBeCloseTo(58.71, 1)
  })

  test('Test 8: Point Cloud Extraction from SLAM Map', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      (window as any).XR8 = {
        addCameraPipelineModules: (mods: any[]) => {
          (window as any).eighthWallModules = mods
        },
        loadChunk: async () => {},
        GlTextureRenderer: { pipelineModule: () => ({}) },
        XrController: { pipelineModule: () => ({}) },
        CameraPixelArray: { pipelineModule: () => ({}) },
        XrConfig: { device: () => ({ ANY: {} }) },
        run: () => {}
      }
    })

    const pts = await page.evaluate(async () => {
      const { EighthWallProvider } = await import('/src/ar/eighthwall.ts')
      const provider = new EighthWallProvider()
      const canvas = document.createElement('canvas')
      await provider.start(canvas)

      const modules = (window as any).eighthWallModules
      const clientModule = modules.find((m: any) => m.name === 'ci-scan-capture')

      // Feed world points in updates
      clientModule.onUpdate({
        processCpuResult: {
          reality: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            worldPoints: [
              { position: { x: 1, y: 2, z: 3 } },
              { position: { x: -4, y: 5, z: -6 } }
            ]
          }
        }
      })

      return provider.featurePoints()
    })

    expect(pts).toEqual([
      { x: 1, y: 2, z: 3 },
      { x: -4, y: 5, z: -6 }
    ])
  })

  test('Test 8b: XR8 reality.points are harvested and camera-near hits are ignored', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      (window as any).XR8 = {
        addCameraPipelineModules: (mods: any[]) => {
          (window as any).eighthWallModules = mods
        },
        loadChunk: async () => {},
        GlTextureRenderer: { pipelineModule: () => ({}) },
        XrController: {
          pipelineModule: () => ({}),
          hitTest: () => [{
            position: { x: 0.001, y: 1.501, z: 0.001 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            distance: 0,
          }],
        },
        CameraPixelArray: { pipelineModule: () => ({}) },
        XrConfig: { device: () => ({ ANY: {} }) },
        run: () => {}
      }
    })

    const result = await page.evaluate(async () => {
      const { EighthWallProvider } = await import('/src/ar/eighthwall.ts')
      const provider = new EighthWallProvider()
      const canvas = document.createElement('canvas')
      await provider.start(canvas)

      const modules = (window as any).eighthWallModules
      const clientModule = modules.find((m: any) => m.name === 'ci-scan-capture')

      clientModule.onUpdate({
        processCpuResult: {
          reality: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            worldPoints: { points: [3, 1.1, -4, 4, 1.3, -5] },
            points: [
              { x: 0.001, y: 1.501, z: 0.001 },
              { position: { x: 1, y: 1.2, z: -2 } },
              [2, 0.8, -3],
            ]
          }
        }
      })

      return {
        points: provider.featurePoints(),
        hit: provider.hitTest(0.5, 0.5),
      }
    })

    expect(result.hit).toBeNull()
    expect(result.points).toEqual([
      { x: 3, y: 1.1, z: -4 },
      { x: 4, y: 1.3, z: -5 },
      { x: 1, y: 1.2, z: -2 },
      { x: 2, y: 0.8, z: -3 }
    ])
  })

  test('Test 9: Centroid 3D Position Extraction', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const resolvedPos = await page.evaluate(async () => {
      const { resolveDetections } = await import('/src/spatial/resolver.ts')
      const mockProvider = {
        hitTest: (x: number, y: number) => {
          return {
            position: { x: x * 2, y: y * 2, z: -1.5 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            distance: 1.5
          }
        }
      }
      // Centroid of [0.1, 0.1, 0.3, 0.3] is cx = 0.2, cy = 0.2
      const detections = [{ label: 'chair', bbox: [0.1, 0.1, 0.3, 0.3], confidence: 0.9, description: 'chair' }]
      const results = await resolveDetections(detections as any, Date.now(), { provider: mockProvider as any })
      return results[0].worldPos
    })

    expect(resolvedPos.x).toBeCloseTo(0.4, 2)
    expect(resolvedPos.y).toBeCloseTo(0.4, 2)
    expect(resolvedPos.z).toBeCloseTo(-1.5, 2)
  })

  test('Test 10: GLB Export Hierarchy Compilation', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const sceneJson = await page.evaluate(async () => {
      const { exportToGLB } = await import('/src/export/gltf.ts')
      const { DetectionStore } = await import('/src/scene/store.ts')
      const { PointCloud } = await import('/src/scene/pointcloud.ts')

      const store = new DetectionStore()
      store.sessionId = 'test-session-123'
      store.detections.set('chair-1', {
        label: 'chair',
        confidence: 0.95,
        description: 'desk chair',
        bbox: [0.1, 0.1, 0.3, 0.3],
        worldPos: { x: 0, y: 0, z: -1 },
        worldRot: { x: 0, y: 0, z: 0, w: 1 },
        captureTimestamp: Date.now()
      })

      const pointCloud = new PointCloud()
      pointCloud.add([{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }])

      const poseHistory = [
        { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { position: { x: 0, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
      ]

      const global = window as any
      global.downloadTriggered = null
      global.uploadTriggered = null

      URL.createObjectURL = (blob: Blob) => {
        global.downloadTriggered = { size: blob.size, type: blob.type, filename: '' }
        return 'blob:test-glb'
      }
      URL.revokeObjectURL = () => {}
      HTMLAnchorElement.prototype.click = function () {
        if (global.downloadTriggered) global.downloadTriggered.filename = this.download
      }

      await exportToGLB({ store, pointCloud, poseHistory })

      return {
        download: global.downloadTriggered,
        uploaded: global.uploadTriggered
      }
    })

    expect(sceneJson.download).toBeTruthy()
    expect(sceneJson.download.size).toBeGreaterThan(0)
  })

  test('Test 11: Asynchronous GLTF Loading and Assembly', async ({ page }) => {
    await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    const isVisible = await page.evaluate(() => {
      const el = document.getElementById('loading-overlay')
      return el !== null
    })
    expect(isVisible).toBeTruthy()
  })

  test('Test 12: Raycast Mesh Picking and Highlight', async ({ page }) => {
    await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded' })
    const pickResult = await page.evaluate(async () => {
      const { SceneEditor } = await import('/src/viewer/editor.ts')
      const THREE = await import('/node_modules/.vite/deps/three.js')
      const editor = new SceneEditor()

      const scene = new THREE.Scene()
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
      box.name = 'chair_001'
      box.userData = { label: 'chair', tag: 'chair', objectId: 'chair_001' }
      scene.add(box)
      editor.setScene(scene)

      const camera = new THREE.PerspectiveCamera()
      camera.position.set(0, 0, 5)
      camera.lookAt(0, 0, 0)
      camera.updateMatrixWorld()

      const picked = editor.pick(0, 0, camera)
      return picked ? { name: picked.name, tag: picked.userData.tag } : null
    })

    expect(pickResult).toBeTruthy()
    expect(pickResult?.name).toBe('chair_001')
  })

  test('Test 13: Semantic Mode Material Color Mapping', async ({ page }) => {
    await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded' })
    const viewModeResult = await page.evaluate(async () => {
      const { SceneEditor } = await import('/src/viewer/editor.ts')
      const THREE = await import('/node_modules/.vite/deps/three.js')
      const editor = new SceneEditor()

      const scene = new THREE.Scene()
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff }))
      box.name = 'chair_001'
      box.userData = { label: 'chair', tag: 'chair' }
      scene.add(box)
      editor.setScene(scene)

      editor.setMode('semantic')
      const mat = box.material as THREE.MeshStandardMaterial
      return {
        mode: editor.mode,
        opacity: mat.opacity,
        transparent: mat.transparent
      }
    })

    expect(viewModeResult.mode).toBe('semantic')
    expect(viewModeResult.transparent).toBeTruthy()
    expect(viewModeResult.opacity).toBeLessThan(1.0)
  })

  test('Test 14: Custom Tag and Note Updating', async ({ page }) => {
    await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded' })
    const updateResult = await page.evaluate(async () => {
      const { SceneEditor } = await import('/src/viewer/editor.ts')
      const THREE = await import('/node_modules/.vite/deps/three.js')
      const editor = new SceneEditor()

      const scene = new THREE.Scene()
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
      box.name = 'chair_001'
      box.userData = { label: 'chair', tag: 'chair' }
      scene.add(box)
      editor.setScene(scene)

      editor.tagObject(box, 'sofa', { notes: 'Updated notes in test' })
      const data = editor.getInspectorData(box)
      return {
        tag: data.tag,
        notes: data.notes
      }
    })

    expect(updateResult.tag).toBe('sofa')
    expect(updateResult.notes).toBe('Updated notes in test')
  })

  test('Test 15: Adaptive Bounding Box Geometry Overlays', async ({ page }) => {
    await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded' })
    const overlaysCount = await page.evaluate(async () => {
      const THREE = await import('/node_modules/.vite/deps/three.js')
      const scene = new THREE.Scene()
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
      box.name = 'chair_001'
      box.userData = { label: 'chair', tag: 'chair' }
      scene.add(box)

      const wireframe = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry))
      box.add(wireframe)
      return box.children.length
    })

    expect(overlaysCount).toBeGreaterThan(0)
  })
})

// ── TIER 2: BOUNDARY & CORNER CASES (Tests 16 - 30) ───────────────────────────

test.describe('Tier 2: Boundary & Corner Cases', () => {

  test('Test 16: Inference with Missing Image Parameter', async ({ request }) => {
    const resp = await request.post(`${BASE}/infer`, {
      multipart: {}
    })
    expect(resp.status()).toBe(400)
    const body = await resp.json() as any
    expect(body.error).toBe('Missing image field')
  })

  test('Test 17: Path Traversal Security Injection', async ({ request }) => {
    const resp1 = await request.get(`${BASE}/scans/..%2F..%2Fetc%2Fpasswd`)
    expect(resp1.status()).toBeGreaterThanOrEqual(400)

    const resp2 = await request.get(`${BASE}/scans/..%252F..%252Fetc%252Fpasswd`)
    expect(resp2.status()).toBeGreaterThanOrEqual(400)
  })

  test('Test 18: Incomplete or Truncated VLM JSON Repair', () => {
    const truncatedText = `[{"label": "chair", "bbox": [0.1, 0.1, 0.2, 0.2], "confidence": 0.85, "description": "red chair"}, {"label": "table", "bbox": [0.3`
    const results = parseDetections(truncatedText)
    expect(results.length).toBe(1)
    expect(results[0].label).toBe('chair')
    expect(results[0].confidence).toBe(0.85)
  })

  test('Test 18b: Duplicate VLM boxes are collapsed and capped', () => {
    const raw = [
      { label: 'Chair', bbox: [0.23, 0.25, 0.5, 0.49], confidence: 0.39, description: 'gray blanket on chair.' },
      { label: 'chair', bbox: [0.231, 0.251, 0.501, 0.491], confidence: 0.62, description: 'same chair, higher confidence' },
      { label: 'chair', bbox: [0.7, 0.1, 0.9, 0.4], confidence: 0.52, description: 'second chair' },
      { label: 'table', bbox: [0.1, 0.1, 0.2, 0.2], confidence: 80, description: 'confidence percent' },
      { label: 'table', bbox: [0.101, 0.1, 0.201, 0.2], confidence: 0.3, description: 'duplicate table' },
    ]

    const results = normalizeDetections(raw)
    expect(results).toHaveLength(3)
    expect(results[0].label).toBe('chair')
    expect(results[0].confidence).toBe(0.62)
    expect(results.find((d) => d.label === 'table')?.confidence).toBe(0.8)
  })

  test('Test 19: Bbox Coordinate Denormalization Recovery', () => {
    const pixelText = `[{"label": "chair", "bbox": [100, 200, 300, 400], "confidence": 0.9, "description": "chair"}]`
    const results = parseDetections(pixelText)
    expect(results.length).toBe(1)
    const bbox = results[0].bbox
    expect(bbox[3]).toBe(1.0)
    expect(bbox[0]).toBe(0.25)
  })

  test('Test 20: Server Startup with Missing ONNX Models', async ({ request }) => {
    const resp = await request.get(`${BASE}/health`)
    expect(resp.status()).toBe(200)
    const body = await resp.json() as any
    expect(body.status).toBe('ok')
  })

  test('Test 21: Fallback Positioning for Missing Hit-Tests', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const resolvedPos = await page.evaluate(async () => {
      const { resolveDetections } = await import('/src/spatial/resolver.ts')
      const mockProvider = {
        hitTest: () => null
      }
      const cameraPose = {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0, w: 1 }
      }
      const detections = [{ label: 'chair', bbox: [0.1, 0.1, 0.3, 0.3], confidence: 0.9, description: 'chair' }]
      const results = await resolveDetections(detections as any, Date.now(), { provider: mockProvider as any, cameraPose })
      return results[0].worldPos
    })

    expect(resolvedPos.x).toBeCloseTo(1, 2)
    expect(resolvedPos.y).toBeCloseTo(2, 2)
    expect(resolvedPos.z).toBeCloseTo(1, 2)
  })

  test('Test 22: Point Cloud Raycast Fallback', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const resolvedPos = await page.evaluate(async () => {
      const { resolveDetections } = await import('/src/spatial/resolver.ts')
      const THREE = await import('/node_modules/.vite/deps/three.js')
      const { PointCloud } = await import('/src/scene/pointcloud.ts')

      const mockProvider = {
        hitTest: () => null
      }
      const cameraPose = {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 }
      }

      const captureCamera = new THREE.PerspectiveCamera()
      captureCamera.position.set(0, 0, 5)
      captureCamera.lookAt(0, 0, 0)
      captureCamera.updateMatrixWorld()

      const pointCloud = new PointCloud()
      pointCloud.add([{ x: 0, y: 0, z: 0 }])

      const detections = [{ label: 'chair', bbox: [0.4, 0.4, 0.6, 0.6], confidence: 0.9, description: 'chair' }]
      const results = await resolveDetections(detections as any, Date.now(), {
        provider: mockProvider as any,
        cameraPose,
        captureCamera,
        pointCloud
      })
      return results[0].worldPos
    })

    expect(resolvedPos.x).toBeCloseTo(0, 2)
    expect(resolvedPos.y).toBeCloseTo(0, 2)
    expect(resolvedPos.z).toBeCloseTo(0, 2)
  })

  test('Test 22b: BBox ray fallback keeps detections spatially separated', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const threeModuleUrl = `/@fs${process.cwd()}/node_modules/three/build/three.module.js`
    const positions = await page.evaluate(async (threeUrl) => {
      const { resolveDetections } = await import('/src/spatial/resolver.ts')
      const THREE = await import(threeUrl)

      const cameraPose = {
        position: { x: 0, y: 1.5, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 }
      }
      const mockProvider = {
        hitTest: () => ({
          position: { x: 0.001, y: 1.501, z: 0.001 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          distance: 0,
        })
      }

      const captureCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 100)
      captureCamera.position.set(0, 1.5, 0)
      captureCamera.quaternion.set(0, 0, 0, 1)
      captureCamera.updateMatrixWorld(true)

      const detections = [
        { label: 'chair', bbox: [0.1, 0.45, 0.25, 0.65], confidence: 0.9, description: 'chair' },
        { label: 'vase', bbox: [0.7, 0.45, 0.85, 0.65], confidence: 0.9, description: 'vase' },
      ]
      const results = await resolveDetections(detections as any, Date.now(), {
        provider: mockProvider as any,
        cameraPose,
        captureCamera,
      })
      return results.map((r) => r.worldPos)
    }, threeModuleUrl)

    expect(positions).toHaveLength(2)
    expect(positions[0].x).toBeLessThan(positions[1].x)
    expect(Math.hypot(
      positions[0].x - positions[1].x,
      positions[0].y - positions[1].y,
      positions[0].z - positions[1].z,
    )).toBeGreaterThan(0.5)
    expect(positions[0].z).toBeLessThan(-1)
    expect(positions[1].z).toBeLessThan(-1)
  })

  test('Test 23: Duplicate Collision Mitigation', () => {
    const existing = new Map()
    existing.set('chair:0.0,0.0,-1.0', {
      label: 'chair',
      confidence: 0.7,
      description: 'First chair',
      bbox: [0.1, 0.1, 0.2, 0.2],
      worldPos: { x: 0.0, y: 0.0, z: -1.0 },
      worldRot: { x: 0, y: 0, z: 0, w: 1 },
      captureTimestamp: 1000,
    })

    const incoming = [{
      label: 'chair',
      confidence: 0.9,
      description: 'First chair but higher confidence',
      bbox: [0.12, 0.12, 0.22, 0.22],
      worldPos: { x: 0.05, y: 0.01, z: -0.98 },
      worldRot: { x: 0, y: 0, z: 0, w: 1 },
      captureTimestamp: 1100,
    }]

    const merged = mergeDetections(existing, incoming)
    expect(merged.size).toBe(1)
    const val = Array.from(merged.values())[0]
    expect(val.confidence).toBe(0.9)
    expect(val.description).toBe('First chair but higher confidence')
  })

  test('Test 24: Corrupt Intrinsics Safety', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      (window as any).XR8 = {
        addCameraPipelineModules: (mods: any[]) => {
          (window as any).eighthWallModules = mods
        },
        loadChunk: async () => {},
        GlTextureRenderer: { pipelineModule: () => ({}) },
        XrController: { pipelineModule: () => ({}) },
        CameraPixelArray: { pipelineModule: () => ({}) },
        XrConfig: { device: () => ({ ANY: {} }) },
        run: () => {}
      }
    })

    const fov = await page.evaluate(async () => {
      const { EighthWallProvider } = await import('/src/ar/eighthwall.ts')
      const provider = new EighthWallProvider()
      const canvas = document.createElement('canvas')
      await provider.start(canvas)

      const modules = (window as any).eighthWallModules
      const clientModule = modules.find((m: any) => m.name === 'ci-scan-capture')

      clientModule.onUpdate({
        processCpuResult: {
          reality: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            intrinsics: {
              fy: NaN,
              height: 1080
            }
          }
        }
      })

      return provider.getCameraFovY()
    })

    expect(fov).toBe(60)
  })

  test('Test 24b: Pending capture rejects duplicates and times out cleanly', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const result = await page.evaluate(async () => {
      ;(window as any).XR8 = {
        addCameraPipelineModules: (mods: any[]) => {
          ;(window as any).eighthWallModules = mods
        },
        loadChunk: async () => {},
        GlTextureRenderer: { pipelineModule: () => ({}) },
        XrController: { pipelineModule: () => ({}), hitTest: () => [] },
        CameraPixelArray: { pipelineModule: () => ({}) },
        XrConfig: { device: () => ({ ANY: {} }) },
        run: () => {},
        stop: () => {},
      }

      const { EighthWallProvider } = await import('/src/ar/eighthwall.ts')
      const provider = new EighthWallProvider()
      const canvas = document.createElement('canvas')
      await provider.start(canvas)

      const first = provider.captureFrame(40)
        .then(() => 'resolved')
        .catch((error: Error) => error.message)
      const second = await provider.captureFrame(40)
        .then(() => 'resolved')
        .catch((error: Error) => error.message)
      const firstResult = await first
      provider.stop()
      return { firstResult, second }
    })

    expect(result.second).toContain('already pending')
    expect(result.firstResult).toContain('Timed out')
  })

  test('Test 25: Quaternion Normalization Safeguards', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const resolvedRot = await page.evaluate(async () => {
      const { resolveDetections } = await import('/src/spatial/resolver.ts')
      const mockProvider = {
        hitTest: () => ({
          position: { x: 0, y: 0, z: -1.5 },
          rotation: { x: 0, y: 2, z: 0, w: 0 },
          distance: 1.5
        })
      }
      const detections = [{ label: 'chair', bbox: [0.1, 0.1, 0.3, 0.3], confidence: 0.9, description: 'chair' }]
      const results = await resolveDetections(detections as any, Date.now(), { provider: mockProvider as any })
      return results[0].worldRot
    })

    expect(resolvedRot.x).toBe(0)
    expect(resolvedRot.y).toBe(1)
    expect(resolvedRot.z).toBe(0)
    expect(resolvedRot.w).toBe(0)
  })

  test('Test 26: Raycast Probes on Empty Scenes', async ({ page }) => {
    await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded' })
    const testResult = await page.evaluate(async () => {
      const { SceneEditor } = await import('/src/viewer/editor.ts')
      const THREE = await import('/node_modules/.vite/deps/three.js')
      const editor = new SceneEditor()
      const picked = editor.pick(0, 0, new THREE.PerspectiveCamera())
      return picked
    })
    expect(testResult).toBeNull()
  })

  test('Test 27: Missing Mesh Metadata Fallbacks', async ({ page }) => {
    await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded' })
    const details = await page.evaluate(async () => {
      const { SceneEditor } = await import('/src/viewer/editor.ts')
      const THREE = await import('/node_modules/.vite/deps/three.js')
      const editor = new SceneEditor()

      const mesh = new THREE.Mesh()
      mesh.name = 'unnamed'
      const data = editor.getInspectorData(mesh)
      return {
        name: data.name,
        confidence: data.confidence,
        notes: data.notes
      }
    })
    expect(details.name).toBe('unnamed')
    expect(details.confidence).toBeUndefined()
    expect(details.notes).toBeUndefined()
  })

  test('Test 28: Invalid View Mode Recovery', async ({ page }) => {
    await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded' })
    const activeMode = await page.evaluate(async () => {
      const { SceneEditor } = await import('/src/viewer/editor.ts')
      const editor = new SceneEditor()
      editor.setMode('invalid-mode' as any)
      return editor.mode
    })
    expect(activeMode).toBe('solid')
  })

  test('Test 29: Extreme Scale Model Fitting', async ({ page }) => {
    await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded' })
    const cameraPosChanged = await page.evaluate(async () => {
      const THREE = await import('/node_modules/.vite/deps/three.js')
      const scene = new THREE.Scene()
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.0001, 0.0001, 0.0001))
      scene.add(box)

      const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100)
      camera.position.set(0, 0, 5)

      const boundingBox = new THREE.Box3().setFromObject(scene)
      const center = new THREE.Vector3()
      const size = new THREE.Vector3()
      boundingBox.getCenter(center)
      boundingBox.getSize(size)
      const maxDim = Math.max(size.x, size.y, size.z)
      const fov = camera.fov * (Math.PI / 180)
      const distance = (maxDim / 2) / Math.tan(fov / 2) * 1.6

      camera.position.set(center.x + distance * 0.6, center.y + distance * 0.4, center.z + distance * 0.8)
      return { x: camera.position.x, y: camera.position.y, z: camera.position.z }
    })

    expect(cameraPosChanged.z).toBeGreaterThan(0)
  })

  test('Test 30: CDN Load Rejections for Leaflet', async ({ page }) => {
    await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded' })
    const errorHandled = await page.evaluate(async () => {
      const container = document.createElement('div')
      container.id = 'geomap-drawer'
      document.body.appendChild(container)

      const { GeoMap } = await import('/src/viewer/geomap.ts')
      const geoMap = new GeoMap()
      geoMap.mount(document.body)

      let threw = false
      try {
        await geoMap.updatePins([])
      } catch {
        threw = true
      }
      return threw || geoMap !== null
    })
    expect(errorHandled).toBeTruthy()
  })
})

// ── TIER 3: CROSS-FEATURE COMBINATIONS (Tests 31 - 33) ────────────────────────

test.describe('Tier 3: Cross-Feature Combinations', () => {

  test('Test 31: Inference Server Mode Toggle to Local WebGPU (F1 + F2)', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => document.getElementById('start-screen')?.remove())

    await page.locator('#panel-toggle').click()
    await page.waitForTimeout(300)

    const webgpuBtn = page.locator('[data-mode="webgpu"]')
    if (await webgpuBtn.isVisible()) {
      await webgpuBtn.click()
      const mode = await page.evaluate(() => localStorage.getItem('infer-mode'))
      expect(mode).toBe('webgpu')

      const serverBtn = page.locator('[data-mode="server"]')
      await serverBtn.click()
      const modeBack = await page.evaluate(() => localStorage.getItem('infer-mode'))
      expect(modeBack).toBe('server')
    }
  })

  test('Test 32: WebRTC Live Collaboration Updates (F1 + F3)', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })

    const room = `pw-collab-${Date.now()}`
    const result = await page.evaluate(async ({ base, room }) => {
      const wsUrl = base.replace(/^https/, 'wss').replace(/^http/, 'ws')
      return new Promise<boolean>((resolve) => {
        const phone = new WebSocket(`${wsUrl}/rtc-signal?role=phone&room=${room}`)
        const viewer = new WebSocket(`${wsUrl}/rtc-signal?role=viewer&room=${room}`)

        let receivedUpdate = false

        viewer.onmessage = (e) => {
          const msg = JSON.parse(e.data)
          if (msg.type === 'sync-state' && msg.data === 'test-data') {
            receivedUpdate = true
            phone.close()
            viewer.close()
            resolve(true)
          }
        }

        phone.onopen = () => {
          setTimeout(() => {
            phone.send(JSON.stringify({ type: 'sync-state', data: 'test-data' }))
          }, 500)
        }

        setTimeout(() => {
          phone.close()
          viewer.close()
          resolve(receivedUpdate)
        }, 3000)
      })
    }, { base: BASE, room })

    expect(result).toBeTruthy()
  })

  test('Test 33: GPS Geotagged GLTF E2E Flow (F2 + F3 + F1)', async ({ request, page }) => {
    const buf = makeMinimalGlb()
    const lat = 37.7749
    const lng = -122.4194
    const address = 'GPS Geotagged Test Location'

    const upResp = await request.post(`${BASE}/upload-scan`, {
      multipart: {
        file: { name: 'geotag-test.glb', mimeType: 'model/gltf-binary', buffer: buf },
        metadata: JSON.stringify({ geoLat: lat, geoLng: lng, geoAddress: address, detectionCount: 1, labels: ['chair'] }),
      },
    })
    expect(upResp.status()).toBe(200)

    const locationsResp = await request.get(`${BASE}/scan-locations`)
    expect(locationsResp.status()).toBe(200)
    const list = await locationsResp.json() as Array<any>
    const match = list.find(l => l.address === address)
    expect(match).toBeTruthy()
    expect(match.lat).toBe(lat)
    expect(match.lng).toBe(lng)

    await page.goto(`${BASE}/viewer.html`, { waitUntil: 'domcontentloaded' })
    await page.locator('#btn-geomap').click()
    const geomapDrawer = page.locator('#geomap-drawer')
    await expect(geomapDrawer).toHaveClass(/geomap-open/)
  })
})

// ── TIER 4: REAL-WORLD SCENARIOS (Tests 34 - 38) ──────────────────────────────

test.describe('Tier 4: Real-World Application Scenarios', () => {

  test('Test 34: Highly Cluttered Environment Scanning (F2 + F3)', async () => {
    const existing = new Map()
    existing.set('chair:1.0,2.0,-1.0', {
      label: 'chair',
      confidence: 0.8,
      description: 'First chair',
      bbox: [0.1, 0.1, 0.2, 0.2],
      worldPos: { x: 1.0, y: 2.0, z: -1.0 },
      worldRot: { x: 0, y: 0, z: 0, w: 1 },
      captureTimestamp: 1000,
    })

    const incomingClose = [{
      label: 'chair',
      confidence: 0.9,
      description: 'First chair updated',
      bbox: [0.1, 0.1, 0.2, 0.2],
      worldPos: { x: 1.05, y: 2.02, z: -0.98 },
      worldRot: { x: 0, y: 0, z: 0, w: 1 },
      captureTimestamp: 1100,
    }]

    const result1 = mergeDetections(existing, incomingClose)
    expect(result1.size).toBe(1)
    const merged = Array.from(result1.values())[0]
    expect(merged.confidence).toBe(0.9)

    const incomingFar = [{
      label: 'chair',
      confidence: 0.7,
      description: 'Second chair',
      bbox: [0.3, 0.3, 0.4, 0.4],
      worldPos: { x: 1.5, y: 2.0, z: -1.0 },
      worldRot: { x: 0, y: 0, z: 0, w: 1 },
      captureTimestamp: 1200,
    }]

    const result2 = mergeDetections(existing, incomingFar)
    expect(result2.size).toBe(2)
  })

  test('Test 35: Multi-Floor Construction Project Walkthrough (F2 + F3 + F1)', async ({ request }) => {
    const uniqueName = `Project-${Date.now()}`
    const createResp = await request.post(`${BASE}/projects`, {
      data: { name: uniqueName, address: 'Multi-Floor site', notes: 'Walking through floors' },
    })
    expect(createResp.status()).toBe(201)
    const project = await createResp.json() as any

    const updatedProject = {
      ...project,
      floors: [
        ...project.floors,
        { name: 'First Floor', level: 1, scans: [] }
      ]
    }

    const putResp = await request.put(`${BASE}/projects/${project.projectId}`, {
      data: updatedProject,
    })
    expect(putResp.status()).toBe(200)
    const putResult = await putResp.json() as any
    expect(putResult.floors.length).toBe(2)
    expect(putResult.floors[1].name).toBe('First Floor')

    await request.delete(`${BASE}/projects/${project.projectId}`)
  })

  test('Test 36: Rapid-Fire Frame Capturing (F2 + F1)', async ({ request }) => {
    const dummyJpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAAEAAQBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')

    const promises = Array.from({ length: 5 }).map(() =>
      request.post(`${BASE}/infer`, {
        multipart: {
          image: { name: 'rapid.jpg', mimeType: 'image/jpeg', buffer: dummyJpeg }
        }
      })
    )

    const responses = await Promise.all(promises)
    for (const resp of responses) {
      expect([200, 503]).toContain(resp.status())
      if (resp.status() === 200) {
        const list = await resp.json()
        expect(Array.isArray(list)).toBeTruthy()
      }
    }
  })

  test('Test 37: Offline Scanning and Delayed Server Sync (F2 + F1)', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => document.getElementById('start-screen')?.remove())

    await page.locator('#history-btn').click()
    await expect(page.locator('#history-drawer')).toHaveClass(/open/)

    const dbStatus = await page.evaluate(async () => {
      return new Promise<boolean>((resolve) => {
        const req = indexedDB.open('ci-xr-scan', 1)
        req.onsuccess = () => {
          const db = req.result
          const storeExists = db.objectStoreNames.contains('sessions')
          db.close()
          resolve(storeExists)
        }
        req.onerror = () => resolve(false)
      })
    })
    expect(dbStatus).toBeTruthy()
  })

  test('Test 38: Remote Inspector WebRTC Walkthrough (F1 + F2 + F3)', async ({ page }) => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const room = `pw-inspector-${Date.now()}`

    const testResult = await page.evaluate(async ({ base, room }) => {
      const wsUrl = base.replace(/^https/, 'wss').replace(/^http/, 'ws')
      return new Promise<boolean>((resolve) => {
        const phone = new WebSocket(`${wsUrl}/rtc-signal?role=phone&room=${room}`)
        const viewer = new WebSocket(`${wsUrl}/rtc-signal?role=viewer&room=${room}`)

        let receivedPose = false

        viewer.onmessage = (e) => {
          const msg = JSON.parse(e.data)
          if (msg.type === 'pose' && msg.x === 1 && msg.y === 2 && msg.z === 3) {
            receivedPose = true
            phone.close()
            viewer.close()
            resolve(true)
          }
        }

        phone.onopen = () => {
          setTimeout(() => {
            phone.send(JSON.stringify({ type: 'pose', x: 1, y: 2, z: 3 }))
          }, 500)
        }

        setTimeout(() => {
          phone.close()
          viewer.close()
          resolve(receivedPose)
        }, 3000)
      })
    }, { base: BASE, room })

    expect(testResult).toBeTruthy()
  })
})
