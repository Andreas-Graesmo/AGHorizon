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

// From "repository": electron-builder strips "build" (and its publish settings) from the installed app's package.json.
const repo = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i.exec(String((pkg.repository && pkg.repository.url) || pkg.repository || '').trim());
const pub = repo ? { owner: repo[1], repo: repo[2] } : {};
const releasesUrl = pub.owner && pub.repo ? `https://github.com/${pub.owner}/${pub.repo}/releases/latest` : '';

let status = { state: 'idle' };
function send(next) {
  status = next;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('updater:status', status);
}
const reason = () => {
  if (!autoUpdater) return 'The update component is not installed.';
  if (!app.isPackaged) return 'Updates only work in the installed app, not when started from source.';
  if (!releasesUrl) return 'No GitHub repository is configured yet (see RELEASING.md).';
  // electron-updater on macOS needs a code-signed app, and the release build isn't signed
  if (process.platform === 'darwin') return 'On a Mac, download new versions from GitHub.';
  return '';
};

// "v1.12.0" vs "1.9.3": compare the numbers part by part
function newer(tag, current) {
  const a = tag.replace(/^v/i, '').split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

async function manualCheck() {
  if (!releasesUrl) { send({ state: 'error', message: 'No GitHub repository is configured yet: set your username and repository in package.json (see RELEASING.md).' }); return status; }
  send({ state: 'checking' });
  try {
    const r = await fetch(`https://api.github.com/repos/${pub.owner}/${pub.repo}/releases/latest`, { headers: { 'User-Agent': 'AG-Horizon', Accept: 'application/vnd.github+json' } });
    if (r.status === 404) { send({ state: 'error', message: 'No published release found. Draft releases are invisible: open the release on GitHub and press Publish.' }); return status; }
    if (!r.ok) throw new Error('GitHub answered ' + r.status);
    const j = await r.json();
    const tag = String(j.tag_name || '');
    send(newer(tag, app.getVersion()) ? { state: 'available', version: tag.replace(/^v/i, ''), manual: true } : { state: 'current', checkedAt: Date.now() });
  } catch (e) { send({ state: 'error', message: String((e && e.message) || e).slice(0, 200) }); }
  return status;
}

function init() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(), platform: process.platform, arch: process.arch,
    updater: !reason(), updaterReason: reason(), releasesUrl,
  }));
  ipcMain.handle('updater:status', () => status);
  ipcMain.handle('updater:open', () => { if (releasesUrl) shell.openExternal(releasesUrl); });

  if (reason()) {
    // No in-app installer here (started from source, or no repository configured): still tell the person whether a newer release exists.
    ipcMain.handle('updater:check', () => manualCheck());
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
  ipcMain.handle('updater:install', () => { setImmediate(() => autoUpdater.quitAndInstall(true, true)); return status; });
}

module.exports = { init };
