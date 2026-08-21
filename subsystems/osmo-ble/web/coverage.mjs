// Command-coverage tracker: a persistent grid of every cmdSet:cmdId this session has sent,
// seeded with everything we already have a named builder for, so "what have I actually tried
// against real hardware, and did it move anything" is a glance at a grid instead of a scroll
// through a log. Clicking a row (tried or still-untested) loads its cmdSet/cmdId into the Raw
// Command fields — the fastest way to go from "here's a gap in coverage" to "now probing it".

import { CMD_SET, CMD_ID } from '../protocol/constants.mjs';

const KNOWN = [
  { cmdSet: CMD_SET.WIFI, cmdId: CMD_ID.SET_PAIRING_PIN, label: 'SetPairingPIN' },
  { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_STICK_CONTROL_ENABLE, label: 'StickControlEnable' },
  { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SPEED_CTRL, label: 'SpeedControl (nudge)' },
  { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_ANGLE_SET, label: 'AngleSet (base, no builder yet)' },
  { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_ABS_ANGLE, label: 'AbsoluteAngle (ex)' },
  { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_SET_WORK_MODE, label: 'SetWorkMode (landscape toggle)' },
  { cmdSet: CMD_SET.GIMBAL_FN, cmdId: CMD_ID.GIMBAL_RESET_AND_CENTER, label: 'ResetAndCenter' },
];

function key(cmdSet, cmdId) {
  return `${cmdSet}:${cmdId}`;
}

export function attachCoverage(container, { onSelect } = {}) {
  container.classList.add('coverage-grid');
  const rows = new Map();

  function ensureRow(cmdSet, cmdId, label) {
    const k = key(cmdSet, cmdId);
    if (rows.has(k)) return rows.get(k);

    const el = document.createElement('div');
    el.className = 'cov-row';
    const dot = document.createElement('span');
    dot.className = 'cov-dot cov-untested';
    const idEl = document.createElement('span');
    idEl.className = 'cov-id';
    idEl.textContent = `0x${cmdSet.toString(16).padStart(2, '0')}:0x${cmdId.toString(16).padStart(2, '0')}`;
    const labelEl = document.createElement('span');
    labelEl.className = 'cov-label';
    labelEl.textContent = label || '';
    const verdictEl = document.createElement('span');
    verdictEl.className = 'cov-verdict';
    verdictEl.textContent = 'untested';
    el.append(dot, idEl, labelEl, verdictEl);

    if (onSelect) {
      el.classList.add('cov-clickable');
      el.title = 'Click to load into Raw Command';
      el.addEventListener('click', () => onSelect({ cmdSet, cmdId }));
    }
    container.appendChild(el);
    const data = { cmdSet, cmdId, label, verdict: 'untested', count: 0 };
    const entry = { el, dot, labelEl, verdictEl, data };
    rows.set(k, entry);
    return entry;
  }

  for (const k of KNOWN) ensureRow(k.cmdSet, k.cmdId, k.label);

  function record(cmdSet, cmdId, { label, verdict, delta } = {}) {
    if (cmdSet == null || cmdId == null) return;
    const row = ensureRow(cmdSet, cmdId, label);
    row.data.count += 1;
    row.data.verdict = verdict || 'sent';
    row.data.delta = delta;
    row.dot.className = 'cov-dot cov-' + row.data.verdict;
    const suffix = `×${row.data.count}`;
    row.verdictEl.textContent =
      row.data.verdict === 'moved' ? `MOVED${suffix}`
      : row.data.verdict === 'no-movement' ? `no-move${suffix}`
      : row.data.verdict === 'error' ? `error${suffix}`
      : `sent${suffix}`;
    if (label && !row.labelEl.textContent) row.labelEl.textContent = label;
  }

  return { record };
}
