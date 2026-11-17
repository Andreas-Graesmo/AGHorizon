'use strict';
/**
 * Moving to the Tauri build (MIGRATION_PLAN.md Phase 1): the page's own storage — playlists, favourites, history,
 * settings in localStorage, and playlists from files in IndexedDB — lives in Chromium's profile, which the new app's
 * webview can't read. So this Electron version writes it to <userData>/migration.json, which the new app imports.
 *
 * EXPORT_SCRIPT runs in the page (webContents.executeJavaScript) and returns plain JSON. IMPORT_SCRIPT is its
 * counterpart for the new app (Phase 6); it lives here so the two are written, tested and changed together.
 */
const fs = require('fs');
const path = require('path');

const FORMAT = 1;
const FILE = 'migration.json';

// In the page: every localStorage key, and every record of IndexedDB "tuner" / "files" (values are strings and
// small objects: playlist file text, the downloads' info map). Opening "tuner" creates it when missing, as core.js does.
const EXPORT_SCRIPT = `(async () => {
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
  const files = await new Promise((resolve, reject) => {
    const open = indexedDB.open('tuner', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const out = [];
      const tx = db.transaction('files', 'readonly');
      const cur = tx.objectStore('files').openCursor();
      cur.onsuccess = () => { const c = cur.result; if (c) { out.push({ key: c.key, value: c.value }); c.continue(); } };
      tx.oncomplete = () => { db.close(); resolve(out); };
      tx.onerror = () => reject(tx.error);
    };
  });
  return { origin: location.origin, localStorage: ls, indexedDB: { tuner: { files } } };
})()`;

// In the new app's page, before core.js reads storage (Phase 6.2): desktop/migration-import.js, shared with the
// Tauri app, which runs it as an initialization script.
const IMPORT_FN = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'migration-import.js'), 'utf8').replace(/^\/\/.*\n/gm, '').trim();
const IMPORT_SCRIPT = (data) => `${IMPORT_FN}(${JSON.stringify(data)})`;

// Writes migration.json next to the app's other files, atomically. extra: fields such as the sync code, which is only
// added right before handing over to the new app (handover.js), never on an ordinary start.
async function exportNow(webContents, userData, { appVersion, extra = {}, timeoutMs = 10000 } = {}) {
  if (!webContents || webContents.isDestroyed()) throw new Error('no page to export from');
  const page = await Promise.race([
    webContents.executeJavaScript(EXPORT_SCRIPT, true),
    new Promise((_, reject) => setTimeout(() => reject(new Error('the page did not answer')), timeoutMs)),
  ]);
  const payload = { format: FORMAT, app: 'AG Horizon', appVersion, exportedAt: new Date().toISOString(), ...page, ...extra };
  const file = path.join(userData, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
  await fs.promises.rename(tmp, file);
  return { file, keys: Object.keys(page.localStorage).length, files: page.indexedDB.tuner.files.length };
}

module.exports = { FORMAT, FILE, EXPORT_SCRIPT, IMPORT_SCRIPT, exportNow };
