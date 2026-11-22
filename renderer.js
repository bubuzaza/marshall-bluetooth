// renderer.js — amp-panel UI driven by the Python BLE engine (window.ble bridge).
console.log('[renderer] start; BLE=' + !!window.BLE + ' ble=' + !!window.ble);

// --- early diagnostics: surface any load error into the on-screen Log ---
function _rlog(msg) {
  try {
    const el = document.getElementById('log');
    if (el) {
      el.textContent += '[' + new Date().toLocaleTimeString() + '] ' + msg + '\n';
      el.scrollTop = el.scrollHeight;
    }
  } catch { /* ignore */ }
}
window.addEventListener('error', (e) => _rlog('JS ERROR: ' + (e && (e.message || e.error))));
if (!window.BLE) _rlog('FATAL: ble-protocol.js did not load (window.BLE missing).');
if (!window.ble) _rlog('FATAL: preload bridge missing (window.ble undefined) — check preload.cjs.');

const { CHARS, SOURCE_CODE, enc, dec, IMG_BASE, MODEL_CODENAME } = window.BLE || {};
const bridge = window.ble || { send() {}, onEvent() {} };

const $ = (id) => document.getElementById(id);
const body = document.body;

const powerBtn = $('powerBtn');
const statusText = $('statusText');
const statusMeta = $('statusMeta');
const deviceNameEl = $('deviceName');
const logEl = $('log');

// frameless window controls
$('winMin').addEventListener('click', () => window.win?.minimize());
$('winClose').addEventListener('click', () => window.win?.close());

const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const hexToDv = (hex) => {
  const bytes = new Uint8Array((hex.match(/../g) || []).map((h) => parseInt(h, 16)));
  return new DataView(bytes.buffer);
};

function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
const setStatus = (t) => (statusText.textContent = t);

let connected = false;
let availChars = new Set();

let metaFw = '';
let metaBatt = null;
function renderMeta() {
  const parts = [];
  if (metaFw) parts.push('FW ' + metaFw);
  if (metaBatt != null) parts.push(metaBatt + '%');
  statusMeta.textContent = parts.join(' ') || '—';
}

/* ───────────── throttled writes (coalesce knob drags before hitting the bridge) ───────────── */
const wPending = {};
const wTimer = {};
function writeKey(key, u8) {
  const hex = toHex(u8);
  wPending[key] = hex;
  if (wTimer[key]) return;
  const flush = () => {
    const h = wPending[key];
    delete wPending[key];
    if (h != null) bridge.send({ cmd: 'write', char: key, hex: h });
  };
  flush(); // leading
  wTimer[key] = setTimeout(() => {
    wTimer[key] = null;
    if (wPending[key] != null) flush();
  }, 70);
}

/* ───────────── Volume knob ───────────── */
const KNOB_SWEEP = 270;
const ARC_FULL = 367.57;
const knob = $('knob');
const pointer = $('knobPointer');
const volArc = $('volArc');
const volVal = $('volVal');
// `volume` is the device's NATIVE step (0..volMax); the UI DISPLAYS it as 0–100%.
// Control stays in real steps (write/read are raw bytes); only the shown number is a percentage.
let volume = 16; // current step 0..volMax
let volMax = 31; // max step, from VOLUME_LIMIT (fallback until read)
let lastVolTouch = 0; // ignore device echo right after a user change
let calibTable = null; // step -> real Windows % (from calibration); null = linear fallback
let curDeviceName = ''; // for per-device calibration storage
let calibrating = false; // block knob input during a calibration sweep
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));

function renderVolume() {
  const frac = volMax > 0 ? volume / volMax : 0;
  const pct = calibTable && calibTable[volume] != null ? calibTable[volume] : Math.round(frac * 100);
  volVal.textContent = String(pct);
  pointer.style.transform = `rotate(${frac * KNOB_SWEEP - KNOB_SWEEP / 2}deg)`;
  volArc.setAttribute('stroke-dasharray', `${frac * ARC_FULL} 490`);
  knob.setAttribute('aria-valuenow', String(pct));
  knob.setAttribute('aria-valuemax', '100');
}
function setVolume(v, write = false) {
  volume = clamp(v, 0, volMax);
  renderVolume();
  if (write) {
    lastVolTouch = Date.now();
    writeKey('VOLUME', enc.volume(volume)); // raw byte = step, written directly
  }
}

