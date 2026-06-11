/**
 * Project management API tests — exercises the Deno/Hono server's
 * /projects and /process-scan endpoints via the Vite dev server proxy.
 *
 * Run:
 *   npx playwright test tests/project.spec.ts
 */
import { test, expect } from '@playwright/test'

const BASE = process.env['VITE_URL'] ?? 'https://liambook.capybara-ulmer.ts.net:5173'

// ── /projects ─────────────────────────────────────────────────────────────────

test.describe('GET /projects', () => {
  test('returns 200 with JSON array', async ({ request }) => {
    const resp = await request.get(`${BASE}/projects`)
    expect(resp.status()).toBe(200)
    const body = await resp.json() as unknown[]
    expect(Array.isArray(body)).toBeTruthy()
  })

  test('CORS header present', async ({ request }) => {
    const resp = await request.get(`${BASE}/projects`)
    expect(resp.headers()['access-control-allow-origin']).toBeTruthy()
  })
})

test.describe('POST /projects', () => {
  test('creates project with name, address, notes', async ({ request }) => {
    const resp = await request.post(`${BASE}/projects`, {
      data: { name: 'Test Building', address: '1 Test St', notes: 'Playwright test' },
    })
    expect(resp.status()).toBe(201)
    const body = await resp.json() as Record<string, unknown>
    expect(typeof body['projectId']).toBe('string')
    expect(body['name']).toBe('Test Building')
    expect(body['address']).toBe('1 Test St')
    expect(body['notes']).toBe('Playwright test')
    expect(typeof body['createdAt']).toBe('number')
    expect(Array.isArray(body['floors'])).toBeTruthy()
  })

  test('returns 400 when name is missing', async ({ request }) => {
    const resp = await request.post(`${BASE}/projects`, {
      data: { address: 'No name' },
    })
    expect(resp.status()).toBe(400)
  })

  test('new project appears in GET /projects list', async ({ request }) => {
    const createResp = await request.post(`${BASE}/projects`, {
      data: { name: `Scan Site ${Date.now()}` },
    })
    expect(createResp.status()).toBe(201)
    const created = await createResp.json() as { projectId: string; name: string }

    const listResp = await request.get(`${BASE}/projects`)
    const list = await listResp.json() as Array<{ projectId: string }>
    expect(list.some(p => p.projectId === created.projectId)).toBeTruthy()
  })

  test('new project has default Ground Floor', async ({ request }) => {
    const resp = await request.post(`${BASE}/projects`, {
      data: { name: 'Floor Test' },
    })
    const body = await resp.json() as { floors: Array<{ name: string; level: number }> }
    expect(body.floors.length).toBeGreaterThanOrEqual(1)
    expect(body.floors[0]?.name).toBeTruthy()
    expect(body.floors[0]?.level).toBe(0)
  })
})

test.describe('GET /projects/:id', () => {
  test('returns the created project', async ({ request }) => {
    const createResp = await request.post(`${BASE}/projects`, {
      data: { name: 'Get By ID' },
    })
    const created = await createResp.json() as { projectId: string }

    const getResp = await request.get(`${BASE}/projects/${created.projectId}`)
    expect(getResp.status()).toBe(200)
    const body = await getResp.json() as { projectId: string; name: string }
    expect(body.projectId).toBe(created.projectId)
    expect(body.name).toBe('Get By ID')
  })

  test('returns 404 for unknown ID', async ({ request }) => {
    const resp = await request.get(`${BASE}/projects/nonexistent-id-12345`)
    expect(resp.status()).toBe(404)
  })
})

test.describe('PUT /projects/:id', () => {
  test('updates project name and notes', async ({ request }) => {
    const createResp = await request.post(`${BASE}/projects`, {
      data: { name: 'Before Update' },
    })
    const created = await createResp.json() as { projectId: string; floors: unknown[]; createdAt: number }

    const updated = {
      ...created,
      name: 'After Update',
      notes: 'Updated in test',
    }
    const putResp = await request.put(`${BASE}/projects/${created.projectId}`, {
      data: updated,
    })
    expect(putResp.status()).toBe(200)
    const body = await putResp.json() as { name: string; notes: string; updatedAt: number }
    expect(body.name).toBe('After Update')
    expect(body.notes).toBe('Updated in test')
    expect(body.updatedAt).toBeGreaterThanOrEqual(created.createdAt)
  })

  test('returns 404 for unknown ID', async ({ request }) => {
    const resp = await request.put(`${BASE}/projects/no-such-id`, {
      data: { projectId: 'no-such-id', name: 'X', createdAt: 0, updatedAt: 0, floors: [] },
    })
    expect(resp.status()).toBe(404)
  })
})

