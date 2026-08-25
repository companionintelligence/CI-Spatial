// Reusable live-orientation readout: a compass dial for pan, a vertical gauge for tilt, the
// three raw numbers (pan / tilt / yaw) beside them, and — on the server pathway only — a
// separate block for the phone's own magnetometer. Shared between the direct (Web Bluetooth)
// and server (backend WS) panels; only where the samples come from differs, not how they're
// displayed.
//
// TWO gauges, not three. An earlier revision drew pan (compass), Tilt (bar) and Roll (bar), and
// the Roll bar was a lie: on this cradle mount the raw `roll` channel IS physical pan (see
// quatToGimbalControlDeg in ../protocol/telemetry.mjs, measured live 2026-08-24), so that bar
// printed the compass's own number to the last decimal — and pinned its marker at the end stop
// doing it, since a +/-30° scale cannot hold a 128° pan. Two widgets, one axis, one of them
// mislabeled: a reader would conclude the gimbal was rolling 128° while it was panning 128°.
// The gauges are still exactly the pair the closed-loop controller steers on — pan and tilt.
// The raw `yaw` channel is printed as a *number* next to them, labelled as the mount frame it
// is, rather than given a gauge of its own: it holds still while the gimbal moves, so a gauge
// would show a needle that never travels.
//
// Physical roll is deliberately absent: nothing in this telemetry measures it separately.
//
// TWO REFERENCE FRAMES, never merged. The gimbal quaternion is relative to wherever the gimbal
// booted and carries no compass reference at all; the phone's heading is absolute (true north)
// but unreliable indoors near steel and wiring — which is the exact condition this app scans
// in. ../protocol/phone_telemetry.mjs's header states the rule: display them side by side, each
// labelled with its own frame, and never average them into one number. That is why the phone
// block below has its own caption and its own separator, and why the reported heading accuracy
// is shown with the heading instead of a bare degree value.

