'use strict';
/* AG Horizon – sync, the parts that don't touch the page: the sync code, the keys and encryption made from it, and
   turning Recently viewed / where you stopped / favorites into records that mean the same on every computer (and back).
   sync.js wires this to the app. Loaded in the page (as globals) and by test/sync.test.js (module.exports).

   The sync code is 128 random bits. From it come three separate values: the vault id (which rows are ours), an access
   token (proves we may read and write them; the server keeps only its hash) and the AES-256-GCM key. The key never
   leaves this computer, so whoever stores the data – a server or a synced folder – sees only random ids and noise. */

/* ───────────────────────────── the sync code ───────────────────────────── */
const SYNC_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford base32: no I, L, O or U to misread
const SYNC_SECRET_BYTES = 16;

// one extra character that catches a mistyped or swapped character
const codeCheck = (s) => [...s].reduce((sum, c, i) => (sum + (i + 1) * SYNC_ALPHABET.indexOf(c)) % 31, 0);

// 16 bytes -> "K7QM-2X9P-4T8W-ZR3N-H6VD-JC5B-Q8E"
function codeFromSecret(bytes) {
  let out = '', val = 0, bits = 0;
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += SYNC_ALPHABET[(val >>> (bits - 5)) & 31]; bits -= 5; }
    val &= (1 << bits) - 1;
  }
  if (bits) out += SYNC_ALPHABET[(val << (5 - bits)) & 31];
  out += SYNC_ALPHABET[codeCheck(out)];
  return out.match(/.{1,4}/g).join('-');
}

// What someone typed or pasted -> the 16 bytes, or null when it isn't a whole, correct code.
// Forgiving about case, spaces and dashes, and reads I/L as 1 and O as 0.
function secretFromCode(text) {
  const s = String(text || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  const len = Math.ceil((SYNC_SECRET_BYTES * 8) / 5);
  if (s.length !== len + 1 || /[^0-9A-HJKMNP-TV-Z]/.test(s)) return null;
  const body = s.slice(0, len);
  if (SYNC_ALPHABET[codeCheck(body)] !== s[len]) return null;
  const out = new Uint8Array(SYNC_SECRET_BYTES);
  let val = 0, bits = 0, n = 0;
  for (const c of body) {
    val = (val << 5) | SYNC_ALPHABET.indexOf(c); bits += 5;
    if (bits >= 8) { if (n < out.length) out[n++] = (val >>> (bits - 8)) & 255; bits -= 8; }
    val &= (1 << bits) - 1;
  }
  return n === out.length && val === 0 ? out : null;   // the last bits are padding and must be 0
}

const newSyncSecret = () => crypto.getRandomValues(new Uint8Array(SYNC_SECRET_BYTES));

/* ───────────────────────────── keys & encryption ───────────────────────────── */
const syncTe = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

// The code has 128 random bits, so it can't be guessed: a fast HKDF is enough (no slow password hashing needed).
async function syncKeys(secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const p = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: syncTe.encode('ag-horizon-sync-v1'), info: syncTe.encode(info) });
  return {
    vaultId: toHex(await crypto.subtle.deriveBits(p('vault-id'), base, 256)),
    token: toHex(await crypto.subtle.deriveBits(p('access-token'), base, 256)),
    key: await crypto.subtle.deriveKey(p('data-key'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  };
}

async function gzipBytes(bytes, mode) {
  const stream = new Blob([bytes]).stream().pipeThrough(mode === 'gzip' ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// object -> JSON -> gzip -> AES-GCM, as [12-byte IV | ciphertext + tag]. A new random IV every time. The AAD ties the
// result to the row it is stored in (vault and device), so rows can't be swapped around.
async function syncSeal(key, obj, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const zipped = await gzipBytes(syncTe.encode(JSON.stringify(obj)), 'gzip');
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: syncTe.encode(aad) }, key, zipped));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
// Throws when the data was changed, belongs to another row, or was made with another code.
async function syncOpen(key, bytes, aad) {
  const iv = bytes.subarray(0, 12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: syncTe.encode(aad) }, key, bytes.subarray(12));
  return JSON.parse(new TextDecoder().decode(await gzipBytes(new Uint8Array(plain), 'gunzip')));
}

const bytesToB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* ───────────────────────────── records ───────────────────────────── */
/* Inside the app an item is "<playlist id>:<rest>", and the playlist id is random per computer. A record key replaces
   it with the playlist's key – the same on every computer that has the same account or link – so
   "k3x9q2ab:m4711" here and "p0z8w1cd:m4711" there are both "p|<playlist key>|m4711".
   Records: { v: value, ts } or, for something removed, { del: 1, ts }. */
const SYNC_DAY = 864e5;

const splitUid = (uid) => { const s = String(uid), i = s.indexOf(':'); return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [null, s]; };
const recKey = (ty, pk, rest) => `${ty}|${pk}|${rest}`;
function parseRecKey(k) { const a = k.indexOf('|'), b = k.indexOf('|', a + 1); return { ty: k.slice(0, a), pk: k.slice(a + 1, b), rest: k.slice(b + 1) }; }

// a Favorites / Recently viewed snapshot without this computer's playlist id, and back
function portableSnap(s) {
  const { uid, pid, seriesUid, ts, ...v } = s;
  if (seriesUid) v.sr = splitUid(seriesUid)[1];
  return v;
}
function localSnap(v, pid, rest) {
  const { sr, ...o } = v;
  return { ...o, uid: `${pid}:${rest}`, pid, seriesUid: sr ? `${pid}:${sr}` : '' };
}