test.describe('DELETE /projects/:id', () => {
  test('deletes and returns ok:true', async ({ request }) => {
    const createResp = await request.post(`${BASE}/projects`, {
      data: { name: 'To Delete' },
    })
    const created = await createResp.json() as { projectId: string }

    const delResp = await request.delete(`${BASE}/projects/${created.projectId}`)
    expect(delResp.status()).toBe(200)
    const body = await delResp.json() as { ok: boolean }
    expect(body.ok).toBe(true)

    // Confirm gone
    const getResp = await request.get(`${BASE}/projects/${created.projectId}`)
    expect(getResp.status()).toBe(404)
  })

  test('returns 404 for already-deleted project', async ({ request }) => {
    const createResp = await request.post(`${BASE}/projects`, {
      data: { name: 'Delete Twice' },
    })
    const created = await createResp.json() as { projectId: string }

    await request.delete(`${BASE}/projects/${created.projectId}`)
    const resp = await request.delete(`${BASE}/projects/${created.projectId}`)
    expect(resp.status()).toBe(404)
  })
})

// ── /process-scan ─────────────────────────────────────────────────────────────

test.describe('POST /process-scan', () => {
  test('returns 400 when action is missing', async ({ request }) => {
    const resp = await request.post(`${BASE}/process-scan`, {
      data: { filename: 'scan.glb' },
    })
    expect(resp.status()).toBe(400)
  })

  test('object-count returns action + result string', async ({ request }) => {
    const resp = await request.post(`${BASE}/process-scan`, {
      data: { action: 'object-count', filename: '' },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { action: string; result: string }
    expect(body.action).toBe('object-count')
    expect(typeof body.result).toBe('string')
    expect(body.result.length).toBeGreaterThan(0)
  })

  test('scene-description returns action + result string', async ({ request }) => {
    const resp = await request.post(`${BASE}/process-scan`, {
      data: { action: 'scene-description', filename: '' },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { action: string; result: string }
    expect(body.action).toBe('scene-description')
    expect(typeof body.result).toBe('string')
  })

  test('floor-plan returns action + result string', async ({ request }) => {
    const resp = await request.post(`${BASE}/process-scan`, {
      data: { action: 'floor-plan', filename: '' },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { action: string; result: string }
    expect(body.action).toBe('floor-plan')
    expect(typeof body.result).toBe('string')
  })

  test('mesh-cleanup returns recommendations', async ({ request }) => {
    const resp = await request.post(`${BASE}/process-scan`, {
      data: { action: 'mesh-cleanup', filename: '' },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { action: string; result: string }
    expect(body.action).toBe('mesh-cleanup')
    expect(body.result.toLowerCase()).toContain('mesh')
  })

  test('room-segment returns suggestions', async ({ request }) => {
    const resp = await request.post(`${BASE}/process-scan`, {
      data: { action: 'room-segment', filename: '' },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { action: string; result: string }
    expect(body.action).toBe('room-segment')
    expect(body.result.length).toBeGreaterThan(0)
  })

  test('unknown action returns result with error message', async ({ request }) => {
    const resp = await request.post(`${BASE}/process-scan`, {
      data: { action: 'not-a-real-action', filename: '' },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { result: string }
    expect(body.result.toLowerCase()).toContain('unknown')
  })

  test('response includes processedAt timestamp', async ({ request }) => {
    const resp = await request.post(`${BASE}/process-scan`, {
      data: { action: 'object-count', filename: '' },
    })
    const body = await resp.json() as { processedAt: string }
    expect(typeof body.processedAt).toBe('string')
    expect(new Date(body.processedAt).getTime()).toBeGreaterThan(0)
  })
})

// ── /upload-summary ────────────────────────────────────────────────────────────

test.describe('POST /upload-summary', () => {
  test('stores markdown summary and returns filename', async ({ request }) => {
    const md = `# Session Summary\n\nGenerated by Playwright test at ${new Date().toISOString()}\n`
    const resp = await request.post(`${BASE}/upload-summary`, {
      multipart: {
        file: {
          name: 'test-summary.md',
          mimeType: 'text/markdown',
          buffer: Buffer.from(md),
        },
      },
    })
    expect(resp.status()).toBe(200)
    const body = await resp.json() as { filename: string }
    expect(typeof body.filename).toBe('string')
    expect(body.filename.endsWith('.md')).toBeTruthy()
  })

  test('returns 400 when no file is provided', async ({ request }) => {
    const resp = await request.post(`${BASE}/upload-summary`, {
      multipart: {},
    })
    expect(resp.status()).toBe(400)
  })
})
