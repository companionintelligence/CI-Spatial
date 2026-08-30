/**
 * The BLE link only gets to call itself connected once telemetry is actually flowing.
 *
 * The defect this guards against, found on 2026-08-30 while building multi-station dome
 * capture: after restarting `server/backend.mjs`, `transport.connect()` could reject with
 * noble's `Peripheral already connected` and never subscribe to a single GATT notification.
 * `/api/status` and the web UI then reported `connected: true` with `lastQuaternion: null`
 * — healthy-looking, and every closed-loop move silently running with no feedback. Recovery
 * was a full process restart; reconnecting did not help. That is this repo's recurring defect
 * class (ADR 0005 rule 3: a status value that claims something must be backed by a measurement),
 * so the fix is both a state that means what it says and an automatic recovery.
 *
 * The transport is driven here through an injected fake noble. That injection exists for this
 * test: importing @stoprocent/noble for real opens a raw HCI socket as an import side effect,
 * which would take the Bluetooth adapter away from a running backend mid-scan.
 *
 * Run: npm run test:gimbal:link
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  LINK,
  STREAM_STALE_MS,
  deriveLinkState,
  describeLink,
  isLinked,
  isStreaming,
  isStaleHandleError,
  isTransientLinkError,
} from '../../../subsystems/osmo-ble/protocol/link_state.mjs'
import { OsmoBleTransport } from '../../../subsystems/osmo-ble/server/ble-transport.mjs'
import { encodeFrame } from '../../../subsystems/osmo-ble/protocol/duml.mjs'

// ── The state machine, in isolation ──────────────────────────────────────────────────────────

test('link state: no handle is disconnected, whatever else is set', () => {
  assert.equal(deriveLinkState({ peripheralState: null }), LINK.DISCONNECTED)
  assert.equal(
    deriveLinkState({ peripheralState: 'disconnected', subscribedChars: ['fff4'], lastNotifyAt: Date.now() }),
    LINK.DISCONNECTED,
  )
})

test('link state: an attempt in flight is never reported as usable', () => {
  // The handle exists mid-connect, before discovery or subscription has run. Reporting that as
  // `linked` would let a caller write to a peripheral whose write candidates are not latched yet.
  assert.equal(deriveLinkState({ peripheralState: 'connected', connecting: true }), LINK.CONNECTING)
  assert.equal(isLinked(LINK.CONNECTING), false)
})

/** The exact shape of the reported defect: a GATT handle nothing was ever subscribed on. */
test('link state: a handle with zero subscriptions is linked, NOT streaming', () => {
  const state = deriveLinkState({ peripheralState: 'connected', subscribedChars: [] })
  assert.equal(state, LINK.LINKED)
  assert.equal(isStreaming(state), false, 'this is the state that used to report connected: true')
  assert.equal(isLinked(state), true, 'writes still work — stopMotors() depends on this')
})

test('link state: subscribed but silent is linked, not streaming', () => {
  const state = deriveLinkState({ peripheralState: 'connected', subscribedChars: ['fff4'], lastNotifyAt: 0 })
  assert.equal(state, LINK.LINKED)
})

test('link state: streaming needs a notification, and decays when they stop', () => {
  const now = 1_000_000
  const fresh = { peripheralState: 'connected', subscribedChars: ['fff4'], now }
  assert.equal(deriveLinkState({ ...fresh, lastNotifyAt: now - 40 }), LINK.STREAMING)
  assert.equal(deriveLinkState({ ...fresh, lastNotifyAt: now - STREAM_STALE_MS }), LINK.STREAMING)
  assert.equal(deriveLinkState({ ...fresh, lastNotifyAt: now - STREAM_STALE_MS - 1 }), LINK.LINKED)
})

/**
 * Measured on a real OM6, idle, 2026-08-30: 500 notifications in 15.06s, max gap 75ms. The
 * window has to clear that by a wide margin or ordinary jitter reads as a dead link.
 */
test('link state: the stale window is far wider than the observed worst-case gap', () => {
  assert.ok(STREAM_STALE_MS >= 75 * 10, `${STREAM_STALE_MS}ms must dwarf the 75ms worst observed gap`)
})

