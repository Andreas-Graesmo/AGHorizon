'use strict';
/* AG Horizon – sync between computers: Settings › Sync, and keeping Recently viewed, where you stopped and favorites
   the same on all of them. The code, the encryption and the merging are in sync-core.js; the desktop side (the code
   in the keychain, the folder) in electron/sync.js; the server side in supabase/sync.sql.

   Each computer stores one encrypted blob – everything it knows – in the vault its sync code points to, and reads
   the others'. So two computers never write the same thing, and one that's off for a month just catches up. */

const SYNC_CFG = 'tuner.sync';     // { on, mode, device, known, since, fullAt, devices, last, pushed, pushedAt }
const SYNC_DB = 'tuner.syncdb';    // { recs, cleared }: all synced records, also those for playlists that aren't here
const syncApi = window.tunerDesktop && window.tunerDesktop.sync;
const sy = { keys: null, code: '', busy: false, again: false, timer: 0, due: 0, lastRun: 0, applying: false, info: {}, mode: '', joining: false, showCode: false, msg: '', working: false };

const syncCfg = () => LS.get(SYNC_CFG, {});
const saveSyncCfg = (c) => LS.set(SYNC_CFG, c);
const loadSyncDb = () => { const d = LS.get(SYNC_DB, null); return d && d.recs ? d : { recs: {}, cleared: 0 }; };
const saveSyncDb = (d) => LS.set(SYNC_DB, d);
const syncCloud = () => LS.get('tuner.syncCloud', null) || SYNC_CLOUD;   // the setting is for testing / running your own
const cloudReady = () => !!(syncCloud().url && syncCloud().key);
const syncName = () => sy.info.host || 'Computer';
const newDeviceId = () => toHex(crypto.getRandomValues(new Uint8Array(8)));
const MODE_LABEL = { cloud: 'AG Horizon cloud', folder: 'A synced folder' };

// the code lives in the system keychain (desktop); a plain copy in the page only when there is no desktop shell
const codeStore = {
  get: () => (syncApi ? syncApi.getCode() : Promise.resolve(LS.get('tuner.syncCode', ''))),
  set: (c) => (syncApi ? syncApi.setCode(c) : Promise.resolve(LS.set('tuner.syncCode', c))),
};

/* ───────────────────────────── playlist keys ───────────────────────────── */
// The same Xtream account or playlist link gives the same key on every computer (a hash: the login stays here).
const plKeyCache = {};
async function playlistKeys() {
  const pkOf = {}, pidOf = {};
  for (const p of state.playlists) {
    const ident = p.type === 'xtream' ? `x|${normServer(p.server).toLowerCase()}|${p.username}`
      : p.type === 'file' ? `f|${p.fileName || p.name}` : `u|${p.url}`;
    const k = plKeyCache[ident] || (plKeyCache[ident] = toHex(await crypto.subtle.digest('SHA-256', syncTe.encode(ident))).slice(0, 20));
    pkOf[p.id] = k;
    if (!pidOf[k]) pidOf[k] = p.id;
  }
  return { pkOf, pidOf, pks: new Set(Object.values(pkOf)) };
}

/* ───────────────────────────── where it's stored ───────────────────────────── */
function syncTransport(mode, keys) {
  if (mode === 'folder') {
    return {
      list: () => syncApi.folderList(keys.vaultId),
      put: (dev, blob) => syncApi.folderPut(keys.vaultId, dev, blob),
      remove: (dev) => syncApi.folderRemove(keys.vaultId, dev || null),
    };
  }
  const rpc = async (fn, args) => {
    const { url, key } = syncCloud();
    const headers = { 'Content-Type': 'application/json', apikey: key };
    if (/^eyJ/.test(key)) headers.Authorization = `Bearer ${key}`;   // the older (JWT) project keys go here too
    let r;
    try {
      r = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers, body: JSON.stringify({ p_vault: keys.vaultId, p_token: keys.token, ...args }), signal: AbortSignal.timeout(20000),
      });
    } catch { throw new Error('Can’t reach the sync service. Are you online?'); }
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const m = (j && j.message) || '';
      const e = new Error({ denied: 'Nothing has been synced with this code yet.', 'too many devices': 'This sync code is already used on 10 computers. Remove one in Settings › Sync on another computer.', 'too large': 'There is too much to sync.', busy: 'The sync service is busy. Try again in an hour.', 'too many new codes': 'Too many new sync codes from this network today. Try again tomorrow.' }[m] || `The sync service answered: ${m || 'HTTP ' + r.status}`);
      e.denied = m === 'denied';
      throw e;
    }
    return j;
  };
  return {
    list: async (since) => (await rpc('sync_get', since ? { p_since: since } : {}) || []).map((x) => ({ device: x.device_id, updated: x.updated_at, blob: b64ToBytes(x.blob) })),
    put: (dev, blob) => rpc('sync_put', { p_device: dev, p_blob: bytesToB64(blob) }),
    remove: (dev) => rpc('sync_delete', { p_device: dev || null }),
  };
}

