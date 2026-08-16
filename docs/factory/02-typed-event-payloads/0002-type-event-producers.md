> **Type:** Backend
> **Wave:** 02-typed-event-payloads
> **Branch:** `refactor/type-event-producers`
> **Commit style:** `refactor(events): type-check every broadcast() call site`
> **Design:** implements 0001's `EventPayload` union and typed `broadcast()` signature
> **Dependencies:** 0001 (hard)

## Goal

Change `broadcast(event: Record<string, unknown>): void` (`main.ts:160`) to
`broadcast(payload: EventPayload): void` per 0001's design, and fix every call site
(`main.ts`, plus `jobs.ts`'s `onEvent` callback if `01-merge-jobs`/0005 left it in
place) so each is checked against its exact union member at compile time.

## Non-goals

- Do not change any wire value sent — same JSON goes over the wire; only the
  TypeScript type checking it changes.
- Do not touch `WebSocket.send()` internals, the `eventSockets` set, or the
  `/events` route handler itself — only `broadcast()`'s parameter type and its
  callers.
- Do not type the `/rtc-signal` relay — out of scope per 0001.

## Pinned conventions

- Per 0001's `EventPayload` union (`src/shared/events.ts`) — implement exactly what
  it specifies; if a call site doesn't fit any member cleanly, that's a signal 0001's
  design missed a field, not license to widen the type with `any`/`unknown`.
- ADR 0001 (reuse): import `EventPayload` from `src/shared/events.ts`; do not
  redeclare a narrower local type at any call site.

## Before implementation

- `src/shared/events.ts` as landed by 0001.
- Every `broadcast({ type: ...` call site in `main.ts` (and `jobs.ts` if still
  present post `01-merge-jobs`).

## Open questions & answers

- Q: none anticipated — this ticket implements 0001's design without new decisions.
  If one arises, resolve it here and note the resolution.

## Files impacted

- Changed: `main.ts` (broadcast signature + every call site's literal now
  type-checked; add explicit `EventPayload` member annotations where TS can't infer
  the discriminant from an inline object literal)
- Changed: `jobs.ts` (if it still exists post `01-merge-jobs`/0005 and still emits
  `'job-update'` via its own `onEvent` callback path)

## Schema required

None new — implements 0001's schema, doesn't design one.

## Definition of Done

- [ ] `broadcast()`'s parameter type is `EventPayload`, not `Record<string, unknown>`.
- [ ] `deno task check` passes with zero `any`/type-assertion escapes introduced to
      make a call site compile — a compile error here means the payload didn't match
      the design, which must be fixed at the call site or flagged back to 0001, not
      silenced.
- [ ] Every event type in `EVENT` (0006) has at least one real call site exercising
      its union member (if one is currently unused, note it — don't invent a fake
      call to satisfy a check).

## Tests

- [ ] `deno task check` passes (this ticket's main verification — a broken payload
      shape is a compile error now, not a runtime surprise).
- [ ] `deno task test` passes.
- [ ] `npm run test:mock` passes (exercises several broadcast paths: scan-added,
      world-job-update).

```
deno task check
deno task test
npm run test:mock
```

## Acceptance Criteria

- [ ] Given a future call site that sends a `world-job-update` payload missing
      `worldId`, when `deno task check` runs, then it fails at compile time.

## Risks / potential issues

- **Risk:** a legitimate call site needs a field 0001's design didn't anticipate,
  discovered only while implementing. — **Mitigation:** fix it by amending 0001's
  union in `src/shared/events.ts` as part of this ticket (small, additive) rather
  than working around it — the design ticket isn't sacred, catching real gaps is
  exactly what implementation is for; just don't silently widen to `unknown`.

## Subtasks

1. [ ] Change `broadcast()`'s signature.
2. [ ] Fix every call site to satisfy the union (add explicit type args/annotations
       where object-literal inference needs help).
3. [ ] Run `deno task check` to convergence — zero errors, zero introduced escapes.
4. [ ] Run full verification.