test('link state: the "linked but not streaming" description says what to do', () => {
  const detail = describeLink(LINK.LINKED, { subscribedChars: [] })
  assert.match(detail, /linked but not streaming/)
  assert.match(detail, /no telemetry will ever arrive/)
  assert.match(detail, /[Rr]econnect/)
})

// ── Recognizing the stale handle ─────────────────────────────────────────────────────────────

test('stale handle: noble\'s exact message is recognized, unrelated failures are not', () => {
  assert.equal(isStaleHandleError(new Error('Peripheral already connected')), true)
  assert.equal(isStaleHandleError(new Error('peripheral  already   connected')), true)
  assert.equal(isStaleHandleError(new Error('Connection Rejected due to Limited Resources (0xd)')), false)
  assert.equal(isStaleHandleError(new Error('Osmo service (fff0) not found on this device.')), false)
  assert.equal(isStaleHandleError(null), false)
})

test('transient: a link that drops mid-setup is retryable, a wrong device is not', () => {
  // noble rejects an in-flight GATT operation as `Disconnected <hci reason>`. 62 is 0x3E,
  // "Connection Failed to be Established" — measured on real hardware as the outcome of roughly
  // one re-open in three straight after dropping a stale handle.
  assert.equal(isTransientLinkError(new Error('Disconnected 62')), true)
  assert.equal(isTransientLinkError(new Error('Peripheral already connected')), true)
  assert.equal(isTransientLinkError(new Error('Osmo service (fff0) not found on this device.')), false)
  assert.equal(isTransientLinkError(new Error('no notify characteristic accepted a subscription')), false)
  assert.equal(isTransientLinkError(null), false)
})

test('transient: a wrapped error is classified on its cause, not its wrapper', () => {
  // connect() wraps a failed stale-handle recovery in a longer, actionable message. Without the
  // cause hop that wrapper would hide a retryable failure behind unretryable-looking text.
  const wrapped = new Error('connect(): abc was held by a stale BLE handle …: Disconnected 62. …', {
    cause: new Error('Disconnected 62'),
  })
  assert.equal(isTransientLinkError(wrapped), true)
})

// ── A fake noble, mirroring the semantics the real one has ───────────────────────────────────

class FakeCharacteristic extends EventEmitter {
  uuid: string
  properties: string[]
  subscribeError: Error | null = null
  subscribed = false
  writes: Buffer[] = []

  constructor(uuid: string, properties: string[]) {
    super()
    this.uuid = uuid
    this.properties = properties
  }

  async subscribeAsync() {
    if (this.subscribeError) throw this.subscribeError
    this.subscribed = true
  }

  async writeAsync(data: Buffer) {
    this.writes.push(data)
  }
}

class FakeService {
  uuid: string
  chars: FakeCharacteristic[]
  constructor(uuid: string, chars: FakeCharacteristic[]) {
    this.uuid = uuid
    this.chars = chars
  }
  async discoverCharacteristicsAsync() {
    return this.chars
  }
}

class FakePeripheral extends EventEmitter {
  id: string
  state = 'disconnected'
  services: FakeService[]
  disconnectCalls = 0

  constructor(id: string, services: FakeService[]) {
    super()
    this.id = id
    this.services = services
  }

  async discoverServicesAsync() {
    return this.services
  }

  /** Mirrors noble: 'disconnecting' synchronously, 'disconnected' + event on the HCI reply. */
  disconnect() {
    this.disconnectCalls++
    this.state = 'disconnecting'
    setTimeout(() => {
      this.state = 'disconnected'
      this.emit('disconnect', 'local')
    }, 0)
  }

  async disconnectAsync() {
    return new Promise<void>((resolve) => {
      this.once('disconnect', () => resolve())
      this.disconnect()
    })
  }
}

class FakeNoble {
  peripherals = new Map<string, FakePeripheral>()
  connectAttempts: string[] = []

  async waitForPoweredOnAsync() {}