/* ───────────────────────────── one round ───────────────────────────── */
// Note what changed here, fetch what the other computers wrote, merge, show the result, and save this computer's
// blob when there's anything new in it.
async function syncCycle({ full = false } = {}) {
  const cfg = syncCfg();
  if (!cfg.on || !sy.keys) return;
  if (sy.busy) { sy.again = true; return; }
  sy.busy = true;
  sy.lastRun = Date.now();
  const keys = sy.keys;
  const t = syncTransport(cfg.mode, keys);
  const aad = (dev) => `${keys.vaultId}|${dev}`;
  try {
    const now = Date.now();
    const { pkOf, pidOf, pks } = await playlistKeys();
    const db = loadSyncDb();

    const all = full || !cfg.since || now - (cfg.fullAt || 0) > 6 * 3600e3;   // now and then the whole list, so removed computers drop off
    let rows = [];
    try { rows = await t.list(all ? null : cfg.since); } catch (e) { if (!(e.denied && !cfg.pushedAt)) throw e; }   // a new code: nothing there yet
    const devices = all ? {} : { ...(cfg.devices || {}) };
    for (const row of rows) {
      if (!cfg.since || Date.parse(row.updated) > Date.parse(cfg.since)) cfg.since = row.updated;
      if (row.device === cfg.device) { devices[row.device] = { name: syncName(), at: row.updated }; continue; }
      try {
        const pl = await syncOpen(keys.key, row.blob, aad(row.device));
        mergePayload(db, pl);
        devices[row.device] = { name: String(pl.name || 'Computer').slice(0, 60), at: row.updated };
      } catch { devices[row.device] = { name: 'Can’t be read', at: row.updated, bad: 1 }; }
    }
    if (all) cfg.fullAt = now;
    // read this computer's state only now, after the last await: a change made while we waited isn't overwritten
    const local = exportLocal(state, pkOf);
    markRemoved(db, cfg.known, local, pks, now);
    mergeRecs(db, local);
    pruneRecs(db, now);
    syncApply(applyRecs(db, state, pidOf, pkOf));
    cfg.known = Object.keys(exportLocal(state, pkOf));
    saveSyncDb(db);

    const payload = { v: 1, name: syncName(), recs: db.recs, cleared: db.cleared || 0 };
    const hash = toHex(await crypto.subtle.digest('SHA-256', syncTe.encode(JSON.stringify(payload))));
    if (hash !== cfg.pushed || now - (cfg.pushedAt || 0) > 7 * 864e5 || !devices[cfg.device]) {
      const at = await t.put(cfg.device, await syncSeal(keys.key, payload, aad(cfg.device)));
      cfg.pushed = hash;
      cfg.pushedAt = now;
      devices[cfg.device] = { name: syncName(), at: typeof at === 'string' ? at : new Date().toISOString() };
    }
    cfg.devices = devices;
    cfg.last = { at: Date.now(), ok: true };
  } catch (e) {
    cfg.last = { at: Date.now(), ok: false, error: e.denied ? 'This code doesn’t work any more. If a new code was made on another computer, turn sync off here and enter the new one.' : e.message };
  } finally {
    const cur = syncCfg();   // turned off or another code meanwhile: don't write this round's state over it
    if (cur.on && cur.device === cfg.device && sy.keys === keys) {
      saveSyncCfg({ ...cur, known: cfg.known || cur.known, since: cfg.since, fullAt: cfg.fullAt, devices: cfg.devices || cur.devices, pushed: cfg.pushed, pushedAt: cfg.pushedAt, last: cfg.last });
    }
    sy.busy = false;
    syncRenderCard();
    if (sy.again) { sy.again = false; syncSoon(1000); }
  }
}

