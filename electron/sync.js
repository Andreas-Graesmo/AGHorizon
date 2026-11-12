'use strict';
/**
 * AG Horizon – sync, the desktop side (the page side is public/js/sync.js):
 *  - keeps the sync code, encrypted with the system's keychain (Electron safeStorage) when it has one;
 *  - the "folder" way to sync: reads and writes the encrypted files in a folder the person picked (Dropbox, iCloud
 *    Drive, OneDrive, Google Drive, Syncthing…). Only that folder: the page never gets to name a path itself.
 */
const { app, ipcMain, dialog, safeStorage, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const cfgFile = () => path.join(app.getPath('userData'), 'sync.json');
const secretFile = () => path.join(app.getPath('userData'), 'sync-code');
const SUBDIR = 'AG Horizon Sync';
const HEX = (min, max) => new RegExp(`^[0-9a-f]{${min},${max}}$`);

function readCfg() { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } }
function writeCfg(c) { fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2)); }

// the folder for one vault: "<picked folder>/AG Horizon Sync/<first 16 of the vault id>"
function vaultDir(vault) {
  const root = readCfg().folder;
  if (!root) throw new Error('No sync folder chosen');
  if (!HEX(64, 64).test(String(vault))) throw new Error('Bad vault');
  return path.join(root, SUBDIR, vault.slice(0, 16));
}
const checkDevice = (d) => { if (!HEX(16, 32).test(String(d))) throw new Error('Bad device'); return d; };

function init() {
  ipcMain.handle('sync:info', () => ({
    host: os.hostname().replace(/\.(local|lan|home)$/i, ''),
    keychain: safeStorage.isEncryptionAvailable(),
    folder: readCfg().folder || '',
  }));

  /* the sync code */
  ipcMain.handle('sync:code:get', () => {
    let raw;
    try { raw = fs.readFileSync(secretFile()); } catch { return ''; }
    if (raw.subarray(0, 4).toString() === 'enc:') {
      try { return safeStorage.decryptString(raw.subarray(4)); } catch { return ''; }   // e.g. the keychain was reset
    }
    return raw.toString('utf8');
  });
  ipcMain.handle('sync:code:set', (_e, code) => {
    code = String(code || '');
    if (!code) { fs.rmSync(secretFile(), { force: true }); return; }
    const data = safeStorage.isEncryptionAvailable() ? Buffer.concat([Buffer.from('enc:'), safeStorage.encryptString(code)]) : Buffer.from(code);
    fs.writeFileSync(secretFile(), data, { mode: 0o600 });
  });

  /* the folder */
  ipcMain.handle('sync:folder:choose', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Choose a folder to sync through',
      message: 'Pick a folder that your cloud storage keeps in sync on all your computers.',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return '';
    writeCfg({ ...readCfg(), folder: r.filePaths[0] });
    return r.filePaths[0];
  });
  ipcMain.handle('sync:folder:list', async (_e, vault) => {
    const dir = vaultDir(vault);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      const m = /^([0-9a-f]{16,32})\.agh$/.exec(n);
      if (!m) continue;
      try {
        const file = path.join(dir, n);
        const [st, blob] = await Promise.all([fsp.stat(file), fsp.readFile(file)]);
        out.push({ device: m[1], updated: st.mtime.toISOString(), blob: new Uint8Array(blob) });
      } catch { /* being written by the sync program right now: next time */ }
    }
    return out;
  });
  ipcMain.handle('sync:folder:put', async (_e, vault, device, blob) => {
    const dir = vaultDir(vault);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, checkDevice(device) + '.agh');
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, Buffer.from(blob));
    await fsp.rename(tmp, file);   // whole files only: a sync program never picks up half of one
    return new Date().toISOString();
  });
  ipcMain.handle('sync:folder:remove', async (_e, vault, device) => {
    const dir = vaultDir(vault);
    if (device) await fsp.rm(path.join(dir, checkDevice(device) + '.agh'), { force: true });
    else await fsp.rm(dir, { recursive: true, force: true });
  });
}

module.exports = { init };
