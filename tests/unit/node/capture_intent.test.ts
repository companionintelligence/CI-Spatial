/**
 * Intent-based capture entry — src/capture/capture-intent.ts.
 *
 * The invariant these exist for is one sentence: whatever the device turns out
 * to be, the person is recommended a method that can actually run. The start
 * screen's old dead end was the opposite — a phone that failed the AR probe was
 * pointed at Upload Content, the weakest path, and a phone that had not been
 * probed yet was shown a live-scan card as its primary action whether or not it
 * would ever start.
 *
 * So the exhaustive sweep below (every subject x every shape of device) is the
 * point of this file, not a flourish: it is the only way to state "no device
 * dead-ends" as something checked rather than believed.
 *
 * Run: node --experimental-strip-types --test tests/unit/node/capture_intent.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUBJECT_CHOICES,
  SUBJECT_QUESTION,
  deviceFromProbe,
  resolveCapture,
  withoutLiveCapture,
  type Availability,
  type CaptureSubject,
  type DeviceCapture,
} from '../../../src/capture/capture-intent.ts'

const SUBJECTS: CaptureSubject[] = ['room', 'place', 'object', 'person']
const AVAILABILITIES: Availability[] = ['yes', 'no', 'unknown']

/** Every shape of device this can be handed: 3 x 3 x 2 = 18. */
function allDevices(): DeviceCapture[] {
  const out: DeviceCapture[] = []
  for (const secureContext of [true, false]) {
    for (const nativeAr of AVAILABILITIES) {
      for (const browserAr of AVAILABILITIES) out.push({ secureContext, nativeAr, browserAr })
    }
  }
  return out
}

const describe = (subject: CaptureSubject, device: DeviceCapture) =>
  `${subject} / secure=${device.secureContext} native=${device.nativeAr} browser=${device.browserAr}`

test('every subject on every device gets a method that can run', () => {
  // THE invariant. 72 combinations, and not one of them is allowed to answer
  // "nothing" — which is what the start screen did in practice by leaving a
  // failed-AR phone staring at a disabled primary card.
  for (const subject of SUBJECTS) {
    for (const device of allDevices()) {
      const rec = resolveCapture(subject, device)
      const where = describe(subject, device)
      assert.ok(rec.best, `${where}: no recommendation at all`)
      assert.ok(rec.best.title.length > 0, `${where}: recommendation has no title`)
      assert.ok(rec.best.action.length > 0, `${where}: recommendation says nothing to do`)
      assert.ok(rec.best.result.length > 0, `${where}: recommendation promises nothing`)
      assert.ok(
        ['start-ar-btn', 'start-tripod-card', 'start-upload-card'].includes(rec.best.control),
        `${where}: recommendation points at no control that exists`,
      )
    }
  }
})

test('a device with no live capture at all is never recommended one', () => {
  // The Beam Pro after its session rejected, and every desktop browser. The
  // old copy sent exactly this device to Upload Content; what it must never do
  // is send it to the path it has just been found unable to take.
  const dead: DeviceCapture = { secureContext: true, nativeAr: 'no', browserAr: 'no' }
  for (const subject of SUBJECTS) {
    const rec = resolveCapture(subject, dead)
    assert.ok(
      !rec.best.method.startsWith('live-'),
      `${subject}: recommended a live capture on a device that cannot`,
    )
    for (const alt of rec.alternatives) {
      assert.ok(
        !alt.method.startsWith('live-'),
        `${subject}: offered a live capture as an alternative on a device that cannot`,
      )
    }
    assert.ok(rec.note, `${subject}: must say why the live paths are not on offer`)
  }
})

test('an insecure page keeps every no-camera path and drops the live ones', () => {
  // main.ts returns before an AR runtime exists on an insecure context, so this
  // is a real state a user reaches. The photo paths run there anyway — they
  // collect through a file input — which is what stops that return being a
  // dead end.
  for (const subject of SUBJECTS) {
    const rec = resolveCapture(subject, { secureContext: false, nativeAr: 'yes', browserAr: 'yes' })
    assert.ok(!rec.best.method.startsWith('live-'), `${subject}: live capture over an insecure page`)
    assert.ok(rec.best.control !== 'start-ar-btn', `${subject}: pointed at the live control anyway`)
  }
})

test('the ladder is walked in order: proven live, then advertised live, then the rest', () => {
  const room = (nativeAr: Availability, browserAr: Availability) =>
    resolveCapture('room', { secureContext: true, nativeAr, browserAr }).best.method

  assert.equal(room('yes', 'yes'), 'live-native', 'the phone\'s own tracking is rung 1')
  assert.equal(room('no', 'yes'), 'live-browser', 'in-browser is rung 2')
  // A rung that has been seen to load beats one that is merely advertised —
  // "the API is present" is the exact claim the Beam Pro also makes.
  assert.equal(room('unknown', 'yes'), 'live-browser', 'proven beats advertised')
  assert.equal(room('unknown', 'no'), 'live-native', 'advertised still beats no live path')
  assert.equal(room('no', 'no'), 'tripod', 'rung 3 when both live rungs are dead')
})

