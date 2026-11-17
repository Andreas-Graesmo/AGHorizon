'use strict';
/**
 * AG Horizon – sync, the desktop side (the page side is public/js/sync.js):
 *  - keeps the sync code, encrypted with the system's keychain (Electron safeStorage) when it has one;
 *  - the "folder" way to sync: reads and writes the encrypted files in a folder the person picked (Dropbox, iCloud
 *    Drive, OneDrive, Google Drive, Syncthing…). Only that folder: the page never gets to name a path itself.
 */
const { app, ipcMain, dialog, safeStorage, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const folderSync = require('../desktop/sync-folder');   // the folder itself, shared with the Tauri app's sidecar

const secretFile = () => path.join(app.getPath('userData'), 'sync-code');

// Electron's safeStorage, the asynchronous calls (the synchronous ones are on their way out). What the synchronous
// ones encrypted, these decrypt.
const keychain = () => safeStorage.isAsyncEncryptionAvailable().catch(() => false);
async function saveCode(code) {
  const data = await keychain() ? Buffer.concat([Buffer.from('enc:'), await safeStorage.encryptStringAsync(code)]) : Buffer.from(code);
  fs.writeFileSync(secretFile(), data, { mode: 0o600 });
}

// The sync code in plain text, or '' (none, or the keychain can't decrypt it any more). Also used by handover.js,
// which passes it to the new app.
async function readCode() {
  let raw;
  try { raw = fs.readFileSync(secretFile()); } catch { return ''; }
  if (raw.subarray(0, 4).toString() !== 'enc:') return raw.toString('utf8');
  let code;
  try {
    const r = await safeStorage.decryptStringAsync(raw.subarray(4));
    code = r.result;
    if (r.shouldReEncrypt) await saveCode(code).catch(() => {});   // the keychain has a newer key: keep the code under that one
  } catch { return ''; }   // e.g. the keychain was reset
  return code;
}

function init() {
  folderSync.configure({ dataDir: app.getPath('userData') });
  ipcMain.handle('sync:info', async () => ({ host: folderSync.host(), keychain: await keychain(), folder: folderSync.folder() }));

  /* the sync code */
  ipcMain.handle('sync:code:get', () => readCode());
  ipcMain.handle('sync:code:set', async (_e, code) => {
    code = String(code || '');
    if (!code) { fs.rmSync(secretFile(), { force: true }); return; }
    await saveCode(code);
  });

  /* the folder */
  ipcMain.handle('sync:folder:choose', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Choose a folder to sync through',
      message: 'Pick a folder that your cloud storage keeps in sync on all your computers.',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return '';
    return folderSync.setFolder(r.filePaths[0]);
  });
  ipcMain.handle('sync:folder:list', (_e, vault) => folderSync.list(vault));
  ipcMain.handle('sync:folder:put', (_e, vault, device, blob) => folderSync.put(vault, device, blob));
  ipcMain.handle('sync:folder:remove', (_e, vault, device) => folderSync.remove(vault, device));
}

module.exports = { init, readCode };
