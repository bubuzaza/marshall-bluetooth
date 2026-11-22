import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';

Menu.setApplicationMenu(null); // clean amp look — no default File/Edit/View menu
app.setAppUserModelId('com.marshall.controller'); // Windows uses our taskbar/tray icon, not Electron's
app.isQuitting = false;

// File locations differ between `bun run start` (dev) and the packaged .exe.
const BRIDGE_PY = app.isPackaged
  ? path.join(process.resourcesPath, 'bridge', 'ble_bridge.py')
  : path.join(import.meta.dirname, 'bridge', 'ble_bridge.py');
const ICON = app.isPackaged
  ? path.join(process.resourcesPath, 'assets', 'icon.ico')
  : path.join(import.meta.dirname, '..', 'assets', 'icon.ico');
const DEBUG_LOG = app.isPackaged
  ? path.join(app.getPath('userData'), 'debug.log') // asar is read-only when packaged
  : path.join(import.meta.dirname, '..', 'debug.log');

try { fs.writeFileSync(DEBUG_LOG, ''); } catch {}
function dlog(s) {
  try { fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + s + '\n'); } catch {}
}

let win = null;
let tray = null;
let py = null;

function startBridge() {
  py = spawn('python', ['-X', 'utf8', BRIDGE_PY], { stdio: ['pipe', 'pipe', 'pipe'] });
  dlog('[spawn] python ' + BRIDGE_PY);
  const rl = readline.createInterface({ input: py.stdout });
  rl.on('line', (line) => {
    dlog('[py-evt] ' + line);
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (win && !win.isDestroyed()) win.webContents.send('ble:evt', obj);
  });
  py.stderr.on('data', (d) => {
    dlog('[py-stderr] ' + d.toString().trim());
    if (win && !win.isDestroyed()) win.webContents.send('ble:evt', { evt: 'log', message: '[py] ' + d.toString().trim() });
  });
  py.on('exit', (code) => {
    dlog('[py-exit] code=' + code);
    if (win && !win.isDestroyed()) win.webContents.send('ble:evt', { evt: 'bridge_exit', code });
  });
  py.on('error', (e) => {
    dlog('[py-spawn-error] ' + e.message);
    if (win && !win.isDestroyed())
      win.webContents.send('ble:evt', { evt: 'error', where: 'spawn', message: e.message + ' (is Python installed and in PATH?)' });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 412,
    height: 880,
    minWidth: 380,
    minHeight: 720,
    maxWidth: 520,
    backgroundColor: '#120f0e',
    show: false,
    frame: false, // custom amp-themed title bar
    maximizable: false, // fixed portrait app — minimize + close only
    icon: ICON,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
    },
  });

  win.loadFile(path.join(import.meta.dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Closing (the ✕ button or OS close) hides to the tray instead of quitting.
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); hintTray(); }
  });

  // Marshall's image CDN requires this header; <img> tags can't set it, so inject it here.
  win.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['https://app-images.marshall.software/*'] },
    (details, cb) => {
      details.requestHeaders['marshall-mobile-app-version'] = '3.9.2';
      cb({ requestHeaders: details.requestHeaders });
    },
  );

  win.webContents.on('console-message', (...args) => {
    const a = args[0];
    if (a && typeof a === 'object' && 'message' in a) dlog(`[console:${a.level}] ${a.message} @${a.sourceId || ''}:${a.lineNumber || ''}`);
    else dlog(`[console:${args[1]}] ${args[2]} @${args[4] || ''}:${args[3] || ''}`);
  });
  win.webContents.on('preload-error', (_e, p, err) => dlog(`[preload-error] ${p}: ${(err && err.stack) || err}`));
  win.webContents.on('did-fail-load', (_e, c, d) => dlog(`[did-fail-load] ${c} ${d}`));
  win.webContents.on('render-process-gone', (_e, det) => dlog(`[render-gone] ${JSON.stringify(det)}`));

  // spawn the bridge only after the renderer has loaded + subscribed to 'ble:evt'
  win.webContents.once('did-finish-load', () => startBridge());
}

function showWindow() { if (win) { win.show(); win.focus(); } }
function toggleWindow() { if (win) (win.isVisible() ? win.hide() : showWindow()); }

let hinted = false;
function hintTray() {
  if (hinted || !tray) return;
  hinted = true;
  try {
    tray.displayBalloon({ iconType: 'info', title: 'Marshall Controller', content: 'Still running in the tray — right-click the tray icon to quit.' });
  } catch { /* balloons are Windows-only */ }
}

function createTray() {
  let img = nativeImage.createFromPath(ICON);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img.isEmpty() ? ICON : img);
  tray.setToolTip('Marshall Controller');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Marshall Controller', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', toggleWindow);
}

ipcMain.on('ble:cmd', (_e, cmd) => {
  if (py && py.stdin.writable) {
    try { py.stdin.write(JSON.stringify(cmd) + '\n'); } catch { /* bridge gone */ }
  }
});

// custom window controls (frameless title bar)
ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('win:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) (w.isMaximized() ? w.unmaximize() : w.maximize());
});
ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

function stopBridge() {
  if (py) { try { py.kill(); } catch {} py = null; }
}

// single instance — a second launch just reveals the running window
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    createWindow();
    createTray();
    app.on('activate', () => (win ? showWindow() : createWindow()));
  });
}

app.on('before-quit', () => { app.isQuitting = true; stopBridge(); });