// Put the merged result into the app, and redraw what shows it – only when something actually changed.
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameMap = (a, b) => { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => sameJson(a[k], b[k])); };
function syncApply(next) {
  if (sameMap(next.progress, state.progress) && sameJson(next.recent, state.recent) && sameJson(next.favs, [...state.favs]) && sameMap(next.favdata, state.favdata)) return false;
  sy.applying = true;
  try {
    state.progress = next.progress; persistProgress();
    state.recent = next.recent; LS.set('tuner.recent', state.recent);
    state.favs = new Set(next.favs); state.favdata = next.favdata; persistFavs();
  } finally { sy.applying = false; }
  if (['dashboard', 'recent', 'favorites'].includes(ui.route)) renderRoute(ui.route);
  else if (ui.route === 'ws') {
    if (ws.detail) renderDetail();
    else if (ws.mode === 'live') renderLiveList();
    else refreshProgressBars();
  }
  return true;
}

/* ───────────────────────────── when to sync ───────────────────────────── */
// Soon after a change (a little later while something plays: progress is saved every few seconds), at most every 30 s.
function syncSoon(delay) {
  if (!sy.keys || !syncCfg().on) return;
  const due = Math.max(Date.now() + delay, sy.lastRun + 30000);
  if (sy.timer && sy.due <= due) return;
  clearTimeout(sy.timer);
  sy.due = due;
  sy.timer = setTimeout(() => { sy.timer = 0; syncCycle(); }, due - Date.now());
}
const SYNC_WATCH = { 'tuner.recent': 8000, 'tuner.favs': 8000, 'tuner.favdata': 8000, 'tuner.playlists': 3000, 'tuner.progress': 8000 };
const lsSetPlain = LS.set;
LS.set = (k, v) => {
  lsSetPlain(k, v);
  if (!(k in SYNC_WATCH) || sy.applying) return;
  const playing = k === 'tuner.progress' && state.current && !video.paused;
  syncSoon(playing ? 120000 : SYNC_WATCH[k]);
};
setInterval(() => { if (!document.hidden) syncSoon(0); }, 5 * 60e3);
window.addEventListener('focus', () => { if (Date.now() - sy.lastRun > 60e3) syncSoon(0); });

// Settings / Recently viewed › Clear: clear it on the other computers too (also what this one never saw)
function syncHistoryCleared() {
  if (!syncCfg().on) return;
  const db = loadSyncDb();
  db.cleared = Date.now();
  saveSyncDb(db);
  syncSoon(3000);
}

/* ───────────────────────────── turning it on and off ───────────────────────────── */
async function syncStart(code, mode, { keepDb = false } = {}) {
  sy.keys = await syncKeys(secretFromCode(code));
  sy.code = code;
  await codeStore.set(code);
  const cfg = syncCfg();
  saveSyncCfg({ on: true, mode, device: cfg.device || newDeviceId(), known: [], since: null, devices: {}, pushed: '', pushedAt: 0 });
  if (!keepDb) saveSyncDb({ recs: {}, cleared: 0 });
  await syncCycle({ full: true });
}

async function syncCreate(mode) {
  sy.showCode = true;
  await syncStart(codeFromSecret(newSyncSecret()), mode);
  const c = syncCfg();
  if (c.last && !c.last.ok) sy.msg = c.last.error;
}

