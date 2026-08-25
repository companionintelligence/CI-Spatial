// Reusable live-orientation readout: shows the raw telemetry quaternion plus an approximate
// Euler-angle decomposition, and a "since reference" delta so a nudge's effect reads as one
// number instead of just eyeballing the physical gimbal. Shared between the direct (Web
// Bluetooth) and server (backend WS) panels — only where the quaternion samples come from
// differs, not how they're displayed.

import { quaternionDelta, quatToEulerDeg, quatToGimbalControlDeg } from '../protocol/telemetry.mjs';

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
    // Raw channels stay on show — they are the diagnostic that revealed `yaw` is pinned at -90
    // on this mount while physical pan lands in `roll`. The pan/tilt pair after them is what
    // the closed-loop controller actually steers on (quatToGimbalControlDeg), so a reader
    // comparing this readout against a move-to run sees the same numbers the controller sees.
    const { roll, pitch, yaw } = quatToEulerDeg(quat);
    const { pan, tilt } = quatToGimbalControlDeg(quat);
    eulerEl.textContent = `pan ${pan.toFixed(1)}°  tilt ${tilt.toFixed(1)}°   ·  raw: pitch ${pitch.toFixed(1)}°  yaw ${yaw.toFixed(1)}°  roll ${roll.toFixed(1)}°`;
    quatEl.textContent = `x${quat[0].toFixed(3)} y${quat[1].toFixed(3)} z${quat[2].toFixed(3)} w${quat[3].toFixed(3)}`;
    if (reference) {
      deltaEl.textContent = `Δ ${quaternionDelta(reference, quat).toFixed(3)} since ref`;
    }
  }

  return { update };
}