import { quaternionDelta, quatToEulerDeg, quatToGimbalControlDeg } from '../protocol/telemetry.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Tilt's proven-safe range is asymmetric (down to ~-40°, up stalls around +16° — a real
// mechanical limit found live on hardware, not a display choice), so its gauge is scaled to that
// range rather than a naive +/-90°, or most of the gauge would sit in territory the gimbal can
// never actually reach.
const TILT_MIN = -45;
const TILT_MAX = 20;

// The raw `yaw` channel is a frame offset from the cradle mount, not a live axis: it holds
// steady while pan and tilt move. What it holds steady *at* is per-rig. This file used to
// hardcode -90° and warn outside +/-5° of it, with a comment claiming that figure had been
// verified across a full pan sweep and a full tilt sweep. On the rig measured 2026-08-25 (pan
// 122.0°, tilt -38.7°) yaw sat at -100.7° with a 0.1° spread over 24 samples — rock steady, and
// 10.7° off the hardcoded number, so that warning was on permanently. A warning that is always
// on is not a check, and one measurement per rig is not enough to claim where a "correct" mount
// sits, so the absolute comparison is gone.
//
// What IS observable from this page, without a second rig to calibrate against, is *change
// within one session*: the offset can only move if the mount itself moves, and if it moves the
// pan/tilt labels stop meaning what they say. So the reference is the first sample of the
// session and the tolerance sits far above the 0.1° of noise that was actually measured — it is
// a "something was knocked" tripwire, not a precision figure. It renders nothing at all while
// within tolerance; the yaw number itself is on screen either way.
const MOUNT_YAW_DRIFT_DEG = 10;

// Component order of the telemetry quaternion as decodeQuaternion() returns it.
const QUAT_LABELS = ['x', 'y', 'z', 'w'];

// Phone telemetry can simply stop — the relay dies, the phone sleeps, the browser tab holding
// the sensors is backgrounded — and none of those produce an event here. So the phone row
// carries the age of its last sample and greys/ambers as that grows. The thresholds are chosen
// so a dead feed becomes visible within a few seconds; they are not a measured latency budget.
const PHONE_AGE_SHOW_MS = 3000;
const PHONE_AGE_STALE_MS = 10000;

// Shortest signed difference between two angles, so a comparison spanning the +/-180° seam
// reads as a few degrees rather than ~360.
function angleDiffDeg(a, b) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

function buildCompass() {
  const wrap = document.createElement('div');
  wrap.className = 'compass-wrap';

  const svg = svgEl('svg', { class: 'compass', viewBox: '0 0 120 120' });
  svg.append(
    svgEl('circle', { cx: 60, cy: 60, r: 56, class: 'compass-ring' }),
    svgEl('circle', { cx: 60, cy: 60, r: 3, class: 'compass-hub' }),
  );
  // Tick marks every 30°, labelled every 90° — the labels are plain degrees with no N/E/S/W,
  // since "pan" has no fixed compass reference, only a relative zero from wherever the gimbal
  // happened to boot. (The phone block below is the only thing on this readout that knows where
  // north is, and it is kept well away from this dial for exactly that reason.)
  for (let deg = 0; deg < 360; deg += 30) {
    const rad = (deg - 90) * (Math.PI / 180);
    const major = deg % 90 === 0;
    const rOuter = 56;
    const rInner = major ? 47 : 51;
    const x1 = 60 + rOuter * Math.cos(rad);
    const y1 = 60 + rOuter * Math.sin(rad);
    const x2 = 60 + rInner * Math.cos(rad);
    const y2 = 60 + rInner * Math.sin(rad);
    svg.appendChild(svgEl('line', { x1, y1, x2, y2, class: major ? 'compass-tick-major' : 'compass-tick' }));
    if (major) {
      const lx = 60 + 38 * Math.cos(rad);
      const ly = 60 + 38 * Math.sin(rad);
      const label = svgEl('text', { x: lx, y: ly, class: 'compass-label' });
      const shown = deg > 180 ? deg - 360 : deg;
      label.textContent = `${shown}°`;
      svg.appendChild(label);
    }
  }
  const needle = svgEl('line', { x1: 60, y1: 60, x2: 60, y2: 14, class: 'compass-needle' });
  svg.appendChild(needle);

  const name = document.createElement('div');
  name.className = 'gauge-name';
  name.textContent = 'pan';

  // No number under the dial any more: pan, tilt and yaw are all printed together in the
  // numbers column beside these gauges, and printing pan twice was the same duplication that
  // made the old three-gauge layout unreadable.
  wrap.append(name, svg);

  return {
    el: wrap,
    update(panDeg) {
      // CSS `transform`, NOT the SVG `transform="rotate(a cx cy)"` presentation attribute.
      // Because .compass-needle carries a CSS transition, that attribute is funnelled through
      // the CSS transform machinery, where transform-origin gets applied *on top of* the cx/cy
      // already baked into rotate() — the needle then pivots about (120,120) rather than the
      // hub at (60,60), drifting further off as pan grows until it leaves the 120x120 viewBox
      // and the outer <svg>'s default overflow:hidden silently eats it. Checked live at
      // pan 127.9°: the needle's box sat ~90px right of the dial, i.e. invisible — the dial
      // looked correct at 0° and needle-less at any real heading. One-argument rotate() plus
      // the stylesheet's single transform-origin has no such ambiguity.
      needle.style.transform = `rotate(${panDeg}deg)`;
    },
  };
}

// Tilt reads as an elevation, so its gauge stands upright next to the dial instead of lying
// under it — same information, one column rather than one extra row, which is most of why this
// block still fits in the height the compass alone used to need.
function buildTiltGauge() {
  const wrap = document.createElement('div');
  wrap.className = 'tilt-gauge';

  const name = document.createElement('div');
  name.className = 'gauge-name';
  name.textContent = 'tilt';

  const track = document.createElement('div');
  track.className = 'tilt-track';
  const zeroPct = ((0 - TILT_MIN) / (TILT_MAX - TILT_MIN)) * 100;
  const zero = document.createElement('div');
  zero.className = 'tilt-zero';
  zero.style.bottom = `${zeroPct}%`;
  const fill = document.createElement('div');
  fill.className = 'tilt-fill';
  const marker = document.createElement('div');
  marker.className = 'tilt-marker';
  track.append(zero, fill, marker);

  wrap.append(name, track);

  return {
    el: wrap,
    // Returns whether the value sat outside the mechanically reachable range, so the caller can
    // amber the printed number to match the pinned marker.
    update(tiltDeg) {
      const clamped = Math.max(TILT_MIN, Math.min(TILT_MAX, tiltDeg));
      const pct = ((clamped - TILT_MIN) / (TILT_MAX - TILT_MIN)) * 100;
      marker.style.bottom = `${pct}%`;
      // Fill grows from the zero line toward the current value, in whichever direction — reads
      // like an attitude indicator rather than a plain bottom-to-top gauge.
      const lo = Math.min(zeroPct, pct);
      const hi = Math.max(zeroPct, pct);
      fill.style.bottom = `${lo}%`;
      fill.style.height = `${hi - lo}%`;
      // Past the scale ends the marker pins and turns amber, so a value outside the mechanically
      // reachable range never silently looks like a legal one sitting at the end stop.
      const outOfRange = tiltDeg < TILT_MIN || tiltDeg > TILT_MAX;
      marker.classList.toggle('tilt-marker-clip', outOfRange);
      return outOfRange;
    },
  };
}

// pan / tilt / yaw as three labelled numbers. Yaw is styled as a secondary row and carries its
// own note, because it is not a third steerable axis — see MOUNT_YAW_DRIFT_DEG above.
function buildNumbers() {
  const wrap = document.createElement('div');
  wrap.className = 'or-nums';

  function row(key, note, sub) {
    const el = document.createElement('div');
    el.className = sub ? 'or-num or-num-sub' : 'or-num';
    const k = document.createElement('span');
    k.className = 'or-num-k';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = 'or-num-v';
    v.textContent = '—°';
    el.append(k, v);
    if (note) {
      const n = document.createElement('span');
      n.className = 'or-num-note';
      n.textContent = note;
      el.appendChild(n);
    }
    wrap.appendChild(el);
    return v;
  }

  return {
    el: wrap,
    pan: row('pan'),
    tilt: row('tilt'),
    yaw: row('yaw', 'mount frame', true),
  };
}

// The phone's sensors, kept in their own captioned block: absolute heading (true north) with the
// accuracy the phone itself reported, plus pitch and roll. Nothing here is combined with the
// gimbal numbers above — see this file's header, and phone_telemetry.mjs's.
function buildPhoneBlock() {
  const wrap = document.createElement('div');
  wrap.className = 'or-phone';

  const head = document.createElement('div');
  head.className = 'or-src';
  head.textContent = 'phone · magnetometer, true north';

  const body = document.createElement('div');
  body.className = 'or-phone-body or-phone-idle';
  body.textContent = 'no phone telemetry yet';

  wrap.append(head, body);

  let latest = null;
  // Age is measured from when the frame arrived in this page, NOT from its `at` field: `at` is
  // stamped by the phone's clock, and any skew between the two devices would show up here as a
  // fake age (or a negative one).
  let arrivedAt = 0;

  function part(key, value, warn) {
    const el = document.createElement('span');
    el.className = 'or-p';
    const k = document.createElement('span');
    k.className = 'or-p-k';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = warn ? 'or-p-v or-p-warn' : 'or-p-v';
    v.textContent = value;
    el.append(k, v);
    return el;
  }

  function render() {
    if (!latest) return;
    const ageMs = Date.now() - arrivedAt;
    const stale = ageMs > PHONE_AGE_STALE_MS;
    body.className = 'or-phone-body';

    const parts = [];
    // A null heading means the phone has no compass fix — say so rather than printing 0°, which
    // is a perfectly plausible heading and would read as a measurement.
    if (latest.heading === null) {
      parts.push(part('hdg ', 'no fix', true));
    } else {
      const acc = latest.headingAccuracyDeg === null
        ? '±?'
        : `±${latest.headingAccuracyDeg.toFixed(0)}°`;
      parts.push(part('hdg ', `${latest.heading.toFixed(0)}° ${acc}`, stale));
    }
    parts.push(part('pitch ', latest.pitch === null ? '—' : `${latest.pitch.toFixed(1)}°`, stale));
    parts.push(part('roll ', latest.roll === null ? '—' : `${latest.roll.toFixed(1)}°`, stale));
    if (latest.deviceLabel) parts.push(part('', latest.deviceLabel));
    if (ageMs > PHONE_AGE_SHOW_MS) parts.push(part('', `${Math.round(ageMs / 1000)}s ago`, stale));
    body.replaceChildren(...parts);
  }

  return {
    el: wrap,
    update(telemetry) {
      latest = telemetry;
      arrivedAt = Date.now();
      render();
    },
    refresh() {
      if (latest) render();
    },
  };
}

/**
 * @param {HTMLElement} container
 * @param {{ showPhone?: boolean }} [opts] `showPhone` adds the phone-magnetometer block. Only
 *   the server pathway can ever receive those frames (they arrive on the backend WebSocket), so
 *   the direct/Web-Bluetooth panel deliberately doesn't draw a block that could never fill in.
 */
export function attachOrientationReadout(container, { showPhone = false } = {}) {
  const src = document.createElement('div');
  src.className = 'or-src or-src-gimbal';
  src.textContent = 'gimbal · relative to power-on, no north';

  // Compass first in DOM order and first in the flex row, with the row aligned to flex-start —
  // it is the anchor of this block and belongs in its top-left corner.
  const gauges = document.createElement('div');
  gauges.className = 'or-gauges';

  const compass = buildCompass();
  const tilt = buildTiltGauge();
  const nums = buildNumbers();
  gauges.append(compass.el, tilt.el, nums.el);

  // Mount tripwire. Empty and hidden while yaw stays where it started — a check with nothing to
  // report should cost zero lines, which the old always-on version did not.
  const mountEl = document.createElement('div');
  mountEl.className = 'or-mount or-mount-off';
  mountEl.hidden = true;

  const deltaRow = document.createElement('div');
  deltaRow.className = 'or-delta-row';
  const deltaEl = document.createElement('span');
  deltaEl.className = 'or-delta';
  deltaEl.textContent = 'Δ —';
  const zeroBtn = document.createElement('button');
  zeroBtn.type = 'button';
  zeroBtn.textContent = 'Zero ref';
  deltaRow.append(deltaEl, zeroBtn);

  const quatEl = document.createElement('div');
  quatEl.className = 'or-quat';
  // Starts empty, not with a "no telemetry yet" placeholder: the pan/tilt/yaw readouts above
  // already render as "—°" before the first sample, so a second line saying the same thing
  // spent a whole row restating it. The raw quaternion parts fill this in on the first update.
  quatEl.hidden = true;

  container.append(src, gauges, mountEl, deltaRow, quatEl);

  const phone = showPhone ? buildPhoneBlock() : null;
  if (phone) container.append(phone.el);
  // No teardown hook: this readout lives for the page's lifetime, and the tick only re-renders
  // a row that already exists.
  if (phone) setInterval(() => phone.refresh(), 2000);

  let reference = null;
  let latest = null;
  let yawAtFirstSample = null;
  zeroBtn.addEventListener('click', () => {
    reference = latest;
    deltaEl.textContent = latest ? 'Δ 0.000 (ref set)' : 'Δ — (no sample yet)';
    // Re-baseline the mount tripwire too, not just the quaternion delta. `yawAtFirstSample`
    // was latched from whatever the very first frame of the page happened to be — including a
    // frame captured mid-move — and nothing else ever reset it, so once the warning fired it
    // stayed on for the life of the page with no way to clear it. A warning that cannot be
    // acknowledged stops carrying information and just occupies space; "Zero ref" is already
    // the button that means "treat the current pose as the reference", so it should mean that
    // for both readings.
    yawAtFirstSample = null;
    mountEl.hidden = true;
  });

  function update(quat) {
    if (!quat) return;
    latest = quat;
    // pan/tilt come from quatToGimbalControlDeg, which is the same function the backend's
    // closed-loop move-to steers on — so a reader comparing this readout against a move-to run
    // sees exactly the numbers the controller sees, not a parallel decomposition of its own.
    const { pan, tilt: tiltDeg } = quatToGimbalControlDeg(quat);
    compass.update(pan);
    const tiltClipped = tilt.update(tiltDeg);
    nums.pan.textContent = `${pan.toFixed(1)}°`;
    nums.tilt.textContent = `${tiltDeg.toFixed(1)}°`;
    nums.tilt.classList.toggle('or-num-clip', tiltClipped);

    // Only `yaw` is pulled out of the raw Euler triple. `pitch` and `roll` are not shown
    // alongside pan/tilt because they are not extra information — on this mount they ARE tilt
    // and pan respectively, to the last decimal. Printing them again is what made the old
    // three-gauge layout read as though the gimbal had three moving axes.
    const { yaw } = quatToEulerDeg(quat);
    nums.yaw.textContent = `${yaw.toFixed(1)}°`;
    if (yawAtFirstSample === null) yawAtFirstSample = yaw;
    const drift = angleDiffDeg(yaw, yawAtFirstSample);
    const drifted = Math.abs(drift) > MOUNT_YAW_DRIFT_DEG;
    mountEl.hidden = !drifted;
    if (drifted) {
      mountEl.textContent = `mount moved: yaw drifted ${drift.toFixed(1)}° since this session's first sample (${yawAtFirstSample.toFixed(1)}°) — pan/tilt labels may no longer match the axes`;
    }

    // Four atomic spans rather than one string: this line does wrap on a narrow phone, and CSS
    // treats the minus in "w-0.107" as a break opportunity — as one string it wrapped to
    // "w-" / "0.107", which reads as a truncated number rather than a wrapped one. Per-span
    // nowrap confines the wrap to the gaps between components.
    quatEl.hidden = false;
    quatEl.replaceChildren(
      ...quat.map((v, i) => {
        const part = document.createElement('span');
        part.className = 'or-quat-part';
        part.textContent = `${QUAT_LABELS[i]}${v.toFixed(3)}`;
        return part;
      }),
    );
    if (reference) {
      deltaEl.textContent = `Δ ${quaternionDelta(reference, quat).toFixed(3)} since ref`;
    }
  }

  // Separate entry point on purpose: a phone sample must never reach the gimbal path above, and
  // a caller that has no phone relay simply never calls this.
  function updatePhone(telemetry) {
    phone?.update(telemetry);
  }

  return { update, updatePhone };
}
