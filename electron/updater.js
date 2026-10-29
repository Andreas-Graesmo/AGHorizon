'use strict';
/**
 * In-app updates via electron-updater + GitHub Releases.
 * Only active in the installed app (not when started with `npm start`).
 * The page talks to this through the small bridge in preload.js.
 */
const { app, ipcMain, BrowserWindow, shell } = require('electron');
const pkg = require('../package.json');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* dependency missing: updates are simply unavailable */ }

const pub = [].concat((pkg.build && pkg.build.publish) || [])[0] || {};
const releasesUrl = pub.owner && pub.repo && !/^YOUR-/i.test(pub.owner) ? `https://github.com/${pub.owner}/${pub.repo}/releases/latest` : '';

let status = { state: 'idle' };
function send(next) {
  status = next;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('updater:status', status);
}
const reason = () => {
  if (!autoUpdater) return 'The update component is not installed.';
  if (!app.isPackaged) return 'Updates only work in the installed app, not when started from source.';
  if (!releasesUrl) return 'No GitHub repository is configured yet (see RELEASING.md).';
  return '';
};

function init() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(), platform: process.platform, arch: process.arch,
    updater: !reason(), updaterReason: reason(), releasesUrl,
  }));
  ipcMain.handle('updater:status', () => status);
  ipcMain.handle('updater:open', () => { if (releasesUrl) shell.openExternal(releasesUrl); });

  if (reason()) {
    ipcMain.handle('updater:check', () => ({ state: 'unsupported', message: reason() }));
    ipcMain.handle('updater:download', () => status);
    ipcMain.handle('updater:install', () => status);
    return;
  }

  autoUpdater.autoDownload = false;          // the person decides
  autoUpdater.autoInstallOnAppQuit = true;   // a downloaded update installs when the app is closed
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => send({ state: 'available', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : '' }));
  autoUpdater.on('update-not-available', (i) => send({ state: 'current', version: i && i.version, checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', version: status.version, percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => send({ state: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => send({ state: 'error', version: status.version, message: String((e && e.message) || e).split('\n')[0].slice(0, 200) }));

  ipcMain.handle('updater:check', async () => { try { await autoUpdater.checkForUpdates(); } catch (e) { send({ state: 'error', message: String(e.message || e).split('\n')[0] }); } return status; });
  ipcMain.handle('updater:download', async () => { try { await autoUpdater.downloadUpdate(); } catch (e) { send({ state: 'error', version: status.version, message: String(e.message || e).split('\n')[0] }); } return status; });
  ipcMain.handle('updater:install', () => { setImmediate(() => autoUpdater.quitAndInstall(false, true)); return status; });
}

module.exports = { init };
