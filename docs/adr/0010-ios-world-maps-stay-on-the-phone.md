# 0010. iOS world maps stay on the phone, keyed by world slug

- **Status:** Accepted. Device verification pending.
- **Date:** 2026-11-16
- **Related issue:** none

## Context

ADR 0009 left two iOS gaps. ARKit's interruptions were not reported, and each native session started in a new coordinate frame, so two scans of the same room could not be placed in one frame. The multi-scan World Editor needs one frame per room.

ARKit's `ARWorldMap` gives that frame. A session started with `initialWorldMap` set relocalizes into the map's coordinates, and the map is an archive the app can write to disk. The ARPersistence reference this design follows uses that path.

## Decision

- We will save an iOS world map under the world's slug (the identity the server already uses for a world file, ADR 0004), through `ScanAR.saveWorldMap({ name })`. A session starts from it through `ScanAR.start({ worldMap })`. One room keeps one map, and no new domain type is introduced.
- The file is ARKit's own archive, written with secure coding to `Application Support/ScanWorldMaps/<name>.worldmap`. That folder is excluded from iCloud and device backups. The app never uploads a map.
- A start with a name that has no saved map starts a fresh session and reports `worldMap: "missing"`. It does not fail, because a failed native start hands the scanner to the 8th Wall runtime, and a missing map is not a failure of native AR.
- A start from a saved map keeps that map's coordinates, and every start resets tracking as it did before. An interruption does not reset anything: iOS reports it as tracking `notAvailable`, and the pose events carry the tracking state again once frames resume.
- Android has no world maps. `saveWorldMap` is optional in the TypeScript contract, and the provider refuses it there.

## Consequences

- No server contract changes. Nothing on the server or in the upload path reads a world map.
- The scanner does not call the API yet. Two product choices remain: when to save (for example, when a scan finishes), and which slug a phone uses when it scans a room. Until those are decided, the provider can save and load maps but the UI does not.
- A map stays on the phone where it was saved. A reinstall removes it, and another phone cannot use it.
- Relocalization is unverified until a device run in the same room, after a restart. The steps are in `docs/testing/DEVICE_TESTING.md` under Checklist D.
- Revisit this decision if a product requirement needs maps on the server, if a second platform needs maps, or if device runs show relocalization failing often in a room that was mapped.
