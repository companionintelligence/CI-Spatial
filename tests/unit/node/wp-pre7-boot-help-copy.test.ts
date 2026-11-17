/**
 * PRE7-1 and PRE7-2: the copy `#ar-help` can carry at boot, held to its limits.
 *
 * Every caveated detail probeVerdict() returns is checked here: at most fifteen
 * words, at most two sentences, and no control named. The secure-page ones are
 * the lines the boot writes into `#ar-help` before the camera opens: the advertised
 * caveat and the no-AR line. The insecure-page line is not written on an ordinary
 * boot, because main.ts returns before the probe on an insecure page. It is
 * checked anyway, because probeVerdict() can return it. Where a dead end offers
 * both no-AR paths, the tripod path comes first, and the no-AR line keeps the
 * upload's caveat. The word ceiling the screen is held to, with these lines
 * counted, is in wp-pre7-boot-help-budget.test.ts.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-pre7-boot-help-copy.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { probeVerdict, type ProbeEnv } from '../../../src/ar/preflight.ts'
import { allProbeEnvs, countWords } from '../../support/startup-budget.ts'

const TRIPOD_PATH = /tripod/i
const UPLOAD_PATH = /video or photos/i
const CONTROL_LABEL = /Tripod Scan|Upload Content|Scan a Place/

/** The probe states, and the verdict each one gives. */
const verdicts = allProbeEnvs().map((env) => ({ env, verdict: probeVerdict(env) }))

/** Only a caveated verdict can be written into the start screen at boot. */
const caveated = verdicts.filter(({ verdict }) => verdict.caveat)

/** A sentence ends in a full stop, question mark or bang, followed by a space or the end. */
function sentences(text: string): number {
  return (text.match(/[.!?](?=\s|$)/g) ?? []).length
}

function label(env: ProbeEnv): string {
  return JSON.stringify(env)
}

test('every caveated probe detail is at most fifteen words', () => {
  assert.ok(caveated.length > 0, 'no caveated verdicts: the copy checks below would prove nothing')
  for (const { env, verdict } of caveated) {
    const words = countWords(verdict.detail)
    assert.ok(words <= 15, label(env) + ': ' + words + ' words, not 15 or fewer: "' + verdict.detail + '"')
  }
})

test('every caveated probe detail is one or two sentences', () => {
  for (const { env, verdict } of caveated) {
    assert.ok(
      sentences(verdict.detail) <= 2,
      label(env) + ': ' + sentences(verdict.detail) + ' sentences in "' + verdict.detail + '"',
    )
  }
})

test('no caveated probe detail names a control instead of a path', () => {
  // preflight.ts has no subject and may name no control; the cards carry the labels.
  for (const { env, verdict } of caveated) {
    assert.doesNotMatch(verdict.detail, CONTROL_LABEL, label(env) + ': names a control')
  }
})

test('the no-AR line puts the tripod path first, and the upload path second', () => {
  const noAr = caveated.filter(({ verdict }) => verdict.routeToUpload)
  assert.ok(noAr.length > 0, 'no dead end routes to the no-AR paths: the ordering check would prove nothing')
  for (const { env, verdict } of noAr) {
    assert.match(verdict.detail, TRIPOD_PATH, label(env) + ': must offer the path that works here')
    assert.match(verdict.detail, UPLOAD_PATH, label(env) + ': must still offer the upload path')
    assert.ok(
      verdict.detail.search(TRIPOD_PATH) < verdict.detail.search(UPLOAD_PATH),
      label(env) + ': the tripod path must come before the video and photos text',
    )
    // The upload's caveat: on first paint for a room it is only on cards behind "Other ways".
    assert.match(verdict.detail, /catalogues nothing/, label(env) + ': must keep the upload caveat')
  }
})

test('the insecure line says HTTPS and offers no capture path', () => {
  // Nothing runs on an insecure page, the tripod sweep included: it uploads to
  // this same origin, so offering it here would be a dead end dressed as a step.
  const insecure = caveated.filter(({ env }) => !env.secureContext)
  assert.ok(insecure.length > 0)
  for (const { env, verdict } of insecure) {
    assert.match(verdict.detail, /HTTPS/, label(env) + ': must name the link problem')
    assert.doesNotMatch(verdict.detail, TRIPOD_PATH, label(env) + ': must not offer a capture path')
    assert.doesNotMatch(verdict.detail, UPLOAD_PATH, label(env) + ': must not offer a capture path')
  }
})

test('the advertised line says the claim is unproven, and names the fallback', () => {
  // The one probe state main.ts writes this line for: a secure page, no engine,
  // and an immersive-ar session the browser advertises but has not proven.
  const advertised = caveated.filter(({ env }) => (
    env.secureContext && !env.xr8Loaded && env.webxrApi && env.immersiveArAdvertised
  ))
  assert.equal(advertised.length, 1)
  const verdict = advertised[0]!.verdict
  assert.equal(verdict.outcome, 'warming-up')
  assert.equal(verdict.canScan, true)
  assert.match(verdict.detail, /unproven/i, 'an advertised session is not a green light')
  assert.match(verdict.detail, /If it fails, other capture options need no AR/, 'the fallback is named')
})

test('a loaded engine writes nothing at boot', () => {
  // The start screen is clean for a phone that is about to work: no caveat, so
  // applyPreflightToStartScreen() returns before it touches #ar-help.
  for (const { env, verdict } of verdicts) {
    if (!env.secureContext || !env.xr8Loaded) continue
    assert.equal(verdict.caveat, false, label(env) + ': a loaded engine must not write a caveat')
  }
})
