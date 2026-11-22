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

const { CHARS, SOURCE_CODE, PRESET_CODE, enc, dec, IMG_BASE, MODEL_CODENAME } = window.BLE || {};
const bridge = window.ble || { send() {}, onEvent() {} };

const $ = (id) => document.getElementById(id);
const body = document.body;

/* ───────────── Motion (GSAP) ───────────── */
// ANIM gates every animation: off if GSAP failed to load or the user asked for reduced motion.
const ANIM = typeof gsap !== 'undefined' && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
if (typeof gsap !== 'undefined') gsap.defaults({ ease: 'power3.out', duration: 0.5 });

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
// Smoothly tween the needle to a target step (used for remote changes + the connect sweep).
// User drag stays instant via renderVolume() — never routed through here.
let sweepPending = false; // connect: sweep 0 -> real value when it first arrives
let volTween = null;
function animateVolumeTo(target) {
  target = clamp(target, 0, volMax);
  if (!ANIM) { volume = target; renderVolume(); return; }
  if (volTween) volTween.kill();
  const proxy = { v: volume };
  volTween = gsap.to(proxy, {
    v: target, duration: 0.6, ease: 'expo.out',
    onUpdate() { volume = proxy.v; renderVolume(); },
    onComplete() { volume = target; renderVolume(); },
  });
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

/* ───────────── EQ presets (EQUALIZER_SETTINGS; models without manual bass/treble) ───────────── */
$('eqGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $('eqGroup').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  const code = PRESET_CODE[btn.dataset.eq];
  if (code != null) writeKey('EQUALIZER_SETTINGS', enc.eqPreset(code));
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
  if (ANIM) gsap.fromTo(calibStatus, { autoAlpha: 0.45 }, { autoAlpha: 1, duration: 0.7, ease: 'sine.inOut', repeat: -1, yoyo: true });
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
  deviceImg.onload = () => {
    deviceImg.classList.remove('hidden');
    if (ANIM) gsap.fromTo(deviceImg, { autoAlpha: 0, scale: 0.84, y: 16 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.7, ease: 'back.out(1.4)' });
  };
  deviceImg.onerror = () => {
    i += 1;
    if (i < colors.length) deviceImg.src = `${IMG_BASE}${code}_${colors[i]}_hero_1-1_xxxhdpi.webp`;
    else deviceImg.classList.add('hidden');
  };
  deviceImg.src = `${IMG_BASE}${code}_${colors[0]}_hero_1-1_xxxhdpi.webp`;
}

// Playful 3D tilt + lift while hovering the speaker render (like inspecting it in 3D).
if (ANIM && deviceImg) {
  const MAX = 8; // max tilt, degrees
  let hovering = false;
  deviceImg.addEventListener('pointerenter', () => {
    if (deviceImg.classList.contains('hidden')) return;
    hovering = true;
    gsap.to(deviceImg, { scale: 1.06, duration: 0.4, ease: 'power2.out' });
  });
  deviceImg.addEventListener('pointermove', (e) => {
    if (!hovering) return;
    const r = deviceImg.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5; // -0.5 .. 0.5
    const py = (e.clientY - r.top) / r.height - 0.5;
    gsap.to(deviceImg, {
      rotationY: px * MAX * 2, rotationX: -py * MAX * 2,
      transformPerspective: 800, transformOrigin: 'center center',
      duration: 0.5, ease: 'power2.out',
    });
  });
  deviceImg.addEventListener('pointerleave', () => {
    hovering = false;
    gsap.to(deviceImg, { rotationX: 0, rotationY: 0, scale: 1, duration: 0.6, ease: 'power3.out' });
  });
}

/* ───────────── Now playing (Windows media session) ───────────── */
const nowPlaying = $('nowPlaying');
const npPlay = $('npPlay');
const ICON_PLAY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
npPlay.innerHTML = ICON_PLAY;
function hideNowPlaying() { nowPlaying.classList.add('hidden'); nowPlaying.classList.remove('flex'); }
function onMedia(e) {
  const hasMedia = (e.title && e.title.trim()) || (e.artist && e.artist.trim());
  if (!hasMedia) {
    if (ANIM && nowPlaying.classList.contains('flex')) {
      gsap.to(nowPlaying, { autoAlpha: 0, y: 8, duration: 0.3, ease: 'power2.in', onComplete: hideNowPlaying });
    } else hideNowPlaying();
    return;
  }
  const wasHidden = nowPlaying.classList.contains('hidden');
  nowPlaying.classList.remove('hidden');
  nowPlaying.classList.add('flex');

  const titleChanged = $('npTitle').textContent !== (e.title || '—');
  $('npTitle').textContent = e.title || '—';
  $('npArtist').textContent = e.artist || '';

  const playing = e.status === 4; // 4 = Playing
  if (npPlay.dataset.playing !== String(playing)) {
    npPlay.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    npPlay.dataset.playing = String(playing);
    if (ANIM && !wasHidden) gsap.fromTo(npPlay, { scale: 0.7 }, { scale: 1, duration: 0.35, ease: 'back.out(2.5)' });
  }

  if (ANIM && wasHidden) gsap.fromTo(nowPlaying, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.45, ease: 'power3.out' });
  else if (ANIM && titleChanged) gsap.fromTo([$('npTitle'), $('npArtist')], { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.4, ease: 'power2.out', stagger: 0.05 });
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
  if (ANIM) { sweepPending = true; volume = 0; } // needle starts at 0, sweeps up when the real value arrives
  renderVolume();
  document.querySelectorAll('[data-needs]').forEach((el) => el.classList.toggle('unavailable', !availChars.has(el.dataset.needs)));
  if (ANIM) {
    gsap.fromTo('.led', { scale: 0.3 }, { scale: 1, duration: 0.5, ease: 'back.out(3)' }); // pilot light powers on
    gsap.from('.scroll-area > *', { y: 12, duration: 0.55, stagger: 0.06, ease: 'power3.out' }); // control stack lifts in
  }
}