async function syncJoin(text, mode) {
  const secret = secretFromCode(text);
  if (!secret) { sy.msg = 'That code isn’t right. Check it and try again: it has 27 letters and digits.'; return; }
  const keys = await syncKeys(secret);
  let rows = [];
  try { rows = await syncTransport(mode, keys).list(null); } catch (e) { if (!e.denied) { sy.msg = e.message; return; } }
  if (!rows.length) {
    sy.msg = mode === 'folder'
      ? 'Nothing has been synced with this code in this folder yet. Check the code and the folder, or turn sync on on the other computer first.'
      : 'Nothing has been synced with this code yet. Check the code, or turn sync on on the other computer first.';
    return;
  }
  sy.joining = false;
  await syncStart(codeFromSecret(secret), mode);
  toast('Sync is on');
}

async function syncChangeCode() {
  const yes = await askConfirm({ title: 'Make a new sync code?', text: 'Use this if someone else may have seen the code, or to stop a computer you no longer have from syncing. Your other computers stop syncing until you enter the new code on them.', ok: 'Make a new code' });
  if (!yes) return;
  const cfg = syncCfg();
  const old = syncTransport(cfg.mode, sy.keys);
  sy.showCode = true;
  await syncStart(codeFromSecret(newSyncSecret()), cfg.mode, { keepDb: true });
  old.remove(null).catch(() => {});   // the old vault: nobody can use it any more
  toast('New sync code made. Enter it on your other computers.');
}

async function syncStop(everywhere) {
  const cfg = syncCfg();
  const yes = await askConfirm(everywhere
    ? { title: 'Delete the synced data?', text: `This deletes the encrypted copy in ${cfg.mode === 'folder' ? 'your sync folder' : 'AG Horizon cloud'} and turns sync off on this computer. Your other computers stop syncing. What each computer has stays on it.`, ok: 'Delete', danger: true }
    : { title: 'Turn sync off on this computer?', text: 'Your history, progress and favorites stay here. Your other computers keep syncing with each other.', ok: 'Turn off' });
  if (!yes) return;
  if (sy.keys) {
    const t = syncTransport(cfg.mode, sy.keys);
    try { await (everywhere ? t.remove(null) : t.remove(cfg.device)); } catch (e) { if (everywhere) toast('Couldn’t delete the synced copy: ' + e.message, 'err'); }
  }
  clearTimeout(sy.timer); sy.timer = 0;
  sy.keys = null; sy.code = ''; sy.showCode = false;
  await codeStore.set('');
  saveSyncCfg({ on: false, mode: cfg.mode, device: cfg.device });
  saveSyncDb({ recs: {}, cleared: 0 });
  toast(everywhere ? 'Synced data deleted' : 'Sync is off on this computer');
}

async function syncRemoveDevice(id) {
  const cfg = syncCfg();
  const d = (cfg.devices || {})[id];
  const yes = await askConfirm({ title: `Remove “${d ? d.name : 'this computer'}”?`, text: 'Removes what it last synced. If that computer still has the code, it will sync again the next time it starts. To stop it for good, make a new code.', ok: 'Remove' });
  if (!yes) return;
  try { await syncTransport(cfg.mode, sy.keys).remove(id); } catch (e) { toast(e.message, 'err'); return; }
  const devices = { ...cfg.devices };
  delete devices[id];
  saveSyncCfg({ ...syncCfg(), devices });
}