// rotary drag — follow the pointer angle around the knob centre; grab-offset = no jump on grab
const HALF = KNOB_SWEEP / 2;
function pointerAngle(e) {
  const r = knob.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  return (Math.atan2(dx, -dy) * 180) / Math.PI; // 0 at top (12 o'clock), clockwise positive
}
let dragging = false, grabOffset = 0;
knob.addEventListener('pointerdown', (e) => {
  if (calibrating) return;
  dragging = true;
  grabOffset = ((volMax > 0 ? volume / volMax : 0) * KNOB_SWEEP - HALF) - pointerAngle(e);
  knob.setPointerCapture(e.pointerId);
});
knob.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  let a = pointerAngle(e) + grabOffset;
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  a = Math.max(-HALF, Math.min(HALF, a));
  setVolume(((a + HALF) / KNOB_SWEEP) * volMax, true);
});
const endDrag = () => (dragging = false);
knob.addEventListener('pointerup', endDrag);
knob.addEventListener('pointercancel', endDrag);
knob.addEventListener('lostpointercapture', endDrag);
knob.addEventListener('wheel', (e) => { if (calibrating) return; e.preventDefault(); setVolume(volume + (e.deltaY < 0 ? 1 : -1), true); }, { passive: false });
knob.addEventListener('keydown', (e) => {
  const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
  if (dir === undefined || calibrating) return;
  e.preventDefault();
  setVolume(volume + dir * (e.shiftKey ? 3 : 1), true);
});
renderVolume();

/* ───────────── Tone (bass/treble -> GRAPHICAL_EQ bands 0 & 4) ───────────── */
let eqState = [5, 5, 5, 5, 5];
const bass = $('bass');
const treble = $('treble');
bass.addEventListener('input', (e) => { const v = +e.target.value; $('bassVal').textContent = v; eqState[0] = v; writeKey('GRAPHICAL_EQ', enc.eq5(eqState)); });
treble.addEventListener('input', (e) => { const v = +e.target.value; $('trebleVal').textContent = v; eqState[4] = v; writeKey('GRAPHICAL_EQ', enc.eq5(eqState)); });
function reflectEq() {
  bass.value = String(eqState[0] <= 10 ? eqState[0] : 5);
  treble.value = String(eqState[4] <= 10 ? eqState[4] : 5);
  $('bassVal').textContent = bass.value;
  $('trebleVal').textContent = treble.value;
}

/* ───────────── Source ───────────── */
const sourceGroup = $('sourceGroup');
sourceGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const code = SOURCE_CODE[btn.dataset.src];
  reflectSource(code);
  writeKey('AUDIO_SOURCE', enc.source(code));
});
function reflectSource(code) {
  sourceGroup.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(SOURCE_CODE[b.dataset.src] === code)));
}

/* ───────────── EQ presets (local visual only) ───────────── */
$('eqGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $('eqGroup').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
});

/* ───────────── Night mode ───────────── */
const nightBtn = $('night');
nightBtn.addEventListener('click', () => setNight(nightBtn.getAttribute('aria-pressed') !== 'true', true));
function setNight(on, write) {
  nightBtn.setAttribute('aria-pressed', String(on));
  nightBtn.textContent = on ? 'On' : 'Off';
  if (write) writeKey('NIGHT_MODE', enc.night(on));
}

