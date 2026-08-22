// Reusable live-orientation readout: shows the raw telemetry quaternion plus an approximate
// Euler-angle decomposition, and a "since reference" delta so a nudge's effect reads as one
// number instead of just eyeballing the physical gimbal. Shared between the direct (Web
// Bluetooth) and server (backend WS) panels — only where the quaternion samples come from
// differs, not how they're displayed.

import { quaternionDelta, quatToEulerDeg } from '../protocol/telemetry.mjs';

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