test('an unproven live path is still recommended, and hedged in words', () => {
  // The counterpart to preflight's 'warming-up': never route a merely-slow or
  // merely-unproven phone away from a session that was about to work — but do
  // not let the screen imply it is settled either.
  const rec = resolveCapture('room', { secureContext: true, nativeAr: 'unknown', browserAr: 'no' })
  assert.equal(rec.best.method, 'live-native')
  assert.ok(rec.note, 'an unproven recommendation must carry its hedge')
  assert.match(rec.note!, /does not start/i)
  // And the hedge has to point somewhere, not just warn.
  assert.ok(rec.alternatives.length > 0, 'nothing to fall back to makes the hedge useless')
})

test('a settled, working phone gets no note', () => {
  // Same rule as PreflightVerdict.caveat: a sentence that adds nothing is
  // noise on a screen with a word budget.
  const rec = resolveCapture('room', { secureContext: true, nativeAr: 'yes', browserAr: 'yes' })
  assert.equal(rec.note, null)
})

test('each subject gets the method that actually suits it once live is gone', () => {
  const dead: DeviceCapture = { secureContext: true, nativeAr: 'no', browserAr: 'no' }
  // A room can be swept from tripod spots — 5 spots gave 36 of 36 usable
  // photos, against 3 of 17 from a single spot spun in place.
  assert.equal(resolveCapture('room', dead).best.method, 'tripod')
  // A whole place is a walk, not a tripod carried through every room: a
  // continuous walkthrough registered 48 of 48.
  assert.equal(resolveCapture('place', dead).best.method, 'video')
  // "Several spots around a small object" is just photographs of it.
  assert.equal(resolveCapture('object', dead).best.method, 'photos')
  assert.ok(
    !resolveCapture('object', dead).alternatives.some(a => a.method === 'tripod'),
    'a tripod loop around a single object is ceremony, not a method',
  )
  // A person cannot hold a pose for a walkthrough.
  assert.equal(resolveCapture('person', dead).best.method, 'video')
  assert.ok(
    !resolveCapture('person', dead).alternatives.some(a => a.method === 'tripod'),
    'nobody stands still for five tripod sweeps',
  )
})

test('alternatives never repeat the recommendation and never dead-end', () => {
  for (const subject of SUBJECTS) {
    for (const device of allDevices()) {
      const rec = resolveCapture(subject, device)
      const where = describe(subject, device)
      assert.ok(
        !rec.alternatives.some(alt => alt.method === rec.best.method),
        `${where}: the recommendation is repeated as its own alternative`,
      )
      if (!device.secureContext || (device.nativeAr === 'no' && device.browserAr === 'no')) {
        assert.ok(
          !rec.alternatives.some(alt => alt.control === 'start-ar-btn'),
          `${where}: offered a control that cannot run`,
        )
      }
    }
  }
})

test('only the live paths claim real-world size', () => {
  // The measurement this guards: a tripod or video capture reconstructs a room
  // that is an exact similarity of the real one and has no idea how big it is
  // until something of known length calibrates it. A wrong size is worse than
  // an absent one, because everything downstream trusts it.
  for (const subject of SUBJECTS) {
    for (const device of allDevices()) {
      const rec = resolveCapture(subject, device)
      for (const plan of [rec.best, ...rec.alternatives]) {
        const copy = `${plan.title} ${plan.action} ${plan.result}`
        const where = `${describe(subject, device)} / ${plan.method}`
        if (plan.method.startsWith('live-')) {
          assert.ok(plan.trueToSize, `${where}: a live capture does recover size`)
          continue
        }
        assert.equal(plan.trueToSize, false, `${where}: claims size it cannot have`)
        assert.doesNotMatch(
          copy,
          /true size|true to size|to scale|actual size|in met(re|er)s|life-?size/i,
          `${where}: copy promises a real-world size this path does not measure`,
        )
        assert.match(
          plan.result,
          /size is not measured/i,
          `${where}: a scale-free path must say so where the promise is made`,
        )
      }
    }
  }
})