/* ───────────── Calibrate (map device step -> real Windows %) ───────────── */
const calibBtn = $('calibBtn');
const calibStatus = $('calibStatus');
const calibKey = (name) => 'marshall_calib_' + (name || 'default');
function loadCalib(name) {
  try {
    const o = JSON.parse(localStorage.getItem(calibKey(name)) || 'null');
    return o && Array.isArray(o.table) ? o.table : null;
  } catch {
    return null;
  }
}
function saveCalib(name, limit, table) {
  try { localStorage.setItem(calibKey(name), JSON.stringify({ limit, table })); } catch { /* ignore */ }
}
calibBtn.addEventListener('click', () => {
  if (!connected || calibrating) return;
  calibrating = true;
  calibStatus.classList.remove('hidden');
  calibStatus.textContent = 'Calibrating… keep audio paused';
  calibBtn.setAttribute('disabled', 'true');
  bridge.send({ cmd: 'calibrate' });
});

/* ───────────── Device image (remote, per model) ───────────── */
const deviceImg = $('deviceImg');
function setDeviceImage(name) {
  const code = MODEL_CODENAME[(name || '').trim().toUpperCase()];
  deviceImg.classList.add('hidden');
  if (!code) { deviceImg.removeAttribute('src'); return; }
  const colors = ['p1', 'all'];
  let i = 0;
  deviceImg.onload = () => deviceImg.classList.remove('hidden');
  deviceImg.onerror = () => {
    i += 1;
    if (i < colors.length) deviceImg.src = `${IMG_BASE}${code}_${colors[i]}_hero_1-1_xxxhdpi.webp`;
    else deviceImg.classList.add('hidden');
  };
  deviceImg.src = `${IMG_BASE}${code}_${colors[0]}_hero_1-1_xxxhdpi.webp`;
}

/* ───────────── Now playing (Windows media session) ───────────── */
const nowPlaying = $('nowPlaying');
const npPlay = $('npPlay');
const ICON_PLAY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
npPlay.innerHTML = ICON_PLAY;
function onMedia(e) {
  const hasMedia = (e.title && e.title.trim()) || (e.artist && e.artist.trim());
  if (!hasMedia) { nowPlaying.classList.add('hidden'); nowPlaying.classList.remove('flex'); return; }
  nowPlaying.classList.remove('hidden');
  nowPlaying.classList.add('flex');
  $('npTitle').textContent = e.title || '—';
  $('npArtist').textContent = e.artist || '';
  npPlay.innerHTML = e.status === 4 ? ICON_PAUSE : ICON_PLAY; // 4 = Playing
}
npPlay.addEventListener('click', () => bridge.send({ cmd: 'media', action: 'playpause' }));
$('npPrev').addEventListener('click', () => bridge.send({ cmd: 'media', action: 'prev' }));
$('npNext').addEventListener('click', () => bridge.send({ cmd: 'media', action: 'next' }));

/* ───────────── Connect / power ───────────── */
powerBtn.addEventListener('click', () => {
  if (connected) {
    bridge.send({ cmd: 'disconnect' });
  } else {
    availChars = new Set();
    setStatus('Scanning');
    showChooser();
    bridge.send({ cmd: 'scan' });
  }
});

function onConnected(e) {
  hideChooser();
  connected = true;
  availChars = new Set(e.chars || []);
  body.classList.add('lit');
  powerBtn.setAttribute('aria-pressed', 'true');
  setStatus('Connected');
  if (e.name) deviceNameEl.textContent = e.name;
  curDeviceName = e.name || '';
  setDeviceImage(e.name);
  calibTable = loadCalib(curDeviceName); // use saved calibration for this device if present
  renderVolume();
  document.querySelectorAll('[data-needs]').forEach((el) => el.classList.toggle('unavailable', !availChars.has(el.dataset.needs)));
}

function onDisconnected() {
  connected = false;
  body.classList.remove('lit');
  powerBtn.setAttribute('aria-pressed', 'false');
  setStatus('Standby');
  metaFw = ''; metaBatt = null; renderMeta();
  deviceImg.classList.add('hidden');
}

