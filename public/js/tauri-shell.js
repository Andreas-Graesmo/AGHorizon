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
})();
