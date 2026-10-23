'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const naturalCompare = (a, b) =>
  collator.compare(path.basename(a), path.basename(b)) || collator.compare(a, b);
const isPdf = (p) => path.extname(p).toLowerCase() === '.pdf';
const toItems = (set) =>
  [...set].sort(naturalCompare).map((p) => ({ path: p, name: path.basename(p) }));

async function walk(dir, out) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && isPdf(full)) out.add(full);
  }
}

async function resolvePaths(paths) {
  const out = new Set();
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || !p) continue;
    let st;
    try { st = await fs.promises.stat(p); } catch { continue; }
    if (st.isDirectory()) await walk(p, out);
    else if (st.isFile() && isPdf(p)) out.add(path.resolve(p));
  }
  return toItems(out);
}

// Extract pdf/folder args from an argv list
function pathsFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  return args.filter((a) => a && !a.startsWith('--') && fs.existsSync(a));
}

let win = null;
let rendererReady = false;
let pending = [];
let lastRoots = [];   // root paths picked in the last open dialog (for session restore)

function sendPaths(paths) {
  if (!paths.length) return;
  if (win && rendererReady) win.webContents.send('open-paths', paths);
  else pending.push(...paths);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  rendererReady = false;
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    if (pending.length) {
      win.webContents.send('open-paths', pending, { launch: true });
      pending = [];
    }
  });
  win.on('closed', () => { win = null; rendererReady = false; });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

Menu.setApplicationMenu(null);

// Auto-update (installed NSIS build only; the portable exe cannot self-update).
function sendUpdate(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('update-status', payload);
}
const canUpdate = () => app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
let updater = null;
let manualCheck = false;   // true only while a user-initiated check runs: errors/no-update are reported then
function setupAutoUpdate() {
  if (!canUpdate()) return;
  try {
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (i) => sendUpdate({ state: 'available', version: i && i.version }));
    autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'progress', percent: p && p.percent }));
    autoUpdater.on('update-downloaded', (i) => sendUpdate({ state: 'downloaded', version: i && i.version }));
    autoUpdater.on('checking-for-update', () => { if (manualCheck) sendUpdate({ state: 'checking' }); });
    autoUpdater.on('update-not-available', () => { if (manualCheck) sendUpdate({ state: 'not-available', version: app.getVersion() }); manualCheck = false; });
    autoUpdater.on('error', () => { /* launch-time check stays silent; manual checks report */ if (manualCheck) sendUpdate({ state: 'error' }); manualCheck = false; });
    ipcMain.on('install-update', () => { try { autoUpdater.quitAndInstall(); } catch {} });
    const p = autoUpdater.checkForUpdates();
    if (p && p.catch) p.catch(() => {});
  } catch { /* never block startup */ }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    sendPaths(pathsFromArgv(argv));
  });

  ipcMain.handle('open-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return [];
    lastRoots = r.filePaths.slice();
    return resolvePaths(r.filePaths);
  });
  ipcMain.handle('last-roots', () => lastRoots);
  ipcMain.handle('open-files', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePaths.length) return [];
    lastRoots = r.filePaths.slice();
    return resolvePaths(r.filePaths);
  });
  ipcMain.handle('get-version', () => app.getVersion());
  ipcMain.handle('check-updates', async () => {
    if (!canUpdate() || !updater) return { state: 'unavailable' };
    manualCheck = true;
    try { await updater.checkForUpdates(); return { state: 'started' }; }
    catch { manualCheck = false; sendUpdate({ state: 'error' }); return { state: 'error' }; }
  });
  ipcMain.handle('resolve-paths', (_e, paths) => resolvePaths(paths));
  ipcMain.handle('read-file', async (_e, p) => {
    const buf = await fs.promises.readFile(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });

  app.whenReady().then(() => {
    pending.push(...pathsFromArgv(process.argv));
    createWindow();
    setupAutoUpdate();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
}