function onValue(char, hex) {
  const dv = hexToDv(hex);
  switch (char) {
    case 'VOLUME': { const raw = dec.volume(dv); if (raw >= 0 && Date.now() - lastVolTouch > 500) { volume = raw; renderVolume(); } break; }
    case 'VOLUME_LIMIT': { const m = dec.u8(dv); if (m > 0) { volMax = m; renderVolume(); } break; }
    case 'AUDIO_SOURCE': reflectSource(dec.source(dv)); break;
    case 'NIGHT_MODE': setNight(dec.night(dv), false); break;
    case 'GRAPHICAL_EQ': eqState = dec.eq5(dv); reflectEq(); break;
    case 'MODEL_NAME': { const n = dec.str(dv); if (n) { deviceNameEl.textContent = n; setDeviceImage(n); } break; }
    case 'FIRMWARE': metaFw = dec.str(dv); renderMeta(); break;
    case 'BATTERY': metaBatt = dec.u8(dv); renderMeta(); break;
  }
}

/* ───────────── Bridge events ───────────── */
bridge.onEvent((e) => {
  switch (e.evt) {
    case 'bridge_ready': log('BLE engine ready.'); break;
    case 'bridge_exit': log('BLE engine stopped (code ' + e.code + ').'); onDisconnected(); break;
    case 'scanning': setStatus('Scanning'); break;
    case 'scanStopped': break;
    case 'device': addDevice(e); break;
    case 'status': setStatus(e.text); break;
    case 'connected': onConnected(e); break;
    case 'ready': log('Ready.'); break;
    case 'value': onValue(e.char, e.hex); break;
    case 'media': onMedia(e); break;
    case 'disconnected': onDisconnected(); log('Disconnected.'); break;
    case 'calibrateProgress':
      calibStatus.textContent = `Calibrating… ${e.step + 1}/${e.max + 1}`;
      break;
    case 'calibrateDone':
      calibrating = false;
      calibTable = e.table;
      saveCalib(curDeviceName, e.limit, e.table);
      calibBtn.removeAttribute('disabled');
      calibStatus.textContent = 'Calibrated ✓';
      setTimeout(() => calibStatus.classList.add('hidden'), 2500);
      renderVolume();
      break;
    case 'error':
      log('ERROR [' + e.where + (e.char ? '/' + e.char : '') + ']: ' + e.message);
      if (e.where === 'connect' || e.where === 'spawn') { hideChooser(); setStatus('Standby'); }
      if (e.where === 'calibrate') { calibrating = false; calibBtn.removeAttribute('disabled'); calibStatus.textContent = 'Calibrate failed: ' + e.message; }
      break;
    case 'log': log(e.message); break;
  }
});

/* ───────────── Device chooser ───────────── */
const chooser = $('chooser');
const deviceListEl = $('deviceList');
let chooserEmpty = true;

function showChooser() {
  chooserEmpty = true;
  deviceListEl.innerHTML = '<div class="readout text-[12px] text-cream/40">Scanning…</div>';
  chooser.classList.remove('hidden');
  chooser.classList.add('flex');
}
function hideChooser() {
  chooser.classList.add('hidden');
  chooser.classList.remove('flex');
}
function addDevice(d) {
  if (chooserEmpty) { deviceListEl.innerHTML = ''; chooserEmpty = false; }
  const existing = deviceListEl.querySelector(`[data-addr="${d.address}"]`);
  if (existing) { existing.textContent = d.name; return; } // update label when a real name arrives
  const b = document.createElement('button');
  b.className = 'switch w-full px-3 py-2.5 text-left text-[12px]';
  b.dataset.addr = d.address;
  b.textContent = d.name;
  b.addEventListener('click', () => { setStatus('Connecting'); bridge.send({ cmd: 'connect', address: d.address }); });
  deviceListEl.appendChild(b);
}
$('chooserCancel').addEventListener('click', () => {
  bridge.send({ cmd: 'stopScan' });
  hideChooser();
  setStatus('Standby');
});

log('Press power to scan for your speaker.');
console.log('[renderer] loaded OK; power listener attached =', !!powerBtn);
