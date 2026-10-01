const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let win = null;
let pendingPortCallback = null;

const FONT_DIRS = [
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  '/Library/Fonts',
  path.join(os.homedir(), 'Library/Fonts'),
];
const FONT_EXT = /\.(ttf|otf|woff)$/i;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    title: 'Laser Studio',
    backgroundColor: '#17181b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const ses = win.webContents.session;

  // navigator.serial.requestPort() lands here; let the renderer show its own picker.
  ses.on('select-serial-port', (event, portList, _webContents, callback) => {
    event.preventDefault();
    if (pendingPortCallback) pendingPortCallback('');
    pendingPortCallback = callback;
    win.webContents.send(
      'serial-port-list',
      portList.map((p) => ({
        portId: p.portId, portName: p.portName, displayName: p.displayName || '', usb: !!(p.vendorId || p.productId),
      }))
    );
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'serial');
  ses.setDevicePermissionHandler((details) => details.deviceType === 'serial');

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

ipcMain.on('serial-port-chosen', (_e, portId) => {
  if (pendingPortCallback) {
    pendingPortCallback(portId || '');
    pendingPortCallback = null;
  }
});

ipcMain.handle('list-fonts', () => {
  const fonts = [];
  for (const dir of FONT_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (FONT_EXT.test(f)) fonts.push({ name: f.replace(FONT_EXT, ''), path: path.join(dir, f) });
    }
  }
  fonts.sort((a, b) => a.name.localeCompare(b.name));
  return fonts;
});

ipcMain.handle('read-font', (_e, fontPath) => {
  if (typeof fontPath !== 'string' || !FONT_EXT.test(fontPath)) throw new Error('Not a font file');
  return fs.readFileSync(fontPath);
});

ipcMain.handle('choose-font', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a font',
    filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff'] }],
    properties: ['openFile'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('save-gcode', async (_e, text) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save G-code',
    defaultPath: 'laser-job.gcode',
    filters: [{ name: 'G-code', extensions: ['gcode', 'nc', 'gc'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, text, 'utf8');
  return res.filePath;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