test('an upload path still says it catalogues nothing', () => {
  // The same claim uploadExpectation() makes one tap later (measured: 48 of 48
  // frames registered, 0 of 29 objects placed). If the card promised more than
  // the dialog, the dialog would read as a retraction.
  const dead: DeviceCapture = { secureContext: true, nativeAr: 'no', browserAr: 'no' }
  for (const subject of ['room', 'place'] as CaptureSubject[]) {
    const rec = resolveCapture(subject, dead)
    const upload = [rec.best, ...rec.alternatives].filter(p => p.control === 'start-upload-card')
    assert.ok(upload.length > 0, `${subject}: no upload path offered at all`)
    for (const plan of upload) {
      assert.match(plan.result, /nothing catalogued/i, `${subject}/${plan.method}`)
    }
  }
})

test('no copy anywhere prints machinery at the user', () => {
  // Same rule as tests/unit/node/upload_expectation.test.ts, extended with the
  // runtime names this screen used to wear on its cards. "AR" is in the list
  // deliberately: whether this phone does AR is the question this whole flow
  // exists to stop asking.
  const banned = [
    /\bAR\b/, /\bSLAM\b/, /\bWebXR\b/, /8th ?Wall/i, /ARCore/i, /\bQuest\b/i,
    /\bpose\b/i, /\bSfM\b/i, /\bCOLMAP\b/i, /parallax/i, /panoptic/i, /\bsplat/i,
    /keyframe/i, /pipeline/i, /\bjob\b/i, /reconstruct(ion|or)\b/i, /\bmesh\b/i,
  ]
  for (const subject of SUBJECTS) {
    for (const device of allDevices()) {
      const rec = resolveCapture(subject, device)
      const copy = [rec.note ?? '', ...[rec.best, ...rec.alternatives]
        .map(p => `${p.title} ${p.action} ${p.result}`)].join(' ')
      for (const term of banned) {
        assert.doesNotMatch(copy, term, `${describe(subject, device)}: copy must not say ${term}`)
      }
    }
  }
  const question = `${SUBJECT_QUESTION} ${SUBJECT_CHOICES.map(c => c.label).join(' ')}`
  for (const term of banned) assert.doesNotMatch(question, term, `the question must not say ${term}`)
})

test('the question asks about the subject, and offers all four', () => {
  assert.match(SUBJECT_QUESTION, /what are you capturing/i)
  assert.deepEqual(SUBJECT_CHOICES.map(c => c.subject), SUBJECTS)
  // The chips sit in a row on a 393px screen; two words each is what fits.
  for (const choice of SUBJECT_CHOICES) {
    assert.ok(
      choice.label.trim().split(/\s+/).length <= 2,
      `"${choice.label}" is too long for the chip row`,
    )
  }
})

test('the probe is read for what it proves, not what it advertises', () => {
  // isSessionSupported('immersive-ar') answering true is NOT evidence — the
  // Beam Pro answers true with nothing installed behind it — so it may never
  // become 'yes'. The engine having loaded is a script that ran, so it may.
  const advertised = deviceFromProbe({
    secureContext: true, xr8Loaded: false, webxrApi: true, immersiveArAdvertised: true,
  })
  assert.equal(advertised.nativeAr, 'unknown', 'an advertised session is not a proven one')

  const declined = deviceFromProbe({
    secureContext: true, xr8Loaded: false, webxrApi: true, immersiveArAdvertised: false,
  })
  assert.equal(declined.nativeAr, 'no', 'the negative answer is the trustworthy one')

  const engine = deviceFromProbe({
    secureContext: true, xr8Loaded: true, webxrApi: false, immersiveArAdvertised: false,
  })
  assert.equal(engine.browserAr, 'yes')
  assert.equal(engine.nativeAr, 'no')

  const insecure = deviceFromProbe({
    secureContext: false, xr8Loaded: true, webxrApi: true, immersiveArAdvertised: true,
  })
  assert.equal(insecure.secureContext, false)
  // Still resolves to something usable — the reason the whole model keeps
  // secureContext rather than folding it into the two live fields.
  assert.ok(!resolveCapture('room', insecure).best.method.startsWith('live-'))
})

test('closing the live paths leaves a recommendation standing', () => {
  // The single funnel every dead end in main.ts goes through. What it must not
  // do is leave the screen with nothing on it — which is the whole bug: a
  // failed AR start used to disable the primary card and point at prose.
  const live: DeviceCapture = { secureContext: true, nativeAr: 'unknown', browserAr: 'yes' }
  const closed = withoutLiveCapture(live)
  assert.deepEqual(closed, { secureContext: true, nativeAr: 'no', browserAr: 'no' })
  for (const subject of SUBJECTS) {
    const rec = resolveCapture(subject, closed)
    assert.ok(rec.best, `${subject}: nothing left after the live paths closed`)
    assert.ok(!rec.best.method.startsWith('live-'), `${subject}: recommended a closed path`)
  }
  // Idempotent, because more than one dead end can fire on the same load: the
  // session rejects, and the boot's own catch runs afterwards.
  assert.deepEqual(withoutLiveCapture(closed), closed)
})