  /**
   * Noble#connect's real contract, including the branch this whole file is about: an
   * already-connected peripheral is rejected AND handed back through the callback — the handle
   * connectAsync() throws away and the recovery path needs.
   */
  connect(id: string, _params: unknown, cb: (err: Error | null, p: FakePeripheral | null) => void) {
    this.connectAttempts.push(id)
    const p = this.peripherals.get(id)
    if (!p) return cb(new Error(`Invalid peripheral ID or Address ${id}`), null)
    if (p.state === 'connected') return cb(new Error('Peripheral already connected'), p)
    setTimeout(() => {
      p.state = 'connected'
      cb(null, p)
    }, 0)
  }

  disconnect(id: string) {
    this.peripherals.get(id)?.disconnect()
  }
}

const PERIPHERAL_ID = 'aabbccddeeff'

function makeNoble({ services }: { services?: FakeService[] } = {}) {
  const fff0 = new FakeCharacteristic('fff0', ['read', 'notify'])
  const fff3 = new FakeCharacteristic('fff3', ['write', 'notify'])
  const fff4 = new FakeCharacteristic('fff4', ['notify'])
  const fff5 = new FakeCharacteristic('fff5', ['writeWithoutResponse'])
  const noble = new FakeNoble()
  const peripheral = new FakePeripheral(
    PERIPHERAL_ID,
    services ?? [new FakeService('fff0', [fff0, fff3, fff4, fff5])],
  )
  noble.peripherals.set(PERIPHERAL_ID, peripheral)
  return { noble, peripheral, chars: { fff0, fff3, fff4, fff5 } }
}

/** A real, CRC-valid quaternion notification (cmdSet 0x4 / cmdId 0x5, quaternion at offset 24). */
function quaternionNotification(): Buffer {
  const payload = new Uint8Array(40)
  const view = new DataView(payload.buffer, 24, 16)
  view.setFloat32(0, 0.7011, true)
  view.setFloat32(4, -0.7011, true)
  view.setFloat32(8, -0.0916, true)
  view.setFloat32(12, 0.0916, true)
  return Buffer.from(encodeFrame({ sender: 4, receiver: 2, msgId: 1, flags: 0, cmdSet: 0x4, cmdId: 0x5, payload }))
}

// ── The defect, end to end ───────────────────────────────────────────────────────────────────

/**
 * The reported failure. noble adopts links it did not open (its Linux HCI bindings see connect
 * events for every link on the adapter), so the link left behind by the previous backend
 * process is already `connected` in a freshly started one — and the first connect() of the new
 * process is rejected against a handle it has never discovered services on.
 */
test('already-connected: the stale handle is dropped and the link re-established', async () => {
  const { noble, peripheral, chars } = makeNoble()
  peripheral.state = 'connected' // left over from the process that just restarted

  const transport = new OsmoBleTransport({ noble })
  const recoveries: unknown[] = []
  transport.on('link-recovery', (e: unknown) => recoveries.push(e))

  const info = await transport.connect(PERIPHERAL_ID)

  assert.equal(recoveries.length, 1, 'the recovery must be announced, not silent')
  assert.equal(peripheral.disconnectCalls, 1, 'the stale handle must be dropped, not reused')
  assert.equal(noble.connectAttempts.length, 2, 'and the link re-established afterwards')
  assert.deepEqual(info.subscribedChars, ['fff0', 'fff3', 'fff4'], 'every notify char is subscribed')
  assert.equal(chars.fff4.subscribed, true, 'fff4 is the one that actually carries telemetry')
})

test('already-connected: a re-established link reports linked, and only streams once bytes arrive', async () => {
  const { noble, peripheral, chars } = makeNoble()
  peripheral.state = 'connected'
  const transport = new OsmoBleTransport({ noble })

  const info = await transport.connect(PERIPHERAL_ID)

  // The exact claim the old code got wrong: connect() returning is not telemetry.
  assert.equal(info.link, LINK.LINKED)
  assert.equal(transport.connected, false, 'no notification has arrived yet')
  assert.equal(transport.linked, true, 'but commands can be written — stopMotors() must still work')
  assert.equal(transport.lastQuaternion, null)

  chars.fff4.emit('data', quaternionNotification())

  assert.equal(transport.linkState, LINK.STREAMING)
  assert.equal(transport.connected, true, 'connected now means what it says')
  assert.ok(transport.lastQuaternion, 'and the pose the control loop steers on has arrived')
  assert.ok(transport.lastNotifyAt > 0)
})

