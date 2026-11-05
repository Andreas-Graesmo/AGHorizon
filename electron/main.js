'use strict';
/**
 * AG Horizon – desktop shell.
 * Starts the bundled local server (../server.js) and shows the UI in a normal app window.
 */
const { app, BrowserWindow, dialog, shell, session, screen, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { start, server, setLocalFiles } = require('../server');
const updater = require('./updater');
const downloads = require('./downloads');

// The UI stores playlists in localStorage, which is tied to the page's origin (including the port).
// So the port must be the same on every launch, otherwise your playlists would "disappear".
const APP_PORT = Number(process.env.TUNER_PORT) || 47831;

// The app used to be called "Tuner IPTV". Keep using that data folder so saved playlists, favorites and history survive the rename.
app.setName('AG Horizon');
app.setPath('userData', path.join(app.getPath('appData'), 'Tuner IPTV'));

// Best effort: let Chromium use the OS decoder for HEVC where the machine supports it.
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

if (!app.requestSingleInstanceLock()) {
  app.quit(); // a second copy would fight over the port
  process.exit(0);
}

let win = null;
let origin = '';
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* not critical */ }
}

function createWindow() {
  const s = loadWindowState();
  win = new BrowserWindow({
    width: s.width || 1280,
    height: s.height || 800,
    x: s.x,
    y: s.y,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0c0e12',
    title: 'AG Horizon',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', // lets "next episode" start by itself
    },
  });
  if (s.maximized) win.maximize();

  win.loadURL(origin + '/');

  // Keep the window on our own page; send real links to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The second-screen window is the one pop-up we allow (it needs a link back to this window to receive the video).
    if (url.startsWith(origin + '/mirror.html')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'AG Horizon – second screen',
          backgroundColor: '#000000',
          autoHideMenuBar: true,
          frame: false,
          show: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Put the second-screen window full screen on the monitor that was picked (?d=<display id>).
  win.webContents.on('did-create-window', (child, details) => {
    let id = null;
    try { id = new URL(details.url).searchParams.get('d'); } catch { /* no display chosen */ }
    const target = screen.getAllDisplays().find((d) => String(d.id) === id);
    if (!target) return;
    child.setBounds(target.bounds);
    if (process.platform === 'darwin') child.setSimpleFullScreen(true); else child.setFullScreen(true);
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin + '/')) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });

  win.on('close', saveWindowState);
  win.on('closed', () => {
    win = null;
    for (const w of BrowserWindow.getAllWindows()) w.close(); // takes the second-screen window with it
  });
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

updater.init();
setLocalFiles(downloads.localFile);

ipcMain.handle('tuner:displays', () => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || (d.id === primary ? 'Main display' : `Display ${i + 1}`),
    primary: d.id === primary,
    width: d.bounds.width,
    height: d.bounds.height,
  }));
});

app.whenReady().then(async () => {
  // Only the permissions a video player needs.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(['fullscreen', 'clipboard-sanitized-write'].includes(permission)));

  let port;
  try {
    port = await start(APP_PORT);
  } catch (e) {
    dialog.showErrorBox(
      'AG Horizon could not start',
      e.code === 'EADDRINUSE'
        ? `Port ${APP_PORT} is used by another program. Close it, or start AG Horizon with the environment variable TUNER_PORT set to a free port number (your saved playlists are tied to the port, so keep using the same one).`
        : String(e.message || e)
    );
    app.quit();
    return;
  }
  origin = `http://127.0.0.1:${port}`;
  downloads.init();
  createWindow();

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { server.close(); } catch { /* already closed */ } });
