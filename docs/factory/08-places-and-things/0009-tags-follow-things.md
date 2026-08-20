> **Type:** Backend + Frontend
> **Wave:** 08-places-and-things
> **Branch:** `feat/thing-scoped-tags`
> **Commit style:** `feat(tags): summary`
> **Design:** this ticket is the spec
> **Dependencies:** 0007 (`Thing` identity and the correspondence job) — hard. This
> ticket is the payoff for 0007 and cannot be built without `Thing` /
> `ThingObservation`. Independent of 0008; the two touch disjoint parts of `viewer.ts`.

## Goal

A user tags "my armchair" once and it stays tagged across later visits. Today the tag is
welded to the scan it was applied in, so the next walkthrough shows the same chair,
untagged, as if it had never been seen.

## Why it does not follow today

Tagging already works, and it already persists server-side. The problem is not
durability — it is *namespacing*. Verified by reading the source:

- A tag is stored as an `EditPatch` (`src/world/types.ts:131-144`: `patchId`, `worldId`,
  `scanId?`, `targetId`, `scope`, `transform?`, `label?`, `category?`, `notes?`,
  `visible?`, `actorId?`, `createdAt`), POSTed to `/worlds/:slug/patches`
  (`main.ts:3009-3040`), which mints
  `` `patch-${Date.now()}-${crypto.randomUUID().slice(0, 8)}` `` (`:3022`) and pushes
  onto `world.editPatches` (`:3035`).
- The tag itself travels as `category`. It is written by `saveObjectSemanticPatch`
  (`src/viewer/viewer.ts:1743-1755`) through `postEditPatch` (`:1757+`), and replayed on
  load by `applyStoredPatches` (`:877-898`), whose line `:893` is the whole mechanism:
  `if (patch.category) target.userData['tag'] = patch.category`.
- **`targetId` is scan-namespaced.** `stableObjectId()` (`:2328-2335`) returns
  `userData.objectId` when present, and detection LOD nodes are stamped with
  `` objectId: `${scanId}:${name}:lod` `` at `:837`. Every other node gets
  `` `${scanId}/${path}-${name}` `` from `assignStableObjectIds` (`:864-875`). There is
  no id in the system that names an object rather than an object-inside-a-scan.
- **`applyStoredPatches` also filters by scan** — `:881`:
  `if (patch.scanId && patch.scanId !== scan.scanId && patch.scanId !== scan.filename) continue`.
  This is the one place per-scan patch filtering already works, and it must keep working
  for genuinely scan-scoped patches (a scan transform at `:883-886`).

So a tag applied in session 1 has a `targetId` beginning with session 1's `scanId`, and
`findObjectByTargetId` (`:~2314-2326`) will never find a match inside session 2's tree.
Two correct mechanisms, composing into the wrong outcome.

Two further facts worth knowing before touching this:

- **The in-memory tag map is not the durable copy.** `SceneEditor._tags`
  (`src/viewer/editor.ts:95`) is keyed by `obj.uuid`, and `GLTFLoader` regenerates
  `uuid` on every load — so nothing in that map survives a page refresh. Durability comes
  entirely from `userData` plus the server patch. Do not "fix" tag durability by
  persisting `_tags`.
- **"Save Tags" saves almost nothing.** The `btn-flush-tags` handler
  (`viewer.ts:2530-2536`) calls `editor.flushTags()` (`editor.ts:276-289`), which only
  copies `_tags` back onto `userData` in memory, and then POSTs a patch for the **single
  selected object**. Every other tag survives only because each tag-chip click already
  POSTs its own patch on the spot (`viewer.ts:2475`). The button's name overpromises;
  this ticket should not make that worse.

## The fix

Make a tag resolve **through its `Thing`**, so it applies to every corresponded
observation of that object in every session.

### Pinned: one patch, resolved at read time

The owner's rule is *session-scoped in storage, propagated to corresponded observations*.
Implemented as:

- Extend `EditPatch.scope` with `'thing'` (see Schema). A thing-scoped patch has
  `targetId = thingId`.
- **Do not rewrite historical patches.** Existing `scope: 'object'` patches stay exactly
  as they are and keep working.
- **Do not write a Thing-scoped patch *alongside* a per-session one.** One patch per
  tagging action.
- The patch keeps its `scanId` — the session it was applied in — as provenance. That is
  the "session-scoped in storage" half.
