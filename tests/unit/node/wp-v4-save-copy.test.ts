/**
 * The copy for an unsaved edit, in the Edit panel and Save Tags (src/viewer/viewer.ts), fourth pass.
 *
 * viewer.ts runs its DOM code when it is imported, so node cannot load it. These checks take the
 * functions and lines that choose the copy from the source, run them with a real PendingSaves, and
 * check what they produce. The copy strings stay in viewer.ts, where wp-v3-viewer-guards (V3-9) pins them.
 *
 * V4-1: with only refused edits pending, the Edit panel says the server refused the change and
 * promises no retry. A transient failure still gets the retry line.
 * V4-2: a world-link refusal (401, 403) gets its own line, in the Edit panel and in Save Tags.
 * V5-2 (fifth pass): a retry is promised while any edit can still be sent, and the refusal copy
 * shows only when nothing can be retried. Both places use the same copy.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-v4-save-copy.test.ts
 */
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PendingSaves } from '../../../src/viewer/editor.ts'

const source = readFileSync(new URL('../../../src/viewer/viewer.ts', import.meta.url), 'utf8')

const RETRY = 'Not saved. Save again to retry.'
const REFUSED = 'Not saved. The server refused this change.'
const LINK = 'Not saved. This link cannot save changes.'

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
  const from = source.indexOf('\nfunction ' + name + '(')
  assert.notEqual(from, -1, 'viewer.ts declares ' + name)
  const to = source.indexOf('\n}\n', from)
  assert.notEqual(to, -1, 'viewer.ts ends ' + name)
  return source.slice(from + 1, to + 3)
}

/** The one line of viewer.ts that starts with `start` once its indentation is removed. */
function sourceLine(start: string): string {
  const lines = source.split('\n').filter(line => line.trimStart().startsWith(start))
  assert.equal(lines.length, 1, 'viewer.ts has one line that starts with: ' + start)
  return lines[0]!
}

/**
 * The Edit panel's save line after showEditSaveState runs for `state`. The function and the copy it
 * uses come from viewer.ts; `document` is a stand-in that holds the one line.
 */
function panelCopy(saves: PendingSaves, state: 'saving' | 'saved' | 'failed' = 'failed'): string {
  const line = { textContent: '', style: { color: '' } }
  const code = stripTypeScriptTypes([
    sourceLine('const RETRY_COPY'),
    topLevelFunction('refusalCopy'),
    sourceLine('let droppedEdits'),
    topLevelFunction('showEditSaveState'),
    "showEditSaveState('" + state + "')",
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

test('V4-1: with only refused edits pending, the Edit panel gives the refused copy and no retry promise', async () => {
  assert.equal(panelCopy(await unsavedWith([400])), REFUSED)
  assert.equal(panelCopy(await unsavedWith([400, 422])), REFUSED, 'several refused edits, still no retry')
})

test('V4-1: a transient failure alone still gets the retry line in the Edit panel', async () => {
  assert.equal(panelCopy(await unsavedWith(['offline'])), RETRY)
})

test('V4-1: a transient failure next to a refused edit keeps the retry line in the Edit panel', async () => {
  assert.equal(panelCopy(await unsavedWith([400, 'offline'])), RETRY)
})

test('V5-4: a refused-only state gives the Edit panel its refusal line, and no retry promise', async () => {
  assert.equal(panelCopy(await unsavedWith([400])), REFUSED)
  assert.equal(panelCopy(await unsavedWith([422, 404])), REFUSED, 'several server refusals')
  assert.equal(panelCopy(await unsavedWith([401])), LINK, 'a world-link refusal names the link')
  assert.equal(panelCopy(await unsavedWith([403, 401])), LINK, 'several world-link refusals')
})

test('V5-4: a retryable state gives the Edit panel its retry line, for a transient failure, 408 and 429', async () => {
  assert.equal(panelCopy(await unsavedWith(['offline'])), RETRY)
  assert.equal(panelCopy(await unsavedWith([408])), RETRY, 'a request timeout is sent again, not refused')
  assert.equal(panelCopy(await unsavedWith([429])), RETRY, 'a rate limit is sent again, not refused')
})

test('V5-4: a mixed state gives the Edit panel its retry line, whichever edit was refused', async () => {
  assert.equal(panelCopy(await unsavedWith([400, 'offline'])), RETRY)
  assert.equal(panelCopy(await unsavedWith([401, 'offline'])), RETRY)
  assert.equal(panelCopy(await unsavedWith([403, 429])), RETRY)
})

test('V4-2: a world-link refusal (401, 403) gets the link line in the Edit panel, for 401 and 403', async () => {
  assert.equal(panelCopy(await unsavedWith([401])), LINK)
  assert.equal(panelCopy(await unsavedWith([403])), LINK)
})

test('V5-2: a world-link refusal next to a transient failure keeps the retry line in the Edit panel', async () => {
  assert.equal(panelCopy(await unsavedWith([401, 'offline'])), RETRY)
})

test('V4-2: Save Tags gives the link line for 401 and 403, and no retry promise', async () => {
  assert.equal(saveTagsCopy(await unsavedWith([401])), LINK)
  assert.equal(saveTagsCopy(await unsavedWith([403])), LINK)
})

test('V4-2: Save Tags keeps the refused line for other refusals, and the retry line for transient failures', async () => {
  assert.equal(saveTagsCopy(await unsavedWith([400])), REFUSED)
  assert.equal(saveTagsCopy(await unsavedWith([422])), REFUSED)
  assert.equal(saveTagsCopy(await unsavedWith(['offline'])), RETRY)
})

test('V5-2: Save Tags promises a retry while a transient edit is still pending next to a refused one', async () => {
  assert.equal(saveTagsCopy(await unsavedWith([400, 'offline'])), RETRY)
})
