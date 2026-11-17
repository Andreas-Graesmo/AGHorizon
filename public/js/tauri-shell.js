'use strict';
/*
 * The desktop bridge (window.tunerDesktop, the shape of electron/preload.js) for the Tauri build.
 * MIGRATION_PLAN.md 3.2. Does nothing in Electron (its preload set tunerDesktop already), on Android TV (tv.js) and
 * in a plain browser (no window.__TAURI__). Defined synchronously: downloads.js reads it as soon as it loads.
 * Phase 2: just enough for the page to run. The window works; updates, downloads and folder sync answer
 * "not available yet" until their Rust commands come in Phase 3.
 */
(() => {
  if (window.tunerDesktop || window.AGHorizonTV || !window.__TAURI__) return;
  const T = window.__TAURI__;
  const win = () => T.window.getCurrentWindow();
  const ok = (v) => () => Promise.resolve(v);
  const LATER = 'This comes in a later step of the move to the new app.';
  const platform = /Windows/.test(navigator.userAgent) ? 'win32' : /Mac/.test(navigator.userAgent) ? 'darwin' : 'linux';

  window.tunerDesktop = {
    displays: ok([]),
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
      list: ok({ items: [], folder: '', pauseWhileWatching: false, held: false, free: 0 }),
      add: () => Promise.reject(new Error(LATER)), pause: ok(), resume: ok(), reorder: ok(), remove: ok(), reveal: ok(),
      openFolder: ok(LATER), chooseFolder: ok(null), setOption: ok(), setWatching: ok(), orphans: ok([]), adopt: ok(0), onChange() {},
    },
    // no `sync` yet: public/js/sync.js then keeps the code in localStorage and hides folder sync (MIGRATION_PLAN.md 3.4)
  };
})();