- `applyStoredPatches` (`viewer.ts:877-898`) gains a `scope === 'thing'` branch that
  looks up the Thing's observations **in the scan currently being loaded** and applies
  `category` / `label` / `notes` to each observation's `targetId`. That is the
  "propagated to corresponded observations" half, and it happens at read time.

Why one patch resolved at read, rather than a second patch written alongside:

1. Two records can disagree, and there is no rule that says which one is true. One
   record cannot.
2. Patch volume in `worlds/*.json` is a named risk below; writing two patches per tag
   doubles the exact thing being worried about, in a file ADR 0004 already documents as
   write-contended.
3. Correspondence is *revisable* (0007 makes it user-correctable). A tag resolved at
   read time follows a corrected correspondence for free. A tag copied at write time is
   frozen against the correspondence as it was that day, and would need a backfill job
   every time somebody fixes a match.

### Pinned: precedence is most-recent-wins, with history kept

When the same Thing is tagged differently in two sessions, the winner is the patch with
the greatest `createdAt`. Ties break by array order — later index wins.

This is not a new rule; it is the rule `applyStoredPatches` already has. The loop at
`:880-897` iterates `world.editPatches` in order and *assigns* on each match
(`target.userData['tag'] = patch.category`, `:893`), so the last matching patch in the
array already wins today, and the server appends chronologically
(`world.editPatches.push(patch)`, `main.ts:3035`). **Reuse it. Do not add a sort, do not
add a "winning patch" field, do not add a tie-break heuristic.**

Older patches are never deleted — `world.editPatches` is append-only and is the audit
trail. The history is the array.

### Pinned: a tag must not strand when correspondence changes

If a `Thing` is later deleted, split, or the user breaks the correspondence, a
thing-scoped patch whose `targetId` names a vanished `thingId` would resolve to nothing —
the tag would silently disappear, which is the worst possible outcome for a durability
feature.

Resolution: a thing-scoped patch also records the object the user actually clicked, in
one new optional field, `EditPatch.originTargetId` — the scan-namespaced
`stableObjectId()` of that object. Resolution order in `applyStoredPatches`:

1. If a `Thing` with `targetId` exists → apply to every one of its observations in this
   scan. (The normal path.)
2. Else if `patch.scanId` matches this scan **and** `originTargetId` resolves through
   `findObjectByTargetId` → apply to that one object.

Step 2 is exactly today's `scope: 'object'` behaviour. So the worst case of a broken
correspondence is that the tag degrades to the single-session tag it would have been
without 0007 — it never strands, and it never silently vanishes.

## Non-goals

- No bulk re-tagging UI. No "apply this tag to every chair" affordance.
- No tag taxonomy changes. `SEMANTIC_TAGS` (`src/viewer/editor.ts:16-29`) stays exactly
  as it is — same 33 entries, same order, same `SemanticTag` type.
- No automatic tagging. A tag is always a user action; correspondence propagates it, it
  never invents one.
- Do not rewrite or migrate existing `scope: 'object'` patches. They keep working
  unchanged.
- Do not build the correspondence-correction UI. 0007 defines the schema for it; the UI
  is a later ticket.
- Do not persist `SceneEditor._tags`. It is keyed by a uuid `GLTFLoader` regenerates on
  every load — see above.
- Do not touch `applyStoredPatches`' existing scan-scoped branch (`:883-886`) or its
  `scanId` filter (`:881`) except to let thing-scoped patches past it.

## Pinned conventions

**ADR 0001** — this touches schema and a client↔server connection, so it states what it
reuses and what it searched.

| Existing | Where | How used |
| --- | --- | --- |
| `EditPatch` | `src/world/types.ts:131-144` | **extended**, not replaced: one new `scope` member and one new optional field. No parallel "tag record" type. |
| `EditPatch.scope` | `:136` — `'scan' \| 'object' \| 'point-selection' \| 'layer' \| 'world'` | gains `'thing'`. The union is already the extension point for "what does this patch name"; adding a member is the sanctioned move. |
| `EditPatch.category` | `:139` | **the tag**, unchanged. Do not add a `tag` field next to it. |
| `POST /worlds/:slug/patches` | `main.ts:3009-3040` | reused as-is; only its `scope` validation list (`:3017`) changes. No new route. |
| `applyStoredPatches` | `src/viewer/viewer.ts:877-898` | reused as the single replay path; gains one branch. |
| `stableObjectId()` | `:2328-2335` | reused for `originTargetId`. Do not invent a second id scheme. |
| `Thing` / `ThingObservation` | `src/world/types.ts` (from 0007) | the correspondence data; imported, not re-derived. |
| `saveObjectSemanticPatch` / `postEditPatch` | `:1743-1755`, `:1757+` | reused; `saveObjectSemanticPatch` learns to prefer a Thing when one exists. |
| `activeMemberForToken` | `main.ts:1742` (used by `denyUnlessWorldRole`, `:1735-1752`) | reused to populate `actorId` — see below. |

