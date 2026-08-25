/**
 * Uploads a recorded person clip and its pose track.
 *
 * Posts to `/ingest-video` in `person` mode — the same route walkthrough video
 * already uses, extended rather than duplicated (ADR 0001). The two modes
 * diverge on the server: a walkthrough's video is scratch and is deleted once
 * keyframes are extracted, while a person clip *is* the durable artifact,
 * because 4DAnyone consumes the video itself rather than frames.
 *
 * ## Why XHR and not fetch
 *
 * `xhr.upload.onprogress` is the only way to report upload progress, and a
 * 1080p clip is large enough that a silent multi-second wait reads as a hang.
 * `wireContentUpload()` in `src/main.ts` uses XHR for the same reason.
 *
 * ## Why not the offline queue
 *
 * The service worker's queue (`public/sw.js`) is bounded by item count and age
 * rather than bytes, deliberately: measuring bytes would mean reading every
 * queued body into memory, which is the allocation the cap exists to prevent.
 * `queueRequest()` does `await request.clone().arrayBuffer()` into IndexedDB, so
 * a clip through it is exactly the failure it guards against. `/ingest-video`
 * is correctly absent from `QUEUEABLE_WRITE_PREFIXES` and must stay absent —
 * an interrupted clip upload is retried from the device instead.
 *
 * See docs/factory/10-4d-person-capture/0004-durable-clip-storage.md.
 */
import type { RecordedClip } from './clip-recorder'

export interface ClipUploadResult {
  sessionId: string
  scanId: string
  jobId: string | null
  clipUrl: string | null
}

export interface ClipUploadOptions {
  projectId?: string | null
  areaId?: string | null
  takeId?: string | null
  clientId?: string | null
  onProgress?: (percent: number) => void
}

export function uploadPersonClip(clip: RecordedClip, opts: ClipUploadOptions = {}): Promise<ClipUploadResult> {
  const form = new FormData()
  form.append('video', clip.blob, clip.fileName)
  form.append('mode', 'person')
  // The negotiated container differs per device, and the server must not guess
  // it from the extension — Safari and Chrome disagree on both.
  form.append('mimeType', clip.mimeType)
  form.append(
    'poseTrack',
    new Blob([JSON.stringify(clip.poseTrack)], { type: 'application/json' }),
    'pose-track.json',
  )
  if (opts.projectId) form.append('projectId', opts.projectId)
  if (opts.areaId) form.append('areaId', opts.areaId)
  if (opts.takeId) form.append('takeId', opts.takeId)
  if (opts.clientId) form.append('clientId', opts.clientId)

  return new Promise<ClipUploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/ingest-video')

    xhr.upload.addEventListener('progress', ev => {
      if (ev.lengthComputable && opts.onProgress) {
        opts.onProgress(Math.round((ev.loaded / ev.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        // Surface the server's own message where there is one — the size and
        // format rejections are worth reading verbatim.
        let detail = `HTTP ${xhr.status}`
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string }
          if (body.error) detail = body.error
        } catch { /* non-JSON error body */ }
        reject(new Error(detail))
        return
      }
      try {
        const body = JSON.parse(xhr.responseText) as ClipUploadResult
        resolve(body)
      } catch {
        reject(new Error('Upload succeeded but the response could not be read'))
      }
    })

    xhr.addEventListener('error', () => reject(new Error('Network error during upload')))
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')))
    xhr.send(form)
  })
}
