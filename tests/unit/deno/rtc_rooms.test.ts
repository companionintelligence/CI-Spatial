/**
 * Deno unit tests for signalling room membership.
 *
 * Extracted from main.ts precisely so these can run without its top-level
 * side effects. The superseded-socket cases are the ones that matter: they
 * encode a real bug where a reconnecting peer's stale close event evicted its
 * own replacement and wedged the room for both sides.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@^1.0.0'
import {
  captureMemberCount,
  joinRoom,
  leaveRoom,
  MAX_TAKE_MEMBERS,
  previewPairReady,
  relayTargets,
  type RoomSocket,
  roster,
  type RtcRoom,
  WS_OPEN,
} from '../../../server/world/rtc_rooms.ts'

/** A socket stub that records what it was sent and whether it was closed. */
function fakeSocket(): RoomSocket & { sent: string[]; closed: boolean } {
  return {
    readyState: WS_OPEN,
    sent: [] as string[],
    closed: false,
    send(data: string) { this.sent.push(data) },
    close() { this.closed = true },
  }
}

const room = (): RtcRoom => ({ members: new Map() })

Deno.test('N capture members join and appear in the roster', () => {
  const r = room()
  for (const id of ['client-a', 'client-b', 'client-c']) {
    const res = joinRoom(r, 'capture', id, fakeSocket())
    assert(res.ok)
  }
  assertEquals(captureMemberCount(r), 3)
  assertEquals(roster(r).map(m => m.peerId), ['client-a', 'client-b', 'client-c'])
})

Deno.test('the member cap rejects a new client but never a reconnecting one', () => {
  const r = room()
  for (let i = 0; i < MAX_TAKE_MEMBERS; i++) {
    assert(joinRoom(r, 'capture', `client-${i}`, fakeSocket()).ok)
  }
  const overflow = joinRoom(r, 'capture', 'client-one-too-many', fakeSocket())
  assertFalse(overflow.ok)
  if (!overflow.ok) {
    assertEquals(overflow.reason, 'room-full')
    // Rejected explicitly, with something a device can actually show a user.
    assert(overflow.message.includes(String(MAX_TAKE_MEMBERS)))
  }
  // A member already in the room reclaiming its own slot is never refused —
  // refusing it would strand a device mid-take at the moment it is recovering.
  const reconnect = joinRoom(r, 'capture', 'client-0', fakeSocket())
  assert(reconnect.ok)
  assertEquals(captureMemberCount(r), MAX_TAKE_MEMBERS)
})

Deno.test('a reconnecting capture member reclaims its slot rather than doubling the roster', () => {
  const r = room()
  const first = fakeSocket()
  joinRoom(r, 'capture', 'client-a', first)
  const second = fakeSocket()
  const res = joinRoom(r, 'capture', 'client-a', second)
  assert(res.ok)
  assertEquals(res.ok && res.superseded?.ws, first)
  assertEquals(captureMemberCount(r), 1)
  assertEquals(roster(r).length, 1)
})

Deno.test('a superseded phone socket closing does not evict its live replacement', () => {
  const r = room()
  const stale = fakeSocket()
  const staleJoin = joinRoom(r, 'phone', null, stale)
  assert(staleJoin.ok)
  const fresh = fakeSocket()
  const freshJoin = joinRoom(r, 'phone', null, fresh)
  assert(freshJoin.ok)

  // The stale socket's close event arrives after the replacement registered.
  assertFalse(staleJoin.ok ? leaveRoom(r, staleJoin.peer) : true, 'stale close must be a no-op')
  assert(r.members.has('phone'), 'the live phone must still hold the slot')
  assertEquals(r.members.get('phone')?.ws, fresh)
})

Deno.test('a capture member leaving does not tear down a room that still holds a phone', () => {
  const r = room()
  joinRoom(r, 'phone', null, fakeSocket())
  const cap = joinRoom(r, 'capture', 'client-a', fakeSocket())
  assert(cap.ok)
  assert(cap.ok && leaveRoom(r, cap.peer))
  assertEquals(captureMemberCount(r), 0)
  assert(r.members.has('phone'), 'the preview phone must survive a capture member leaving')
})

Deno.test('previewPairReady ignores capture members entirely', () => {
  const r = room()
  joinRoom(r, 'capture', 'client-a', fakeSocket())
  joinRoom(r, 'capture', 'client-b', fakeSocket())
  assertFalse(previewPairReady(r), 'capture members negotiate nothing')
  joinRoom(r, 'phone', null, fakeSocket())
  assertFalse(previewPairReady(r))
  joinRoom(r, 'viewer', null, fakeSocket())
  assert(previewPairReady(r))
})

Deno.test('relay targets are everyone else, and skip closed sockets', () => {
  const r = room()
  const a = joinRoom(r, 'capture', 'client-a', fakeSocket())
  joinRoom(r, 'capture', 'client-b', fakeSocket())
  const closed = fakeSocket()
  closed.readyState = 3 // CLOSED
  joinRoom(r, 'capture', 'client-c', closed)

  assert(a.ok)
  const targets = a.ok ? relayTargets(r, a.peer) : []
  assertEquals(targets.map(t => t.peerId), ['client-b'])
})

Deno.test('singleton roles key on the role name, so two viewers cannot coexist', () => {
  const r = room()
  joinRoom(r, 'viewer', 'ignored-a', fakeSocket())
  joinRoom(r, 'viewer', 'ignored-b', fakeSocket())
  assertEquals(roster(r).filter(m => m.role === 'viewer').length, 1)
})
