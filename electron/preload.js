'use strict';
// What the page may ask the desktop shell: which monitors exist (second-screen picker), the app version, updates and downloads.
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
  downloads: {
    list: () => ipcRenderer.invoke('downloads:list'),
    add: (items) => ipcRenderer.invoke('downloads:add', items),
    pause: (id) => ipcRenderer.invoke('downloads:pause', id),
    resume: (id) => ipcRenderer.invoke('downloads:resume', id),
    remove: (id, deleteFile) => ipcRenderer.invoke('downloads:remove', id, deleteFile),
    reveal: (id) => ipcRenderer.invoke('downloads:reveal', id),
    openFolder: () => ipcRenderer.invoke('downloads:openFolder'),
    chooseFolder: () => ipcRenderer.invoke('downloads:chooseFolder'),
    setOption: (key, value) => ipcRenderer.invoke('downloads:setOption', key, value),
    setWatching: (on) => ipcRenderer.invoke('downloads:setWatching', on),
    onChange: (cb) => { ipcRenderer.on('downloads:changed', (_e, s) => cb(s)); },
  },
});
