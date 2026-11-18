'use strict';
/**
 * In-app updates via electron-updater + GitHub Releases.
 * Only active in the installed app (not when started with `npm start`).
 * The page talks to this through the small bridge in preload.js.
 */
const { app, ipcMain, BrowserWindow, shell } = require('electron');
const pkg = require('../package.json');
const fs = require('fs');
const path = require('path');
const versions = require('./versions');
const handover = require('./handover');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* dependency missing: updates are simply unavailable */ }

// From "repository": electron-builder strips "build" (and its publish settings) from the installed app's package.json.
const repo = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i.exec(String((pkg.repository && pkg.repository.url) || pkg.repository || '').trim());
const pub = repo ? { owner: repo[1], repo: repo[2] } : {};
const releasesUrl = pub.owner && pub.repo ? `https://github.com/${pub.owner}/${pub.repo}/releases/latest` : '';
const api = (p) => fetch(`https://api.github.com/repos/${pub.owner}/${pub.repo}${p}`, { headers: { 'User-Agent': 'AG-Horizon', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });

// Update channel, chosen in Settings: 'stable' gets published releases only; 'test' also gets pre-releases
// (versions like 2.5.0-beta.1, see RELEASING.md). A test version installed by hand starts out on 'test'.
let channel = versions.isTest(app.getVersion()) ? 'test' : 'stable';
function applyChannel() {
  if (!autoUpdater) return;
  // electron-updater: with channel "beta" it reads the GitHub releases feed and takes the newest beta or release;
  // with "latest" and allowPrerelease off it takes GitHub's "latest release", which is never a pre-release
  autoUpdater.channel = channel === 'test' ? 'beta' : 'latest';
  autoUpdater.allowPrerelease = channel === 'test';
  autoUpdater.allowDowngrade = false;   // setting the channel turns this on: never offer an older version
}

let status = { state: 'idle' };

/* Hand-over to the Tauri build (handover.js, MIGRATION_PLAN.md 1.3, 9.10): when the newest release on the channel is
 * a Tauri build for this system, it is offered through the same states as an ordinary update. On Windows always; on
 * Linux for the AppImage, on macOS for an app that can be replaced where it is (handover.target()), and on a Mac also
 * though the app has no updater of its own. Off until the Tauri updater's public key is in
 * electron/tauri-updater.key.pub. */
let handoverDeps = { exportForHandover: null };
let pending = null;   // { rel, inst, file, target }
const handoverOn = () => app.isPackaged && !!handover.publicKey() && !!pub.owner && (process.platform === 'win32' || !!handover.target());

async function checkHandover() {
  const rel = await handover.findRelease({ channel, current: app.getVersion(), api });
  if (!rel) return false;
  const r = await fetch(rel.latestJsonUrl, { headers: { 'User-Agent': 'AG-Horizon' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('latest.json: GitHub answered ' + r.status);
  const inst = handover.updateFor(await r.json(), pub);
  if (!inst) return false;
  pending = { rel, inst, target: process.platform === 'win32' ? null : handover.target() };
  send({ state: 'available', version: rel.version, notes: rel.notes });
  return true;
}

async function downloadHandover() {
  const { rel, inst, target } = pending;
  // Windows: the installer, to the temp folder; macOS and Linux: next to the app it replaces
  const dest = target ? handover.stagingFile(target, rel.version) : path.join(app.getPath('temp'), `AG-Horizon-Setup-${rel.version}.exe`);
  send({ state: 'downloading', version: rel.version, percent: 0 });
  try {
    const got = await handover.download(inst.url, dest, (percent) => send({ state: 'downloading', version: rel.version, percent }));
    const ok = handover.verify(null, inst.signature, handover.publicKey(), got.blake2b512);
    if (!ok.ok) {
      fs.rmSync(dest, { force: true });
      send({ state: 'error', version: rel.version, message: `The new version's installer failed its signature check (${ok.reason}), so it was not installed.` });
      return status;
    }
    pending.file = got.file;
    send({ state: 'ready', version: rel.version });
  } catch (e) {
    fs.rmSync(dest, { force: true });
    send({ state: 'error', version: rel.version, message: String((e && e.message) || e).slice(0, 200) });
  }
  return status;
}

async function installHandover() {
  // the person's data first: if it can't be saved, nothing is installed
  try {
    if (!handoverDeps.exportForHandover) throw new Error('not ready');
    await handoverDeps.exportForHandover();
  } catch (e) {
    send({ state: 'error', version: pending.rel.version, message: `Couldn't save your playlists and settings for the new version (${String((e && e.message) || e).slice(0, 120)}). Nothing was installed.` });
    return status;
  }
  if (pending.target) {
    try {
      handover.install(pending.file, pending.target);
    } catch (e) {
      send({ state: 'error', version: pending.rel.version, message: `The new version couldn't be put in place (${String((e && e.message) || e).slice(0, 120)}). This version is unchanged.` });
      return status;
    }
  } else {
    handover.runInstaller(pending.file);
  }
  setImmediate(() => app.quit());
  return status;
}
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

async function manualCheck() {
  if (!releasesUrl) { send({ state: 'error', message: 'No GitHub repository is configured yet: set your username and repository in package.json (see RELEASING.md).' }); return status; }
  send({ state: 'checking' });
  try {
    let tag = '';
    if (channel === 'test') {
      // the newest published release or pre-release (drafts aren't listed for people who aren't logged in)
      const r = await api('/releases?per_page=30');
      if (!r.ok) throw new Error('GitHub answered ' + r.status);
      for (const rel of await r.json()) {
        const t = String(rel.tag_name || '');
        if (!rel.draft && versions.parse(t) && (!tag || versions.compare(t, tag) > 0)) tag = t;
      }
    } else {
      const r = await api('/releases/latest');
      if (r.status !== 404) {
        if (!r.ok) throw new Error('GitHub answered ' + r.status);
        tag = String((await r.json()).tag_name || '');
      }
    }
    if (!tag) { send({ state: 'error', message: 'No published release found. Draft releases are invisible: open the release on GitHub and press Publish.' }); return status; }
    send(versions.compare(tag, app.getVersion()) > 0 ? { state: 'available', version: tag.replace(/^v/i, ''), manual: true } : { state: 'current', checkedAt: Date.now() });
  } catch (e) { send({ state: 'error', message: String((e && e.message) || e).slice(0, 200) }); }
  return status;
}

function init(deps = {}) {
  handoverDeps = { ...handoverDeps, ...deps };
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(), platform: process.platform, arch: process.arch,
    updater: !reason(), updaterReason: reason(), releasesUrl, channel,
  }));
  ipcMain.handle('updater:channel', (_e, next) => {
    if (next !== 'stable' && next !== 'test') return channel;
    if (next !== channel) { channel = next; applyChannel(); if (status.state !== 'downloading' && status.state !== 'ready') { pending = null; send({ state: 'idle' }); } }
    return channel;
  });
  ipcMain.handle('updater:status', () => status);
  // the release on offer, else the newest release (or, on the test channel, the list with the pre-releases)
  ipcMain.handle('updater:open', () => {
    if (!releasesUrl) return;
    const v = ['available', 'downloading', 'ready', 'error'].includes(status.state) && status.version;
    shell.openExternal(v ? releasesUrl.replace(/latest$/, 'tag/v' + v) : channel === 'test' ? releasesUrl.replace(/\/latest$/, '') : releasesUrl);
  });
  // "What's new?": the notes of one version, as the Markdown written on its GitHub release.
  ipcMain.handle('updater:notes', async (_e, version) => {
    const none = { error: 'No release notes were found for this version.' };
    if (!releasesUrl || !versions.parse(version)) return none;
    try {
      const r = await api(`/releases/tags/v${String(version).replace(/^v/i, '')}`);
      if (r.status === 404) return none;   // not published (a draft), or started from source with a version that was never released
      if (!r.ok) throw new Error('GitHub answered ' + r.status);
      return { body: String((await r.json()).body || '') };
    } catch (e) { return { error: 'Couldn’t fetch the release notes: ' + String((e && e.message) || e).slice(0, 120) }; }
  });

  if (reason()) {
    // No in-app installer here (a Mac, started from source, or no repository configured): still tell the person
    // whether a newer release exists; on a Mac, the hand-over to the Tauri build can still install itself
    ipcMain.handle('updater:check', async () => {
      if (pending && (status.state === 'downloading' || status.state === 'ready')) return status;
      pending = null;
      if (handoverOn()) {
        send({ state: 'checking' });
        try { if (await checkHandover()) return status; } catch (e) { console.warn('hand-over check failed:', e && e.message); }
      }
      return manualCheck();
    });
    ipcMain.handle('updater:download', () => (pending ? downloadHandover() : status));
    ipcMain.handle('updater:install', () => (pending && pending.file ? installHandover() : status));
    return;
  }

  applyChannel();
  autoUpdater.autoDownload = false;          // the person decides
  autoUpdater.autoInstallOnAppQuit = true;   // a downloaded update installs when the app is closed
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => send({ state: 'available', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : '' }));
  autoUpdater.on('update-not-available', (i) => send({ state: 'current', version: i && i.version, checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', version: status.version, percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => send({ state: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => send({ state: 'error', version: status.version, message: String((e && e.message) || e).split('\n')[0].slice(0, 200) }));

  ipcMain.handle('updater:check', async () => {
    if (pending && (status.state === 'downloading' || status.state === 'ready')) return status;
    pending = null;
    if (handoverOn()) {
      send({ state: 'checking' });
      try { if (await checkHandover()) return status; } catch (e) { console.warn('hand-over check failed:', e && e.message); }   // then the ordinary check
    }
    try { await autoUpdater.checkForUpdates(); } catch (e) { send({ state: 'error', message: String(e.message || e).split('\n')[0] }); }
    return status;
  });
  ipcMain.handle('updater:download', async () => {
    if (pending) return downloadHandover();
    try { await autoUpdater.downloadUpdate(); } catch (e) { send({ state: 'error', version: status.version, message: String(e.message || e).split('\n')[0] }); }
    return status;
  });
  ipcMain.handle('updater:install', () => {
    if (pending && pending.file) return installHandover();
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return status;
  });
}

module.exports = { init };
