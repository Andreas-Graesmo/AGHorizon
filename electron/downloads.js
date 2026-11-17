'use strict';
/**
 * Downloads, the Electron side: the engine is desktop/downloads-core.js (shared with the Tauri app's server sidecar);
 * this file gives it Electron's paths, tells every window about changes, and answers the page (preload.js) with the
 * same IPC channels as before, including the folder dialog and "show in folder".
 */
const { app, ipcMain, BrowserWindow, dialog, shell } = require('electron');
const core = require('../desktop/downloads-core');

function init() {
  core.configure({
    dataDir: app.getPath('userData'),
    documentsDir: app.getPath('documents'),
    broadcast: (s) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('downloads:changed', s); },
  });
  ipcMain.handle('downloads:list', () => core.list());
  ipcMain.handle('downloads:orphans', () => core.orphans());
  ipcMain.handle('downloads:adopt', (_e, list) => core.adopt(list));
  ipcMain.handle('downloads:add', (_e, list) => core.add(list));
  ipcMain.handle('downloads:pause', (_e, id) => core.pause(id));
  ipcMain.handle('downloads:resume', (_e, id) => core.resume(id));
  ipcMain.handle('downloads:reorder', (_e, ids) => core.reorder(ids));
  ipcMain.handle('downloads:remove', (_e, id, deleteFile) => core.remove(id, !!deleteFile));
  ipcMain.handle('downloads:reveal', (_e, id) => {
    const t = core.revealTarget(id);
    if (t.file) shell.showItemInFolder(t.file); else shell.openPath(t.folder);
  });
  ipcMain.handle('downloads:openFolder', async () => shell.openPath(await core.ensureFolder()));
  ipcMain.handle('downloads:chooseFolder', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Choose the download folder', defaultPath: core.currentFolder(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return core.setFolder(r.filePaths[0]);
  });
  ipcMain.handle('downloads:setOption', (_e, key, value) => core.setOption(key, value));
  ipcMain.handle('downloads:setWatching', (_e, on) => core.setWatching(on));
  app.on('before-quit', () => core.quitting());
  core.start();
}

module.exports = { init, localFile: core.localFile, removeEmptyDirs: core.removeEmptyDirs, targetFile: core.targetFile };   // the last two for test/
