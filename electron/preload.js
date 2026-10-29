'use strict';
// What the page may ask the desktop shell: which monitors exist (second-screen picker), the app version, and updates.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tunerDesktop', {
  displays: () => ipcRenderer.invoke('tuner:displays'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  updater: {
    status: () => ipcRenderer.invoke('updater:status'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    openReleases: () => ipcRenderer.invoke('updater:open'),
    onStatus: (cb) => { ipcRenderer.on('updater:status', (_e, s) => cb(s)); },
  },
});
