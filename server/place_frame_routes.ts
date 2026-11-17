/**
 * The routes of a Place's frame generations that read or hold a frame's own data (ADR 0009): the status a client asks
 * before it replaces a reference, and the reference photos of each frame.
 *
 * A module of its own, registered on the server's app by one call in `server/main.ts`, so the hub carries a hook and not
 * the routes. Everything these routes need from the server is handed in (`PlaceFrameRouteDeps`): the Place registry,
 * the scan counts, where photos live and how large one may be. They sit behind the Companion session guard like every
 * `/projects` route, which `server/main.ts` applies to the path and not to a handler; tests/unit/deno/frame_generations_route.test.ts
 * runs them through the real server in every guard mode.
 *
 * The writes that change a Place's frame (`PUT /projects/:id/spatial-frame`), move scans between Places (merge, a
 * moved scan) and the Place's own legacy photo route are in `server/main.ts`, beside the registry code they use.
 */
import type { Hono } from 'hono'
import type { Project } from '../src/world/types.ts'
import type { ScanFrameCounts } from '../src/world/frame-generations.ts'
import { frameStatusOf, knownFrameIds } from './place_frames.ts'
import {
  framePhotoDirPath,
  framePhotoFileName,
  framePhotoUrl,
  parseFramePhotoMeta,
  roleForFramePhotoFile,
  storeFramePhoto,
} from './project_media.ts'
import { readFormDataCapped } from './wp-a-body.ts'

/** What the routes need from the server. */
export interface PlaceFrameRouteDeps {
  /** The Places the registry holds. */
  loadProjects(): Promise<Project[]>
  /** How a Place's stored scans split by the frame they were measured against. */
  countScansByFrame(projectId: string): Promise<ScanFrameCounts>
  /** The folder the Places' photo folders are in. */
  mediaDir: string
  /** The most bytes one photo upload may carry. */
  maxPhotoBytes: number
}

export function registerPlaceFrameRoutes(app: Hono, deps: PlaceFrameRouteDeps): void {
  /**
   * `GET /projects/:id/frame-status`: where the Place's reference stands, and what replacing it would affect.
   * `FrameStatus` (src/world/frame-generations.ts): the current frame and its revision, how many of the Place's
   * scans were measured against each frame (counted from the scans' own records, not from any world), and the
   * frames the Place held before. The scanner's "Replace this Place's reference" asks it before it confirms, and the
   * editor's banner reads it.
   */
  app.get('/projects/:id/frame-status', async (c) => {
    const projectId = c.req.param('id')
    const project = (await deps.loadProjects()).find(p => p.projectId === projectId)
    if (!project) return c.json({ error: 'Not found' }, 404)
    return c.json(frameStatusOf(project, await deps.countScansByFrame(projectId)))
  })

  /**
   * `POST /projects/:id/frames/:frameId/reference-photos`: one photo of a frame, kept in the folder of the frame it
   * belongs to, so a frame that replaces another leaves the earlier frame's photos where they were. Taken for the frame
   * the Place holds and for the frames it held (`frameHistory`), and for no other id: a photo of a frame that lost to
   * another device's is refused, and cannot replace the winner's. The request and the answer are those of the Place's
   * own photo route (multipart `image` and `meta`, `{ ok, role, url }`), with the roles of `FRAME_PHOTO_ROLES`.
   */
  app.post('/projects/:id/frames/:frameId/reference-photos', async (c) => {
    const projectId = c.req.param('id')
    const frameId = c.req.param('frameId')
    const dir = framePhotoDirPath(deps.mediaDir, projectId, frameId)
    if (!dir) return c.json({ error: 'Invalid project or frame id' }, 400)

    const project = (await deps.loadProjects()).find(p => p.projectId === projectId)
    if (!project) return c.json({ error: 'Project not found' }, 404)
    if (!knownFrameIds(project).has(frameId)) return c.json({ error: 'This Place has no reference with that id' }, 404)

    // A body that is not form data is the sender's mistake, and is said to be (the Place's own route answers 500).
    const form = await readFormDataCapped(c.req.raw, deps.maxPhotoBytes).catch(() => undefined)
    if (form === undefined) return c.json({ error: 'Send the photo as multipart form data: image and meta' }, 400)
    if (!form) return c.json({ error: `photo exceeds ${deps.maxPhotoBytes} bytes`, maxBytes: deps.maxPhotoBytes }, 413)
    const image = form.get('image')
    if (!image || !(image instanceof File)) return c.json({ error: 'Missing image field' }, 400)

    const parsed = parseFramePhotoMeta(form.get('meta'))
    if ('error' in parsed) return c.json({ error: parsed.error }, 400)

    try {
      await storeFramePhoto(dir, parsed.meta, new Uint8Array(await image.arrayBuffer()))
      return c.json({ ok: true, role: parsed.meta.role, url: framePhotoUrl(projectId, frameId, parsed.meta.role) })
    } catch (err) {
      console.error('[project frame reference-photo error]', err)
      return c.json({ error: String(err) }, 500)
    }
  })

  /** `GET /projects/:id/frames/:frameId/ref-<role>.jpg`: a frame's photo. An allowlist of names, as the Place's own route has. */
  app.get('/projects/:id/frames/:frameId/:file', async (c) => {
    const dir = framePhotoDirPath(deps.mediaDir, c.req.param('id'), c.req.param('frameId'))
    const role = roleForFramePhotoFile(c.req.param('file'))
    if (!dir || !role) return c.json({ error: 'Invalid reference photo path' }, 400)
    try {
      return new Response(await Deno.readFile(`${dir}/${framePhotoFileName(role)}`), {
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' },
      })
    } catch {
      return c.json({ error: 'Reference photo not found' }, 404)
    }
  })
}
