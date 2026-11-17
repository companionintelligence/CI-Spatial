/**
 * The editor's side of the undo route (POST /worlds/:slug/patches/revert): what it asks, and what it does with the
 * answer. viewer.ts hands over how to send, how to read a refusal and where to put the world; the rules are here, where
 * a test can reach them (viewer.ts runs its DOM code when it is imported).
 *
 * Three things a caller must not get wrong:
 *   - the request names the scan and the move the person saw as the last one, so the server can refuse (409) when
 *     another came after it;
 *   - a request the service worker queued because the network is down is not an undo that happened, and gets said so
 *     (it answers 202 with no world, and 202 is "ok");
 *   - the world it answers with belongs to the Place it was asked about: after a Place switch it is dropped.
 */
import { isQueuedOffline } from '../shared/offline-queue.ts'
import type { WorldProject } from '../world/types.ts'

export interface RevertEnvironment {
  /** POST `body` to the undo route of the Place on screen and give back the reply. */
  post(body: string): Promise<Response>
  /** The error a refused reply becomes: the viewer's own, which carries the status and the server's sentence. */
  refused(response: Response): Promise<Error>
  /** Whether the Place on screen is still the one the request was made for. */
  stillCurrent(): boolean
  /** Take the world the server answered with. */
  take(world: WorldProject): void
}

/** What a person is told when the undo was queued and not made. In the shape of a refused reply, so it is read like one. */
export const OFFLINE_UNDO_SENTENCE = 'You are offline. The undo will run when you are back online.'

/** Ask for the last saved move of `scanId` to be taken back, `patchId` being the move the person saw as the last one. */
export async function requestRevert(env: RevertEnvironment, scanId: string, patchId: string): Promise<void> {
  const response = await env.post(JSON.stringify({ scanId, patchId }))
  if (!response.ok) throw await env.refused(response)
  if (isQueuedOffline(response)) {
    throw Object.assign(new Error(`${response.status} ${JSON.stringify({ error: OFFLINE_UNDO_SENTENCE })}`), { status: response.status })
  }
  const payload = await response.json() as { world: WorldProject }
  if (!env.stillCurrent()) return
  env.take(payload.world)
}
