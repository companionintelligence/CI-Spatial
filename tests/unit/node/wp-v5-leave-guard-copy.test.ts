/**
 * The leave-page guard and the save copy, fifth pass (src/viewer/viewer.ts and src/viewer/editor.ts).
 *
 * viewer.ts runs its DOM code when it is imported, so node cannot load it. The copy and the guard
 * are taken from its source, run with a real PendingSaves, and checked for what they do.
 *
 * V5-1: a 401 or 403 from the world link is named as a link that cannot save, not as a sign-in, and
 * the helper that names it is isLinkRefusalError.
 * V5-2: a retry is promised while any edit can still be sent. With only refusals left, a server
 * refusal (a 400) is named before the link. The Edit panel and Save Tags always show the same copy.
 * V5-3: a beforeunload listener asks before a reload or a leave while an edit is pending or still
 * posting, and does nothing when none is.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-v5-leave-guard-copy.test.ts
 */
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as editorModule from '../../../src/viewer/editor.ts'
import { PendingSaves } from '../../../src/viewer/editor.ts'

const viewerSource = readFileSync(new URL('../../../src/viewer/viewer.ts', import.meta.url), 'utf8')

const RETRY = 'Not saved. Save again to retry.'
const REFUSED = 'Not saved. The server refused this change.'
const LINK = 'Not saved. This link cannot save changes.'
const COPIES = [RETRY, REFUSED, LINK]

/** An error shaped like httpError() in viewer.ts: a message and the HTTP status. */
function httpFailure(status: number): Error {
  return Object.assign(new Error(String(status) + ' refused'), { status })
}

/**
 * Saves that leave unsaved edits behind, one per entry: a number is the HTTP status the server
 * answers with, and 'offline' is a transient failure with no status.
 */
async function unsavedWith(failures: Array<number | 'offline'>): Promise<PendingSaves> {
  const saves = new PendingSaves(() => {})
  const silence = console.error
  console.error = () => {}
  try {
    for (const [index, failure] of failures.entries()) {
      await saves.save('semantic:' + String(index), async () => {
        throw failure === 'offline' ? new Error('offline') : httpFailure(failure)
      })
    }
  } finally {
    console.error = silence
  }
  return saves
}

/** A top-level function of viewer.ts, from its `function` line to the closing brace at column 0. */
function topLevelFunction(name: string): string {
  const from = viewerSource.indexOf('\nfunction ' + name + '(')
  assert.notEqual(from, -1, 'viewer.ts declares ' + name)
  const to = viewerSource.indexOf('\n}\n', from)
  assert.notEqual(to, -1, 'viewer.ts ends ' + name)
  return viewerSource.slice(from + 1, to + 3)
}

/** The one line of viewer.ts that starts with `start` once its indentation is removed. */
function sourceLine(start: string): string {
  const lines = viewerSource.split('\n').filter(line => line.trimStart().startsWith(start))
  assert.equal(lines.length, 1, 'viewer.ts has one line that starts with: ' + start)
  return lines[0]!
}

/** The Edit panel's save line after showEditSaveState runs for the failed state. */
function panelCopy(saves: PendingSaves): string {
  const line = { textContent: '', style: { color: '' } }
  const code = stripTypeScriptTypes([
    sourceLine('const RETRY_COPY'),
    topLevelFunction('refusalCopy'),
    sourceLine('let droppedEdits'),
    topLevelFunction('showEditSaveState'),
    "showEditSaveState('failed')",
  ].join('\n'))
  new Function('editSaves', 'document', code)(saves, { getElementById: () => line })
  return line.textContent
}

/** Save Tags' copy for an edit still unsaved: the line of the Save Tags listener that chooses it. */
function saveTagsCopy(saves: PendingSaves): string {
  const code = stripTypeScriptTypes([
    sourceLine('const RETRY_COPY'),
    topLevelFunction('refusalCopy'),
    sourceLine('const notSaved'),
  ].join('\n')) + '\nreturn notSaved'
  return new Function('editSaves', code)(saves) as string
}

/**
 * The beforeunload listener of viewer.ts, run against `saves` with a stand-in window that records
 * the listener, then fired once. Returns what the listener did to the event.
 */
function unloadGuard(saves: PendingSaves): { prevented: boolean; returnValue: unknown } {
  const start = viewerSource.indexOf("window.addEventListener('beforeunload'")
  assert.notEqual(start, -1, 'viewer.ts registers a beforeunload listener')
  const end = viewerSource.indexOf('\n})\n', start)
  assert.notEqual(end, -1, 'the beforeunload listener ends')
  const listeners: Array<(event: unknown) => void> = []
  const windowStandIn = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === 'beforeunload') listeners.push(listener)
    },
  }
  new Function('editSaves', 'window', stripTypeScriptTypes(viewerSource.slice(start, end + 3)))(saves, windowStandIn)
  assert.equal(listeners.length, 1, 'viewer.ts adds one beforeunload listener')
  const event = {
    returnValue: 'untouched' as unknown,
    prevented: false,
    preventDefault() { this.prevented = true },
  }
  listeners[0]!(event)
  return { prevented: event.prevented, returnValue: event.returnValue }
}

test('V5-1: the helper that names a world-link refusal is isLinkRefusalError, and the sign-in name is gone', () => {
  assert.equal(typeof editorModule.isLinkRefusalError, 'function')
  assert.equal('isSignInEditError' in editorModule, false)
  assert.equal(editorModule.isLinkRefusalError(httpFailure(401)), true)
  assert.equal(editorModule.isLinkRefusalError(httpFailure(403)), true)
  assert.equal(editorModule.isLinkRefusalError(httpFailure(400)), false)
})

