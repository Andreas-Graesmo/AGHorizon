'use strict';
/**
 * The "folder" way to sync (the page side is public/js/sync.js): reads and writes the encrypted files in a folder the
 * person picked (Dropbox, iCloud Drive, OneDrive, Google Drive, Syncthing…). Only that folder: the page never gets to
 * name a path itself. The choice is kept in <data dir>/sync.json.
 *
 * No Electron here (MIGRATION_PLAN.md 3.4): used by electron/sync.js and by the Tauri app's server sidecar
 * (sidecar/entry.js). The folder dialog and the sync code's keychain stay with each shell.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

let dataDir = '';
function configure(h) { dataDir = h.dataDir; }

const cfgFile = () => path.join(dataDir, 'sync.json');
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

const host = () => os.hostname().replace(/\.(local|lan|home)$/i, '');
const folder = () => readCfg().folder || '';
function setFolder(f) { if (f) writeCfg({ ...readCfg(), folder: String(f) }); return f ? String(f) : ''; }

async function list(vault) {
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
}

async function put(vault, device, blob) {
  const dir = vaultDir(vault);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, checkDevice(device) + '.agh');
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, Buffer.from(blob));
  await fsp.rename(tmp, file);   // whole files only: a sync program never picks up half of one
  return new Date().toISOString();
}

async function remove(vault, device) {
  const dir = vaultDir(vault);
  if (device) await fsp.rm(path.join(dir, checkDevice(device) + '.agh'), { force: true });
  else await fsp.rm(dir, { recursive: true, force: true });
}

module.exports = { configure, host, folder, setFolder, list, put, remove };