/* ───────────────────────────── Settings › Sync ───────────────────────────── */
function syncSettingsCard() {
  const cfg = syncCfg();
  const canCloud = cloudReady(), canFolder = !!syncApi;
  const mode = cfg.on ? cfg.mode : (sy.mode || cfg.mode || (canCloud ? 'cloud' : 'folder'));
  const intro = `<div class="set-row"><div><b>Sync between your computers</b><p class="muted">Keeps Recently viewed, where you stopped and your favorites the same on every computer you use.
    It’s encrypted on this computer with your sync code before it leaves, so nobody else can read it, not even AG Horizon. Playlists and logins aren’t synced: add the same playlist on each computer.</p></div></div>`;
  if (!canCloud && !canFolder) return `<section class="set-card"><h3>Sync</h3>${intro}<p class="muted sub-na">Sync isn’t available in this build.</p></section>`;
  const msg = sy.msg ? `<p class="err-text sync-msg">${esc(sy.msg)}</p>` : '';
  const busy = sy.working ? ' disabled' : '';

  if (!cfg.on) {
    const modeRow = canCloud && canFolder ? `<div class="set-row"><div><b>Where to keep it</b><p class="muted">${mode === 'cloud'
      ? 'On AG Horizon’s sync server, encrypted. Works wherever you are.'
      : 'In a folder your cloud storage already syncs, like Dropbox, iCloud Drive, OneDrive or Google Drive. Encrypted, and no AG Horizon server involved.'}</p></div>
      <div class="seg">${['cloud', 'folder'].map((m) => `<button data-sync="mode" data-val="${m}" class="${mode === m ? 'on' : ''}">${MODE_LABEL[m]}</button>`).join('')}</div></div>` : '';
    const folderRow = mode === 'folder' ? `<div class="set-row"><div><b>Folder</b><p class="muted dl-path">${sy.info.folder ? esc(sy.info.folder) : 'None chosen yet. Pick the same synced folder on each computer.'}</p></div>
      <div class="upd-btns"><button class="btn ghost" data-sync="folder">${sy.info.folder ? 'Change' : 'Choose folder…'}</button></div></div>` : '';
    const ready = mode === 'cloud' || !!sy.info.folder;
    const start = sy.joining
      ? `<div class="set-row sync-join"><div><b>Enter the sync code</b><p class="muted">From Settings › Sync on the computer where sync is on.</p>
          <input id="syncCodeIn" class="sync-code-in" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX" autocomplete="off" spellcheck="false" maxlength="60">${msg}</div>
          <div class="upd-btns"><button class="btn" data-sync="join-go"${busy}>Connect</button><button class="btn ghost" data-sync="join-cancel">Cancel</button></div></div>`
      : `<div class="set-row"><div><b>Turn on sync</b><p class="muted">Create a code on the first computer, then enter it on the others.</p>${msg}</div>
          <div class="upd-btns"><button class="btn" data-sync="create"${ready ? busy : ' disabled'}>Create a sync code</button><button class="btn ghost" data-sync="join"${ready ? busy : ' disabled'}>I have a code</button></div></div>`;
    return `<section class="set-card"><h3>Sync</h3>${intro}${modeRow}${folderRow}${start}</section>`;
  }

  const last = cfg.last;
  const status = !last ? 'Starting…'
    : last.ok ? `Last synced ${ago(last.at)} · ${MODE_LABEL[cfg.mode]}${cfg.mode === 'folder' && sy.info.folder ? ` (${esc(sy.info.folder)})` : ''}`
    : `<span class="err-text">Couldn’t sync ${ago(last.at)}: ${esc(last.error)}</span>`;
  const shown = sy.showCode && sy.code;
  const code = shown ? esc(sy.code) : sy.code ? esc(sy.code.replace(/[0-9A-Z]/g, '•').replace(/^(.{0,4})/, sy.code.slice(0, 4))) : '…';
  const devs = Object.entries(cfg.devices || {}).sort((a, b) => (b[0] === cfg.device) - (a[0] === cfg.device) || Date.parse(b[1].at) - Date.parse(a[1].at));
  const devRows = devs.map(([id, d]) => `<li class="sync-dev"><svg class="ic"><use href="#i-monitor"/></svg><div><b>${esc(d.name)}</b>${id === cfg.device ? ' <span class="pill">This computer</span>' : ''}
      <small class="muted">${d.bad ? 'Its data can’t be read with this code' : 'Synced ' + ago(Date.parse(d.at))}</small></div>
      ${id === cfg.device ? '' : `<button class="icon-btn danger" data-sync="remove-dev" data-id="${esc(id)}" title="Remove" aria-label="Remove ${esc(d.name)}"><svg class="ic"><use href="#i-x"/></svg></button>`}</li>`).join('');
  return `<section class="set-card"><h3>Sync</h3>${intro}
    <div class="set-row"><div><b>${last && !last.ok ? 'Sync has a problem' : 'Sync is on'}</b><p class="muted">${status}</p>${msg}</div><div class="upd-btns"><button class="btn ghost" data-sync="now"${sy.busy ? ' disabled' : ''}>${sy.busy ? 'Syncing…' : 'Sync now'}</button></div></div>
    <div class="set-row"><div><b>Sync code</b><p class="muted">Enter it on your other computers: Settings › Sync › I have a code. Anyone with this code can read what you sync, so keep it like a password.</p>
      <code class="sync-code${shown ? '' : ' hidden-code'}">${code}</code></div>
      <div class="upd-btns"><button class="btn ghost" data-sync="show">${shown ? 'Hide' : 'Show'}</button><button class="btn ghost" data-sync="copy">Copy</button></div></div>
    <div class="set-row"><div><b>Computers</b><p class="muted">${devs.length === 1 ? 'Only this one so far.' : `${devs.length} computers use this code.`}</p><ul class="sync-devs">${devRows}</ul></div></div>
    <div class="set-row"><div><b>Stop or start over</b><p class="muted">A new code shuts out every computer that only knows the old one.</p></div>
      <div class="upd-btns"><button class="btn ghost" data-sync="change"${busy}>New code</button><button class="btn ghost" data-sync="off"${busy}>Turn off</button><button class="btn ghost danger-text" data-sync="delete"${busy}>Delete synced data</button></div></div>
  </section>`;
}