test('already-connected: recovery is not attempted for an unrelated connect failure', async () => {
  const { noble } = makeNoble()
  const transport = new OsmoBleTransport({ noble })

  await assert.rejects(
    () => transport.connect('not-a-real-peripheral'),
    /Invalid peripheral ID/,
  )
  assert.equal(noble.connectAttempts.length, 1, 'no blind retry against an error that will not recover')
  assert.equal(transport.linkState, LINK.DISCONNECTED)
})

// ── No half-open link may ever report itself as connected ────────────────────────────────────

test('half-open: a connect that fails after the handle exists leaves nothing reporting connected', async () => {
  // Service discovery succeeds but the device is not an Osmo — connect() throws AFTER noble has
  // handed over a live handle. This is the path that used to leave `_peripheral` assigned.
  const { noble, peripheral } = makeNoble({ services: [new FakeService('180a', [])] })
  const transport = new OsmoBleTransport({ noble })

  await assert.rejects(() => transport.connect(PERIPHERAL_ID), /Osmo service \(fff0\) not found/)

  assert.equal(transport.connected, false)
  assert.equal(transport.linked, false, 'and not merely "not streaming" — the handle is gone too')
  assert.equal(transport.linkState, LINK.DISCONNECTED)
  assert.ok(peripheral.disconnectCalls > 0, 'the handle is torn back down, not left dangling')
})

/**
 * The reported sequence, end to end. Pre-fix: connect #1 kept the handle and failed in
 * characteristic discovery, leaving `connected: true` / `lastQuaternion: null`; connect #2 and
 * every retry after it hit `Peripheral already connected` against that same handle, so nothing
 * short of restarting the process recovered. Post-fix the first failure gives the handle back,
 * and the retry — recovering from the stale handle if one is still there — reconnects for real.
 */
test('half-open: a failed connect leaves a retry able to recover, not wedged', async () => {
  const { noble, peripheral, chars } = makeNoble()
  const transport = new OsmoBleTransport({ noble })

  // Fail characteristic discovery exactly once — the first connect gets an ATT timeout on a
  // handle noble has already handed over, the second finds the device healthy again.
  const service = peripheral.services[0]
  const realDiscover = service.discoverCharacteristicsAsync.bind(service)
  service.discoverCharacteristicsAsync = async () => {
    service.discoverCharacteristicsAsync = realDiscover
    throw new Error('ATT timeout')
  }

  await assert.rejects(() => transport.connect(PERIPHERAL_ID), /ATT timeout/)
  assert.equal(transport.connected, false, 'the failed connect claims nothing')
  assert.equal(transport.linked, false)

  const info = await transport.connect(PERIPHERAL_ID)
  assert.deepEqual(info.subscribedChars, ['fff0', 'fff3', 'fff4'])
  chars.fff4.emit('data', quaternionNotification())
  assert.equal(transport.connected, true, 'a reconnect recovers — no process restart needed')
})

test('half-open: a link nothing could subscribe on is refused, with the reason', async () => {
  const { noble, chars } = makeNoble()
  for (const ch of [chars.fff0, chars.fff3, chars.fff4]) {
    ch.subscribeError = new Error('Notify not permitted')
  }
  const transport = new OsmoBleTransport({ noble })

  await assert.rejects(
    () => transport.connect(PERIPHERAL_ID),
    /no notify characteristic accepted a subscription/,
  )
  assert.equal(transport.connected, false)
  assert.equal(transport.linked, false)
})

test('half-open: one characteristic refusing does not cost the whole stream', async () => {
  // fff0 has no observed role and is subscribed defensively; fff4 is the telemetry source.
  // Losing the defensive one must not take the real one down with it.
  const { noble, chars } = makeNoble()
  chars.fff0.subscribeError = new Error('Notify not permitted')
  const transport = new OsmoBleTransport({ noble })

  const info = await transport.connect(PERIPHERAL_ID)

  assert.deepEqual(info.subscribedChars, ['fff3', 'fff4'])
  assert.equal(info.subscribeFailures.length, 1)
  chars.fff4.emit('data', quaternionNotification())
  assert.equal(transport.connected, true)
})