**What was searched before adding the `'thing'` scope member.** `EditPatch` is the only
persisted record of a user edit in the system; there is no other type that stores a
user-supplied label, category, or note against an object. `WorldDetection`
(`src/spatial/resolver.ts:22-28`) and `DetectObject` (`src/world/detect-objects.ts:35-61`)
are both detector *output* and carry nothing user-authored. `SceneEditor._tags`
(`editor.ts:95`) is in-memory and uuid-keyed. `ScanQualitySummary`
(`types.ts:107-122`) is derived metrics. So the choice was between adding a member to
`EditPatch.scope` and inventing a `ThingTag` record — and inventing one would mean two
places a tag can live, two replay paths, and two things to keep in sync, which is this
codebase's documented failure mode (the two `ScanManifest`s, the two job queues).
Extending the existing union is the ADR 0001 answer.

**ADR 0002** — `EditPatch`, `Thing`, and `ThingObservation` all live in
`src/world/types.ts`, which is Deno-API-free and is what the viewer already imports.
Nothing new is declared anywhere else. `npm run build` (`tsc --noEmit && vite build`) is
the gate that catches a mistake here; `deno task check` will not.

**ADR 0003** — no new job type. Tag resolution is read-time, in the viewer and in a pure
function; nothing about it needs a background pass. If a future ticket wants a
"materialise tags" job, it extends `WorldJob` — but this ticket does not need one.

**ADR 0004** — patches are written through `POST /worlds/:slug/patches`, which already
goes through `updateWorld()` (`main.ts:3020`). No new write path to `worlds/*.json`.

**Ids** — `patchId` keeps its existing shape,
`` `patch-${Date.now()}-${crypto.randomUUID().slice(0, 8)}` `` (`main.ts:3022`), assigned
server-side. The client never mints one.

**`actorId`** — the field exists (`types.ts:142`) and the *server* does populate it, but
never distinctly: `main.ts:3032` is
`actorId: objectKey(body.actorId) ?? 'local-editor'`, and the viewer never sends one
(it holds only an opaque `accessToken` from the query string, `viewer.ts:91`, and
decodes no identity from it). So every patch ever written says `'local-editor'`. Fix it
**server-side**, not client-side: `denyUnlessWorldRole` already resolves the request's
token to a `WorldMember` via `activeMemberForToken` (`main.ts:1742`), and
`WorldMember.memberId` (`types.ts:166`, minted as `` `${role}-${crypto.randomUUID()}` ``
at `main.ts:1444`) is a real identity. Prefer the authenticated member's `memberId`; fall
back to `'local-editor'` when there is no token. **Do not** trust a client-supplied
`body.actorId` for an authenticated request — that would let any editor write patches
attributed to someone else.

**Tests** — Deno `*.test.ts` at the repo root, and the new file **must be added to the
explicit list in `deno.json:8`**; that task names every test file individually, so an
unlisted file silently never runs. Playwright specs live in `tests/`, `chromium-mock`
project. Full gate is `npm run verify`.

## Before implementation

- Ticket 0007, and the `Thing` / `ThingObservation` shapes it landed
- `src/world/types.ts:131-144` — `EditPatch`, the type being extended
- `main.ts:3009-3040` — the patch route, its scope validation at `:3017`, its `patchId`
  and `actorId` assignment at `:3022` / `:3032`
- `main.ts:1735-1752` — `denyUnlessWorldRole` and `activeMemberForToken`
- `main.ts:1770-1775` — `applyPatchToWorld`; note it only acts on `scope === 'scan'`
  transforms, so a thing-scoped patch passes through it harmlessly
