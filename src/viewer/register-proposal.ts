/**
 * The editor's side of the `place-register` job: show what it measured, preview
 * the move it proposes, and let a person apply it. Nothing here moves a scan on
 * its own.
 *
 * Each scan with a finished alignment check gets a card in the World tab:
 *
 *  - what was compared and what lined up, in the words `describeRegisterResult`
 *    chooses, which say what was measured and never "aligned" or "verified";
 *  - **Show**, which draws the scan's points twice over the scene: where the scan
 *    sits now in red, and where the proposal would put it in green;
 *  - **Apply**, which writes an ordinary scan EditPatch carrying
 *    `provenance { source: 'place-register', jobId, score, residualM }` through
 *    the same `postEditPatch` the Edit gizmo uses. The raw `sessionToProject` in
 *    the scan's sidecar is not touched; the patch is the refined placement and
 *    the provenance carries the residual that backs it.
 *
 * Every rule about when Apply may run, what it writes and what a second press
 * does lives in src/world/register-proposal.ts (`applyRegistrationProposal`), which
 * has no DOM and is tested under Node. This file only draws and wires.
 *
 * The ghosts share each scan's point geometry and own only their materials, so
 * removing one frees nothing the scan still needs.
 */
import * as THREE from 'three'
import type { WorldProject } from '../world/types.ts'
import {
  applyRegistrationProposal,
  buildRegisterPatch,
  describeRegisterResult,
  findAppliedRegisterPatch,
  type PlaceRegisterResult,
  readPlaceRegisterResult,
  type RegisterPatchBody,
  registerApplyState,
} from '../world/register-proposal.ts'

/** What the card needs from the editor. Injected so this file does not reach into viewer.ts's state. */
export interface RegisterProposalHost {
  world(): WorldProject | null
  /** Writes the patch as every other editor save does, and updates the editor's world from the reply. Rejects on a refusal. */
  postPatch(body: RegisterPatchBody): Promise<void>
  /** The group every scan root hangs from, or null before a Place has loaded. */
  worldGroup(): THREE.Group | null
  /** The point clouds of a scan that is loaded in the scene; empty when it is not. */
  scanPoints(scanId: string): THREE.Points[]
  /** Puts a loaded scan's root at `matrix`, column-major, as the editor does when it loads a scan with patches. */
  moveScan(scanId: string, matrix: number[]): void
}

export interface RegisterProposals {
  /** Redraws the cards from the editor's current world. Cheap; called whenever the job list is. */
  render(): void
}

/** Where the scan sits now. */
const BEFORE_COLOUR = 0xff6b6b
/** Where the proposal would put it. */
const AFTER_COLOUR = 0x5be0a3
/** The newest scans with a check, so a Place with many scans does not fill the tab. */
const MAX_CARDS = 5

interface Ghost {
  jobId: string
  worldId: string
  group: THREE.Group
  materials: THREE.Material[]
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * What went wrong, in the server's own words when it gave some. `postEditPatch` reports a refusal as
 * `<status> <body>`; the sentence a person can act on is the `error` inside that body, not the JSON around it.
 */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const body = /^\d{3} (\{[\s\S]*\})$/.exec(message)
  if (body) {
    try {
      const parsed = JSON.parse(body[1]!) as { error?: unknown }
      if (typeof parsed.error === 'string' && parsed.error !== '') return parsed.error
    } catch { /* not JSON after all: say what the server said */ }
  }
  return message
}