// This computer's history, progress and favorites as records. pkOf: playlist id -> playlist key; items from a playlist
// that isn't here any more are left out (and are left alone).
function exportLocal(st, pkOf) {
  const recs = {};
  const put = (ty, uid, v, ts) => {
    const [pid, rest] = splitUid(uid);
    const pk = pid && pkOf[pid];
    if (!pk) return;
    const k = recKey(ty, pk, rest);
    if (!recs[k] || recs[k].ts < ts) recs[k] = { v, ts };
  };
  for (const [uid, p] of Object.entries(st.progress || {})) if (p) put('p', uid, { t: p.t, d: p.d, w: p.w }, p.ts || 0);
  for (const r of st.recent || []) put('r', r.uid, portableSnap(r), r.ts || 0);
  for (const uid of st.favs || []) { const f = st.favdata && st.favdata[uid]; if (f) put('f', uid, portableSnap(f), f.ts || 1); }
  return recs;
}

// the newer record wins; at the very same moment a removal wins
const recWins = (a, b) => !b || a.ts > b.ts || (a.ts === b.ts && !!a.del && !b.del);
function mergeRecs(db, recs) {
  let changed = false;
  for (const [k, r] of Object.entries(recs || {})) if (r && typeof r.ts === 'number' && recWins(r, db.recs[k])) { db.recs[k] = r; changed = true; }
  return changed;
}
function mergePayload(db, payload) {
  let changed = mergeRecs(db, payload.recs);
  if ((payload.cleared || 0) > (db.cleared || 0)) { db.cleared = payload.cleared; changed = true; }
  return changed;
}

// What was here after the last sync but is gone now was removed on this computer: say so, so it goes everywhere.
// Only for playlists that are here (pks), so removing a playlist doesn't remove its history on the other computers.
function markRemoved(db, known, recs, pks, now) {
  let changed = false;
  for (const k of known || []) {
    if (recs[k] || !pks.has(parseRecKey(k).pk)) continue;
    const r = db.recs[k];
    if (r && !r.del) { db.recs[k] = { del: 1, ts: now }; changed = true; }
  }
  return changed;
}

// The synced records -> this computer's progress / Recently viewed / favorites. pidOf: playlist key -> the playlist id
// here. Items of playlists that aren't here stay as they are; records for playlists that aren't here are kept in the
// records (and passed on) until that playlist is added.
function applyRecs(db, st, pidOf, pkOf) {
  const here = (uid) => !!pkOf[splitUid(uid)[0]];
  const cleared = db.cleared || 0;
  const progress = {}, recent = [], favs = [];
  for (const [uid, p] of Object.entries(st.progress || {})) if (!here(uid)) progress[uid] = p;
  for (const r of st.recent || []) if (!here(r.uid) && (r.ts || 0) > cleared) recent.push(r);
  for (const uid of st.favs || []) if (!here(uid)) favs.push([uid, st.favdata && st.favdata[uid]]);
  for (const [k, r] of Object.entries(db.recs)) {
    if (r.del) continue;
    const { ty, pk, rest } = parseRecKey(k);
    const pid = pidOf[pk];
    if (!pid) continue;
    const uid = `${pid}:${rest}`;
    if (ty === 'p') progress[uid] = { t: r.v.t, d: r.v.d, w: r.v.w, ts: r.ts };
    else if (ty === 'r') { if (r.ts > cleared) recent.push({ ...localSnap(r.v, pid, rest), ts: r.ts }); }
    else if (ty === 'f') favs.push([uid, { ...localSnap(r.v, pid, rest), ts: r.ts }]);
  }
  recent.sort((a, b) => b.ts - a.ts);
  favs.sort((a, b) => ((a[1] && a[1].ts) || 0) - ((b[1] && b[1].ts) || 0));   // oldest first, the order they were added
  const keep = Object.keys(progress).sort((a, b) => (progress[b].ts || 0) - (progress[a].ts || 0)).slice(0, 500);
  return {
    progress: Object.fromEntries(keep.map((u) => [u, progress[u]])),
    recent: recent.slice(0, 60),
    favs: favs.map(([u]) => u),
    favdata: Object.fromEntries(favs.filter(([, f]) => f).map(([u, f]) => [u, f])),
  };
}

// Keep the records from growing forever: removals are kept 90 days (long enough for every computer to hear about
// them), and the newest 1500 progress / 200 history records.
function pruneRecs(db, now) {
  const cap = { p: 1500, r: 200 };
  const by = { p: [], r: [] };
  for (const [k, r] of Object.entries(db.recs)) {
    if (r.del) { if (now - r.ts > 90 * SYNC_DAY) delete db.recs[k]; continue; }
    if (k[0] === 'r' && r.ts <= (db.cleared || 0)) { delete db.recs[k]; continue; }
    if (by[k[0]]) by[k[0]].push([k, r.ts]);
  }
  for (const ty of Object.keys(by)) by[ty].sort((a, b) => b[1] - a[1]).slice(cap[ty]).forEach(([k]) => delete db.recs[k]);
}

if (typeof module !== 'undefined') {
  module.exports = {
    codeFromSecret, secretFromCode, newSyncSecret, syncKeys, syncSeal, syncOpen, bytesToB64, b64ToBytes, toHex,
    exportLocal, mergeRecs, mergePayload, markRemoved, applyRecs, pruneRecs, recKey, parseRecKey,
  };
}