- `src/viewer/viewer.ts:877-898` — `applyStoredPatches`, the whole function, especially
  the `scanId` filter at `:881` and the assignment at `:893`
- `src/viewer/viewer.ts:1743-1755` — `saveObjectSemanticPatch`
- `src/viewer/viewer.ts:2328-2335` — `stableObjectId`, and `:837` for where the LOD
  `objectId` is stamped
- `src/viewer/viewer.ts:2465-2477` — the tag-chip click handler that POSTs on every click
- `src/viewer/viewer.ts:2530-2536` — the `btn-flush-tags` handler
- `src/viewer/editor.ts:16-29` (`SEMANTIC_TAGS`), `:95` (`_tags`), `:276-289`
  (`flushTags`), `:292-295` (`exportTagMap`)
- `docs/adr/0001-reuse-existing-domain-model.md`

## Open questions & answers

- Q: Should the goal be that a tag follows the object across visits? — A: Yes. **Tags
  follow the thing** once matched: session-scoped in storage, propagated to corresponded
  observations in later sessions. (owner, 2026-08-19)
- Q: Resolve at read time through the correspondence links, or write a Thing-scoped patch
  alongside the session one? — **A: resolve at read time, one patch.** Three reasons,
  pinned above: two records can disagree and nothing arbitrates; writing two patches per
  tag doubles the patch-volume risk in a file ADR 0004 already calls write-contended; and
  a read-time resolution follows a *corrected* correspondence for free, where a
  write-time copy would need a backfill job every time a user fixes a match. (decided
  here, 2026-08-19)
- Q: New `EditPatch.scope` member, or a parallel tag record? — A: **a `'thing'` member on
  the existing union.** The ADR 0001 search is in Pinned conventions. (2026-08-19)
- Q: Precedence when the same Thing is tagged differently in two sessions? — A:
  **most-recent-wins, older kept in history**, implemented by *not adding anything* —
  `applyStoredPatches`' existing in-order assignment loop already gives last-write-wins,
  and `world.editPatches` is append-only. (owner, 2026-08-19)
- Q: What happens when a correspondence is later corrected or broken? — A: the tag must
  not strand. Two-step resolution via the new `originTargetId`; worst case the tag
  degrades to today's single-session behaviour. Pinned above. (2026-08-19)
- Q: Should `actorId` finally be populated? — A: **Yes, server-side, from the
  authenticated member**, never from a client-supplied value on an authenticated request.
  (2026-08-19)
- Q: What about the dead `SceneEditor.exportTagMap()` (`editor.ts:292-295`)? — A:
  **Delete it.** Confirmed zero callers anywhere in the repo
  (`grep -rn exportTagMap` returns only its own declaration). Its docstring — "Return all
  tags as a serialisable map" — advertises a durability story that was never true (it
  serialises a uuid-keyed map whose keys `GLTFLoader` regenerates every load). Leaving a
  plausible-looking serialisation entry point next to a real one is how the next
  contributor picks the wrong one. (2026-08-19)
- Q: Should "Save Tags" (`btn-flush-tags`) be fixed to save *all* tags, not just the
  selected object's? — **OPEN, and out of scope for this ticket.** It is a real defect —
  the button POSTs one patch for one object (`viewer.ts:2530-2536`) — but it is
  orthogonal to correspondence and would muddy this diff. Recommend a separate ticket. Do
  not silently change it here.
