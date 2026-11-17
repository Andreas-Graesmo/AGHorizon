// The import of migration.json into the new app's page (MIGRATION_PLAN.md 6.2): one function expression, so that
// electron/migration.js (IMPORT_SCRIPT, tested in spike/migration/check-roundtrip.js) and the Tauri app
// (src-tauri/src/main.rs, an initialization script that runs before the page's own scripts) use the very same code.
// localStorage is written before the first `await`, so it is in place before core.js reads it; IndexedDB follows,
// and core.js's idb waits for window.__aghMigrating. Keys and records the new app already has are left alone.
// Returns what it did.
(async (data) => {
  let ls = 0, skipped = 0, files = 0;
  for (const [k, v] of Object.entries(data.localStorage || {})) {
    if (localStorage.getItem(k) != null) { skipped++; continue; }
    localStorage.setItem(k, v); ls++;
  }
  const records = ((data.indexedDB || {}).tuner || {}).files || [];
  if (records.length) {
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('tuner', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('files');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('files', 'readwrite');
        const store = tx.objectStore('files');
        for (const r of records) {
          const get = store.getKey(r.key);
          get.onsuccess = () => { if (get.result === undefined) { store.put(r.value, r.key); files++; } };
        }
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  return { localStorage: ls, skipped, files };
})
