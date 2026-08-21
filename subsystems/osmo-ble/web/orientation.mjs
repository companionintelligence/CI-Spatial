// Reusable live-orientation readout: shows the raw telemetry quaternion plus an approximate
// Euler-angle decomposition, and a "since reference" delta so a nudge's effect reads as one
// number instead of just eyeballing the physical gimbal. Shared between the direct (Web
// Bluetooth) and server (backend WS) panels — only where the quaternion samples come from
// differs, not how they're displayed.

import { quaternionDelta } from '../protocol/telemetry.mjs';

// Standard ZYX Tait-Bryan extraction. Labeled "approx" throughout because we haven't confirmed
// which axis of the gimbal's own quaternion frame maps to which real-world pitch/yaw/roll —
// treat this as a relative-change indicator, not a calibrated attitude readout.
function quatToEulerDeg([x, y, z, w]) {
  const sinrCosp = 2 * (w * x + y * z);
  const cosrCosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinrCosp, cosrCosp);

  const sinp = 2 * (w * y - z * x);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);

  const sinyCosp = 2 * (w * z + x * y);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(sinyCosp, cosyCosp);

  const toDeg = (r) => (r * 180) / Math.PI;
  return { roll: toDeg(roll), pitch: toDeg(pitch), yaw: toDeg(yaw) };
}

export function attachOrientationReadout(container) {
  const eulerEl = document.createElement('div');
  eulerEl.className = 'or-euler';
  eulerEl.textContent = 'pitch —°  yaw —°  roll —°';

  const quatEl = document.createElement('div');
  quatEl.className = 'or-quat';
  quatEl.textContent = 'no telemetry yet';

  const deltaRow = document.createElement('div');
  deltaRow.className = 'or-delta-row';
  const deltaEl = document.createElement('span');
  deltaEl.className = 'or-delta';
  deltaEl.textContent = 'Δ —';
  const zeroBtn = document.createElement('button');
  zeroBtn.type = 'button';
  zeroBtn.textContent = 'Zero ref';
  deltaRow.append(deltaEl, zeroBtn);

  container.append(eulerEl, quatEl, deltaRow);

  let reference = null;
  let latest = null;
  zeroBtn.addEventListener('click', () => {
    reference = latest;
    deltaEl.textContent = latest ? 'Δ 0.000 (ref set)' : 'Δ — (no sample yet)';
  });

  function update(quat) {
    if (!quat) return;
    latest = quat;
    const { roll, pitch, yaw } = quatToEulerDeg(quat);
    eulerEl.textContent = `pitch ${pitch.toFixed(1)}°  yaw ${yaw.toFixed(1)}°  roll ${roll.toFixed(1)}°`;
    quatEl.textContent = `x${quat[0].toFixed(3)} y${quat[1].toFixed(3)} z${quat[2].toFixed(3)} w${quat[3].toFixed(3)}`;
    if (reference) {
      deltaEl.textContent = `Δ ${quaternionDelta(reference, quat).toFixed(3)} since ref`;
    }
  }

  return { update };
}
