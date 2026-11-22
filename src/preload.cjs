// preload.cjs — bridge between the renderer UI and the Python BLE engine (via main).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ble', {
  send: (cmd) => ipcRenderer.send('ble:cmd', cmd),
  onEvent: (cb) => ipcRenderer.on('ble:evt', (_e, obj) => cb(obj)),
});

contextBridge.exposeInMainWorld('win', {
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
});
