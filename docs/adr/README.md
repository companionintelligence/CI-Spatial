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
- [0004. World-file writes are serialized per slug](0004-world-file-writes-are-serialized-per-slug.md) — Accepted
- [0005. Spatial frames are established by geometry and verified by measurement](0005-spatial-frames-are-established-by-geometry-and-verified-by-measurement.md) — Proposed
- [0006. A person capture is a calibrated take; view densification is a subsystem](0006-person-capture-is-a-calibrated-take-and-densification-is-a-subsystem.md) — Accepted
- [0007. Splat backends are selectable; a rotation-only sweep is not a reconstruction capture](0007-splat-backends-are-selectable-and-a-rotation-only-sweep-is-not-a-reconstruction-capture.md) — Proposed
- [0008. Station-dome capture is a supported path, and its baseline comes from moving the tripod](0008-station-dome-capture-is-a-supported-path-and-its-baseline-comes-from-moving-the-tripod.md) — Proposed
