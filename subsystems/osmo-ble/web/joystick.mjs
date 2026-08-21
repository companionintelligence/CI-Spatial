// Reusable virtual joystick: click-and-drag (mouse), touch-drag, and arrow-key control (while
// the pad has focus). Continuously reports a {yawDegPerSec, pitchDegPerSec} vector while
// active and calls onStop() when released — shared by both the direct Web Bluetooth panel and
// the backend panel, which each wire it to their own transport.

const KEY_VECTOR = {
  ArrowUp: { pitchDegPerSec: 1 },
  ArrowDown: { pitchDegPerSec: -1 },
  ArrowLeft: { yawDegPerSec: -1 },
  ArrowRight: { yawDegPerSec: 1 },
};

export function attachJoystick(padEl, { onMove, onStop, maxSpeedDegPerSec = 60, sendIntervalMs = 100 }) {
  padEl.classList.add('joystick-pad');
  padEl.tabIndex = 0;
  const knob = document.createElement('div');
  knob.className = 'joystick-knob';
  padEl.appendChild(knob);
  const hint = document.createElement('div');
  hint.className = 'joystick-hint';
  hint.textContent = 'drag, or focus + arrow keys';
  padEl.appendChild(hint);

  let dragging = false;
  let lastSendAt = 0;

  function resetKnob() {
    knob.style.transform = 'translate(-50%, -50%)';
  }
  resetKnob();

  function fromPointer(clientX, clientY) {
    const rect = padEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) {
      dx = (dx / dist) * radius;
      dy = (dy / dist) * radius;
    }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const nx = radius ? dx / radius : 0;
    const ny = radius ? dy / radius : 0;
    return { yawDegPerSec: nx * maxSpeedDegPerSec, pitchDegPerSec: -ny * maxSpeedDegPerSec };
  }

  function throttledMove(vector) {
    const now = performance.now();
    if (now - lastSendAt < sendIntervalMs) return;
    lastSendAt = now;
    onMove(vector);
  }

  padEl.addEventListener('pointerdown', (e) => {
    dragging = true;
    try {
      padEl.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    padEl.focus();
    throttledMove(fromPointer(e.clientX, e.clientY));
  });
  padEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    throttledMove(fromPointer(e.clientX, e.clientY));
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    resetKnob();
    onStop();
  }
  padEl.addEventListener('pointerup', endDrag);
  padEl.addEventListener('pointercancel', endDrag);
  padEl.addEventListener('lostpointercapture', endDrag);

  // Keyboard: scoped to when this pad has focus, so multiple joysticks on one page don't fight.
  const held = new Set();
  function combinedKeyVector() {
    let yaw = 0;
    let pitch = 0;
    for (const key of held) {
      const v = KEY_VECTOR[key];
      yaw += (v.yawDegPerSec || 0) * maxSpeedDegPerSec;
      pitch += (v.pitchDegPerSec || 0) * maxSpeedDegPerSec;
    }
    const clamp = (v) => Math.max(-maxSpeedDegPerSec, Math.min(maxSpeedDegPerSec, v));
    return { yawDegPerSec: clamp(yaw), pitchDegPerSec: clamp(pitch) };
  }
  padEl.addEventListener('keydown', (e) => {
    if (!KEY_VECTOR[e.key] || e.repeat) return;
    e.preventDefault();
    held.add(e.key);
    onMove(combinedKeyVector());
  });
  padEl.addEventListener('keyup', (e) => {
    if (!KEY_VECTOR[e.key]) return;
    e.preventDefault();
    held.delete(e.key);
    if (held.size === 0) {
      resetKnob();
      onStop();
    } else {
      onMove(combinedKeyVector());
    }
  });
  padEl.addEventListener('blur', () => {
    if (held.size || dragging) {
      held.clear();
      dragging = false;
      resetKnob();
      onStop();
    }
  });
}
