# 0010. iOS world maps stay on the phone, keyed by world slug

- **Status:** Accepted. Device verification pending.
- **Date:** 2026-11-16
- **Related issue:** none

## Context

ADR 0009 left one iOS gap open: ARKit's interruptions were not reported. Separately, each native session started in a new coordinate frame, so two scans of the same room could not be placed in one frame. The multi-scan World Editor needs one frame per room.

ARKit's `ARWorldMap` gives that frame. A session started with `initialWorldMap` set relocalizes into the map's coordinates, and the map is an archive the app can write to disk. The ARPersistence reference this design follows uses that path.

## Decision

- We will save an iOS world map under the world's slug (the identity the server already uses for a world file, ADR 0004), through `ScanAR.saveWorldMap({ name })`. A session starts from it through `ScanAR.start({ worldMap })`. One room keeps one map, and no new domain type is introduced.
- The file is ARKit's own archive, written with secure coding to `Application Support/ScanWorldMaps/<name>.worldmap`. The folder is marked excluded from iCloud and device backups. The app never uploads a map. Each save first copies the current file to `<name>.worldmap.previous`, so one previous generation is kept.
- A save needs the camera tracking normally and the room mapped (ARKit's mapping status is `mapped` or `extending`). Without that, the save is refused, so a session that has not relocalized cannot overwrite the room's saved map.
- A start reports what the map came to, in `worldMap`: `loaded` (the session starts from the saved map and relocalizes into its coordinates), `missing` (no map has that name, or the name cannot be a file name), or `unreadable` (a file exists under the name but does not decode; the session starts fresh and the file is left in place). None of these fails the start, because a failed native start hands the scanner to the 8th Wall runtime.
- A start whose options differ from the running session's (the map name or depth) starts the session again. The same options answer with the running session's result, so the hit and pose state always belong to the session the caller asked for.
- Autosave: a session started with a valid place name saves its map every minute, when the app goes to the background, when ARKit is interrupted, and on stop. The place name comes from the page address (`?world=`). `default` and invalid names never get a map.
- Interruptions: iOS reports them as tracking `notAvailable`. The session is not reset. The pose events carry the tracking state again once frames resume. The page still reads a loss of a second or more as a suspect epoch when the poses come back (`recovered`, `RECOVERY_SUSPECT_MS`, `src/ar/frame-epoch.ts`), as it does for the web runtimes, because the plugin sends no reset and no epoch of its own and a pose cannot say whether the loss moved the coordinates; that is what lets the re-anchor choice be offered. Whether a session that is not reset should open an epoch at all is the owner's call.
- Android has no world maps. The native side keeps none, the provider reports `unsupported` for a requested map, and `saveWorldMap` is refused there.

## Consequences

- No server contract changes. Nothing on the server or in the upload path reads a world map.
- The scanner does not call the save API itself. The native session saves on its own schedule, so the save points are the timer, backgrounding, interruption, and stop. Two product choices remain for the scanner: which slug the page carries for each Place, and when a scan counts as finished.
- A map stays on the phone where it was saved. A reinstall removes it, and another phone cannot use it.
- Relocalization is unverified until a device run in the same room, after a restart. The steps are in `docs/testing/DEVICE_TESTING.md` under Checklist D.
- Known v1 limit: a saved map is not linked to the Place's frame. A map's origin is wherever its first session started, so the map and the Place frame can disagree until a map-to-Place transform exists. A map from a fresh start, or from a session after a reinstall, defines a second frame.
- Revisit this decision if a product requirement needs maps on the server, if a second platform needs maps, or if device runs show relocalization failing often in a room that was mapped.