export function mountRegisterProposals(host: RegisterProposalHost): RegisterProposals {
  const section = document.getElementById('register-proposals-section')
  const list = document.getElementById('register-proposals')
  let ghost: Ghost | null = null
  /** What each card says besides the check itself: that Apply is under way, or why the last try failed. Kept across redraws. */
  const notes = new Map<string, string>()
  const busy = new Set<string>()

  function clearGhost(): void {
    if (!ghost) return
    ghost.group.parent?.remove(ghost.group)
    for (const material of ghost.materials) material.dispose()
    ghost = null
  }

  function showGhost(jobId: string, result: PlaceRegisterResult, world: WorldProject): boolean {
    clearGhost()
    const parent = host.worldGroup()
    const proposal = result.proposal
    const transform = proposal.transform
    if (!parent || !transform) return false
    const sources = host.scanPoints(result.moving.scanId)
    if (sources.length === 0) return false

    const group = new THREE.Group()
    group.name = 'alignment check preview'
    const correction = new THREE.Matrix4().fromArray(transform)
    const parentInverse = new THREE.Matrix4().copy(parent.matrixWorld).invert()
    const materials: THREE.Material[] = []
    for (const [colour, moved] of [[BEFORE_COLOUR, false], [AFTER_COLOUR, true]] as const) {
      const material = new THREE.PointsMaterial({
        color: colour,
        size: 0.05,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      })
      materials.push(material)
      for (const source of sources) {
        source.updateWorldMatrix(true, false)
        const copy = new THREE.Points(source.geometry, material)
        copy.matrixAutoUpdate = false
        copy.matrix.copy(parentInverse).multiply(source.matrixWorld)
        // The correction is in the Place frame, which is the frame the scan roots live in.
        if (moved) copy.matrix.premultiply(correction)
        copy.renderOrder = 3
        group.add(copy)
      }
    }
    parent.add(group)
    ghost = { jobId, worldId: world.worldId, group, materials }
    return true
  }

  function card(jobId: string, result: PlaceRegisterResult, world: WorldProject): HTMLElement {
    const state = registerApplyState(result, jobId, world.scans, world.editPatches ?? [])
    const { headline, lines } = describeRegisterResult(result)

    const root = element('div', 'register-card')
    root.dataset['jobId'] = jobId
    root.append(element('div', 'job-title register-title', result.moving.name || result.moving.filename))
    root.append(element('div', 'register-headline', state === 'applied' ? 'Applied' : headline))
    for (const line of lines) root.append(element('div', 'layer-meta', line))

    const note = element('div', 'layer-meta register-note')
    note.setAttribute('role', 'status')
    const remembered = notes.get(jobId)
    const appliedPatch = findAppliedRegisterPatch(world.editPatches ?? [], jobId)
    if (state === 'applied') {
      // Whatever the card said while it was applying is over: the patch is in the world, which is what "applied" means.
      note.textContent = `Applied to this scan${appliedPatch ? ` at ${new Date(appliedPatch.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}.`
    } else if (state === 'stale') {
      note.textContent = 'This scan, or the one it was checked against, has moved since the check. Run the check again.'
    } else if (remembered) {
      note.textContent = remembered
    }

    if (state === 'ready') {
      const actions = element('div', 'register-actions')
      const show = element('button', 'job-btn', ghost?.jobId === jobId ? 'Hide' : 'Show')
      show.type = 'button'
      show.addEventListener('click', () => {
        if (ghost?.jobId === jobId) clearGhost()
        else if (!showGhost(jobId, result, world)) notes.set(jobId, 'Open this scan in the scene first, then show the preview.')
        else notes.delete(jobId)
        render()
      })
      const apply = element('button', 'job-btn', 'Apply')
      apply.type = 'button'
      apply.disabled = busy.has(jobId)
      apply.title = 'Moves this scan as shown. The original calibration is kept.'
      apply.addEventListener('click', () => {
        // A press on a card whose first press is still travelling changes nothing: it must not clear the note or
        // re-enable the button that the first press is waiting behind.
        if (busy.has(jobId)) return
        busy.add(jobId)
        notes.set(jobId, 'Applying...')
        render()
        void applyRegistrationProposal(result, jobId, {
          scans: () => host.world()?.scans ?? [],
          patches: () => host.world()?.editPatches ?? [],
          post: (body) => host.postPatch(body),
        }).then((outcome) => {
          if (outcome === 'applied') {
            const body = buildRegisterPatch(result, jobId)
            if (body) host.moveScan(result.moving.scanId, body.transform.matrix)
            clearGhost()
            notes.delete(jobId)
          } else if (outcome === 'already-applied') {
            notes.delete(jobId)
          } else if (outcome === 'stale') {
            notes.set(jobId, 'This scan has moved since the check. Run the check again.')
          } else {
            notes.set(jobId, 'This check proposed no move.')
          }
        }).catch((error: unknown) => {
          notes.set(jobId, `Could not apply: ${errorText(error)}`)
        }).finally(() => {
          busy.delete(jobId)
          render()
        })
      })
      actions.append(show, apply)
      root.append(actions)
    }
    root.append(note)
    return root
  }

  function render(): void {
    if (!section || !list) return
    const world = host.world()
    if (!world) {
      clearGhost()
      section.hidden = true
      return
    }
    // A preview belongs to the Place it was drawn for.
    if (ghost && ghost.worldId !== world.worldId) clearGhost()

    // The newest readable check for each scan. Jobs are newest first.
    const seen = new Set<string>()
    const cards: Array<{ jobId: string; result: PlaceRegisterResult }> = []
    for (const job of world.jobs) {
      if (job.type !== 'place-register' || !job.scanId || seen.has(job.scanId)) continue
      const result = readPlaceRegisterResult(job)
      if (!result) continue
      seen.add(job.scanId)
      cards.push({ jobId: job.jobId, result })
      if (cards.length >= MAX_CARDS) break
    }
    if (ghost && !cards.some((entry) => entry.jobId === ghost!.jobId)) clearGhost()

    list.replaceChildren(...cards.map(({ jobId, result }) => card(jobId, result, world)))
    section.hidden = cards.length === 0
  }

  return { render }
}
