/**
 * Deno inference server — Hono HTTP server on :8000
 *
 * POST /infer              multipart { image: File }   → RawDetection[]
 * POST /upload-scan        multipart { file: File(.glb), metadata?: JSON } → { filename, job }
 * GET  /scans              → [{ filename, size, uploadedAt, optimized, job }]
 * GET  /scans/:filename    → model/gltf-binary (source or derived artifact)
 * GET  /scans/:filename/manifest     → optimization manifest (artifacts + stats)
 * POST /scans/:filename/optimize     → (re-)enqueue optimization job
 * DELETE /scans/:filename → delete stored .glb + sidecar metadata
 * DELETE /scans?confirm=delete-all → clear test scan storage
 * GET  /jobs               → Job[]   (processing queue state)
 * GET  /jobs/:id           → Job
 * POST /sessions                       → { sessionId } — begin keyframe capture session
 * POST /sessions/:id/keyframes         multipart { image, meta } → { ok, index }
 * POST /sessions/:id/finalize          JSON { glbFilename?, … } → session record
 * GET  /sessions/:id                   → session record
 * POST /upload-summary     multipart { file: File(.md) } → { filename }
 * POST /process-scan       JSON { filename, action, sessionId? } → { action, result }
 * GET  /projects           → Project[]
app.delete('/scans', async (c) => {
  const confirm = c.req.query('confirm')
  if (confirm !== 'delete-all') {
    return c.json({ error: 'Add ?confirm=delete-all to clear scan storage' }, 400)
  }

  let deleted = 0
  try {
    for await (const entry of Deno.readDir(SCANS_DIR)) {
      if (!entry.isFile) continue
      if (!entry.name.endsWith('.glb') && !entry.name.endsWith('.json')) continue
      if (await removeIfExists(`${SCANS_DIR}/${entry.name}`)) deleted += 1
    }
    await removeAllScansFromWorlds()
    return c.json({ ok: true, deleted })
  } catch (err) {
    console.error('[scans clear error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

// ── Scan manifest + manual re-optimize ────────────────────────────────────────
// (Semantic edit persistence lives in the worlds patch system: /worlds/:slug/patches)

app.get('/scans/:filename/manifest', async (c) => {
  const filename = safeScanName(c.req.param('filename'))
  app.delete('/scans', async (c) => {
    const confirm = c.req.query('confirm')
    if (confirm !== 'delete-all') {
      return c.json({ error: 'Add ?confirm=delete-all to clear scan storage' }, 400)
    }

    let deleted = 0
    try {
      for await (const entry of Deno.readDir(SCANS_DIR)) {
        if (!entry.isFile) continue
        if (!entry.name.endsWith('.glb') && !entry.name.endsWith('.json')) continue
        if (await removeIfExists(`${SCANS_DIR}/${entry.name}`)) deleted += 1
      }
      await removeAllScansFromWorlds()
      return c.json({ ok: true, deleted })
    } catch (err) {
      console.error('[scans clear error]', err)
      return c.json({ error: String(err) }, 500)
    }
  })

  // ── Scan manifest + manual re-optimize ────────────────────────────────────────
  // (Semantic edit persistence lives in the worlds patch system: /worlds/:slug/patches)

  app.get('/scans/:filename/manifest', async (c) => {
    const filename = safeScanName(c.req.param('filename'))
    if (!filename || !filename.endsWith('.glb')) return c.json({ error: 'Invalid filename' }, 400)
    try {
      const raw = await Deno.readTextFile(`${SCANS_DIR}/${filename.replace(/\.glb$/, '.manifest.json')}`)
      return c.json(JSON.parse(raw))
    } catch {
      return c.json({ error: 'No manifest — scan not optimized yet' }, 404)
    }
  })

  app.post('/scans/:filename/optimize', async (c) => {
    const filename = safeScanName(c.req.param('filename'))
    if (!filename || !filename.endsWith('.glb') || isDerivedScanFile(filename)) {
      return c.json({ error: 'Invalid filename' }, 400)
    }
    try {
      await Deno.stat(`${SCANS_DIR}/${filename}`)
    } catch {
      return c.json({ error: 'Scan not found' }, 404)
    }
    const job = jobQueue.enqueue('optimize-scan', filename)
    return c.json(job, 202)
  })

  // ── Job queue state ───────────────────────────────────────────────────────────

  app.get('/jobs', (c) => c.json([...jobQueue.jobs].reverse()))

  app.get('/jobs/:id', (c) => {
    const job = jobQueue.job(c.req.param('id'))
    return job ? c.json(job) : c.json({ error: 'Not found' }, 404)
  })

  // ── Capture sessions — streaming keyframe ingestion ──────────────────────────
  //
  // The phone opens a session when scanning starts and streams pose-tagged
  // keyframes (JPEG + JSON meta) while the user walks the room.  Frames land in
  //   scans/sessions/<id>/kf-NNNNN.jpg        image
  //   scans/sessions/<id>/keyframes.jsonl     one meta record per frame
  // On finalize the session is linked to the exported .glb.  This is the raw
  // input a dense-reconstruction stage (photogrammetry / splats) consumes.

  const SESSION_ID_RE = /^sess-[a-z0-9-]+$/

  function sessionDir(id: string): string | null {
    return SESSION_ID_RE.test(id) ? `${SESSIONS_DIR}/${id}` : null
  }

  app.post('/sessions', async (c) => {
    const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await Deno.mkdir(`${SESSIONS_DIR}/${sessionId}`, { recursive: true })
    const record = { sessionId, startedAt: new Date().toISOString(), keyframeCount: 0 }
    await Deno.writeTextFile(`${SESSIONS_DIR}/${sessionId}/session.json`, JSON.stringify(record, null, 2))
    console.log(`[session] opened ${sessionId}`)
    broadcast({ type: 'session-started', sessionId })
    return c.json(record, 201)
  })

  app.post('/sessions/:id/keyframes', async (c) => {
    const dir = sessionDir(c.req.param('id'))
    if (!dir) return c.json({ error: 'Invalid session id' }, 400)
    try {
      await Deno.stat(dir)
    } catch {
      return c.json({ error: 'Session not found' }, 404)
    }

    const form = await c.req.formData()
    const image = form.get('image')
    const metaRaw = form.get('meta')
    if (!image || !(image instanceof File)) return c.json({ error: 'Missing image field' }, 400)
    if (typeof metaRaw !== 'string') return c.json({ error: 'Missing meta field' }, 400)

    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(metaRaw) as Record<string, unknown>
    } catch {
      return c.json({ error: 'meta is not valid JSON' }, 400)
    }
    const index = Number.isInteger(meta['index']) ? meta['index'] as number : -1
    if (index < 0 || index >= MAX_KEYFRAMES_PER_SESSION) {
      return c.json({ error: `index must be 0…${MAX_KEYFRAMES_PER_SESSION - 1}` }, 400)
    }

    try {
      const bytes = new Uint8Array(await image.arrayBuffer())
      const name = `kf-${String(index).padStart(5, '0')}.jpg`
      await Deno.writeFile(`${dir}/${name}`, bytes)
      await Deno.writeTextFile(
        `${dir}/keyframes.jsonl`,
        JSON.stringify({ ...meta, file: name, bytes: bytes.byteLength, receivedAt: Date.now() }) + '\n',
        { append: true },
      )
      return c.json({ ok: true, index })
    } catch (err) {
      console.error('[session keyframe error]', err)
      return c.json({ error: String(err) }, 500)
    }
  })

  app.post('/sessions/:id/finalize', async (c) => {
    const dir = sessionDir(c.req.param('id'))
    if (!dir) return c.json({ error: 'Invalid session id' }, 400)
    let record: Record<string, unknown>
    try {
      record = JSON.parse(await Deno.readTextFile(`${dir}/session.json`)) as Record<string, unknown>
    } catch {
      return c.json({ error: 'Session not found' }, 404)
    }

    const body = await c.req.json().catch(() => ({})) as {
      glbFilename?: string
      pointCount?: number
      detectionCount?: number
      poseCount?: number
    }

    let keyframeCount = 0
    try {
      const jsonl = await Deno.readTextFile(`${dir}/keyframes.jsonl`)
      keyframeCount = jsonl.split('\n').filter(Boolean).length
    } catch { /* no keyframes uploaded */ }

    const glbFilename = body.glbFilename ? safeScanName(body.glbFilename) : null
    record = {
      ...record,
      keyframeCount,
      finalizedAt: new Date().toISOString(),
      glbFilename,
      pointCount: body.pointCount ?? null,
      detectionCount: body.detectionCount ?? null,
      poseCount: body.poseCount ?? null,
    }
    await Deno.writeTextFile(`${dir}/session.json`, JSON.stringify(record, null, 2))
    console.log(`[session] finalized ${record['sessionId']} — ${keyframeCount} keyframes` +
      (glbFilename ? ` → ${glbFilename}` : ''))

    if (glbFilename?.endsWith('.glb')) {
      try {
        await Deno.stat(`${SCANS_DIR}/${glbFilename}`)
        try {
          await Deno.stat(`${SCANS_DIR}/${glbFilename.replace(/\.glb$/, '.manifest.json')}`)
        } catch {
          jobQueue.enqueue('optimize-scan', glbFilename)
        }
      } catch { /* glb not uploaded yet — upload-scan enqueues on arrival */ }
    }
    broadcast({ type: 'session-finalized', sessionId: record['sessionId'], keyframeCount, glbFilename })
    return c.json(record)
  })

  app.delete('/scans/:filename', async (c) => {
    const filename = safeStorageFilename(c.req.param('filename'), '.glb')
    if (!filename) return c.json({ error: 'Invalid filename' }, 400)

    try {
      const deletedGlb = await removeIfExists(`${SCANS_DIR}/${filename}`)
      const deletedMeta = await removeIfExists(scanMetaPath(filename))
      if (!deletedGlb && !deletedMeta) return c.json({ error: 'Scan not found' }, 404)
      await removeScanFromWorlds(filename)
      return c.json({ ok: true, filename, deleted: { glb: deletedGlb, metadata: deletedMeta } })
    } catch (err) {
      console.error('[scan delete error]', err)
      return c.json({ error: String(err) }, 500)
    }
  })
    poseCount: body.poseCount ?? null,
  }
  await Deno.writeTextFile(`${dir}/session.json`, JSON.stringify(record, null, 2))
  console.log(`[session] finalized ${record['sessionId']} — ${keyframeCount} keyframes` +
    (glbFilename ? ` → ${glbFilename}` : ''))

  if (glbFilename?.endsWith('.glb')) {
    try {
      await Deno.stat(`${SCANS_DIR}/${glbFilename}`)
      // Skip when upload-scan's job already produced a manifest
      try {
        await Deno.stat(`${SCANS_DIR}/${glbFilename.replace(/\.glb$/, '.manifest.json')}`)
      } catch {
        jobQueue.enqueue('optimize-scan', glbFilename)
        return c.json({ error: String(err) }, 500)
      }
    })

    // ── Scan manifest + manual re-optimize ────────────────────────────────────────
    // (Semantic edit persistence lives in the worlds patch system: /worlds/:slug/patches)

    app.get('/scans/:filename/manifest', async (c) => {
      const filename = safeScanName(c.req.param('filename'))
      if (!filename || !filename.endsWith('.glb')) return c.json({ error: 'Invalid filename' }, 400)
      try {
        const raw = await Deno.readTextFile(`${SCANS_DIR}/${filename.replace(/\.glb$/, '.manifest.json')}`)
        return c.json(JSON.parse(raw))
      } catch {
        return c.json({ error: 'No manifest — scan not optimized yet' }, 404)
      }
    })

    app.post('/scans/:filename/optimize', async (c) => {
      const filename = safeScanName(c.req.param('filename'))
      if (!filename || !filename.endsWith('.glb') || isDerivedScanFile(filename)) {
        return c.json({ error: 'Invalid filename' }, 400)
      }
      try {
        await Deno.stat(`${SCANS_DIR}/${filename}`)
      } catch {
        return c.json({ error: 'Scan not found' }, 404)
      }
      const job = jobQueue.enqueue('optimize-scan', filename)
      return c.json(job, 202)
    })

    // ── Job queue state ───────────────────────────────────────────────────────────

    app.get('/jobs', (c) => c.json([...jobQueue.jobs].reverse()))

    app.get('/jobs/:id', (c) => {
      const job = jobQueue.job(c.req.param('id'))
      return job ? c.json(job) : c.json({ error: 'Not found' }, 404)
    })

    app.delete('/scans', async (c) => {
      const confirm = c.req.query('confirm')
      if (confirm !== 'delete-all') {
        return c.json({ error: 'Add ?confirm=delete-all to clear scan storage' }, 400)
      }

      let deleted = 0
      try {
        for await (const entry of Deno.readDir(SCANS_DIR)) {
          if (!entry.isFile) continue
          if (!entry.name.endsWith('.glb') && !entry.name.endsWith('.json')) continue
          if (await removeIfExists(`${SCANS_DIR}/${entry.name}`)) deleted += 1
        }
        await removeAllScansFromWorlds()
        return c.json({ ok: true, deleted })
      } catch (err) {
        console.error('[scans clear error]', err)
        return c.json({ error: String(err) }, 500)
      }
    })

    // ── Capture sessions — streaming keyframe ingestion ──────────────────────────
    //
    // The phone opens a session when scanning starts and streams pose-tagged
    // keyframes (JPEG + JSON meta) while the user walks the room.  Frames land in
    //   scans/sessions/<id>/kf-NNNNN.jpg        image
    //   scans/sessions/<id>/keyframes.jsonl     one meta record per frame
    // On finalize the session is linked to the exported .glb.  This is the raw
    // input a dense-reconstruction stage (photogrammetry / splats) consumes.

    const SESSION_ID_RE = /^sess-[a-z0-9-]+$/

    function sessionDir(id: string): string | null {
      return SESSION_ID_RE.test(id) ? `${SESSIONS_DIR}/${id}` : null
    }

    app.post('/sessions', async (c) => {
      const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await Deno.mkdir(`${SESSIONS_DIR}/${sessionId}`, { recursive: true })
      const record = { sessionId, startedAt: new Date().toISOString(), keyframeCount: 0 }
      await Deno.writeTextFile(`${SESSIONS_DIR}/${sessionId}/session.json`, JSON.stringify(record, null, 2))
      console.log(`[session] opened ${sessionId}`)
      broadcast({ type: 'session-started', sessionId })
      return c.json(record, 201)
    })

    app.post('/sessions/:id/keyframes', async (c) => {
      const dir = sessionDir(c.req.param('id'))
      if (!dir) return c.json({ error: 'Invalid session id' }, 400)
      try {
        await Deno.stat(dir)
      } catch {
        return c.json({ error: 'Session not found' }, 404)
      }

      const form = await c.req.formData()
      const image = form.get('image')
      const metaRaw = form.get('meta')
      if (!image || !(image instanceof File)) return c.json({ error: 'Missing image field' }, 400)
      if (typeof metaRaw !== 'string') return c.json({ error: 'Missing meta field' }, 400)

      let meta: Record<string, unknown>
      try {
        meta = JSON.parse(metaRaw) as Record<string, unknown>
      } catch {
        return c.json({ error: 'meta is not valid JSON' }, 400)
      }
      const index = Number.isInteger(meta['index']) ? meta['index'] as number : -1
      if (index < 0 || index >= MAX_KEYFRAMES_PER_SESSION) {
        return c.json({ error: `index must be 0…${MAX_KEYFRAMES_PER_SESSION - 1}` }, 400)
      }

      try {
        const bytes = new Uint8Array(await image.arrayBuffer())
        const name = `kf-${String(index).padStart(5, '0')}.jpg`
        await Deno.writeFile(`${dir}/${name}`, bytes)
        await Deno.writeTextFile(
          `${dir}/keyframes.jsonl`,
          JSON.stringify({ ...meta, file: name, bytes: bytes.byteLength, receivedAt: Date.now() }) + '\n',
          { append: true },
        )
        return c.json({ ok: true, index })
      } catch (err) {
        console.error('[session keyframe error]', err)
        return c.json({ error: String(err) }, 500)
      }
    })

    app.post('/sessions/:id/finalize', async (c) => {
      const dir = sessionDir(c.req.param('id'))
      if (!dir) return c.json({ error: 'Invalid session id' }, 400)
      let record: Record<string, unknown>
      try {
        record = JSON.parse(await Deno.readTextFile(`${dir}/session.json`)) as Record<string, unknown>
      } catch {
        return c.json({ error: 'Session not found' }, 404)
      }

      const body = await c.req.json().catch(() => ({})) as {
        glbFilename?: string
        pointCount?: number
        detectionCount?: number
        poseCount?: number
      }

      let keyframeCount = 0
      try {
        const jsonl = await Deno.readTextFile(`${dir}/keyframes.jsonl`)
        keyframeCount = jsonl.split('\n').filter(Boolean).length
      } catch { /* no keyframes uploaded */ }

      const glbFilename = body.glbFilename ? safeScanName(body.glbFilename) : null
      record = {
        ...record,
        keyframeCount,
        finalizedAt: new Date().toISOString(),
        glbFilename,
        pointCount: body.pointCount ?? null,
        detectionCount: body.detectionCount ?? null,
        poseCount: body.poseCount ?? null,
      }
      await Deno.writeTextFile(`${dir}/session.json`, JSON.stringify(record, null, 2))
      console.log(`[session] finalized ${record['sessionId']} — ${keyframeCount} keyframes` +
        (glbFilename ? ` → ${glbFilename}` : ''))

      if (glbFilename?.endsWith('.glb')) {
        try {
          await Deno.stat(`${SCANS_DIR}/${glbFilename}`)
          // Skip when upload-scan's job already produced a manifest
          try {
            await Deno.stat(`${SCANS_DIR}/${glbFilename.replace(/\.glb$/, '.manifest.json')}`)
          } catch {
            jobQueue.enqueue('optimize-scan', glbFilename)
          }
        } catch { /* glb not uploaded yet — upload-scan enqueues on arrival */ }
      }
      broadcast({ type: 'session-finalized', sessionId: record['sessionId'], keyframeCount, glbFilename })
      return c.json(record)
    })

    app.get('/sessions/:id', async (c) => {
      const dir = sessionDir(c.req.param('id'))
      if (!dir) return c.json({ error: 'Invalid session id' }, 400)
      try {
        return c.json(JSON.parse(await Deno.readTextFile(`${dir}/session.json`)))
      } catch {
        return c.json({ error: 'Session not found' }, 404)
      }
    })

    app.get('/sessions', async (c) => {
      const sessions: unknown[] = []
      try {
        for await (const entry of Deno.readDir(SESSIONS_DIR)) {
          if (!entry.isDirectory) continue
          try {
            sessions.push(JSON.parse(await Deno.readTextFile(`${SESSIONS_DIR}/${entry.name}/session.json`)))
          } catch { /* incomplete session dir */ }
        }
      } catch { /* sessions dir missing */ }
      return c.json(sessions)
    })

      filename: entry.name,
      size: stat.size,
      uploadedAt: (stat.mtime ?? new Date()).toISOString(),
      meta: await readScanMeta(entry.name),
    })
  }
  scans.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
  return scans
}

