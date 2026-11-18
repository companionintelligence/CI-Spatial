/**
 * What the calibration modal did in each scenario of ./calibration-flow-scenarios.ts.
 *
 * Every scenario was first run through src/ar/project-calibration.ts as it stood before its commit logic moved to
 * src/ar/calibration-commit.ts (WP-04b step 0; the file at the combined tree's index, git blob
 * fb391fbc996fcbb1deb41a22f2701357e2fb03bb), and what that build did was written down here. The build after the move was
 * held to it. WP-04b's constellation flow (steps 1 to 6) then changed what the modal does on purpose, and the entries were
 * re-recorded from the modal as it now is. An entry that is not what it was is one of these changes, and nothing else moved:
 *
 *  - `toleranceM`, on every two-point calibration and Place frame, is the spacing tolerance at the tap noise in use
 *    (`twoPointToleranceM`, 0.168 m at the adopted 3 cm), where it was the stored frame's own tolerance, or 0.15. The stored
 *    frame's tolerance is no longer read, so the scenarios that pinned it (a stored 0.05, 0.4, null, none, and the exact edge
 *    of a stored 0.25) now show the spacing tolerance deciding, and two new ones sit on the edge of that tolerance.
 *  - A visit to a stored pair is `'provisional'` with `checkedBy: 'separation'`: a distance check is never verified. The stored
 *    pair with no usable separation, which the old build called verified with a residual that is not a figure, is provisional.
 *  - The check-point step follows the heading marker on a first calibration. The card after the heading tap is the step's
 *    (its title, what it asks, the label field naming the check point), and the buttons the card shows include the one
 *    check-point button, `check`; every first-calibration scenario that goes on to commit presses it to skip the step.
 *  - The separation line's estimate is the fit's prediction (`frameUncertaintyAt`, in the sentence a verdict uses), where it
 *    was the closed form for two points.
 *  - The stored pair is drawn by `drawStoredConstellation`: the same rings, in the same order, at the same positions in these
 *    scenarios (the contract test holds them to 1e-9 in general). They come from the stored points' coordinates, where they came
 *    from the stored `separationM`, so a stored frame whose separation is not a number now draws its heading marker's ghost.
 *  - New scenarios, at the end: the check point taken, removed, skipped and added back, turned away, re-tapped, a metre off and
 *    adjusted, swapped, skipped on a return visit, kept over a mismatch, tapped on a table, and stored on the line.
 *
 * The review of the constellation flow (WP-04b, the fix stage) moved these, on purpose, and nothing else:
 *
 *  - The steps count the taps the visit asks for: "Step 1 of 3", "Step 2 of 3" and, in the check step, "Step 3 of 3 (optional)" where the
 *    check point follows the heading marker by itself (a first calibration, or a return visit to a Place that stores one), and "of 2"
 *    only where it is not asked for.
 *  - The check step has no label field until its marker is down, and the field then names the check point (the marker placed last), so
 *    what is typed after a tap names the point just tapped. The scenario that names the check point types after tapping it.
 *  - A return visit that re-taps the check point is not given placement advice: the pair's line quotes the estimate of the stored
 *    three points, and once a readout of how the points sit is showing the placement line is not (a line that says the points cannot be
 *    used is kept). The review's status says the points do not match yet where they do not, and not "Ready to commit.".
 *  - The check step's and the mismatch screen's sentences say what the fit compares (the shape the three points make) and no more.
 *  - The heading marker and the check point are photographed at their own taps, not at Commit, for a visit that writes the Place's frame
 *    (one at a time); a check point placed and then taken away has cost its frame (the count of frames asked for is one more).
 *  - The driver's `release` answers the frames the modal asks for next as well, as a host that answers every request does.
 *
 * The merge of main (#264 to #269, the origin decal and the ground gate) moved these, on purpose, and nothing else:
 *
 *  - The committed origin is one decal, `calibration origin` (src/world/origin-decal.ts), where the flow left a marker on the landmark and
 *    another on the heading point. The arrow's tip stands for the heading point, so the scene lists no marker for it. A check point
 *    keeps its own marker. On a return visit the stored origin is drawn beside the committed one, `calibration stored origin`, after the
 *    ghosts of the stored points.
 *  - Every calibration record carries `groundY`, the floor the origin sat on, and `floorCheckBypassed` (src/ar/ground-gate.ts). In the
 *    scenario whose check point is tapped on a table the second is `true`: the off-floor tap was accepted by a second tap at the same
 *    height, so the record stays provisional and writes no Place frame, which is what it did before.
 *  - A two-point result made with a compass reading carries `originBearingDeg`, the arrow's compass bearing (clockwise from north), for the HUD. It
 *    is the record's own `projectBearingDeg` for the same arrow. (It was recorded as the mirror image, 360 minus that, which is how the HUD came to
 *    contradict the record: tests/unit/node/origin_heading_bearing.test.ts holds the two together, against a physical model.)
 *  - The stored origin of a visit that fitted three points is carried back through the fit, as the rings of the stored points are
 *    (`drawStoredPair`, src/ar/project-calibration.ts), and not read off the tapped pair. The three scenarios here that re-tap the stored points
 *    exactly stand where they did to the last digit: only that digit moved (the fit's inverse is not the tapped pair's to the bit).
 *  - The scene entry of a decal also records `arrowTip`, where its arrow ends, in scene coordinates (./calibration-flow-driver.ts). The arrow's
 *    geometry is single precision, so the tip is the heading point to about 1e-7 m, and the contract holds it to 1e-6.
 *  Nothing else moved: no card, label, photo, record number or count of calls to the host differs.
 *
 * Each entry is the outcome ./calibration-flow-driver.ts reports: whether the modal resolved, the records it
 * returned (a photo's bytes reduced to their length), what its card said at the moments a scenario looked, what it
 * left in the scene, and how often it asked the host for a hit, the compass, the pose and a camera frame.
 * Numbers are the exact doubles the arithmetic produced, so a change of operation order shows up as a changed last
 * digit. The invariants that say what they mean are in wp-calibration-characterisation.test.ts, beside the
 * comparison, so an entry cannot be re-recorded into something that breaks them.
 *
 * To change one on purpose: run the scenario, read the outcome in the failure, replace the entry with it, and say why.
 *
 * Not a test file: it has no `.test.ts` name, so no runner collects it.
 */
import type { Outcome } from './calibration-flow-driver.ts'