test('V5-2: with a 400 and a 401 both refused and nothing retryable, the server refusal is named, not the link', async () => {
  const saves = await unsavedWith([400, 401])
  assert.equal(panelCopy(saves), REFUSED, 'Edit panel')
  assert.equal(saveTagsCopy(saves), REFUSED, 'Save Tags')

  const reversed = await unsavedWith([401, 400])
  assert.equal(panelCopy(reversed), REFUSED, 'the order of the refusals does not matter')
  assert.equal(saveTagsCopy(reversed), REFUSED)
})

test('V5-2: refusals that all come from the world link name the link, in both places', async () => {
  const saves = await unsavedWith([401, 403])
  assert.equal(panelCopy(saves), LINK, 'Edit panel')
  assert.equal(saveTagsCopy(saves), LINK, 'Save Tags')
})

test('V5-2: the Edit panel and Save Tags show the same copy in every mix, and it never asks for a sign-in', async () => {
  const mixes: Array<Array<number | 'offline'>> = [
    [400], [401], [403], [422], ['offline'], [408], [429],
    [400, 401], [401, 403], [400, 'offline'], [401, 'offline'], [403, 429], [400, 401, 'offline'],
  ]
  for (const mix of mixes) {
    const saves = await unsavedWith(mix)
    const panel = panelCopy(saves)
    const label = JSON.stringify(mix)
    assert.ok(COPIES.includes(panel), 'the Edit panel shows one of the three copies for ' + label)
    assert.equal(saveTagsCopy(saves), panel, 'Save Tags agrees with the Edit panel for ' + label)
    assert.doesNotMatch(panel, /sign/i, 'no sign-in copy for ' + label)
  }
})

test('V5-2: the copy follows the state, from a retry to the link copy once the retryable edit is saved', async () => {
  const saves = await unsavedWith([401, 'offline'])
  assert.equal(panelCopy(saves), RETRY)
  assert.equal(saveTagsCopy(saves), RETRY)

  // The transient edit (key semantic:1) is saved again and accepted. Only the link refusal is left.
  assert.equal(await saves.save('semantic:1', async () => {}), true)
  assert.equal(panelCopy(saves), LINK)
  assert.equal(saveTagsCopy(saves), LINK)

  // The refused edit is saved again and accepted. Nothing is left, so nothing is named.
  assert.equal(await saves.save('semantic:0', async () => {}), true)
  assert.equal(saves.pendingCount, 0)
  assert.equal(saves.refusedCount, 0)
})

test('V5-3: the leave-page guard asks while a refused edit is still unsaved', async () => {
  const guard = unloadGuard(await unsavedWith([400]))
  assert.equal(guard.prevented, true)
  assert.equal(guard.returnValue, '')
})

test('V5-3: the leave-page guard asks while a retryable edit is still unsaved', async () => {
  const guard = unloadGuard(await unsavedWith(['offline']))
  assert.equal(guard.prevented, true)
  assert.equal(guard.returnValue, '')
})

test('V5-3: the leave-page guard asks while a save is still posting, and stops once it lands', async () => {
  const saves = new PendingSaves(() => {})
  let land!: () => void
  const posting = new Promise<void>((resolve) => { land = resolve })
  const saved = saves.save('semantic:a', () => posting)
  assert.equal(unloadGuard(saves).prevented, true, 'the edit is still on its way to the server')

  land()
  assert.equal(await saved, true)
  assert.equal(unloadGuard(saves).prevented, false, 'nothing is pending or in flight')
})

test('V5-3: the leave-page guard does not block the page when nothing is pending', () => {
  const guard = unloadGuard(new PendingSaves(() => {}))
  assert.equal(guard.prevented, false)
  assert.equal(guard.returnValue, 'untouched')
})

test('V5-3: the leave-page guard stops once the refused edit is saved again and accepted', async () => {
  const saves = await unsavedWith([403])
  assert.equal(unloadGuard(saves).prevented, true)

  assert.equal(await saves.save('semantic:0', async () => {}), true)
  assert.equal(unloadGuard(saves).prevented, false)
})

test('V5-3: a save that fails leaves the page guarded but is no longer in flight', async (t) => {
  t.mock.method(console, 'error', () => {})
  const saves = new PendingSaves(() => {})

  assert.equal(await saves.save('semantic:a', async () => { throw new Error('offline') }), false)
  assert.equal(saves.inFlight, false, 'the run has ended')
  assert.equal(unloadGuard(saves).prevented, true, 'the edit is still unsaved')
})

test('V5-3: PendingSaves.inFlight is true from the moment a save is queued, and until the queue drains', async () => {
  const saves = new PendingSaves(() => {})
  assert.equal(saves.inFlight, false)

  let landFirst!: () => void
  const heldFirst = new Promise<void>((resolve) => { landFirst = resolve })
  const first = saves.save('semantic:a', () => heldFirst)
  assert.equal(saves.inFlight, true, 'queued before its run starts')
  // Let the first run start and reach its post. A run posts every edit pending when it starts,
  // so the second save is queued only after that.
  await new Promise<void>((resolve) => setImmediate(resolve))

  let landSecond!: () => void
  const heldSecond = new Promise<void>((resolve) => { landSecond = resolve })
  const second = saves.save('semantic:b', () => heldSecond)
  landFirst()
  assert.equal(await first, true)
  assert.equal(saves.inFlight, true, 'the second save is queued or posting')

  landSecond()
  assert.equal(await second, true)
  assert.equal(saves.inFlight, false)
  assert.equal(saves.pendingCount, 0)
})
