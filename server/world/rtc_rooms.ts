/**
 * Signalling room membership — the data structure behind `/rtc-signal`.
 *
 * Extracted from `main.ts` (rather than left as module-level state there) for
 * the same reason `world_job_pump.ts` was: so the membership rules can run as
 * real unit tests without pulling in `main.ts`'s unconditional top-level side
 * effects (hostname resolution, VLM engine load, `Deno.serve`).
 *
 * ## Two room shapes, one relay
 *
 * The room used to be a two-slot map — exactly one `phone` and one `viewer` —
 * because its only job was a 1:1 phone→editor live preview. A take needs N
 * phones coordinating one recording, so the room is now a member map.
 *
 * `phone` and `viewer` stay **reserved singleton roles** with exactly their
 * previous semantics, because the live feed depends on them and a room can
 * legitimately hold a preview `phone` *and* several `capture` members at once.
 * Adding a second relay for takes would have been the parallel-systems
 * duplication ADR 0001 forbids.
 *
 * ## The superseded-socket rule
 *
 * A reconnecting peer arrives while its previous socket is still half-open, so
 * the incumbent is closed when the replacement registers, and — critically —
 * only the socket that *currently holds* a slot may clear it. Without that, the
 * superseded socket's later `close` event deletes the peer that replaced it and
 * wedges the room for both sides. That bug is why `tests/mock-rtc-room.spec.ts`
 * and `tests/mock-rtc-robustness.spec.ts` exist; it is preserved here verbatim
 * and extended to the keyed `capture` members.
 *
 * See docs/factory/10-4d-person-capture/0001-take-model-and-multi-client-rooms.md.
 */

/** The reserved 1:1 preview roles, plus the N-member capture role. */
export type RtcRole = 'phone' | 'viewer' | 'capture'


/**
 * Upper bound on `capture` members in one room.
 *
 * **Adopted, not measured.** Eight is well past any shoot we have run and
 * bounds the roster broadcast; nothing has characterised where the relay
 * actually degrades. Revisit if a real capture needs more members, or if a
 * roster broadcast is ever observed to be the bottleneck.
 */
export const MAX_TAKE_MEMBERS = 8

/** The minimum of `WebSocket` this module needs, so tests need no real socket. */
export interface RoomSocket {
  readyState: number
  send(data: string): void
  close(): void
}

/** OPEN, spelled out so this module does not depend on the `WebSocket` global. */
export const WS_OPEN = 1

export interface RtcPeer {
  ws: RoomSocket
  role: RtcRole
  /** Identity within the room. For singleton roles this is the role name itself. */
  peerId: string
  /** Optional human label shown in the roster, e.g. a device name. */
  label?: string
}

export interface RtcRoom {
  /** peerId → peer. Singleton roles occupy the key equal to their role name. */
  members: Map<string, RtcPeer>
}

export interface JoinAccepted {
  ok: true
  peer: RtcPeer
  /** The incumbent this join superseded, which the caller must close. */
  superseded: RtcPeer | null
}

export interface JoinRejected {
  ok: false
  reason: 'room-full'
  message: string
}

export type JoinResult = JoinAccepted | JoinRejected

/**
 * The key a peer occupies.
 *
 * Singleton roles key on the role name, so a second `phone` necessarily
 * supersedes the first. `capture` members key on their own `clientId`, so a
 * device that drops and reconnects reclaims its own slot instead of doubling
 * the roster.
 */
export function peerKey(role: RtcRole, clientId: string | null | undefined): string {
  if (role !== 'capture') return role
  return typeof clientId === 'string' && clientId.length > 0 ? clientId : 'capture-anonymous'
}

/** Live `capture` members in a room. */
export function captureMemberCount(room: RtcRoom): number {
  let n = 0
  for (const peer of room.members.values()) if (peer.role === 'capture') n++
  return n
}

/**
 * Register a peer, returning the incumbent it superseded (if any).
 *
 * The cap applies only to `capture` members, and only to *new* keys — a
 * reconnecting member reclaiming its own slot is never rejected, because
 * refusing it would strand a device mid-take at exactly the moment it is
 * trying to recover.
 */
export function joinRoom(
  room: RtcRoom,
  role: RtcRole,
  clientId: string | null | undefined,
  ws: RoomSocket,
  label?: string,
): JoinResult {
  const key = peerKey(role, clientId)
  const incumbent = room.members.get(key) ?? null

  if (role === 'capture' && !incumbent && captureMemberCount(room) >= MAX_TAKE_MEMBERS) {
    return {
      ok: false,
      reason: 'room-full',
      message: `This take already has ${MAX_TAKE_MEMBERS} devices. Stop one before adding another.`,
    }
  }

  const peer: RtcPeer = { ws, role, peerId: key, label }
  room.members.set(key, peer)
  return { ok: true, peer, superseded: incumbent && incumbent.ws !== ws ? incumbent : null }
}

/**
 * Remove a peer, but only if it still holds its slot.
 *
 * Returns whether the room actually changed. A `false` return means this socket
 * was superseded by a replacement that is still live, and the caller must **not**
 * tell the other side that the role left — it has not.
 */
export function leaveRoom(room: RtcRoom, peer: RtcPeer): boolean {
  if (room.members.get(peer.peerId) !== peer) return false
  room.members.delete(peer.peerId)
  return true
}

/** The peers a message from `peer` should be relayed to: everyone else in the room. */
export function relayTargets(room: RtcRoom, peer: RtcPeer): RtcPeer[] {
  const out: RtcPeer[] = []
  for (const other of room.members.values()) {
    if (other === peer) continue
    if (other.ws.readyState !== WS_OPEN) continue
    out.push(other)
  }
  return out
}

export interface RosterEntry {
  peerId: string
  role: RtcRole
  label?: string
}

/** The roster broadcast to every member on each join and leave. */
export function roster(room: RtcRoom): RosterEntry[] {
  return [...room.members.values()]
    .map(p => ({ peerId: p.peerId, role: p.role, ...(p.label ? { label: p.label } : {}) }))
    .sort((a, b) => a.peerId.localeCompare(b.peerId))
}

/**
 * Whether the 1:1 preview pair is complete.
 *
 * Unchanged from the original relay: `peer-ready` fires when a `phone` and a
 * `viewer` are both present. `capture` members are irrelevant to it — they
 * negotiate nothing.
 */
export function previewPairReady(room: RtcRoom): boolean {
  return room.members.has('phone') && room.members.has('viewer')
}

/** Send `payload` to every open socket in `peers`, swallowing closed-socket races. */
export function sendAll(peers: Iterable<RtcPeer>, payload: unknown): void {
  const text = JSON.stringify(payload)
  for (const peer of peers) {
    if (peer.ws.readyState !== WS_OPEN) continue
    try { peer.ws.send(text) } catch { /* closing */ }
  }
}