function shouldIncludeInWorld(scan: StoredScanInfo): boolean {
  const geo = geoPoseFromMeta(scan.meta)
  return scan.size > 512 || hasGeoPose(geo)
}

function inferWorldOrigin(scans: StoredScanInfo[]): GeoPose {
  for (const scan of scans) {
    const geo = geoPoseFromMeta(scan.meta)
    if (hasGeoPose(geo)) return geo
  }
  return { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
}

function scanIdFor(filename: string, meta: Record<string, unknown>): string {
  const sessionId = asString(meta['sessionId'])
  if (sessionId) return `scan-${safeSlug(sessionId)}`
  return `scan-${safeSlug(filename.replace(/\.glb$/, ''))}`
}

function scanNameFor(filename: string, meta: Record<string, unknown>): string {
  return asString(meta['scanName']) ?? filename.replace(/^\d+_/, '').replace(/\.glb$/, '')
}

function scanManifestFromStored(
  scan: StoredScanInfo,
  origin: GeoPose,
  index: number,
): ScanManifest {
  const geoPose = geoPoseFromMeta(scan.meta)
  const translation = hasGeoPose(origin) && hasGeoPose(geoPose)
    ? geoToEnu(origin, geoPose)
    : { x: (index % 6) * 3, y: 0, z: Math.floor(index / 6) * 3 }
  const localToWorld = composeYUpTransform(translation, geoPose.bearing, 1)

  return {
    scanId: scanIdFor(scan.filename, scan.meta),
    sessionId: asString(scan.meta['sessionId']),
    filename: scan.filename,
    name: scanNameFor(scan.filename, scan.meta),
    glbUrl: `/scans/${encodeURIComponent(scan.filename)}`,
    metadataUrl: `/scans/${encodeURIComponent(scan.filename.replace(/\.glb$/, '.json'))}`,
    geoPose,
    localToWorld,
    accuracyM: geoPose.accuracyM,
    capturedAt: asString(scan.meta['capturedAt']) ?? asString(scan.meta['exportedAt']) ?? scan.uploadedAt,
    pointCount: asNumber(scan.meta['pointCount']),
    detectionCount: asNumber(scan.meta['detectionCount']),
    layerIndex: defaultLayerIndex(scan.meta),
    frameSetUrl: `/worlds/default/frames/${encodeURIComponent(scanIdFor(scan.filename, scan.meta))}`,
    status: 'ready',
  }
}

function createWorldMembers(): WorldMember[] {
  const now = new Date().toISOString()
  return (['owner', 'editor', 'viewer', 'scanner'] as const).map((role) => ({
    memberId: `${role}-${crypto.randomUUID()}`,
    role,
    token: `${role}-${crypto.randomUUID()}`,
    createdAt: now,
    expiresAt: null,
  }))
}

async function saveWorld(world: WorldProject): Promise<void> {
  world.updatedAt = new Date().toISOString()
  const tmp = `${worldPath(world.shareSlug)}.${crypto.randomUUID()}.tmp`
  await Deno.writeTextFile(tmp, JSON.stringify(world, null, 2))
  await Deno.rename(tmp, worldPath(world.shareSlug))
}

async function mutateWorldFiles(mutator: (world: WorldProject) => boolean | Promise<boolean>): Promise<number> {
  let updated = 0
  try {
    for await (const entry of Deno.readDir(WORLDS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue
      try {
        const world = JSON.parse(await Deno.readTextFile(`${WORLDS_DIR}/${entry.name}`)) as WorldProject
        if (await mutator(world)) {
          await saveWorld(world)
          updated += 1
        }
      } catch (error) {
        console.warn(`[world] Could not mutate ${entry.name}:`, error)
      }
    }
  } catch { /* worlds directory may be empty */ }
  return updated
}

async function removeScanFromWorlds(filename: string): Promise<number> {
  return mutateWorldFiles((world) => {
    const beforeScans = world.scans.length
    world.scans = world.scans.filter(scan => scan.filename !== filename)
    world.editPatches = world.editPatches.filter(patch => patch.targetId !== filename && patch.scanId !== filename)
    world.jobs = world.jobs.filter(job => {
      if (!job.scanId) return true
      return world.scans.some(scan => scan.scanId === job.scanId)
    })
    return world.scans.length !== beforeScans
  })
}

async function removeAllScansFromWorlds(): Promise<number> {
  return mutateWorldFiles((world) => {
    const hadScans = world.scans.length > 0
    world.scans = []
    world.editPatches = world.editPatches.filter(patch => patch.scope === 'world')
    world.jobs = world.jobs.filter(job => !job.scanId)
    world.originGeoPose = { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }
    world.localFrame.origin = world.originGeoPose
    return hadScans
  })
}

async function synthesizeWorld(slug: string): Promise<WorldProject> {
  const stored = await listStoredScans()
  const included = stored.filter(shouldIncludeInWorld).slice(0, 24)
  const source = included.length > 0 ? included : stored.slice(0, 8)
  const originGeoPose = inferWorldOrigin(source)
  const now = new Date().toISOString()
  const world: WorldProject = {
    worldId: `world-${safeSlug(slug)}`,
    name: slug === 'default' ? 'Default World Scan' : slug.replace(/-/g, ' '),
    shareSlug: safeSlug(slug),
    originGeoPose,
    localFrame: {
      type: 'ENU_Y_UP',
      origin: originGeoPose,
      units: 'meters',
      axes: { x: 'east', y: 'up', z: 'north' },
    },
    scans: source.map((scan, i) => scanManifestFromStored(scan, originGeoPose, i)),
    members: createWorldMembers(),
    jobs: [],
    editPatches: [],
    createdAt: now,
    updatedAt: now,
  }
  await saveWorld(world)
  return world
}

async function loadWorld(slug: string): Promise<WorldProject> {
  const safe = safeSlug(slug)
  try {
    const world = JSON.parse(await Deno.readTextFile(worldPath(safe))) as WorldProject
    await refreshWorldScans(world)
    return world
  } catch {
    return synthesizeWorld(safe)
  }
}

async function refreshWorldScans(world: WorldProject): Promise<void> {
  const stored = await listStoredScans()
  const storedFilenames = new Set(stored.map(scan => scan.filename))
  const beforeCount = world.scans.length
  world.scans = world.scans.filter(scan => scan.filename ? storedFilenames.has(scan.filename) : true)

  const existing = new Set(world.scans.map(scan => scan.filename))
  const additions = stored
    .filter(shouldIncludeInWorld)
    .filter(scan => !existing.has(scan.filename))
    .slice(0, 12)
  if (additions.length === 0 && world.scans.length === beforeCount) return

  const origin = world.originGeoPose
  const nextIndex = world.scans.length
  world.scans.push(...additions.map((scan, i) => scanManifestFromStored(scan, origin, nextIndex + i)))
  await saveWorld(world)
}

function clientBaseUrl(c: { req: { url: string; header: (name: string) => string | undefined } }): string {
  const origin = c.req.header('origin')
  if (origin && isAllowedOrigin(origin)) return origin

  const forwardedHost = c.req.header('x-forwarded-host')
  if (forwardedHost) {
    const forwardedProto = c.req.header('x-forwarded-proto') ?? 'https'
    return `${forwardedProto}://${forwardedHost}`
  }

  const url = new URL(c.req.url)
  if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === String(PORT)) {
    return viteBaseUrlFromEnv()
  }
  return `${url.protocol}//${url.host}`
}

function viteBaseUrlFromEnv(): string {
  try {
    const url = new URL(ALLOWED_ORIGIN_PREFIX)
    if (!url.port) url.port = '5173'
    return url.toString().replace(/\/$/, '')
  } catch {
    return 'https://liambook.capybara-ulmer.ts.net:5173'
  }
}

function shareLinks(c: { req: { url: string; header: (name: string) => string | undefined } }, world: WorldProject): Record<string, string> {
  const base = clientBaseUrl(c)
  const byRole = new Map(world.members.filter(m => !m.revokedAt).map(m => [m.role, m.token]))
  return {
    owner: `${base}/viewer.html?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('owner') ?? '')}`,
    editor: `${base}/viewer.html?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('editor') ?? '')}`,
    viewer: `${base}/viewer.html?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('viewer') ?? '')}`,
    scanner: `${base}/scanner.html?world=${world.shareSlug}&token=${encodeURIComponent(byRole.get('scanner') ?? '')}`,
  }
}

function objectKey(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function applyPatchToWorld(world: WorldProject, patch: EditPatch): void {
  if (patch.scope === 'scan' && patch.scanId && patch.transform?.matrix) {
    const scan = world.scans.find(s => s.scanId === patch.scanId || s.filename === patch.targetId)
    if (scan) scan.localToWorld = patch.transform.matrix
  }
}

function createWorldJob(world: WorldProject, type: WorldJobType, scanId?: string, payload?: Record<string, unknown>): WorldJob {
  const now = new Date().toISOString()
  return {
    jobId: `job-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    worldId: world.worldId,
    type,
    status: 'queued',
    scanId,
    capabilities: DEFAULT_WORKER_CAPABILITIES,
    payload,
    createdAt: now,
    updatedAt: now,
  }
}

async function enqueueLegacyProcessJob(action: string, filename: string): Promise<string | null> {
  const mapping: Record<string, WorldJobType> = {
    'object-count': 'semantic-pass',
    'scene-description': 'semantic-pass',
    'floor-plan': 'extract-layers',
    'mesh-cleanup': 'merge-points',
    'room-segment': 'align-scan',
  }
  const type = mapping[action]
  if (!type) return null
  const world = await loadWorld('default')
  const scan = world.scans.find(s => s.filename === filename)
  const job = createWorldJob(world, type, scan?.scanId, { legacyAction: action, filename })
  world.jobs.unshift(job)
  await saveWorld(world)
  await completeJobSoon(world.shareSlug, job.jobId)
  return job.jobId
}

async function completeJobSoon(slug: string, jobId: string): Promise<void> {
  setTimeout(async () => {
    try {
      const world = await loadWorld(slug)
      const job = world.jobs.find(j => j.jobId === jobId)
      if (!job || job.status !== 'queued') return
      job.status = 'processing'
      job.workerId = 'local-coordinator'
      job.updatedAt = new Date().toISOString()
      await saveWorld(world)
      setTimeout(async () => {
        try {
          const current = await loadWorld(slug)
          const currentJob = current.jobs.find(j => j.jobId === jobId)
          if (!currentJob || currentJob.status === 'failed') return
          currentJob.status = 'completed'
          currentJob.result = jobResultFor(currentJob)
          currentJob.updatedAt = new Date().toISOString()
          await saveWorld(current)
        } catch (err) {
          console.error('[world-job complete error]', err)
        }
      }, 650)
    } catch (err) {
      console.error('[world-job start error]', err)
    }
  }, 25)
}

function jobResultFor(job: WorldJob): string {
  switch (job.type) {
    case 'ingest':
      return 'Scan ingest indexed GLB metadata and sidecar manifest.'
    case 'extract-layers':
      return 'Layer index extracted from GLB extras and scene graph conventions.'
    case 'align-scan':
      return 'Hybrid alignment queued: GPS/compass seed, manual transform patch, CV refinement placeholder.'
    case 'merge-points':
      return 'Point merge placeholder completed; Open3D worker can replace this local result.'
    case 'semantic-pass':
      return 'Semantic model pass placeholder completed; Grounding DINO/SAM 2 worker can replace this result.'
    case 'depth-reconstruct':
      return 'Depth reconstruction placeholder completed; Depth Anything/WebXR depth artifacts attach here.'
    case 'splat-train':
      return 'Splat training placeholder completed; gsplat/Graphdeco artifacts attach as splat layers.'
    case 'export-world':
      return 'World export placeholder completed; combined GLB/semantic JSON export can be generated here.'
  }
}

app.get('/worlds', async (c) => {
  const worlds: WorldProject[] = []
  try {
    for await (const entry of Deno.readDir(WORLDS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue
      try {
        worlds.push(JSON.parse(await Deno.readTextFile(`${WORLDS_DIR}/${entry.name}`)) as WorldProject)
      } catch { /* ignore one broken world */ }
    }
  } catch { /* directory may not exist yet */ }
  if (worlds.length === 0) worlds.push(await loadWorld('default'))
  worlds.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return c.json(worlds.map(w => ({
    worldId: w.worldId,
    name: w.name,
    shareSlug: w.shareSlug,
    scanCount: w.scans.length,
    jobCount: w.jobs.length,
    updatedAt: w.updatedAt,
  })))
})

app.post('/worlds', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { name?: string; shareSlug?: string }
  const slug = safeSlug(body.shareSlug ?? body.name ?? `world-${Date.now()}`)
  const existingPath = worldPath(slug)
  try {
    await Deno.stat(existingPath)
    return c.json({ error: 'World already exists', shareSlug: slug }, 409)
  } catch { /* create */ }
  const world = await synthesizeWorld(slug)
  if (body.name?.trim()) {
    world.name = body.name.trim()
    await saveWorld(world)
  }
  return c.json(world, 201)
})

app.get('/worlds/:slug', async (c) => {
  const slug = c.req.param('slug')
  return c.json(await loadWorld(slug))
})

app.get('/worlds/:slug/share', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  return c.json({ worldId: world.worldId, shareSlug: world.shareSlug, links: shareLinks(c, world) })
})

app.get('/worlds/:slug/patches', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  return c.json(world.editPatches)
})

app.post('/worlds/:slug/patches', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  const body = await c.req.json().catch(() => ({})) as Partial<EditPatch>
  const targetId = objectKey(body.targetId)
  if (!targetId) return c.json({ error: 'targetId is required' }, 400)
  const scope = body.scope ?? 'object'
  if (!['scan', 'object', 'point-selection', 'layer', 'world'].includes(scope)) {
    return c.json({ error: 'Invalid patch scope' }, 400)
  }
  const patch: EditPatch = {
    patchId: `patch-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    worldId: world.worldId,
    scanId: objectKey(body.scanId) ?? undefined,
    targetId,
    scope,
    transform: body.transform,
    label: objectKey(body.label) ?? undefined,
    category: objectKey(body.category) ?? undefined,
    notes: objectKey(body.notes) ?? undefined,
    visible: typeof body.visible === 'boolean' ? body.visible : undefined,
    actorId: objectKey(body.actorId) ?? 'local-editor',
    createdAt: new Date().toISOString(),
  }
  world.editPatches.push(patch)
  applyPatchToWorld(world, patch)
  await saveWorld(world)
  return c.json({ ok: true, patch, world })
})

app.get('/worlds/:slug/jobs', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  return c.json(world.jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
})

app.post('/worlds/:slug/jobs', async (c) => {
  const slug = c.req.param('slug')
  const world = await loadWorld(slug)
  const body = await c.req.json().catch(() => ({})) as {
    type?: WorldJobType
    scanId?: string
    payload?: Record<string, unknown>
  }
  const type = body.type
  if (!type || !WORLD_JOB_TYPES.has(type)) {
    return c.json({ error: `type must be one of ${[...WORLD_JOB_TYPES].join(', ')}` }, 400)
  }
  const job = createWorldJob(world, type, body.scanId, body.payload)
  world.jobs.unshift(job)
  await saveWorld(world)
  await completeJobSoon(slug, job.jobId)
  return c.json(job, 202)
})

app.get('/worlds/:slug/frames/:scanId', async (c) => {
  const world = await loadWorld(c.req.param('slug'))
  const scan = world.scans.find(s => s.scanId === c.req.param('scanId'))
  if (!scan) return c.json({ error: 'Scan not found' }, 404)
  return c.json({ scanId: scan.scanId, frames: [] })
})

app.post('/upload-summary', async (c) => {
  console.log('[server] /upload-summary route triggered')
  const form = await c.req.formData()
  const file = form.get('file')
  if (!file || !(file instanceof File)) {
    console.warn('[server] /upload-summary: Missing file field')
    return c.json({ error: 'Missing file field (expected .md)' }, 400)
  }
  const rawName = (file.name || 'summary')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.\./g, '__')
    .replace(/^[._-]+/, '')
  const safeName = rawName.endsWith('.md') ? rawName : `${rawName}.md`
  const filename = `${Date.now()}_${safeName}`
  try {
    const text = await file.text()
    await Deno.writeTextFile(`${SUMMARIES_DIR}/${filename}`, text)
    console.log(`[summary] Saved ${filename}`)
    return c.json({ filename })
  } catch (err) {
    console.error('[summary upload error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

// ── Scan processing ───────────────────────────────────────────────────────────

async function findFilenameBySessionId(sessionId: string): Promise<string | null> {
  if (!sessionId) return null
  try {
    for await (const entry of Deno.readDir(SCANS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue
      try {
        const raw = await Deno.readTextFile(`${SCANS_DIR}/${entry.name}`)
        const meta = JSON.parse(raw) as Record<string, unknown>
        if (meta['sessionId'] === sessionId) {
          return entry.name.replace(/\.json$/, '.glb')
        }
      } catch { /* ignore parse error for single file */ }
    }
  } catch (err) {
    console.error('[server] Error scanning directory for sessionId:', err)
  }
  return null
}

app.post('/process-scan', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    filename?: string
    action?: string
    sessionId?: string
  }
  const { filename = '', action = '', sessionId = '' } = body

  if (!action) return c.json({ error: 'Missing action' }, 400)

  let targetFilename = filename
  if (!targetFilename && sessionId) {
    const found = await findFilenameBySessionId(sessionId)
    if (found) {
      targetFilename = found
      console.log(`[process] Found target file by sessionId="${sessionId}": ${targetFilename}`)
    }
  }

  if (!targetFilename) {
    // Fallback: use the newest scan in the directory
    try {
      const scans: Array<{ name: string; mtime: number }> = []
      for await (const entry of Deno.readDir(SCANS_DIR)) {
        if (!entry.isFile || !entry.name.endsWith('.glb')) continue
        const stat = await Deno.stat(`${SCANS_DIR}/${entry.name}`)
        scans.push({ name: entry.name, mtime: (stat.mtime ?? new Date()).getTime() })
      }
      scans.sort((a, b) => b.mtime - a.mtime)
      if (scans.length > 0) {
        targetFilename = scans[0].name
        console.log(`[process] No filename or sessionId match found. Using newest scan globally: ${targetFilename}`)
      }
    } catch { /* ignore */ }
  }

  if (!targetFilename) {
    console.warn(`[process] Rejecting process-scan: No files available for action="${action}"`)
    return c.json({ error: 'No scans available on server. Please export a scan first.' }, 400)
  }

  // Prevent path traversal
  const safeName = targetFilename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const metaPath = `${SCANS_DIR}/${safeName}`.replace(/\.glb$/, '.json')

  // Read stored metadata (.json companion file saved alongside .glb)
  let meta: Record<string, unknown> = {}
  try {
    const raw = await Deno.readTextFile(metaPath)
    meta = JSON.parse(raw) as Record<string, unknown>
  } catch { /* no metadata file — use empty object */ }

  const labels = (meta['labels'] as string[] | undefined) ?? []
  const detCount = (meta['detectionCount'] as number | undefined) ?? labels.length

  let result = ''

  switch (action) {
    case 'object-count': {
      const freq = new Map<string, number>()
      for (const lbl of labels) freq.set(lbl, (freq.get(lbl) ?? 0) + 1)
      const rows = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([lbl, n]) => `  • ${lbl}: ${n}`)
        .join('\n')
      result = detCount > 0
        ? `Found ${detCount} object${detCount === 1 ? '' : 's'}:\n${rows}`
        : 'No objects detected in this scan.'
      break
    }

    case 'scene-description': {
      if (labels.length === 0) {
        result = 'No detected objects. Scan appears empty or was not processed with inference enabled.'
      } else {
        const unique = [...new Set(labels.map(l => l.toLowerCase()))]
        const listStr = unique.slice(0, -1).join(', ') + (unique.length > 1 ? `, and ${unique.at(-1)}` : unique[0])
        result = `This room scan contains ${detCount} detected object${detCount === 1 ? '' : 's'}, including: ${listStr}.\n\nScanned session: ${sessionId || filename || '(unknown)'}.\nExported: ${new Date((meta['exportedAt'] as string | undefined) ?? Date.now()).toLocaleString()}.`
      }
      break
    }

    case 'floor-plan': {
      // Generate a simple ASCII floor plan from detection positions in metadata.
      // For a richer plan the client should pass bounding-box data.
      if (labels.length === 0) {
        result = 'No object positions available for floor-plan generation. Export a scan with detections first.'
      } else {
        const unique = [...new Set(labels)]
        result = `Floor Plan — ${unique.length} object type${unique.length === 1 ? '' : 's'} detected:\n\n`
        result += unique.map((l, i) => `  [${i + 1}] ${l}`).join('\n')
        result += '\n\nNote: Upload a scan with world-position metadata for a spatial floor plan SVG.'
      }
      break
    }

    case 'mesh-cleanup':
      result = `Mesh Cleanup Recommendations:\n\n  • Remove isolated point clusters (< 50 points)\n  • Voxel downsample to 3 cm resolution for file-size reduction\n  • Smooth SLAM feature noise with a 5-pass Laplacian filter\n  • Fill floor-plane gaps using alpha-shape reconstruction\n\nApply these steps server-side with Open3D or CloudCompare, or export the .glb to Blender's "Mesh > Clean Up" tools.`
      break

    case 'room-segment':
      result = `Room Segmentation Suggestions:\n\n  • Dominant floor region detected — single contiguous room likely.\n  • For multi-room isolation: cluster SLAM points by elevation band, then apply 2D connected-component labelling on the XZ projection.\n  • Doorway detection: look for gaps (< 1 m) in vertical SLAM density at floor level.\n\nTip: scan each room separately for best per-room GLB accuracy.`
      break

    default:
      result = `Unknown action: "${action}". Supported actions: object-count, scene-description, floor-plan, mesh-cleanup, room-segment.`
  }

  console.log(`[process] action=${action} file=${filename}`)
  const jobId = await enqueueLegacyProcessJob(action, targetFilename).catch((err) => {
    console.error('[process] queue bridge failed:', err)
    return null
  })
  return c.json({ action, result, jobId, processedAt: new Date().toISOString() })
})

// ── Project management (in-memory, persisted to projects.json) ────────────────

interface ProjectRecord {
  projectId: string
  name: string
  address?: string
  notes?: string
  createdAt: number
  updatedAt: number
  floors: unknown[]
}

app.delete('/scans/:filename', async (c) => {
  const filename = safeStorageFilename(c.req.param('filename'), '.glb')
  if (!filename) return c.json({ error: 'Invalid filename' }, 400)

  try {
    const deletedGlb = await removeIfExists(`${SCANS_DIR}/${filename}`)
    const deletedMeta = await removeIfExists(scanMetaPath(filename))
    if (!deletedGlb && !deletedMeta) return c.json({ error: 'Scan not found' }, 404)
    await removeScanFromWorlds(filename)
    return c.json({ ok: true, filename, deleted: { glb: deletedGlb, metadata: deletedMeta } })
  } catch (err) {
    console.error('[scan delete error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

app.delete('/scans', async (c) => {
  const confirm = c.req.query('confirm')
  if (confirm !== 'delete-all') {
    return c.json({ error: 'Add ?confirm=delete-all to clear scan storage' }, 400)
  }

  let deleted = 0
  try {
    for await (const entry of Deno.readDir(SCANS_DIR)) {
      if (!entry.isFile) continue
      if (!entry.name.endsWith('.glb') && !entry.name.endsWith('.json')) continue
      if (await removeIfExists(`${SCANS_DIR}/${entry.name}`)) deleted += 1
    }
    await removeAllScansFromWorlds()
    return c.json({ ok: true, deleted })
  } catch (err) {
    console.error('[scans clear error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

app.get('/scans/:filename/manifest', async (c) => {
  const filename = safeScanName(c.req.param('filename'))
  if (!filename || !filename.endsWith('.glb')) return c.json({ error: 'Invalid filename' }, 400)
  try {
    const raw = await Deno.readTextFile(`${SCANS_DIR}/${filename.replace(/\.glb$/, '.manifest.json')}`)
    return c.json(JSON.parse(raw))
  } catch {
    return c.json({ error: 'No manifest — scan not optimized yet' }, 404)
  }
})

app.post('/scans/:filename/optimize', async (c) => {
  const filename = safeScanName(c.req.param('filename'))
  if (!filename || !filename.endsWith('.glb') || isDerivedScanFile(filename)) {
    return c.json({ error: 'Invalid filename' }, 400)
  }
  try {
    await Deno.stat(`${SCANS_DIR}/${filename}`)
  } catch {
    return c.json({ error: 'Scan not found' }, 404)
  }
  const job = jobQueue.enqueue('optimize-scan', filename)
  return c.json(job, 202)
})

app.get('/jobs', (c) => c.json([...jobQueue.jobs].reverse()))

app.get('/jobs/:id', (c) => {
  const job = jobQueue.job(c.req.param('id'))
  return job ? c.json(job) : c.json({ error: 'Not found' }, 404)
})

app.post('/sessions', async (c) => {
  const sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await Deno.mkdir(`${SESSIONS_DIR}/${sessionId}`, { recursive: true })
  const record = { sessionId, startedAt: new Date().toISOString(), keyframeCount: 0 }
  await Deno.writeTextFile(`${SESSIONS_DIR}/${sessionId}/session.json`, JSON.stringify(record, null, 2))
  console.log(`[session] opened ${sessionId}`)
  broadcast({ type: 'session-started', sessionId })
  return c.json(record, 201)
})

app.post('/sessions/:id/keyframes', async (c) => {
  const dir = sessionDir(c.req.param('id'))
  if (!dir) return c.json({ error: 'Invalid session id' }, 400)
  try {
    await Deno.stat(dir)
  } catch {
    return c.json({ error: 'Session not found' }, 404)
  }

  const form = await c.req.formData()
  const image = form.get('image')
  const metaRaw = form.get('meta')
  if (!image || !(image instanceof File)) return c.json({ error: 'Missing image field' }, 400)
  if (typeof metaRaw !== 'string') return c.json({ error: 'Missing meta field' }, 400)

  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(metaRaw) as Record<string, unknown>
  } catch {
    return c.json({ error: 'meta is not valid JSON' }, 400)
  }
  const index = Number.isInteger(meta['index']) ? meta['index'] as number : -1
  if (index < 0 || index >= MAX_KEYFRAMES_PER_SESSION) {
    return c.json({ error: `index must be 0…${MAX_KEYFRAMES_PER_SESSION - 1}` }, 400)
  }

  try {
    const bytes = new Uint8Array(await image.arrayBuffer())
    const name = `kf-${String(index).padStart(5, '0')}.jpg`
    await Deno.writeFile(`${dir}/${name}`, bytes)
    await Deno.writeTextFile(
      `${dir}/keyframes.jsonl`,
      JSON.stringify({ ...meta, file: name, bytes: bytes.byteLength, receivedAt: Date.now() }) + '\n',
      { append: true },
    )
    return c.json({ ok: true, index })
  } catch (err) {
    console.error('[session keyframe error]', err)
    return c.json({ error: String(err) }, 500)
  }
})

app.post('/sessions/:id/finalize', async (c) => {
  const dir = sessionDir(c.req.param('id'))
  if (!dir) return c.json({ error: 'Invalid session id' }, 400)
  let record: Record<string, unknown>
  try {
    record = JSON.parse(await Deno.readTextFile(`${dir}/session.json`)) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Session not found' }, 404)
  }

  const body = await c.req.json().catch(() => ({})) as {
    glbFilename?: string
    pointCount?: number
    detectionCount?: number
    poseCount?: number
  }

  let keyframeCount = 0
  try {
    const jsonl = await Deno.readTextFile(`${dir}/keyframes.jsonl`)
    keyframeCount = jsonl.split('\n').filter(Boolean).length
  } catch { /* no keyframes uploaded */ }

  const glbFilename = body.glbFilename ? safeScanName(body.glbFilename) : null
  record = {
    ...record,
    keyframeCount,
    finalizedAt: new Date().toISOString(),
    glbFilename,
    pointCount: body.pointCount ?? null,
    detectionCount: body.detectionCount ?? null,
    poseCount: body.poseCount ?? null,
  }
  await Deno.writeTextFile(`${dir}/session.json`, JSON.stringify(record, null, 2))
  console.log(`[session] finalized ${record['sessionId']} — ${keyframeCount} keyframes` +
    (glbFilename ? ` → ${glbFilename}` : ''))

  if (glbFilename?.endsWith('.glb')) {
    try {
      await Deno.stat(`${SCANS_DIR}/${glbFilename}`)
      try {
        await Deno.stat(`${SCANS_DIR}/${glbFilename.replace(/\.glb$/, '.manifest.json')}`)
      } catch {
        jobQueue.enqueue('optimize-scan', glbFilename)
      }
    } catch { /* glb not uploaded yet — upload-scan enqueues on arrival */ }
  }
  broadcast({ type: 'session-finalized', sessionId: record['sessionId'], keyframeCount, glbFilename })
  return c.json(record)
})

app.get('/sessions/:id', async (c) => {
  const dir = sessionDir(c.req.param('id'))
  if (!dir) return c.json({ error: 'Invalid session id' }, 400)
  try {
    return c.json(JSON.parse(await Deno.readTextFile(`${dir}/session.json`)))
  } catch {
    return c.json({ error: 'Session not found' }, 404)
  }
})

app.get('/sessions', async (c) => {
  const sessions: unknown[] = []
  try {
    for await (const entry of Deno.readDir(SESSIONS_DIR)) {
      if (!entry.isDirectory) continue
      try {
        sessions.push(JSON.parse(await Deno.readTextFile(`${SESSIONS_DIR}/${entry.name}/session.json`)))
      } catch { /* incomplete session dir */ }
    }
  } catch { /* sessions dir missing */ }
  return c.json(sessions)
})