- Q: Does a tag applied to a Thing appear on *past* sessions too, or only current and
  future ones? — **OPEN.** Read-time resolution makes it apply to *every* corresponded
  observation, past included, which is the simpler and probably correct behaviour ("this
  object is my armchair, and always was"). Confirm with the owner before the wave closes;
  if past sessions must be excluded, the filter is `observation.observedAt >=
  patch.createdAt` and it is a one-line change — but it makes the timeline in 0008 show a
  chair that is tagged in later sessions and untagged in earlier ones, which reads as a
  bug.
- Q: What if an object has no `Thing` yet — 0007 has not run, or it was left unmatched by
  the ambiguity rule? — A: fall back to writing today's `scope: 'object'` patch,
  unchanged. Nothing regresses for an unmatched object; it simply does not propagate.

## Files impacted

Changed:
- `src/world/types.ts` — `EditPatch.scope` gains `'thing'` (`:136`); `EditPatch` gains
  `originTargetId?: string` (`:131-144`)
- `main.ts` — the scope validation list in `POST /worlds/:slug/patches` (`:3017`);
  `originTargetId` accepted and stored (`:3020-3034`); `actorId` derived from the
  authenticated member instead of hardcoding `'local-editor'` (`:3032`)
- `src/viewer/viewer.ts` — `applyStoredPatches` gains the thing-scoped branch and the
  two-step fallback (`:877-898`); `saveObjectSemanticPatch` prefers a Thing and sends
  `originTargetId` (`:1743-1755`)
- `src/viewer/editor.ts` — delete `exportTagMap()` (`:292-295`)
- `docs/factory/atlas.html` — the `EditPatch / TransformPatch` schema row (`~:540`) gains
  the `thing` scope; the World Editor fcard (`~:442`) gets a before/after line on tags
  surviving a second visit

New:
- `thing_tags.ts` — the pure resolver shared by the tests and, if practical, by the
  viewer: given `(editPatches, things, thingObservations, scanId)`, return the
  `Map<targetId, {category?, label?, notes?}>` to apply. Root-level, no `Deno.*`, no
  `main.ts` import — same pattern as `thing_match.ts` (0007), `world_lock.ts`,
  `world_prune.ts`.
- `thing_tags.test.ts` — Deno unit tests, plus its entry in `deno.json:8`
- `tests/mock-thing-tags.spec.ts` — Playwright, `chromium-mock`

## Schema required

Two changes, both to the existing `EditPatch` in `src/world/types.ts:131-144`. No new
record type.

```ts
export interface EditPatch {
  patchId: string
  worldId: string
  scanId?: string
  /**
   * For scope 'thing' this is a Thing.thingId; for every other scope it keeps
   * its existing meaning (a scan-namespaced object id, a filename, a layer id).
   */
  targetId: string
  scope: 'scan' | 'object' | 'point-selection' | 'layer' | 'world' | 'thing'
  transform?: TransformPatch
  label?: string
  category?: string
  notes?: string
  visible?: boolean
  actorId?: string
  /**
   * Only meaningful for scope 'thing': the scan-namespaced stableObjectId() of the
   * object the user actually clicked, in the scan named by scanId. The fallback that
   * keeps the tag from stranding if the Thing is later deleted or split — resolution
   * degrades to exactly the scope:'object' behaviour. Absent for every other scope.
   */
  originTargetId?: string
  createdAt: string
}
```

- `scope` gains one member. The validation list at `main.ts:3017` must gain `'thing'`
  in the same commit or the route rejects it with 400.
- `originTargetId` is optional and absent on every existing patch, so no migration is
  needed and every read path must tolerate its absence.
- No change to `Thing` or `ThingObservation` — this ticket consumes 0007's schema, it
  does not extend it.
- No change to `WorldProject`.
- `applyPatchToWorld` (`main.ts:1770-1775`) needs no change: it acts only on
  `scope === 'scan'` transforms, so a thing-scoped patch falls through harmlessly.

## Definition of Done

- [ ] `EditPatch.scope` accepts `'thing'` end to end — type, route validation, storage,
      replay
- [ ] Tagging an object that has a `Thing` writes exactly **one** patch, scope `'thing'`,
      `targetId = thingId`, `scanId` = the session it was applied in,
      `originTargetId` = the clicked object's `stableObjectId()`
- [ ] Tagging an object with no `Thing` writes today's `scope: 'object'` patch, unchanged
- [ ] `applyStoredPatches` applies a thing-scoped tag to every corresponded observation
      in the scan being loaded
- [ ] A thing-scoped patch whose `Thing` no longer exists falls back to
      `(scanId, originTargetId)` and still applies — the tag never strands
- [ ] Conflicting tags on one Thing resolve most-recent-wins, with no new sort and no new
      field
- [ ] `applyStoredPatches`' `scanId` filter (`:881`) still correctly scopes genuinely
      scan-scoped patches — the scan-transform branch at `:883-886` is unaffected
- [ ] `actorId` carries the authenticated member's `memberId` when a valid world token is
      present, and `'local-editor'` otherwise; a client-supplied `body.actorId` is
      ignored for an authenticated request
- [ ] `SceneEditor.exportTagMap()` is deleted
- [ ] `SEMANTIC_TAGS` is byte-identical to before
- [ ] `deno task check`, `deno task test`, `npm run build`, `npm run verify` all pass

## Tests

Deno, in `thing_tags.test.ts` (registered in `deno.json:8`):

- [ ] A Thing-scoped tag resolves onto a later session's corresponded observation —
      given a `Thing` with observations in scan A and scan B and a `scope: 'thing'` patch
      carrying `category: 'chair'` and `scanId: A`, resolving for scan B yields the tag
      on B's observation `targetId`
- [ ] It also resolves onto its own session (scan A), not only later ones
- [ ] Breaking the correspondence does not strand the tag — remove the `Thing`, resolve
      for the patch's own `scanId`, and assert the tag lands on `originTargetId`
- [ ] Breaking the correspondence does **not** leak the tag into an unrelated scan — with
      the `Thing` gone, resolving for a different `scanId` yields nothing
- [ ] Conflict precedence — two `scope: 'thing'` patches on one Thing with different
      `category` values and different `createdAt`; the later one wins, and the earlier is
      still present in the input array (history is kept, not overwritten)
- [ ] Tie on `createdAt` — later array index wins, matching `applyStoredPatches`' existing
      in-order assignment
- [ ] A `scope: 'object'` patch behaves exactly as before, including the `scanId` filter:
      it applies in its own scan and not in another
- [ ] A patch with no `originTargetId` (as every pre-existing patch has none) does not
      throw
- [ ] An observation belonging to a Thing with no patch gets no tag

Deno, server:

- [ ] `POST /worlds/:slug/patches` with `scope: 'thing'` returns 200 and persists
      `originTargetId` (proves the `main.ts:3017` validation change)
- [ ] `POST` with an unknown scope still returns 400
- [ ] `actorId` on a token-authenticated POST equals the member's `memberId`, not
      `'local-editor'`, and a `body.actorId` supplied by the client is ignored

Playwright, `tests/mock-thing-tags.spec.ts`, `--project=chromium-mock`:

- [ ] A tag applied in one session shows on the next — seed a two-session world, run the
      correspondence job, tag an object in session 1, reload, and assert the corresponded
      object in session 2 carries the tag in its inspector
- [ ] Tagging an unmatched object still works and does not appear in the other session

```
deno task check
deno task test
npm run build
npm run verify

# the new spec, with the mock harness running
API_URL=http://localhost:8000 VITE_URL=http://localhost:5173 \
  npx playwright test --project=chromium-mock mock-thing-tags
```

## Acceptance Criteria

- [ ] Given a chair observed in sessions 1 and 2 and matched by 0007, When the user tags
      it "my armchair" in session 1, Then session 2's chair shows "my armchair" without
      any further action
- [ ] Given that tag, When the world file is inspected, Then there is exactly **one** new
      `EditPatch`, with `scope: 'thing'`
- [ ] Given the user later tags the same Thing differently in session 2, When the world
      reloads, Then the session-2 tag wins everywhere and the session-1 patch is still in
      `world.editPatches`
- [ ] Given a correspondence is later broken, When the world reloads, Then the tag still
      shows on the object it was originally applied to, and on no other
- [ ] Given an object with no `Thing`, When it is tagged, Then behaviour is identical to
      before this ticket
- [ ] Given a pre-existing `scope: 'object'` patch, When the world reloads, Then it
      applies exactly as it did before this ticket
- [ ] Given a patch POSTed with a valid editor token, Then its `actorId` is that member's
      `memberId`
- [ ] `deno task check`, `deno task test`, `npm run build`, and `npm run verify` pass

## Risks / potential issues

- **Risk:** A wrong correspondence from 0007 propagates a wrong tag into every future
  visit. **This is the compounding-error path of the whole wave** — 0007 asserts an
  identity, 0009 acts on it, and the error is now attached to an object the user
  believes they labelled. — **Mitigation:** two things, both already decided. 0007 is
  deliberately biased toward *not* matching (ambiguous candidates are left unmatched
  rather than guessed), so the common failure is a missing propagation, not a wrong one —
  and a missing propagation is visible and re-taggable, while a wrong one is silent. And
  correspondence is user-correctable by design; because this ticket resolves at read
  time, a correction takes effect immediately with no backfill. Do not add anything that
  caches a resolved tag onto disk — that would defeat both mitigations at once.
- **Risk:** Patch volume growth in `worlds/*.json`. `world.editPatches` is append-only
  (`main.ts:3035`), never trimmed, and every tag-chip click already POSTs a patch
  (`viewer.ts:2475`) — a user re-tagging one object ten times writes ten patches. ADR
  0004 documents this file as write-contended, and ADR 0003 had to cap `jobs[]` for
  exactly this reason. — **Mitigation:** the one-patch-per-action rule keeps this ticket
  from making it twice as bad, which is the most this ticket can honestly claim. A real
  bound on `editPatches` (coalescing same-target, same-actor patches, or an
  `MAX_EDIT_PATCHES`-style cap like `world_job_pump.ts:114`'s) is a separate ticket —
  note it, do not smuggle it in here, and do not trim patches as a side effect of this
  change, because a trimmed patch is a lost tag.
- **Risk:** `applyStoredPatches`' `scanId` filter (`viewer.ts:881`) is load-bearing for
  scan-scoped patches, and the new branch has to get past it without weakening it. A
  thing-scoped patch carries a `scanId` (its provenance session), so the existing filter
  would skip it in every *other* scan — which is precisely wrong for the propagation this
  ticket exists to build. — **Mitigation:** the filter must be made scope-aware, not
  removed: exempt `scope === 'thing'` explicitly and leave the predicate untouched for
  every other scope. Cover it with the "a `scope: 'object'` patch behaves exactly as
  before" test, which fails loudly if the filter is weakened rather than narrowed.
- **Risk:** Read-time resolution runs on every scan load, over `world.editPatches` ×
  `thingObservations`. On a world with thousands of patches this is quadratic-ish inside
  `loadScanIntoWorld`. — **Mitigation:** build the observation index once per world load
  (a `Map<thingId, ThingObservation[]>`) rather than per patch; the resolver in
  `thing_tags.ts` should take that index, not the raw arrays.
- **Risk:** Deleting `exportTagMap()` is a drive-by change in a ticket about something
  else. — **Mitigation:** it is four lines, has zero callers (verified), and its
  docstring actively misleads about tag durability — the exact subject of this ticket.
  Keep it as its own commit within the branch so it can be reverted independently.
- **Risk:** Changing `actorId` from a constant to a member id changes what every future
  patch says, and anything that reads `actorId === 'local-editor'` would break. —
  **Mitigation:** nothing reads `actorId` today (it is written at `main.ts:3032` and read
  nowhere). Confirm with a grep before landing, and keep `'local-editor'` as the
  anonymous fallback so untokened local use is unchanged.
- **Risk:** The past-sessions question (Open questions) is unresolved, and the two answers
  produce visibly different behaviour in 0008's timeline. — **Mitigation:** the default
  implemented here (apply to all corresponded observations, past included) is the simpler
  one and the one that reads correctly in a scrubbed timeline; the alternative is a
  one-line filter. Settle it before the wave closes, not after.

## Subtasks

1. [ ] Confirm 0007 has landed; read its final `Thing` / `ThingObservation` shapes
2. [ ] Extend `EditPatch` in `src/world/types.ts` (`scope` member + `originTargetId`) and
       confirm `npm run build` passes (ADR 0002's real gate)
3. [ ] Update the scope validation list at `main.ts:3017` and persist `originTargetId`;
       add the server tests
4. [ ] Derive `actorId` from `activeMemberForToken` at `main.ts:3032`, ignoring any
       client-supplied value on an authenticated request
5. [ ] Write `thing_tags.ts` — the pure resolver plus the per-world observation index —
       and `thing_tags.test.ts`; register the test in `deno.json:8`
6. [ ] Teach `saveObjectSemanticPatch` (`viewer.ts:1743-1755`) to look up the clicked
       object's Thing and, when one exists, write `scope: 'thing'` with `originTargetId`;
       otherwise write today's `scope: 'object'` patch unchanged
7. [ ] Add the thing-scoped branch to `applyStoredPatches` (`:877-898`), making the
       `scanId` filter at `:881` scope-aware rather than removing it
8. [ ] Delete `SceneEditor.exportTagMap()` as its own commit
9. [ ] Write `tests/mock-thing-tags.spec.ts`
10. [ ] Answer the past-sessions open question with the owner and record it above
11. [ ] Update `docs/factory/atlas.html` and run `npm run verify`
