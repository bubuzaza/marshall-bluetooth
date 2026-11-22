import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';

Menu.setApplicationMenu(null); // clean amp look — no default File/Edit/View menu

const DEBUG_LOG = path.join(import.meta.dirname, 'debug.log');
try { fs.writeFileSync(DEBUG_LOG, ''); } catch {}
function dlog(s) {
  try { fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + s + '\n'); } catch {}
}

let py = null;

function startBridge(win) {
  py = spawn('python', ['-X', 'utf8', path.join(import.meta.dirname, 'ble_bridge.py')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  dlog('[spawn] python -X utf8 ble_bridge.py');
  const rl = readline.createInterface({ input: py.stdout });
  rl.on('line', (line) => {
    dlog('[py-evt] ' + line);
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (!win.isDestroyed()) win.webContents.send('ble:evt', obj);
  });
  py.stderr.on('data', (d) => {
    dlog('[py-stderr] ' + d.toString().trim());
    if (!win.isDestroyed()) win.webContents.send('ble:evt', { evt: 'log', message: '[py] ' + d.toString().trim() });
  });
  py.on('exit', (code) => {
    dlog('[py-exit] code=' + code);
    if (!win.isDestroyed()) win.webContents.send('ble:evt', { evt: 'bridge_exit', code });
  });
  py.on('error', (e) => {
    dlog('[py-spawn-error] ' + e.message);
    if (!win.isDestroyed())
      win.webContents.send('ble:evt', { evt: 'error', where: 'spawn', message: e.message + ' (is Python installed and in PATH?)' });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 412,
    height: 880,
    minWidth: 380,
    minHeight: 720,
    maxWidth: 520,
    backgroundColor: '#120f0e',
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
    },
  });

  win.loadFile(path.join(import.meta.dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.webContents.on('console-message', (...args) => {
    const a = args[0];
    if (a && typeof a === 'object' && 'message' in a) dlog(`[console:${a.level}] ${a.message} @${a.sourceId || ''}:${a.lineNumber || ''}`);
    else dlog(`[console:${args[1]}] ${args[2]} @${args[4] || ''}:${args[3] || ''}`);
  });
  win.webContents.on('preload-error', (_e, p, err) => dlog(`[preload-error] ${p}: ${(err && err.stack) || err}`));
  win.webContents.on('did-fail-load', (_e, c, d) => dlog(`[did-fail-load] ${c} ${d}`));
  win.webContents.on('render-process-gone', (_e, det) => dlog(`[render-gone] ${JSON.stringify(det)}`));

  // spawn the bridge only after the renderer has loaded + subscribed to 'ble:evt',
  // so early events (bridge_ready) aren't dropped
  win.webContents.once('did-finish-load', () => startBridge(win));
}

ipcMain.on('ble:cmd', (_e, cmd) => {
  if (py && py.stdin.writable) {
    try { py.stdin.write(JSON.stringify(cmd) + '\n'); } catch { /* bridge gone */ }
  }
});

function stopBridge() {
  if (py) { try { py.kill(); } catch {} py = null; }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', stopBridge);
app.on('window-all-closed', () => {
  stopBridge();
  if (process.platform !== 'darwin') app.quit();
});
