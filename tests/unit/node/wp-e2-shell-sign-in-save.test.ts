/**
 * A shell sign-in whose verifier cannot be saved (E2, src/shared/shell-sign-in.ts). The return needs the
 * verifier, so the browser sheet must not open without it: beginShellSignIn throws instead, and the
 * sign-in control shows its failure words (src/ui/ftue-status.ts). Storage here throws on every call, as
 * blocked storage does. Capacitor is a stand-in, so this runs in Node.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-e2-shell-sign-in-save.test.ts
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { beginShellSignIn } from '../../../src/shared/shell-sign-in.ts'

const PENDING_KEY = 'companion-scan-shell-sign-in'

function stubGlobal(t: TestContext, name: string, value: unknown): void {
  const had = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  t.after(() => {
    if (had) Object.defineProperty(globalThis, name, had)
    else delete (globalThis as Record<string, unknown>)[name]
  })
}

/** A Browser plugin that counts the sheets it opens. */
function installBrowser(t: TestContext): { opened: () => number } {
  let opened = 0
  stubGlobal(t, 'Capacitor', {
    isNativePlatform: () => true,
    Plugins: {
      Browser: {
        open: async () => { opened += 1 },
        close: async () => {},
      },
    },
  })
  return { opened: () => opened }
}

test('a sign-in whose verifier cannot be saved fails before the browser sheet opens', async (t) => {
  const browser = installBrowser(t)
  const broken = () => { throw new Error('storage is blocked') }
  stubGlobal(t, 'localStorage', { getItem: broken, setItem: broken, removeItem: broken })
  await assert.rejects(beginShellSignIn(), /could not be saved/)
  assert.equal(browser.opened(), 0, 'the sheet stays shut: the return would have no verifier to finish with')
})

test('a sign-in whose verifier is saved opens the sheet, and keeps the verifier for the return', async (t) => {
  const browser = installBrowser(t)
  const storage = new Map<string, string>()
  stubGlobal(t, 'localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  })
  await beginShellSignIn()
  assert.equal(browser.opened(), 1)
  assert.ok(storage.has(PENDING_KEY), 'the verifier waits in storage for the app to come back')
})
