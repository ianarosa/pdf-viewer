'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openFiles: () => ipcRenderer.invoke('open-files'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-updates'),
  lastRoots: () => ipcRenderer.invoke('last-roots'),
  resolvePaths: (paths) => ipcRenderer.invoke('resolve-paths', paths),
  readFile: async (p) => {
    const buf = await ipcRenderer.invoke('read-file', p);
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onOpenPaths: (cb) => {
    const handler = (_e, paths, meta) => cb(paths, meta);
    ipcRenderer.on('open-paths', handler);
    return () => ipcRenderer.removeListener('open-paths', handler);
  },
  onUpdateStatus: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
  installUpdate: () => ipcRenderer.send('install-update'),
});
