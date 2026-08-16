# Architecture Decision Records

Decisions that outlive a single ticket live here. Each ADR is an immutable,
numbered record of one significant choice: the context, the decision, and its
consequences. Supersede an ADR with a newer one rather than editing history.

- New ADR: `scripts/factory/factory.sh adr new "Short title" --issue 42`
- Template: [`0000-adr-template.md`](0000-adr-template.md)

When a ticket's decision comment (`🧭 Decision`) captures something that will
shape future work, promote it to an ADR and link back to the issue.

## Index

<!-- Add a line per ADR: `- [NNNN. Title](NNNN-title.md) — Status` -->

- [0001. Reuse existing schema, variables, and connections — organize around things and places](0001-reuse-existing-domain-model.md) — Accepted
- [0002. Shared types importable by the browser must live in Deno-API-free files](0002-shared-types-importable-by-the-browser-must-live-in-deno-api-free-files.md) — Accepted
- [0003. Merged job system: WorldJob absorbs JobQueue](0003-merged-job-system.md) — Accepted