function onDisconnected() {
  connected = false;
  body.classList.remove('lit');
  powerBtn.setAttribute('aria-pressed', 'false');
  setStatus('Standby');
  metaFw = ''; metaBatt = null; renderMeta();
  sweepPending = false;
  if (ANIM && !deviceImg.classList.contains('hidden')) {
    gsap.to(deviceImg, { autoAlpha: 0, scale: 0.9, duration: 0.35, ease: 'power2.in', onComplete: () => deviceImg.classList.add('hidden') });
  } else {
    deviceImg.classList.add('hidden');
  }
  deviceNameEl.textContent = 'Not connected';
  curDeviceName = '';
}

function onValue(char, hex) {
  const dv = hexToDv(hex);
  switch (char) {
    case 'VOLUME': {
      const raw = dec.volume(dv);
      if (raw < 0) break;
      if (sweepPending) { sweepPending = false; volume = 0; renderVolume(); animateVolumeTo(raw); }
      else if (Date.now() - lastVolTouch > 500) animateVolumeTo(raw);
      break;
    }
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
      if (ANIM) { gsap.killTweensOf(calibStatus); gsap.set(calibStatus, { autoAlpha: 1 }); }
      calibStatus.textContent = 'Calibrated ✓';
      setTimeout(() => calibStatus.classList.add('hidden'), 2500);
      renderVolume();
      break;
    case 'error':
      log('ERROR [' + e.where + (e.char ? '/' + e.char : '') + ']: ' + e.message);
      if (e.where === 'connect' || e.where === 'spawn') { hideChooser(); setStatus('Standby'); }
      if (e.where === 'calibrate') { calibrating = false; calibBtn.removeAttribute('disabled'); if (ANIM) { gsap.killTweensOf(calibStatus); gsap.set(calibStatus, { autoAlpha: 1 }); } calibStatus.textContent = 'Calibrate failed: ' + e.message; }
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
  if (ANIM) {
    gsap.fromTo(chooser, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: 'power2.out' });
    gsap.fromTo(chooser.firstElementChild, { scale: 0.92, y: 14, autoAlpha: 0 }, { scale: 1, y: 0, autoAlpha: 1, duration: 0.4, ease: 'back.out(1.5)' });
  }
}
function hideChooser() {
  if (ANIM && chooser.classList.contains('flex')) {
    gsap.to(chooser, { autoAlpha: 0, duration: 0.2, ease: 'power2.in', onComplete: () => {
      chooser.classList.add('hidden'); chooser.classList.remove('flex');
      gsap.set(chooser, { clearProps: 'opacity,visibility' });
    } });
  } else {
    chooser.classList.add('hidden');
    chooser.classList.remove('flex');
  }
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
  if (ANIM) gsap.from(b, { autoAlpha: 0, y: 8, duration: 0.35, ease: 'power3.out' });
}
$('chooserCancel').addEventListener('click', () => {
  bridge.send({ cmd: 'stopScan' });
  hideChooser();
  setStatus('Standby');
});

/* ───────────── Entrance + tactile press (GSAP) ───────────── */
if (ANIM) {
  // amp powers up — header chrome settles into place
  gsap.timeline({ delay: 0.06 })
    .from('.wordmark', { y: -12, autoAlpha: 0, duration: 0.6 })
    .from('#deviceName', { y: -6, autoAlpha: 0, duration: 0.4 }, '-=0.35')
    .from('#powerBtn', { scale: 0.5, autoAlpha: 0, duration: 0.5, ease: 'back.out(2)' }, '-=0.45')
    .from('#statusText', { x: -8, autoAlpha: 0, duration: 0.4 }, '-=0.2')
    .from('.titlebar button', { autoAlpha: 0, duration: 0.3, stagger: 0.05 }, '-=0.35');

  // tactile press on every amp switch (power, source, presets, night, calibrate, transport, chooser)
  let pressed = null;
  const press = (b, s) => gsap.to(b, { scale: s, duration: s < 1 ? 0.08 : 0.3, ease: s < 1 ? 'power2.out' : 'back.out(2)' });
  document.addEventListener('pointerdown', (e) => { const b = e.target.closest('.switch'); if (b) { pressed = b; press(b, 0.94); } });
  const release = () => { if (pressed) { press(pressed, 1); pressed = null; } };
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
}

log('Press power to scan for your speaker.');
console.log('[renderer] loaded OK; power listener attached =', !!powerBtn);