// ── Reconnect hygiene ────────────────────────────────────────────────────────────────────────

test('retry: a link that drops mid-setup is retried rather than surfaced', async () => {
  // The measured real-hardware race: the re-opened link dies during discovery. One retry gets it.
  const { noble, peripheral, chars } = makeNoble()
  const transport = new OsmoBleTransport({ noble })
  const recoveries: any[] = []
  transport.on('link-recovery', (e: any) => recoveries.push(e))

  const service = peripheral.services[0]
  const realDiscover = service.discoverCharacteristicsAsync.bind(service)
  let drops = 2
  service.discoverCharacteristicsAsync = async () => {
    if (drops-- <= 0) return realDiscover()
    throw new Error('Disconnected 62')
  }

  const info = await transport.connect(PERIPHERAL_ID)

  assert.equal(info.attempt, 3, 'two attempts lost the link, the third held it')
  assert.deepEqual(recoveries.map((r) => r.action), ['retry', 'retry'])
  chars.fff4.emit('data', quaternionNotification())
  assert.equal(transport.connected, true)
})

test('retry: a fault a retry cannot fix fails on the first attempt', async () => {
  // A wedged gimbal needs the hardware button-combo reset. Retrying only delays the operator
  // finding that out, so this must not burn attempts.
  const { noble, peripheral } = makeNoble({ services: [new FakeService('180a', [])] })
  const transport = new OsmoBleTransport({ noble })

  await assert.rejects(() => transport.connect(PERIPHERAL_ID), /Osmo service \(fff0\) not found/)
  assert.equal(noble.connectAttempts.length, 1)
  assert.equal(peripheral.disconnectCalls, 1)
})

test('retry: a bounded run of failures still gives up, with the real error', async () => {
  const { noble, peripheral } = makeNoble()
  const transport = new OsmoBleTransport({ noble })
  peripheral.discoverServicesAsync = async () => {
    throw new Error('Disconnected 62')
  }

  await assert.rejects(() => transport.connect(PERIPHERAL_ID, { attempts: 2 }), /Disconnected 62/)
  assert.equal(transport.linkState, LINK.DISCONNECTED)
})

test('reconnect: notification handlers do not stack across connects', async () => {
  // noble reuses its Characteristic objects, so a handler left attached would decode every
  // frame twice per reconnect — and the frame history is what the whole subsystem debugs from.
  const { noble, chars } = makeNoble()
  const transport = new OsmoBleTransport({ noble })

  await transport.connect(PERIPHERAL_ID)
  await transport.disconnect()
  await transport.connect(PERIPHERAL_ID)

  assert.equal(chars.fff4.listenerCount('data'), 1)

  chars.fff4.emit('data', quaternionNotification())
  assert.equal(transport.frames.length, 1, 'one notification, one decoded frame')
})

test('reconnect: disconnecting clears the pose, so no stale reading survives the link', async () => {
  const { noble, chars } = makeNoble()
  const transport = new OsmoBleTransport({ noble })

  await transport.connect(PERIPHERAL_ID)
  chars.fff4.emit('data', quaternionNotification())
  assert.ok(transport.lastQuaternion)

  await transport.disconnect()

  assert.equal(transport.lastQuaternion, null, 'a pose from a link that is gone is not a reading')
  assert.equal(transport.lastQuaternionAt, 0)
  assert.equal(transport.lastNotifyAt, 0)
  assert.equal(transport.linkState, LINK.DISCONNECTED)
})

test('reconnect: a link that goes quiet stops claiming to stream but stays writable', async () => {
  const { noble, chars } = makeNoble()
  const transport = new OsmoBleTransport({ noble })
  await transport.connect(PERIPHERAL_ID)
  chars.fff4.emit('data', quaternionNotification())
  assert.equal(transport.connected, true)

  transport.lastNotifyAt = Date.now() - STREAM_STALE_MS - 1000 // the gimbal stopped reporting

  assert.equal(transport.connected, false, 'closed-loop moves must not run against this')
  assert.equal(transport.linked, true, 'but a stop command must still be able to go out')
  assert.match(transport.linkDetail, /linked but not streaming/)
})
