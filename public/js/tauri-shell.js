'use strict';
/*
 * The desktop bridge (window.tunerDesktop, the shape of electron/preload.js) for the Tauri build.
 * MIGRATION_PLAN.md Phase 3. Does nothing in Electron (its preload set tunerDesktop already), on Android TV (tv.js)
 * and in a plain browser (no window.__TAURI__). Defined synchronously: downloads.js reads it as soon as it loads.
 *   downloads.* and sync.*  → the app's `downloads` / `sync` commands (src-tauri/src/main.rs); their engines run in
 *                             the server sidecar (desktop/), the folder dialogs, Explorer and the keychain in Rust
 *   window, displays        → Tauri's window API
 *   updater.*               → not yet: MIGRATION_PLAN.md Phase 5
 */
(() => {
  if (window.tunerDesktop || window.AGHorizonTV || !window.__TAURI__) return;
  const T = window.__TAURI__;
  const invoke = T.core.invoke;
  const win = () => T.window.getCurrentWindow();
  const ok = (v) => () => Promise.resolve(v);
  const LATER = 'This comes in a later step of the move to the new app.';
  const platform = /Windows/.test(navigator.userAgent) ? 'win32' : /Mac/.test(navigator.userAgent) ? 'darwin' : 'linux';
  const dl = (op) => (...args) => invoke('downloads', { op, args });
  const sy = (op) => (...args) => invoke('sync', { op, args });

  // The sync files are bytes; the commands carry JSON, so base64 on the way (a Uint8Array would become {"0": …}).
  const toB64 = (u8) => { let s = ''; const b = new Uint8Array(u8); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b64) => { const s = atob(b64 || ''); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };

  // Monitors: Tauri has no numeric display id like Electron's, so "name@x,y" stands in (MIGRATION_PLAN.md 3.3).
  async function displays() {
    const [all, primary] = await Promise.all([T.window.availableMonitors(), T.window.primaryMonitor()]);
    const key = (m) => `${m.name}@${m.position.x},${m.position.y}`;
    return all.map((m, i) => ({
      id: key(m),
      label: ((n) => (n ? `Display ${n[1]}` : m.name))(/DISPLAY(\d+)$/i.exec(m.name || '')) || `Display ${i + 1}`,
      primary: !!primary && key(primary) === key(m),
      width: Math.round(m.size.width / (m.scaleFactor || 1)),
      height: Math.round(m.size.height / (m.scaleFactor || 1)),
    }));
  }

  window.tunerDesktop = {
    displays,
    async focusWindow() { const w = win(); await w.unminimize(); await w.show(); await w.setFocus(); },
    async appInfo() {
      return {
        version: await T.app.getVersion(), platform, arch: 'x64', updater: false, updaterReason: LATER,
        releasesUrl: 'https://github.com/Andreas-Graesmo/AGHorizon/releases/latest', channel: 'stable',
      };
    },
    ready() { win().show().catch(() => {}); },   // the window starts hidden, so start-up shows no empty frame
    titleBar() {},                               // HTML caption buttons come in MIGRATION_PLAN.md 4.2
    updater: {
      status: ok({ state: 'idle' }), check: ok({ state: 'idle' }), download: ok({ state: 'idle' }), install: ok({ state: 'idle' }),
      openReleases: ok(), notes: ok({ error: LATER }), setChannel: (c) => Promise.resolve(c), onStatus() {},
    },
    downloads: {
      list: dl('list'), add: dl('add'), pause: dl('pause'), resume: dl('resume'), reorder: dl('reorder'),
      remove: (id, deleteFile) => invoke('downloads', { op: 'remove', args: [id, !!deleteFile] }),
      reveal: dl('reveal'), openFolder: dl('openFolder'), chooseFolder: dl('chooseFolder'),
      setOption: dl('setOption'), setWatching: dl('setWatching'), orphans: dl('orphans'), adopt: dl('adopt'),
      onChange(cb) { T.event.listen('downloads:changed', (e) => cb(e.payload)); },
    },
    sync: {
      info: sy('info'), getCode: sy('getCode'), setCode: (code) => invoke('sync', { op: 'setCode', args: [String(code || '')] }),
      chooseFolder: sy('chooseFolder'),
      async folderList(vault) { return (await invoke('sync', { op: 'folderList', args: [vault] })).map((f) => ({ ...f, blob: fromB64(f.blob) })); },
      folderPut: (vault, device, blob) => invoke('sync', { op: 'folderPut', args: [vault, device, toB64(blob)] }),
      folderRemove: (vault, device) => invoke('sync', { op: 'folderRemove', args: [vault, device || null] }),
    },
  };

  /* ───────────── Windows integration (MIGRATION_PLAN.md Phase 4) ───────────── */
  const cmd = (op, label) => invoke('popups', { op, label }).catch(() => {});

  // 4.2 the title bar: the top bar drags the window (double-click maximises), except its buttons and the search box;
  // the window's own buttons at its right end
  function titleBar() {
    const bar = document.getElementById('topbar');
    if (!bar || bar.querySelector('.win-ctl')) return;
    document.documentElement.classList.add('tauri-shell');
    bar.setAttribute('data-tauri-drag-region', 'deep');
    const search = document.getElementById('topSearch');
    if (search) search.setAttribute('data-tauri-drag-region', 'false');
    const ICON = {
      min: '<svg viewBox="0 0 10 10"><path d="M0 5.5h10"/></svg>',
      max: '<svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg>',
      restore: '<svg viewBox="0 0 10 10"><rect x=".5" y="2.5" width="7" height="7"/><path d="M2.5 2.5v-2h7v7h-2"/></svg>',
      close: '<svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10"/></svg>',
    };
    const box = document.createElement('div');
    box.className = 'win-ctl';
    box.innerHTML = `<button type="button" class="min" aria-label="Minimise" title="Minimise">${ICON.min}</button>`
      + `<button type="button" class="max" aria-label="Maximise" title="Maximise">${ICON.max}</button>`
      + `<button type="button" class="close" aria-label="Close" title="Close">${ICON.close}</button>`;
    bar.appendChild(box);
    const max = box.querySelector('.max');
    box.querySelector('.min').addEventListener('click', () => win().minimize());
    max.addEventListener('click', () => win().toggleMaximize());
    box.querySelector('.close').addEventListener('click', () => win().close());
    const sync = async () => {
      const on = await win().isMaximized().catch(() => false);
      max.innerHTML = on ? ICON.restore : ICON.max;
      max.setAttribute('aria-label', on ? 'Restore' : 'Maximise');
      max.title = on ? 'Restore' : 'Maximise';
    };
    win().onResized(sync);
    sync();
  }

  // 4.3 / 4.4 picture-in-picture and the mirror window are Tauri windows handed over on window.open (Rust). Two
  // things the page can't do itself there: a window it closes stays on screen (spike 0.2), so remove it once closed;
  // and frameless windows are dragged by asking the app (PiP by its top bar, the mirror anywhere but its controls).
  const popupsOpen = {};
  const nativeOpen = window.open.bind(window);
  window.open = function (url, name, features) {
    const w = nativeOpen(url, name, features);
    const label = name === 'ag-horizon-pip' ? 'pip' : name === 'tuner-mirror' ? 'mirror' : null;
    if (w && label) watchPopup(w, label);
    return w;
  };
  function watchPopup(w, label) {
    popupsOpen[label] = w;
    const drag = (e) => {
      if (e.button !== 0 || e.target.closest('button, input, select, a, .m-volpop, [role="slider"]')) return;
      if (label === 'pip' && !e.target.closest('.p-top')) return;
      cmd('drag', label);
    };
    let doc = null;
    const iv = setInterval(() => {
      if (w.closed) { clearInterval(iv); delete popupsOpen[label]; setTimeout(() => cmd('destroy', label), 150); return; }
      try { if (w.document !== doc && w.document.body) { doc = w.document; doc.addEventListener('mousedown', drag, true); } } catch { /* navigating */ }
    }, 250);
  }

  // 4.5 element fullscreen (player, Multiview tiles) fills only the webview in WebView2: make the window fullscreen too
  document.addEventListener('fullscreenchange', () => { win().setFullscreen(!!document.fullscreenElement).catch(() => {}); });
  // Escape leaves fullscreen, as in Electron's Chromium (WebView2 in Tauri doesn't do it by itself: found by e2e)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }, true);

  // 4.6 the screen stays on while a video plays (Electron did this by itself; WebView2 grants the Wake Lock API)
  let wake = null;
  const videos = () => [...document.querySelectorAll('video'), ...Object.values(popupsOpen).flatMap((w) => { try { return [...w.document.querySelectorAll('video')]; } catch { return []; } })];
  async function syncWake() {
    const want = document.visibilityState === 'visible' && videos().some((v) => !v.paused && !v.ended && v.readyState > 2);
    if (want && !wake && navigator.wakeLock) {
      try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } catch { /* not now */ }
    } else if (!want && wake) { const l = wake; wake = null; l.release().catch(() => {}); }
  }
  for (const t of ['playing', 'pause', 'ended', 'emptied']) document.addEventListener(t, syncWake, true);
  document.addEventListener('visibilitychange', syncWake);
  setInterval(syncWake, 10000);

  // for e2e/tauri-windows.js
  window.__aghShell = { wakeLockHeld: () => !!wake };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', titleBar); else titleBar();
})();
