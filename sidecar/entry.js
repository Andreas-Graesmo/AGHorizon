'use strict';
/*
 * AG Horizon server as a separate program (MIGRATION_PLAN.md 0.3 / 2.4): the Tauri app starts it as a sidecar.
 *   aghorizon-server [port]        port 0 = any free port
 * Env: PUBLIC_DIR (the app's public/ folder), FFMPEG_PATH, TMPDIR, TMDB_API_KEY, OPENSUBTITLES_API_KEY.
 * Prints one line the app waits for: "READY <port>" or "ERROR <code> <message>" (then exits with 1).
 * Exits when its stdin closes, so it cannot outlive the app that started it (even if the app is killed).
 *
 * With AGH_DATA_DIR (and AGH_DOCUMENTS_DIR) it also runs the downloads engine and the folder sync
 * (desktop/, MIGRATION_PLAN.md 3.4 / 3.5), and talks to the app over stdin/stdout, one JSON object per line:
 *   in:  {"id": 1, "cmd": "downloads.list", "args": []}
 *   out: RPC {"id": 1, "ok": true, "result": …}   or   RPC {"id": 1, "ok": false, "error": "…"}
 *   out: EVENT {"name": "downloads:changed", "payload": …}
 * Only the commands in OPS below exist; the app's Rust side decides which the page may use.
 */
const readline = require('readline');

const port = process.argv[2] != null ? Number(process.argv[2]) : 47831;

process.on('uncaughtException', (e) => console.error('uncaught:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('unhandled:', (e && e.stack) || e));

const { start, setLocalFiles } = require('../server');

const line = (prefix, obj) => process.stdout.write(`${prefix} ${JSON.stringify(obj)}\n`);
let OPS = null;
let downloads = null;

if (process.env.AGH_DATA_DIR) {
  downloads = require('../desktop/downloads-core');
  const folderSync = require('../desktop/sync-folder');
  downloads.configure({
    dataDir: process.env.AGH_DATA_DIR,
    documentsDir: process.env.AGH_DOCUMENTS_DIR || process.env.AGH_DATA_DIR,
    broadcast: (snapshot) => line('EVENT', { name: 'downloads:changed', payload: snapshot }),
  });
  folderSync.configure({ dataDir: process.env.AGH_DATA_DIR });
  setLocalFiles(downloads.localFile);   // /api/local/<id> plays finished downloads, as in the Electron app
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  OPS = {
    'downloads.list': () => downloads.list(),
    'downloads.orphans': () => downloads.orphans(),
    'downloads.adopt': (list) => downloads.adopt(list),
    'downloads.add': (list) => downloads.add(list),
    'downloads.pause': (id) => downloads.pause(id),
    'downloads.resume': (id) => downloads.resume(id),
    'downloads.reorder': (ids) => downloads.reorder(ids),
    'downloads.remove': (id, deleteFile) => downloads.remove(id, !!deleteFile),
    'downloads.setOption': (key, value) => downloads.setOption(key, value),
    'downloads.setWatching': (on) => downloads.setWatching(!!on),
    'downloads.currentFolder': () => downloads.currentFolder(),
    'downloads.setFolder': (folder) => downloads.setFolder(folder),
    'downloads.revealTarget': (id) => downloads.revealTarget(id),
    'downloads.ensureFolder': () => downloads.ensureFolder(),
    'sync.info': () => ({ host: folderSync.host(), folder: folderSync.folder() }),
    'sync.setFolder': (folder) => folderSync.setFolder(folder),
    // the encrypted files travel as base64 (JSON can't carry bytes)
    'sync.folderList': async (vault) => (await folderSync.list(vault)).map((f) => ({ ...f, blob: b64(f.blob) })),
    'sync.folderPut': (vault, device, blob64) => folderSync.put(vault, device, Buffer.from(String(blob64 || ''), 'base64')),
    'sync.folderRemove': (vault, device) => folderSync.remove(vault, device || null),
    // the app is closing: what was downloading carries on next time, then exit
    quit: () => { downloads.quitting(); setImmediate(() => process.exit(0)); return true; },
  };
}

start(port).then(
  (p) => {
    console.log(`READY ${p}`);
    if (downloads) downloads.start();
  },
  (e) => { console.log(`ERROR ${(e && e.code) || 'START'} ${(e && e.message) || e}`); process.exit(1); },
);

if (!process.env.AGH_NO_STDIN_WATCH) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (text) => {
    if (!OPS || !text.trim()) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const op = Object.prototype.hasOwnProperty.call(OPS, msg.cmd) ? OPS[msg.cmd] : null;
    try {
      if (!op) throw new Error(`unknown command ${msg.cmd}`);
      const result = await op(...(Array.isArray(msg.args) ? msg.args : []));
      line('RPC', { id: msg.id, ok: true, result: result === undefined ? null : result });
    } catch (e) { line('RPC', { id: msg.id, ok: false, error: String((e && e.message) || e) }); }
  });
  rl.on('close', () => { if (downloads) downloads.quitting(); process.exit(0); });   // the app went away
  process.stdin.on('error', () => process.exit(0));
}
