// Structured, filterable frame inspector — replaces a scrolling plain-text log with a table of
// TX/RX DUML frames. The gimbal streams orientation telemetry (cmdSet=0x04 cmdId=0x05) at
// 10-20Hz once connected, which floods any plain-text log and buries the actual command
// responses you're trying to find — this mutes that by default, lets you pause the table while
// you inspect a burst, and clicking a row loads its cmdSet/cmdId/payload into the Raw Command
// fields for quick tweak-and-resend.

const MAX_ROWS = 300;
const TELEMETRY_CMDSET = 0x04;
const TELEMETRY_CMDID = 0x05;

function hexByte(n) {
  return n == null ? '' : '0x' + n.toString(16).padStart(2, '0');
}

export function attachFrameLog(container, { onSelect } = {}) {
  container.classList.add('frame-log');

  const toolbar = document.createElement('div');
  toolbar.className = 'fl-toolbar';

  const muteLabel = document.createElement('label');
  muteLabel.className = 'fl-mute';
  const muteCheckbox = document.createElement('input');
  muteCheckbox.type = 'checkbox';
  muteCheckbox.checked = true;
  muteLabel.append(muteCheckbox, ' mute telemetry (0x04:0x05)');

  const pauseBtn = document.createElement('button');
  pauseBtn.type = 'button';
  pauseBtn.textContent = 'Pause';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';

  toolbar.append(muteLabel, pauseBtn, clearBtn);

  const head = document.createElement('div');
  head.className = 'fl-row fl-head';
  head.innerHTML = '<span>time</span><span>dir</span><span>cmd</span><span>flags</span><span>payload</span>';

  const rowsEl = document.createElement('div');
  rowsEl.className = 'fl-rows';

  container.append(toolbar, head, rowsEl);

  let paused = false;
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('active', paused);
  });
  clearBtn.addEventListener('click', () => {
    rowsEl.innerHTML = '';
  });

  function renderRow(record) {
    const row = document.createElement('div');
    row.className = 'fl-row fl-' + record.dir + (record.error ? ' fl-error' : '');
    const time = new Date(record.at || Date.now()).toLocaleTimeString();
    const cmd = record.cmdSet != null ? `${hexByte(record.cmdSet)}:${hexByte(record.cmdId)}` : '—';

    const timeEl = document.createElement('span');
    timeEl.textContent = time;
    const dirEl = document.createElement('span');
    dirEl.className = 'fl-dir-badge';
    dirEl.textContent = record.dir.toUpperCase();
    const cmdEl = document.createElement('span');
    cmdEl.textContent = cmd;
    const flagsEl = document.createElement('span');
    flagsEl.textContent = record.flags != null ? hexByte(record.flags) : '';
    const payloadEl = document.createElement('span');
    payloadEl.className = 'fl-payload';
    payloadEl.textContent = record.error ? record.error : record.payloadHex || record.note || '';

    row.append(timeEl, dirEl, cmdEl, flagsEl, payloadEl);

    if (record.cmdSet != null && onSelect) {
      row.classList.add('fl-clickable');
      row.title = 'Click to load into Raw Command';
      row.addEventListener('click', () => onSelect(record));
    }
    rowsEl.appendChild(row);
    while (rowsEl.children.length > MAX_ROWS) rowsEl.removeChild(rowsEl.firstChild);
    if (!paused) rowsEl.scrollTop = rowsEl.scrollHeight;
  }

  function add(record) {
    const isTelemetry = record.cmdSet === TELEMETRY_CMDSET && record.cmdId === TELEMETRY_CMDID;
    if (isTelemetry && muteCheckbox.checked) return;
    if (paused) return;
    renderRow(record);
  }

  return { add };
}