export const GOLDEN: Record<string, Outcome> = {
  'first two-point calibration, labels, photos': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          0.8, 0, 0.6, 0,
          0, 1, 0, 0,
          -0.6, 0, 0.8, 0,
          -2.4000000000000004, 1.2, 0.7000000000000002, 1,
        ],
        separationM: 3,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 288.13010235415595,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3 },
        separationM: 3,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 288.13010235415595,
        bearingConvention: 2,
        pointLabels: ['north door frame', 'radiator corner'],
      },
      referencePhotos: [
        {
          role: 'landmark',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.25, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: 'north door frame',
        },
        {
          role: 'headingMarker',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.35, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: 'radiator corner',
        },
      ],
      originBearingDeg: 288.13010235415595,
    },
    looks: {
      'ready to commit': {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when both sit on features you can find again.',
        status: 'Ready to commit.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '3.00 m apart. Estimate: two scans would place a spot 5 m away up to about 20.7 cm apart (95 of 100 times).',
        },
        label: { hidden: false, caption: 'Name point B (optional)', value: 'radiator corner' },
        shown: ['commit', 'check', 'replace', 'fallback', 'skip'],
        disabled: [],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [1.5, -1.2, -2],
        arrowTip: [3.3, -1.2, 0.40000000000000036],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 2 },
  },
  'first two-point calibration, no compass, no photo accessor': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          0.8, 0, 0.6, 0,
          0, 1, 0, 0,
          -0.6, 0, 0.8, 0,
          -2.4000000000000004, 1.2, 0.7000000000000002, 1,
        ],
        separationM: 3,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: null,
        projectBearingDeg: null,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3 },
        separationM: 3,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: null,
        projectBearingDeg: null,
        bearingConvention: 2,
      },
      referencePhotos: [],
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1.5, -1.2, -2],
        arrowTip: [3.3, -1.2, 0.40000000000000036],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 0 },
  },
  'first calibration, pair exactly the minimum apart': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 1,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 1 },
        separationM: 1,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
      },
      referencePhotos: [],
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [2, -1.2, 2],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 0 },
  },
  'first calibration, pair just under the minimum': {
    closed: false,
    result: undefined,
    looks: {
      'after the refusal': {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when both sit on features you can find again.',
        status: 'The markers are too close together to fix a reliable heading.',
        separation: {
          hidden: false,
          state: 'short',
          text: '1.00 m apart — need at least 1.0 m. Walk further and tap again.',
        },
        label: { hidden: false, caption: 'Name point B (optional)', value: '' },
        shown: ['commit', 'replace', 'fallback', 'skip'],
        disabled: ['commit'],
      },
    },
    scene: [],
    counts: { hitTests: 2, compass: 0, pose: 0, captures: 1 },
  },
  'first calibration, pair 0.6 m apart': {
    closed: false,
    result: undefined,
    looks: {
      'before the click': {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when both sit on features you can find again.',
        status: 'The markers are too close together to fix a reliable heading.',
        separation: {
          hidden: false,
          state: 'short',
          text: '0.60 m apart — need at least 1.0 m. Walk further and tap again.',
        },
        label: { hidden: false, caption: 'Name point B (optional)', value: '' },
        shown: ['commit', 'replace', 'fallback', 'skip'],
        disabled: ['commit'],
      },
      'after the click': {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when both sit on features you can find again.',
        status: 'The markers are too close together to fix a reliable heading.',
        separation: {
          hidden: false,
          state: 'short',
          text: '0.60 m apart — need at least 1.0 m. Walk further and tap again.',
        },
        label: { hidden: false, caption: 'Name point B (optional)', value: '' },
        shown: ['commit', 'replace', 'fallback', 'skip'],
        disabled: ['commit'],
      },
    },
    scene: [],
    counts: { hitTests: 2, compass: 0, pose: 0, captures: 1 },
  },
  'first calibration, Use anyway clicked with no mismatch': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3 },
        separationM: 3,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
      },
      referencePhotos: [
        {
          role: 'landmark',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.25, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
        {
          role: 'headingMarker',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.35, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
      ],
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4, -1.2, 2.000000000000001],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 2 },
  },
  'return visit, same separation': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4, -1.2, 2.000000000000001],
      },
      {
        name: 'calibration stored reference',
        position: [1, -1.2, 2],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 2],
      },
      {
        name: 'calibration stored origin',
        position: [1, -1.2, 2],
        arrowTip: [4, -1.2, 2.000000000000001],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 1 },
  },
  'return visit, 10 cm further apart': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3.0999999999999996,
        residualM: 0.09999999999999964,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4.099999904632568, -1.2, 2.000000000000001],
      },
      {
        name: 'calibration stored reference',
        position: [1, -1.2, 2],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 2],
      },
      {
        name: 'calibration stored origin',
        position: [1, -1.2, 2],
        arrowTip: [4, -1.2, 2.000000000000001],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 1 },
  },
  'return visit, 12 cm closer together': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 2.88,
        residualM: -0.1200000000000001,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [3.880000114440918, -1.2, 2.0000000000000004],
      },
      {
        name: 'calibration stored reference',
        position: [1, -1.2, 2],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 2],
      },
      {
        name: 'calibration stored origin',
        position: [1, -1.2, 2],
        arrowTip: [4, -1.2, 2.000000000000001],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 1 },
  },
  'return visit, exactly at the tolerance': {
    closed: false,
    result: undefined,
    looks: {
      mismatch: {
        title: 'These markers do not match the stored pair',
        copy: 'Measured 25 cm further apart than the recorded pair. One marker may be on a different feature. Re-place them, or record this pair as unverified.',
        status: 'Not committed yet.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '2.25 m apart. Stored pair: 2.00 m. Estimate: two scans would place a spot 5 m away up to about 30.1 cm apart (95 of 100 times).',
        },
        label: { hidden: true, caption: 'Name point B (optional)', value: '' },
        shown: ['replace', 'adjust', 'override', 'skip'],
        disabled: [],
      },
    },
    scene: [],
    counts: { hitTests: 2, compass: 0, pose: 0, captures: 1 },
  },
  'return visit, just over the tolerance': {
    closed: false,
    result: undefined,
    looks: {
      mismatch: {
        title: 'These markers do not match the stored pair',
        copy: 'Measured 25 cm further apart than the recorded pair. One marker may be on a different feature. Re-place them, or record this pair as unverified.',
        status: 'Not committed yet.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '2.25 m apart. Stored pair: 2.00 m. Estimate: two scans would place a spot 5 m away up to about 30.1 cm apart (95 of 100 times).',
        },
        label: { hidden: true, caption: 'Name point B (optional)', value: '' },
        shown: ['replace', 'adjust', 'override', 'skip'],
        disabled: [],
      },
    },
    scene: [],
    counts: { hitTests: 2, compass: 0, pose: 0, captures: 1 },
  },
  'return visit, a hair inside the spacing tolerance': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 2.165,
        residualM: 0.16500000000000004,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [3.1649999618530273, -1.2, 2.0000000000000004],
      },
      {
        name: 'calibration stored reference',
        position: [1, -1.2, 2],
      },
      {
        name: 'calibration stored reference',
        position: [3, -1.2, 2],
      },
      {
        name: 'calibration stored origin',
        position: [1, -1.2, 2],
        arrowTip: [3, -1.2, 2.0000000000000004],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 1 },
  },
  'return visit, a hair past the spacing tolerance': {
    closed: false,
    result: undefined,
    looks: {
      mismatch: {
        title: 'These markers do not match the stored pair',
        copy: 'Measured 17 cm further apart than the recorded pair. One marker may be on a different feature. Re-place them, or record this pair as unverified.',
        status: 'Not committed yet.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '2.17 m apart. Stored pair: 2.00 m. Estimate: two scans would place a spot 5 m away up to about 30.1 cm apart (95 of 100 times).',
        },
        label: { hidden: true, caption: 'Name point B (optional)', value: '' },
        shown: ['replace', 'adjust', 'override', 'skip'],
        disabled: [],
      },
    },
    scene: [],
    counts: { hitTests: 2, compass: 0, pose: 0, captures: 1 },
  },
  'return visit, 40 cm further apart': {
    closed: false,
    result: undefined,
    looks: {
      mismatch: {
        title: 'These markers do not match the stored pair',
        copy: 'Measured 40 cm further apart than the recorded pair. One marker may be on a different feature. Re-place them, or record this pair as unverified.',
        status: 'Not committed yet.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '3.40 m apart. Stored pair: 3.00 m. Estimate: two scans would place a spot 5 m away up to about 20.7 cm apart (95 of 100 times).',
        },
        label: { hidden: true, caption: 'Name point B (optional)', value: '' },
        shown: ['replace', 'adjust', 'override', 'skip'],
        disabled: [],
      },
    },
    scene: [],
    counts: { hitTests: 2, compass: 0, pose: 0, captures: 1 },
  },
  'return visit, 30 cm closer together': {
    closed: false,
    result: undefined,
    looks: {
      mismatch: {
        title: 'These markers do not match the stored pair',
        copy: 'Measured 30 cm closer together than the recorded pair. One marker may be on a different feature. Re-place them, or record this pair as unverified.',
        status: 'Not committed yet.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '2.70 m apart. Stored pair: 3.00 m. Estimate: two scans would place a spot 5 m away up to about 20.7 cm apart (95 of 100 times).',
        },
        label: { hidden: true, caption: 'Name point B (optional)', value: '' },
        shown: ['replace', 'adjust', 'override', 'skip'],
        disabled: [],
      },
    },
    scene: [],
    counts: { hitTests: 2, compass: 0, pose: 0, captures: 1 },
  },
  'return visit, mismatch, then Use anyway': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3.4000000000000004,
        residualM: 0.40000000000000036,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3.4000000000000004 },
        separationM: 3.4000000000000004,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
      },
      referencePhotos: [
        {
          role: 'landmark',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.25, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
        {
          role: 'headingMarker',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.35, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
      ],
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4.400000095367432, -1.2, 2.000000000000001],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 2 },
  },
  'return visit, mismatch, then Re-place points': {
    closed: false,
    result: undefined,
    looks: {
      'after re-place': {
        title: 'Align this scan to the project',
        copy: "Step 1 of 2 — tap Point A again, the same spot as last time. Point A is the project's origin.",
        status: 'Tap the ground to place the landmark.',
        separation: {
          hidden: true,
          state: 'ok',
          text: '3.40 m apart. Stored pair: 3.00 m. Estimate: two scans would place a spot 5 m away up to about 20.7 cm apart (95 of 100 times).',
        },
        label: { hidden: false, caption: 'Name point A (optional)', value: '' },
        shown: ['skip'],
        disabled: ['commit'],
      },
    },
    scene: [],
    counts: { hitTests: 2, compass: 0, pose: 0, captures: 0 },
  },
  'return visit, stored tolerance 0.05, 6 cm off': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3.0600000000000005,
        residualM: 0.0600000000000005,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4.059999942779541, -1.2, 2.000000000000001],
      },
      {
        name: 'calibration stored reference',
        position: [1, -1.2, 2],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 2],
      },
      {
        name: 'calibration stored origin',
        position: [1, -1.2, 2],
        arrowTip: [4, -1.2, 2.000000000000001],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 1 },
  },
  'return visit, stored tolerance 0.4, 30 cm off': {
    closed: false,
    result: undefined,
    looks: {
      mismatch: {
        title: 'These markers do not match the stored pair',
        copy: 'Measured 30 cm further apart than the recorded pair. One marker may be on a different feature. Re-place them, or record this pair as unverified.',
        status: 'Not committed yet.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '3.30 m apart. Stored pair: 3.00 m. Estimate: two scans would place a spot 5 m away up to about 20.7 cm apart (95 of 100 times).',
        },
        label: { hidden: true, caption: 'Name point B (optional)', value: '' },
        shown: ['replace', 'adjust', 'override', 'skip'],
        disabled: [],
      },
    },
    scene: [],
    counts: { hitTests: 2, compass: 0, pose: 0, captures: 1 },
  },
  'return visit, stored frame without a tolerance, 14 cm off': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3.1400000000000006,
        residualM: 0.14000000000000057,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4.140000104904175, -1.2, 2.000000000000001],
      },
      {
        name: 'calibration stored reference',
        position: [1, -1.2, 2],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 2],
      },
      {
        name: 'calibration stored origin',
        position: [1, -1.2, 2],
        arrowTip: [4, -1.2, 2.000000000000001],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 1 },
  },
  'return visit, stored tolerance null, 16 cm off': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3.16,
        residualM: 0.16000000000000014,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4.1600000858306885, -1.2, 2.000000000000001],
      },
      {
        name: 'calibration stored reference',
        position: [1, -1.2, 2],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 2],
      },
      {
        name: 'calibration stored origin',
        position: [1, -1.2, 2],
        arrowTip: [4, -1.2, 2.000000000000001],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 1 },
  },
  'return visit, stored frame with no usable separation': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3.4000000000000004,
        residualM: NaN,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4.400000095367432, -1.2, 2.000000000000001],
      },
      {
        name: 'calibration stored reference',
        position: [1, -1.2, 2],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 2],
      },
      {
        name: 'calibration stored origin',
        position: [1, -1.2, 2],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 1 },
  },
  'return visit, Use anyway clicked with no mismatch': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3.05,
        residualM: 0.04999999999999982,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3.05 },
        separationM: 3.05,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
      },
      referencePhotos: [
        {
          role: 'landmark',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.25, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
        {
          role: 'headingMarker',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.35, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
      ],
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4.049999952316284, -1.2, 2.000000000000001],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 2 },
  },
  'one point, compass reading': {
    closed: true,
    result: {
      calibration: {
        method: 'ground-tap-compass',
        sessionToProject: [
          0.8191520442889916, 0, -0.5735764363510465, 0,
          0, 1, 0, 0,
          0.5735764363510465, 0, 0.8191520442889916, 0,
          -0.08157519373139444, 1.2, 2.498668743104553, 1,
        ],
        anchorBearingDeg: 325,
        bearingConvention: 2,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        groundY: -1.2,
        floorCheckBypassed: false,
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'ground-tap-compass',
        anchorBearingDeg: 325,
        bearingConvention: 2,
      },
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1.5, -1.2, -2],
      },
    ],
    counts: { hitTests: 1, compass: 2, pose: 2, captures: 0 },
  },
  'one point, no compass reading': {
    closed: false,
    result: undefined,
    looks: {
      refused: {
        title: "Set this project's world frame",
        copy: "Step 1 of 3 — tap the ground at a permanent feature you will recognise next visit, such as a door frame or a wall corner. This becomes the project's origin.",
        status: 'No usable compass bearing, so one point cannot set the heading. Point the camera ahead, not down, and try again, or use two points.',
        separation: { hidden: true, state: undefined, text: '' },
        label: { hidden: false, caption: 'Name point A (optional)', value: '' },
        shown: ['confirm', 'fallback', 'skip'],
        disabled: ['commit'],
      },
      'heading step': {
        title: 'Place the heading marker',
        copy: 'Step 2 of 3 — walk 3 m or more from the landmark, then tap a second ground feature. Longer is more accurate; their direction sets the heading.',
        status: 'Tap the ground to place the heading marker.',
        separation: { hidden: true, state: undefined, text: '' },
        label: { hidden: false, caption: 'Name point B (optional)', value: '' },
        shown: ['fallback', 'skip'],
        disabled: ['commit'],
      },
    },
    scene: [],
    counts: { hitTests: 1, compass: 1, pose: 1, captures: 0 },
  },
  'one point on a Place with a one-point frame': {
    closed: true,
    result: {
      calibration: {
        method: 'ground-tap-compass',
        sessionToProject: [
          0.8191520442889916, 0, -0.5735764363510465, 0,
          0, 1, 0, 0,
          0.5735764363510465, 0, 0.8191520442889916, 0,
          -0.08157519373139444, 1.2, 2.498668743104553, 1,
        ],
        anchorBearingDeg: 325,
        bearingConvention: 2,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        groundY: -1.2,
        floorCheckBypassed: false,
      },
      spatialFrame: undefined,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1.5, -1.2, -2],
      },
    ],
    counts: { hitTests: 1, compass: 2, pose: 2, captures: 0 },
  },
  'one point on a Place with a two-point frame': {
    closed: false,
    result: undefined,
    looks: {
      'landmark placed': {
        title: 'Align this scan to the project',
        copy: "Step 1 of 2 — tap Point A again, the same spot as last time. Point A is the project's origin.",
        status: 'Landmark placed. Tap it to move it, or confirm to place the heading marker.',
        separation: { hidden: true, state: undefined, text: '' },
        label: { hidden: false, caption: 'Name point A (optional)', value: '' },
        shown: ['confirm', 'skip'],
        disabled: ['commit'],
      },
    },
    scene: [],
    counts: { hitTests: 1, compass: 0, pose: 0, captures: 0 },
  },
  'a tap with no surface under it, then good ones': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          0.8, 0, 0.6, 0,
          0, 1, 0, 0,
          -0.6, 0, 0.8, 0,
          -2.4000000000000004, 1.2, 0.7000000000000002, 1,
        ],
        separationM: 3,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 288.13010235415595,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.400Z',
        status: 'provisional',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.400Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3 },
        separationM: 3,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 288.13010235415595,
        bearingConvention: 2,
      },
      referencePhotos: [],
      originBearingDeg: 288.13010235415595,
    },
    looks: {
      'no surface': {
        title: "Set this project's world frame",
        copy: "Step 1 of 3 — tap the ground at a permanent feature you will recognise next visit, such as a door frame or a wall corner. This becomes the project's origin.",
        status: 'No stable surface there. Aim at a textured floor and tap again.',
        separation: { hidden: true, state: undefined, text: '' },
        label: { hidden: false, caption: 'Name point A (optional)', value: '' },
        shown: ['skip'],
        disabled: ['commit'],
      },
      'after the poll': {
        title: "Set this project's world frame",
        copy: "Step 1 of 3 — tap the ground at a permanent feature you will recognise next visit, such as a door frame or a wall corner. This becomes the project's origin.",
        status: 'No stable surface there. Aim at a textured floor and tap again.',
        separation: { hidden: true, state: undefined, text: '' },
        label: { hidden: false, caption: 'Name point A (optional)', value: '' },
        shown: ['skip'],
        disabled: ['commit'],
      },
      'landmark placed': {
        title: "Set this project's world frame",
        copy: "Step 1 of 3 — tap the ground at a permanent feature you will recognise next visit, such as a door frame or a wall corner. This becomes the project's origin.",
        status: 'Landmark placed. Tap it to move it, or confirm to place the heading marker.',
        separation: { hidden: true, state: undefined, text: '' },
        label: { hidden: false, caption: 'Name point A (optional)', value: '' },
        shown: ['confirm', 'fallback', 'skip'],
        disabled: ['commit'],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [1.5, -1.2, -2],
        arrowTip: [3.3, -1.2, 0.40000000000000036],
      },
    ],
    counts: { hitTests: 3, compass: 2, pose: 2, captures: 0 },
  },
  'a tap the runtime fails on, then good ones': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          0.8, 0, 0.6, 0,
          0, 1, 0, 0,
          -0.6, 0, 0.8, 0,
          -2.4000000000000004, 1.2, 0.7000000000000002, 1,
        ],
        separationM: 3,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 288.13010235415595,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.400Z',
        status: 'provisional',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.400Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3 },
        separationM: 3,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 288.13010235415595,
        bearingConvention: 2,
      },
      referencePhotos: [],
      originBearingDeg: 288.13010235415595,
    },
    looks: {
      'no surface': {
        title: "Set this project's world frame",
        copy: "Step 1 of 3 — tap the ground at a permanent feature you will recognise next visit, such as a door frame or a wall corner. This becomes the project's origin.",
        status: 'No stable surface there. Aim at a textured floor and tap again.',
        separation: { hidden: true, state: undefined, text: '' },
        label: { hidden: false, caption: 'Name point A (optional)', value: '' },
        shown: ['skip'],
        disabled: ['commit'],
      },
      'after the poll': {
        title: "Set this project's world frame",
        copy: "Step 1 of 3 — tap the ground at a permanent feature you will recognise next visit, such as a door frame or a wall corner. This becomes the project's origin.",
        status: 'No stable surface there. Aim at a textured floor and tap again.',
        separation: { hidden: true, state: undefined, text: '' },
        label: { hidden: false, caption: 'Name point A (optional)', value: '' },
        shown: ['skip'],
        disabled: ['commit'],
      },
      'landmark placed': {
        title: "Set this project's world frame",
        copy: "Step 1 of 3 — tap the ground at a permanent feature you will recognise next visit, such as a door frame or a wall corner. This becomes the project's origin.",
        status: 'Landmark placed. Tap it to move it, or confirm to place the heading marker.',
        separation: { hidden: true, state: undefined, text: '' },
        label: { hidden: false, caption: 'Name point A (optional)', value: '' },
        shown: ['confirm', 'fallback', 'skip'],
        disabled: ['commit'],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [1.5, -1.2, -2],
        arrowTip: [3.3, -1.2, 0.40000000000000036],
      },
    ],
    counts: { hitTests: 3, compass: 2, pose: 2, captures: 0 },
  },
  'commit pressed twice while the photos are pending': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          0.8, 0, 0.6, 0,
          0, 1, 0, 0,
          -0.6, 0, 0.8, 0,
          -2.4000000000000004, 1.2, 0.7000000000000002, 1,
        ],
        separationM: 3,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 288.13010235415595,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3 },
        separationM: 3,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 288.13010235415595,
        bearingConvention: 2,
      },
      referencePhotos: [
        {
          role: 'landmark',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.25, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
        {
          role: 'headingMarker',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.35, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
      ],
      originBearingDeg: 288.13010235415595,
    },
    looks: {
      waiting: {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when both sit on features you can find again.',
        status: 'Saving reference photos…',
        separation: {
          hidden: false,
          state: 'ok',
          text: '3.00 m apart. Estimate: two scans would place a spot 5 m away up to about 20.7 cm apart (95 of 100 times).',
        },
        label: { hidden: false, caption: 'Name point B (optional)', value: '' },
        shown: ['commit', 'check', 'replace', 'fallback', 'skip'],
        disabled: [],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [1.5, -1.2, -2],
        arrowTip: [3.3, -1.2, 0.40000000000000036],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 2 },
  },
  'compass, clock and labels settle after the photo wait': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          0.8, 0, 0.6, 0,
          0, 1, 0, 0,
          -0.6, 0, 0.8, 0,
          -2.4000000000000004, 1.2, 0.7000000000000002, 1,
        ],
        separationM: 3,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 65,
        projectBearingDeg: 28.13010235415595,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:05.000Z',
        status: 'provisional',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:05.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3 },
        separationM: 3,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 65,
        projectBearingDeg: 28.13010235415595,
        bearingConvention: 2,
        pointLabels: ['', 'typed during the wait'],
      },
      referencePhotos: [
        {
          role: 'landmark',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.25, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:05.000Z',
          label: null,
        },
        {
          role: 'headingMarker',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.35, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:05.000Z',
          label: 'typed during the wait',
        },
      ],
      originBearingDeg: 28.13010235415595,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [1.5, -1.2, -2],
        arrowTip: [3.3, -1.2, 0.40000000000000036],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 2 },
  },
  'first calibration with a check point, named and photographed': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3.5,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3.5 },
        separationM: 3.5,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        pointLabels: ['north door frame', ''],
        checkPoints: [
          { x: -2.5999999999999996, y: 0, z: 1.0000000000000002, label: 'by the radiator' },
        ],
      },
      referencePhotos: [
        {
          role: 'landmark',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.25, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: 'north door frame',
        },
        {
          role: 'headingMarker',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.35, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
        {
          role: 'check1',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.45, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: 'by the radiator',
        },
      ],
      originBearingDeg: 235,
    },
    looks: {
      'check step': {
        title: 'Add a check point (recommended)',
        copy: 'Step 3 of 3 (optional) — tap a third ground feature at least 3 m from point A and 2 m off the line from A to B. Later visits can then compare the shape the three points make, not only the distance between two.',
        status: 'Tap the ground to place the check point.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '3.50 m apart. Estimate: two scans would place a spot 5 m away up to about 18.1 cm apart (95 of 100 times).',
        },
        label: { hidden: true, caption: 'Name point B (optional)', value: '' },
        shown: ['check', 'fallback', 'skip'],
        disabled: [],
      },
      'review with the check point': {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when all three sit on features you can find again.',
        status: 'Ready to commit.',
        separation: {
          hidden: false,
          state: 'ok',
          text: 'Point C: 2.8 m from A, 2.6 m off the A–B line. Estimate: two scans would place a spot 5 m away up to about 13.7 cm apart (95 of 100 times). At least 3 m from A and 2 m off the line is better.',
        },
        label: { hidden: false, caption: 'Name point C (optional)', value: 'by the radiator' },
        shown: ['commit', 'check', 'replace', 'fallback', 'skip'],
        disabled: [],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4.5, -1.2, 2.000000000000001],
      },
      {
        name: 'calibration anchor check',
        position: [2, -1.2, 4.6],
      },
    ],
    counts: { hitTests: 3, compass: 2, pose: 2, captures: 3 },
  },
  'first calibration, check point taken and then removed': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3.5,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3.5 },
        separationM: 3.5,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
      },
      referencePhotos: [
        {
          role: 'landmark',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.25, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
        {
          role: 'headingMarker',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.35, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
      ],
      originBearingDeg: 235,
    },
    looks: {
      'after removing': {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when both sit on features you can find again.',
        status: 'Ready to commit.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '3.50 m apart. Estimate: two scans would place a spot 5 m away up to about 18.1 cm apart (95 of 100 times).',
        },
        label: { hidden: false, caption: 'Name point B (optional)', value: '' },
        shown: ['commit', 'check', 'replace', 'fallback', 'skip'],
        disabled: [],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4.5, -1.2, 2.000000000000001],
      },
    ],
    counts: { hitTests: 3, compass: 2, pose: 2, captures: 3 },
  },
  'first calibration, check point skipped and added back from review': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          2, 1.2, -1.0000000000000002, 1,
        ],
        separationM: 3.5,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3.5 },
        separationM: 3.5,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        checkPoints: [
          { x: -2.5999999999999996, y: 0, z: 1.0000000000000002 },
        ],
      },
      referencePhotos: [],
      originBearingDeg: 235,
    },
    looks: {
      skipped: {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when both sit on features you can find again.',
        status: 'Ready to commit.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '3.50 m apart. Estimate: two scans would place a spot 5 m away up to about 18.1 cm apart (95 of 100 times).',
        },
        label: { hidden: false, caption: 'Name point B (optional)', value: '' },
        shown: ['commit', 'check', 'replace', 'fallback', 'skip'],
        disabled: [],
      },
      'asked again': {
        title: 'Add a check point (recommended)',
        copy: 'Step 3 of 3 (optional) — tap a third ground feature at least 3 m from point A and 2 m off the line from A to B. Later visits can then compare the shape the three points make, not only the distance between two.',
        status: 'Tap the ground to place the check point.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '3.50 m apart. Estimate: two scans would place a spot 5 m away up to about 18.1 cm apart (95 of 100 times).',
        },
        label: { hidden: true, caption: 'Name point B (optional)', value: '' },
        shown: ['check', 'fallback', 'skip'],
        disabled: [],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [1, -1.2, 2],
        arrowTip: [4.5, -1.2, 2.000000000000001],
      },
      {
        name: 'calibration anchor check',
        position: [2, -1.2, 4.6],
      },
    ],
    counts: { hitTests: 3, compass: 2, pose: 2, captures: 0 },
  },
  'first calibration, check point almost on the line': {
    closed: false,
    result: undefined,
    looks: {
      'on the line': {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when all three sit on features you can find again.',
        status: 'The check point cannot be used where it is. Move it or remove it.',
        separation: {
          hidden: false,
          state: 'short',
          text: 'Point C: 1.8 m from A, 5 cm off the A–B line. The three points are almost on one line (3 cm off it): they need at least 20 cm. Move point C to the side.',
        },
        label: { hidden: false, caption: 'Name point C (optional)', value: '' },
        shown: ['commit', 'check', 'replace', 'fallback', 'skip'],
        disabled: ['commit'],
      },
      refused: {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when all three sit on features you can find again.',
        status: 'Point C: 1.8 m from A, 5 cm off the A–B line. The three points are almost on one line (3 cm off it): they need at least 20 cm. Move point C to the side.',
        separation: {
          hidden: false,
          state: 'short',
          text: 'Point C: 1.8 m from A, 5 cm off the A–B line. The three points are almost on one line (3 cm off it): they need at least 20 cm. Move point C to the side.',
        },
        label: { hidden: false, caption: 'Name point C (optional)', value: '' },
        shown: ['commit', 'check', 'replace', 'fallback', 'skip'],
        disabled: ['commit'],
      },
    },
    scene: [],
    counts: { hitTests: 3, compass: 0, pose: 0, captures: 0 },
  },
  'return visit with a check point, all three re-tapped': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          0.9999999999999993, 1.2, -4, 1,
        ],
        separationM: 3.5,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'verified',
        fit: {
          fitMethod: 'rigid',
          pointsUsed: 3,
          rmsResidualM: 3.8459253727671276e-16,
          maxResidualM: 4.440892098500626e-16,
          perPoint: [
            { residualM: 4.440892098500626e-16, dx: -4.440892098500626e-16, dy: 0, dz: 0 },
            { residualM: 2.220446049250313e-16, dx: -2.220446049250313e-16, dy: 0, dz: 0 },
            { residualM: 4.440892098500626e-16, dx: -4.440892098500626e-16, dy: 0, dz: 0 },
          ],
          headingResidualDeg: 0,
          scaleRatio: 0.9999999999999998,
        },
        checkedBy: 'constellation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {
      'check step': {
        title: 'Tap the check point from last time',
        copy: 'Step 3 of 3 — tap point C, the check point from last time, about 2.8 m from the landmark. It lets this visit compare the shape the three points make, not only the distance between two.',
        status: 'Tap the ground to place the check point.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '3.50 m apart. Stored pair: 3.50 m. Estimate: two scans would place a spot 5 m away up to about 13.7 cm apart (95 of 100 times).',
        },
        label: { hidden: true, caption: 'Name point B (optional)', value: '' },
        shown: ['check', 'skip'],
        disabled: [],
      },
      review: {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when all three sit on features you can find again.',
        status: 'Ready to commit.',
        separation: {
          hidden: true,
          state: 'ok',
          text: 'Point C: 2.8 m from A, 2.6 m off the A–B line. Estimate: two scans would place a spot 5 m away up to about 13.7 cm apart (95 of 100 times).',
        },
        fit: {
          state: 'ok',
          text: '3 points are 0.0 cm off the stored ones on average (limit 8.4 cm).\nA 0.0 cm · B 0.0 cm · C 0.0 cm\nNot checked: that these are the same physical spots. Compare with the photos.',
        },
        label: { hidden: false, caption: 'Name point C (optional)', value: 'by the radiator' },
        shown: ['commit', 'check', 'replace', 'skip'],
        disabled: [],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [4, -1.2, 1],
        arrowTip: [7.5, -1.2, 1.0000000000000009],
      },
      {
        name: 'calibration anchor check',
        position: [5, -1.2, 3.6],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 0.9999999999999996],
      },
      {
        name: 'calibration stored reference',
        position: [7.5, -1.2, 0.9999999999999998],
      },
      {
        name: 'calibration stored reference',
        position: [5, -1.2, 3.5999999999999996],
      },
      {
        name: 'calibration stored origin',
        position: [4, -1.2, 0.9999999999999996],
        arrowTip: [7.5, -1.2, 1.0000000000000004],
      },
    ],
    counts: { hitTests: 3, compass: 2, pose: 2, captures: 0 },
  },
  'return visit with a check point, one metre off, then adjusted': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          0.9999999999999993, 1.2, -4, 1,
        ],
        separationM: 3.5,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'verified',
        fit: {
          fitMethod: 'rigid',
          pointsUsed: 3,
          rmsResidualM: 3.8459253727671276e-16,
          maxResidualM: 4.440892098500626e-16,
          perPoint: [
            { residualM: 4.440892098500626e-16, dx: -4.440892098500626e-16, dy: 0, dz: 0 },
            { residualM: 2.220446049250313e-16, dx: -2.220446049250313e-16, dy: 0, dz: 0 },
            { residualM: 4.440892098500626e-16, dx: -4.440892098500626e-16, dy: 0, dz: 0 },
          ],
          headingResidualDeg: 0,
          scaleRatio: 0.9999999999999998,
        },
        checkedBy: 'constellation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {
      'review, off': {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when all three sit on features you can find again.',
        status: 'These points do not match the stored ones yet.',
        separation: {
          hidden: true,
          state: 'ok',
          text: 'Point C: 3.3 m from A, 2.6 m off the A–B line. Estimate: two scans would place a spot 5 m away up to about 13.7 cm apart (95 of 100 times).',
        },
        fit: {
          state: 'mismatch',
          text: '3 points are 35.7 cm off the stored ones on average (limit 8.4 cm).\nThe worst point is 38.2 cm off (limit 21.0 cm).\nSizes differ by less than 1%.\nThe direction of the first two points is 9.4° off the stored direction.\nA 33.2 cm · B 35.5 cm · C 38.2 cm',
        },
        label: { hidden: false, caption: 'Name point C (optional)', value: 'by the radiator' },
        shown: ['commit', 'check', 'replace', 'skip'],
        disabled: [],
      },
      mismatch: {
        title: 'These points do not match the stored ones',
        copy: 'They do not line up with the stored points. Adjust a point, re-place them, or record these points as unverified.',
        status: 'Not committed yet.',
        separation: {
          hidden: true,
          state: 'ok',
          text: 'Point C: 3.3 m from A, 2.6 m off the A–B line. Estimate: two scans would place a spot 5 m away up to about 13.7 cm apart (95 of 100 times).',
        },
        fit: {
          state: 'mismatch',
          text: '3 points are 35.7 cm off the stored ones on average (limit 8.4 cm).\nThe worst point is 38.2 cm off (limit 21.0 cm).\nSizes differ by less than 1%.\nThe direction of the first two points is 9.4° off the stored direction.\nA 33.2 cm · B 35.5 cm · C 38.2 cm',
        },
        label: { hidden: true, caption: 'Name point C (optional)', value: 'by the radiator' },
        shown: ['replace', 'adjust', 'override', 'skip'],
        disabled: [],
      },
      adjusting: {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when all three sit on features you can find again.',
        status: 'These points do not match the stored ones yet.',
        separation: {
          hidden: true,
          state: 'ok',
          text: 'Point C: 3.3 m from A, 2.6 m off the A–B line. Estimate: two scans would place a spot 5 m away up to about 13.7 cm apart (95 of 100 times).',
        },
        fit: {
          state: 'mismatch',
          text: '3 points are 35.7 cm off the stored ones on average (limit 8.4 cm).\nThe worst point is 38.2 cm off (limit 21.0 cm).\nSizes differ by less than 1%.\nThe direction of the first two points is 9.4° off the stored direction.\nA 33.2 cm · B 35.5 cm · C 38.2 cm',
        },
        label: { hidden: false, caption: 'Name point C (optional)', value: 'by the radiator' },
        shown: ['commit', 'check', 'replace', 'skip'],
        disabled: [],
      },
      'after the re-tap': {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when all three sit on features you can find again.',
        status: 'Ready to commit.',
        separation: {
          hidden: true,
          state: 'ok',
          text: 'Point C: 2.8 m from A, 2.6 m off the A–B line. Estimate: two scans would place a spot 5 m away up to about 13.7 cm apart (95 of 100 times).',
        },
        fit: {
          state: 'ok',
          text: '3 points are 0.0 cm off the stored ones on average (limit 8.4 cm).\nA 0.0 cm · B 0.0 cm · C 0.0 cm\nNot checked: that these are the same physical spots. Compare with the photos.',
        },
        label: { hidden: false, caption: 'Name point C (optional)', value: 'by the radiator' },
        shown: ['commit', 'check', 'replace', 'skip'],
        disabled: [],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [4, -1.2, 1],
        arrowTip: [7.5, -1.2, 1.0000000000000009],
      },
      {
        name: 'calibration anchor check',
        position: [5, -1.2, 3.6],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 0.9999999999999996],
      },
      {
        name: 'calibration stored reference',
        position: [7.5, -1.2, 0.9999999999999998],
      },
      {
        name: 'calibration stored reference',
        position: [5, -1.2, 3.5999999999999996],
      },
      {
        name: 'calibration stored origin',
        position: [4, -1.2, 0.9999999999999996],
        arrowTip: [7.5, -1.2, 1.0000000000000004],
      },
    ],
    counts: { hitTests: 5, compass: 2, pose: 2, captures: 0 },
  },
  'return visit with a check point, pair swapped': {
    closed: false,
    result: undefined,
    looks: {
      mismatch: {
        title: 'These points do not match the stored ones',
        copy: 'They do not line up with the stored points. Adjust a point, re-place them, or record these points as unverified.',
        status: 'Not committed yet.',
        separation: {
          hidden: true,
          state: 'ok',
          text: 'Point C: 3.6 m from A, 2.6 m off the A–B line. Estimate: two scans would place a spot 5 m away up to about 13.7 cm apart (95 of 100 times).',
        },
        fit: { state: 'mismatch', text: 'The first two points may be swapped.' },
        label: { hidden: true, caption: 'Name point C (optional)', value: 'by the radiator' },
        shown: ['replace', 'adjust', 'override', 'skip'],
        disabled: [],
      },
    },
    scene: [],
    counts: { hitTests: 3, compass: 0, pose: 0, captures: 0 },
  },
  'return visit with a check point, check point skipped': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          0.9999999999999998, 1.2, -4, 1,
        ],
        separationM: 3.5,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {
      skipped: {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when both sit on features you can find again.',
        status: 'Skipped. Only the distance between the two points will be checked.',
        separation: {
          hidden: false,
          state: 'ok',
          text: '3.50 m apart. Stored pair: 3.50 m. Estimate: two scans would place a spot 5 m away up to about 18.1 cm apart (95 of 100 times).',
        },
        label: { hidden: false, caption: 'Name point B (optional)', value: '' },
        shown: ['commit', 'check', 'replace', 'skip'],
        disabled: [],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [4, -1.2, 1],
        arrowTip: [7.5, -1.2, 1.0000000000000009],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 1],
      },
      {
        name: 'calibration stored reference',
        position: [7.5, -1.2, 1.0000000000000002],
      },
      {
        name: 'calibration stored origin',
        position: [4, -1.2, 1],
        arrowTip: [7.5, -1.2, 1.0000000000000009],
      },
    ],
    counts: { hitTests: 2, compass: 2, pose: 2, captures: 0 },
  },
  'return visit with a check point, mismatch, then Use anyway': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          0.9999999999999998, 1.2, -4, 1,
        ],
        separationM: 3.5,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        fit: {
          fitMethod: 'rigid',
          pointsUsed: 3,
          rmsResidualM: 0.3571322414668075,
          maxResidualM: 0.38232263704292563,
          perPoint: [
            {
              residualM: 0.33234037277146544,
              dx: 0.2868612794109906,
              dy: 0,
              dz: -0.16781159003050483,
            },
            {
              residualM: 0.3549782972464445,
              dx: -0.2828491361024361,
              dy: 0,
              dz: -0.21448999445682926,
            },
            {
              residualM: 0.38232263704292563,
              dx: -0.004012143308554705,
              dy: 0,
              dz: 0.38230158448733675,
            },
          ],
          headingResidualDeg: -9.36796942462388,
          scaleRatio: 1.0023146980626279,
        },
        checkedBy: 'constellation',
      },
      spatialFrame: {
        version: 1,
        createdAt: '2026-11-16T09:30:00.000Z',
        method: 'two-point-ground',
        landmark: { x: 0, y: 0, z: 0 },
        headingMarker: { x: 0, y: 0, z: 3.5 },
        separationM: 3.5,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        checkPoints: [
          { x: -2.5999999999999996, y: 0, z: 2, label: 'by the radiator' },
        ],
      },
      referencePhotos: [
        {
          role: 'landmark',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.25, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
        {
          role: 'headingMarker',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.35, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: null,
        },
        {
          role: 'check1',
          blob: 5,
          thumbDataUrl: 'data:image/jpeg;base64,AAAA',
          tapPoint: { x: 0.45, y: 0.5 },
          pose: {
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0.3826834323650898, z: 0, w: 0.9238795325112867 },
          },
          capturedAt: '2026-11-16T09:30:00.000Z',
          label: 'by the radiator',
        },
      ],
      originBearingDeg: 235,
    },
    looks: {},
    scene: [
      {
        name: 'calibration origin',
        position: [4, -1.2, 1],
        arrowTip: [7.5, -1.2, 1.0000000000000009],
      },
      {
        name: 'calibration anchor check',
        position: [6, -1.2, 3.6],
      },
    ],
    counts: { hitTests: 3, compass: 2, pose: 2, captures: 3 },
  },
  'return visit with a check point, check point tapped on a table': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          0.9999999999999993, 1.0999999999999999, -4, 1,
        ],
        separationM: 3.5,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: true,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        fit: {
          fitMethod: 'rigid',
          pointsUsed: 3,
          rmsResidualM: 3.8459253727671276e-16,
          maxResidualM: 4.440892098500626e-16,
          perPoint: [
            {
              residualM: 4.440892098500626e-16,
              dx: -4.440892098500626e-16,
              dy: -0.10000000000000009,
              dz: 0,
            },
            {
              residualM: 2.220446049250313e-16,
              dx: -2.220446049250313e-16,
              dy: -0.10000000000000009,
              dz: 0,
            },
            {
              residualM: 4.440892098500626e-16,
              dx: -4.440892098500626e-16,
              dy: 0.19999999999999996,
              dz: 0,
            },
          ],
          headingResidualDeg: 0,
          scaleRatio: 0.9999999999999998,
        },
        checkedBy: 'constellation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {
      review: {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when all three sit on features you can find again.',
        status: 'That point measured 30 cm above the landmark — one of the two is probably not on the floor.',
        separation: {
          hidden: true,
          state: 'ok',
          text: 'Point C: 2.8 m from A, 2.6 m off the A–B line. Estimate: two scans would place a spot 5 m away up to about 13.7 cm apart (95 of 100 times).',
        },
        fit: {
          state: 'warn',
          text: '3 points are 0.0 cm off the stored ones on average (limit 8.4 cm).\nA 0.0 cm · B 0.0 cm · C 0.0 cm\nNot verified: Heights are 14.1 cm off on average (limit 8.4 cm).\nNot checked: that these are the same physical spots. Compare with the photos.',
        },
        label: { hidden: false, caption: 'Name point C (optional)', value: 'by the radiator' },
        shown: ['commit', 'check', 'replace', 'skip'],
        disabled: [],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [4, -1.2, 1],
        arrowTip: [7.5, -1.2, 1.0000000000000009],
      },
      {
        name: 'calibration anchor check',
        position: [5, -1.2, 3.6],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 0.9999999999999996],
      },
      {
        name: 'calibration stored reference',
        position: [7.5, -1.2, 0.9999999999999998],
      },
      {
        name: 'calibration stored reference',
        position: [5, -1.2, 3.5999999999999996],
      },
      {
        name: 'calibration stored origin',
        position: [4, -1.2, 0.9999999999999996],
        arrowTip: [7.5, -1.2, 1.0000000000000004],
      },
    ],
    counts: { hitTests: 4, compass: 2, pose: 2, captures: 0 },
  },
  'return visit, stored check point on the line': {
    closed: true,
    result: {
      calibration: {
        method: 'two-point-ground',
        sessionToProject: [
          6.123233995736766e-17, 0, 1, 0,
          0, 1, 0, 0,
          -1, 0, 6.123233995736766e-17, 0,
          0.9999999999999998, 1.2, -4, 1,
        ],
        separationM: 3.5,
        residualM: 0,
        toleranceM: 0.16799999999999998,
        anchorBearingDeg: 325,
        projectBearingDeg: 235,
        bearingConvention: 2,
        groundY: -1.2,
        floorCheckBypassed: false,
        calibratedAt: '2026-11-16T09:30:00.000Z',
        status: 'provisional',
        checkedBy: 'separation',
      },
      spatialFrame: undefined,
      originBearingDeg: 235,
    },
    looks: {
      review: {
        title: 'Check the alignment',
        copy: 'Tap a marker, then tap where it should go. Commit when all three sit on features you can find again.',
        status: 'Ready to commit.',
        separation: {
          hidden: true,
          state: 'ok',
          text: 'Point C: 2.2 m from A, 2.0 m off the A–B line. Estimate: two scans would place a spot 5 m away up to about 17.7 cm apart (95 of 100 times).',
        },
        fit: {
          state: 'warn',
          text: 'The stored points lie almost on one line, so which side of it the points are on cannot be checked.\nOnly the distance between the two points is compared.',
        },
        label: { hidden: false, caption: 'Name point C (optional)', value: '' },
        shown: ['commit', 'check', 'replace', 'skip'],
        disabled: [],
      },
    },
    scene: [
      {
        name: 'calibration origin',
        position: [4, -1.2, 1],
        arrowTip: [7.5, -1.2, 1.0000000000000009],
      },
      {
        name: 'calibration anchor check',
        position: [5, -1.2, 3],
      },
      {
        name: 'calibration stored reference',
        position: [4, -1.2, 1],
      },
      {
        name: 'calibration stored reference',
        position: [7.5, -1.2, 1.0000000000000002],
      },
      {
        name: 'calibration stored origin',
        position: [4, -1.2, 1],
        arrowTip: [7.5, -1.2, 1.0000000000000009],
      },
    ],
    counts: { hitTests: 3, compass: 2, pose: 2, captures: 0 },
  },
}
