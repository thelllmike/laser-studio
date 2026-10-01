const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  onSerialPortList: (cb) => ipcRenderer.on('serial-port-list', (_e, list) => cb(list)),
  chooseSerialPort: (portId) => ipcRenderer.send('serial-port-chosen', portId),
  listFonts: () => ipcRenderer.invoke('list-fonts'),
  readFont: (fontPath) => ipcRenderer.invoke('read-font', fontPath),
  chooseFont: () => ipcRenderer.invoke('choose-font'),
  saveGcode: (text) => ipcRenderer.invoke('save-gcode', text),
});
