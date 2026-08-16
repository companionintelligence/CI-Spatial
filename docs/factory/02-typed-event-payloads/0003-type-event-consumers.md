> **Type:** Frontend
> **Wave:** 02-typed-event-payloads
> **Branch:** `refactor/type-event-consumers`
> **Commit style:** `refactor(events): narrow consumers against EventPayload`
> **Design:** implements 0001's `EventPayload` union
> **Dependencies:** 0002 (hard — needs the producer side actually emitting the typed shape)

## Goal

`src/viewer/viewer.ts`'s event-consumer switch (`msg['type'] === '...'` string
matching, currently untyped `Record<string, unknown>` reads) and
`scripts/logs-watch.mjs`'s `client-log` match both read `/events` messages with no
compile-time link to what the server actually sends. Import `EventPayload` from
`src/shared/events.ts` in the viewer (a real TS import) and narrow against it;
annotate `logs-watch.mjs` (plain `.mjs`, no build step) with JSDoc `@type` referencing
the same shape so an editor still catches drift, without adding a TS toolchain to a
standalone Node script.

## Non-goals

- Do not change the viewer's actual event-handling *behavior* — same branches, same
  UI updates, only typed instead of stringly-matched.
- Do not add TypeScript compilation to `scripts/logs-watch.mjs` or any other
  `.mjs` tooling script — JSDoc annotations only, consistent with how this repo's
  other `.mjs` scripts are typed (or deliberately untyped) today.
- Do not add a runtime validation layer (e.g. Zod parsing incoming WS messages) — the
  server and client are the same deploy unit; this is compile-time safety between two
  halves of one build, not defense against an untrusted wire.

## Pinned conventions

- Per ADR 0001: import `EventPayload` from `src/shared/events.ts` (same module 0002
  imports it from) — no separate consumer-side copy of the union.
- `viewer.ts`'s switch becomes a `switch (msg.type)` (or an `if`/`else if` chain, if
  that's the file's existing idiom — match what's there, per 0002's own general
  "match existing convention" discipline) with TypeScript narrowing `msg` to the
  correct union member per branch, so each branch's field access is checked.

## Before implementation

- `src/viewer/viewer.ts`'s full event-consumer block (`msg['type'] === ...` branches)
  and the WebSocket message-receive handler feeding it.
- `scripts/logs-watch.mjs`'s `client-log` match and any other field it reads off a
  message.
- `src/shared/events.ts` as it stands after 0002.

## Open questions & answers

- Q: How does the raw `JSON.parse()`'d WebSocket message become typed as
  `EventPayload` at the boundary (a cast, or a runtime discriminant check first)? —
  A: a single `as EventPayload` cast at the one point the message is parsed, with a
  comment noting server and client are the same build and this is a same-process
  contract, not external input — matches the Non-goals' "no runtime validation"
  decision (decided by ticket author, 2026-08-16).

## Files impacted

- Changed: `src/viewer/viewer.ts` (typed event switch)
- Changed: `scripts/logs-watch.mjs` (JSDoc annotation only)

## Schema required

None new — consumes 0001's schema.

## Definition of Done

- [ ] `viewer.ts`'s event switch narrows against `EventPayload`; every branch's field
      access is compile-checked, not a loose `msg['field']` read.
- [ ] The known-dead `'job-update'` branch this wave's earlier audit almost
      misdiagnosed (it's real, fed by `01-merge-jobs`/0004's shim) now has a typed,
      provably-correct payload shape instead of an untyped string match — this is the
      concrete "never again" outcome for that exact class of mistake.
- [ ] `logs-watch.mjs` carries a JSDoc type reference to the shared union.

## Tests

- [ ] `deno task check` passes (viewer.ts is checked as part of the app build).
- [ ] `npm run build` succeeds (Vite/TS build of the viewer).
- [ ] `npm run test:mock` passes (Playwright specs exercising the viewer's live
      job/scan update UI).
- [ ] Manual: `npm start`, upload a scan, confirm the viewer's live update still
      fires exactly as before (same check used throughout this wave and
      `01-merge-jobs`).

```
deno task check
npm run build
npm run test:mock
```

## Acceptance Criteria

- [ ] Given a future producer-side field rename in `EventPayload`, when the viewer is
      type-checked, then every consumer branch reading the renamed field fails to
      compile instead of silently reading `undefined` at runtime.

## Risks / potential issues

- **Risk:** the single `as EventPayload` cast point is a real trust boundary even
  within one build (e.g. a future non-TS producer, or a message crafted by a
  malicious client hitting `/events` directly — it's a public-ish WS endpoint per
  `main.ts`'s CORS allowlist). — **Mitigation:** explicitly out of scope per
  Non-goals (no runtime validation) — logged here so it's a deliberate, visible
  tradeoff rather than an unnoticed gap; a future ticket can add runtime validation
  if this repo's threat model changes.

## Subtasks

1. [ ] Type the viewer's WS message parse point with the single cast + comment.
2. [ ] Convert the event switch to narrow against `EventPayload`.
3. [ ] Add the JSDoc annotation to `logs-watch.mjs`.
4. [ ] Run full verification including the manual scan-upload check.
