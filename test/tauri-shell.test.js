'use strict';
// public/js/tauri-shell.js: the Tauri build's window.tunerDesktop (MIGRATION_PLAN.md 3.2 / 3.7).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'tauri-shell.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');

function load({ tauri = true, existing = null, tv = false } = {}) {
  const calls = [];
  const listeners = {};
  const window = {};
  if (existing) window.tunerDesktop = existing;
  if (tv) window.AGHorizonTV = {};
  if (tauri) {
    window.__TAURI__ = {
      core: { invoke: async (cmd, a) => { calls.push({ cmd, ...a }); return cmd === 'sync' && a.op === 'folderList' ? [{ device: 'd', updated: 'u', blob: Buffer.from([0, 1, 254, 255]).toString('base64') }] : { cmd, ...a }; } },
      event: { listen: async (name, fn) => { listeners[name] = fn; } },
      app: { getVersion: async () => '9.9.9' },
      window: {
        getCurrentWindow: () => ({ show: async () => calls.push({ win: 'show' }), unminimize: async () => {}, setFocus: async () => {} }),
        availableMonitors: async () => [{ name: '\\\\.\\DISPLAY1', position: { x: 0, y: 0 }, size: { width: 3840, height: 2160 }, scaleFactor: 2 }, { name: '\\\\.\\DISPLAY2', position: { x: 1920, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }],
        primaryMonitor: async () => ({ name: '\\\\.\\DISPLAY1', position: { x: 0, y: 0 } }),
      },
    };
  }
  window.open = () => null;
  const document = {   // just enough for the adapter's Phase 4 set-up: no #topbar here, so no window buttons
    readyState: 'complete', visibilityState: 'visible', addEventListener() {}, getElementById: () => null,
    querySelectorAll: () => [], documentElement: { classList: { add() {} } },
  };
  const ctx = { window, document, setInterval: () => 0, clearInterval() {}, setTimeout: (f) => f, navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), atob: (s) => Buffer.from(s, 'base64').toString('binary'), Promise, Uint8Array, String, Math };
  vm.runInNewContext(SRC, ctx);
  return { td: window.tunerDesktop, calls, listeners };
}

// member names in electron/preload.js: "name:" or "name(" inside exposeInMainWorld('tunerDesktop', {...})
const plain = (x) => JSON.parse(JSON.stringify(x));   // values made in the vm's realm have its prototypes
const shape = (obj) => Object.keys(obj).sort().map((k) => (obj[k] && typeof obj[k] === 'object' ? `${k}{${shape(obj[k])}}` : k)).join(',');
function preloadShape() {
  const body = PRELOAD.slice(PRELOAD.indexOf("exposeInMainWorld('tunerDesktop'"));
  const out = {};
  let group = null;
  for (const line of body.split('\n')) {
    const g = /^\s{2}(\w+): \{/.exec(line);
    if (g) { group = out[g[1]] = {}; continue; }
    if (/^\s{2}\},?$/.test(line)) { group = null; continue; }
    const m = /^\s+(\w+)(?::|\()/.exec(line);
    if (m && !/^(const|return|if)$/.test(m[1])) (group || out)[m[1]] = 1;
  }
  return out;
}

test('the same members as electron/preload.js', () => {
  const { td } = load();
  assert.strictEqual(shape(td), shape(preloadShape()));
});

test('inert outside Tauri, in Electron (preload already there) and on Android TV', () => {
  assert.strictEqual(load({ tauri: false }).td, undefined);
  const existing = { mine: true };
  assert.strictEqual(load({ existing }).td, existing);
  assert.strictEqual(load({ tv: true }).td, undefined);
});

test('downloads and sync go to their commands with the right operation and arguments', async () => {
  const { td, calls, listeners } = load();
  await td.downloads.add([{ uid: 'x' }]);
  await td.downloads.remove('id1', 1);
  await td.downloads.chooseFolder();
  await td.sync.setCode(null);
  await td.sync.folderRemove('v', undefined);
  assert.deepStrictEqual(plain(calls.map(({ cmd, op, args }) => [cmd, op, args])), [
    ['downloads', 'add', [[{ uid: 'x' }]]],
    ['downloads', 'remove', ['id1', true]],
    ['downloads', 'chooseFolder', []],
    ['sync', 'setCode', ['']],
    ['sync', 'folderRemove', ['v', null]],
  ]);
  let got = null;
  td.downloads.onChange((s) => { got = s; });
  await new Promise((r) => setImmediate(r));
  listeners['downloads:changed']({ payload: { items: [1] } });
  assert.deepStrictEqual(plain(got), { items: [1] });
});

test('sync files travel as base64 and come back as the same bytes', async () => {
  const { td, calls } = load();
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
  await td.sync.folderPut('v', 'd', bytes);
  assert.strictEqual(calls[0].args[2], Buffer.from(bytes).toString('base64'));
  const [f] = await td.sync.folderList('v');
  assert.ok(f.blob instanceof Uint8Array || Object.prototype.toString.call(f.blob) === '[object Uint8Array]');
  assert.deepStrictEqual(Array.from(f.blob), [0, 1, 254, 255]);
});

test('displays: one per monitor, in logical pixels, with a stable key and the primary marked', async () => {
  const { td } = load();
  const d = await td.displays();
  assert.deepStrictEqual(plain(d), [
    { id: '\\\\.\\DISPLAY1@0,0', label: 'Display 1', primary: true, width: 1920, height: 1080 },
    { id: '\\\\.\\DISPLAY2@1920,0', label: 'Display 2', primary: false, width: 1920, height: 1080 },
  ]);
});
