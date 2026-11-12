'use strict';
// What the page may ask the desktop shell: which monitors exist (mirror picture picker), bringing the window forward,
// the app version, updates, downloads and sync.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tunerDesktop', {
  displays: () => ipcRenderer.invoke('tuner:displays'),
  focusWindow: () => ipcRenderer.invoke('tuner:focus'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  ready: () => ipcRenderer.send('app:ready'),   // the first view is drawn: main.js shows the window
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
    reorder: (ids) => ipcRenderer.invoke('downloads:reorder', ids),
    remove: (id, deleteFile) => ipcRenderer.invoke('downloads:remove', id, deleteFile),
    reveal: (id) => ipcRenderer.invoke('downloads:reveal', id),
    openFolder: () => ipcRenderer.invoke('downloads:openFolder'),
    chooseFolder: () => ipcRenderer.invoke('downloads:chooseFolder'),
    setOption: (key, value) => ipcRenderer.invoke('downloads:setOption', key, value),
    setWatching: (on) => ipcRenderer.invoke('downloads:setWatching', on),
    orphans: () => ipcRenderer.invoke('downloads:orphans'),
    adopt: (list) => ipcRenderer.invoke('downloads:adopt', list),
    onChange: (cb) => { ipcRenderer.on('downloads:changed', (_e, s) => cb(s)); },
  },
  sync: {
    info: () => ipcRenderer.invoke('sync:info'),
    getCode: () => ipcRenderer.invoke('sync:code:get'),
    setCode: (code) => ipcRenderer.invoke('sync:code:set', code),
    chooseFolder: () => ipcRenderer.invoke('sync:folder:choose'),
    folderList: (vault) => ipcRenderer.invoke('sync:folder:list', vault),
    folderPut: (vault, device, blob) => ipcRenderer.invoke('sync:folder:put', vault, device, blob),
    folderRemove: (vault, device) => ipcRenderer.invoke('sync:folder:remove', vault, device),
  },
});