// redraw just this card (not the whole page: a code being typed elsewhere stays put)
function syncRenderCard() {
  if (ui.route !== 'settings') return;
  const el = document.getElementById('set-sync');
  if (!el || (document.activeElement && document.activeElement.id === 'syncCodeIn')) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = syncSettingsCard();
  const card = tmp.firstElementChild;
  card.id = 'set-sync';
  el.replaceWith(card);
}

async function syncAction(fn) {
  sy.working = true; sy.msg = ''; syncRenderCard();
  try { await fn(); } catch (e) { sy.msg = e.message; }
  sy.working = false; syncRenderCard();
}

$('#v-settings').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sync]');
  if (!b || b.disabled) return;
  const cfg = syncCfg();
  const mode = cfg.on ? cfg.mode : (sy.mode || cfg.mode || (cloudReady() ? 'cloud' : 'folder'));
  switch (b.dataset.sync) {
    case 'mode': sy.mode = b.dataset.val; sy.msg = ''; syncRenderCard(); break;
    case 'folder': syncApi.chooseFolder().then((f) => { if (f) sy.info.folder = f; syncRenderCard(); }); break;
    case 'create': syncAction(() => syncCreate(mode)); break;
    case 'join': sy.joining = true; sy.msg = ''; syncRenderCard(); setTimeout(() => { const i = $('#syncCodeIn'); if (i) i.focus(); }); break;
    case 'join-cancel': sy.joining = false; sy.msg = ''; syncRenderCard(); break;
    case 'join-go': { const v = $('#syncCodeIn').value; $('#syncCodeIn').blur(); syncAction(() => syncJoin(v, mode)).then(() => { const i = $('#syncCodeIn'); if (i) { i.value = v; i.focus(); } }); break; }
    case 'now': syncCycle({ full: true }); syncRenderCard(); break;
    case 'show': sy.showCode = !sy.showCode; syncRenderCard(); break;
    case 'copy': navigator.clipboard.writeText(sy.code).then(() => toast('Sync code copied'), () => toast('Couldn’t copy. Show the code and copy it by hand.', 'err')); break;
    case 'change': syncAction(syncChangeCode); break;
    case 'off': syncAction(() => syncStop(false)); break;
    case 'delete': syncAction(() => syncStop(true)); break;
    case 'remove-dev': syncAction(() => syncRemoveDevice(b.dataset.id)); break;
    default: break;
  }
});
$('#v-settings').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'syncCodeIn') $('[data-sync="join-go"]').click(); });

/* ───────────────────────────── start ───────────────────────────── */
(async () => {
  if (syncApi) sy.info = await syncApi.info().catch(() => ({})) || {};
  const cfg = syncCfg();
  if (!cfg.on) return;
  const code = await codeStore.get().catch(() => '');
  const secret = secretFromCode(code);
  if (!secret) {   // the keychain lost it (or it was never saved): sync can't go on without the code
    saveSyncCfg({ ...cfg, on: false });
    return;
  }
  sy.code = codeFromSecret(secret);
  sy.keys = await syncKeys(secret);
  syncSoon(3000);
})();
