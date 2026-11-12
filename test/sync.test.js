'use strict';
const test = require('node:test');
const assert = require('node:assert');
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;   // Node 18
const S = require('../public/js/sync-core.js');

/* ── the sync code ── */
test('a sync code turns back into the same secret', () => {
  for (let i = 0; i < 200; i++) {
    const secret = S.newSyncSecret();
    const code = S.codeFromSecret(secret);
    assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{3}$/);
    assert.deepStrictEqual(S.secretFromCode(code), secret);
  }
});

test('typing the code is forgiving about case, spaces and look-alike letters', () => {
  const secret = new Uint8Array(16).map((_, i) => i * 17);
  const code = S.codeFromSecret(secret);
  assert.deepStrictEqual(S.secretFromCode(code.toLowerCase().replace(/-/g, ' ')), secret);
  assert.deepStrictEqual(S.secretFromCode(`  ${code}\n`), secret);
  const withLetters = code.replace(/0/g, 'O').replace(/1/g, 'l');
  assert.deepStrictEqual(S.secretFromCode(withLetters), secret);
});

test('a mistyped, swapped, short or long code is refused', () => {
  const code = S.codeFromSecret(S.newSyncSecret()).replace(/-/g, '');
  let caught = 0, tried = 0;
  for (let i = 0; i < code.length; i++) {
    for (const c of '0123456789ABCDEFGHJKMNPQRSTVWXYZ') {
      if (c === code[i]) continue;
      tried++;
      if (S.secretFromCode(code.slice(0, i) + c + code.slice(i + 1)) === null) caught++;
    }
  }
  assert.ok(caught / tried > 0.99, `only ${caught} of ${tried} single typos caught`);
  for (let i = 0; i < code.length - 1; i++) {
    if (code[i] === code[i + 1]) continue;
    const swapped = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
    assert.strictEqual(S.secretFromCode(swapped), null, `swap at ${i}`);
  }
  assert.strictEqual(S.secretFromCode(code.slice(1)), null);
  assert.strictEqual(S.secretFromCode(code + 'A'), null);
  assert.strictEqual(S.secretFromCode(''), null);
  assert.strictEqual(S.secretFromCode('hello'), null);
});

/* ── keys and encryption ── */
test('the same code gives the same keys; the three values differ', async () => {
  const secret = S.newSyncSecret();
  const a = await S.syncKeys(secret), b = await S.syncKeys(secret.slice());
  assert.strictEqual(a.vaultId, b.vaultId);
  assert.strictEqual(a.token, b.token);
  assert.match(a.vaultId, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a.vaultId, a.token);
  const other = await S.syncKeys(S.newSyncSecret());
  assert.notStrictEqual(a.vaultId, other.vaultId);
});

test('sealed data opens with the same code and row, and nothing else', async () => {
  const k1 = await S.syncKeys(S.newSyncSecret()), k2 = await S.syncKeys(S.newSyncSecret());
  const data = { v: 1, name: 'Laptop', recs: { 'p|abc|m1': { v: { t: 10, d: 100, w: 0 }, ts: 5 } }, cleared: 0 };
  const sealed = await S.syncSeal(k1.key, data, 'vault|dev1');
  assert.deepStrictEqual(await S.syncOpen(k1.key, sealed, 'vault|dev1'), data);
  assert.notDeepStrictEqual(await S.syncSeal(k1.key, data, 'vault|dev1'), sealed, 'a new IV each time');
  await assert.rejects(S.syncOpen(k2.key, sealed, 'vault|dev1'), 'another code');
  await assert.rejects(S.syncOpen(k1.key, sealed, 'vault|dev2'), 'another row');
  const tampered = sealed.slice(); tampered[40] ^= 1;
  await assert.rejects(S.syncOpen(k1.key, tampered, 'vault|dev1'), 'changed on the way');
  assert.deepStrictEqual(S.b64ToBytes(S.bytesToB64(sealed)), sealed);
});

/* ── records: two computers with different playlist ids for the same account ── */
const snapOf = (pid, rest, extra = {}) => ({ uid: `${pid}:${rest}`, pid, id: rest, kind: 'movie', name: 'Film ' + rest, logo: '', group: '', year: '', rating: '', seriesUid: '', seriesName: '', season: 0, num: 0, ...extra });
const A = { pkOf: { aaa: 'K1' }, pidOf: { K1: 'aaa' } };   // computer A calls the playlist "aaa"
const B = { pkOf: { bbb: 'K1' }, pidOf: { K1: 'bbb' } };   // computer B calls the same account "bbb"
const empty = () => ({ progress: {}, recent: [], favs: [], favdata: {} });
const newDb = () => ({ recs: {}, cleared: 0 });

test('history, progress and favorites move between computers with different playlist ids', () => {
  const a = {
    progress: { 'aaa:m1': { t: 600, d: 6000, w: 0, ts: 100 } },
    recent: [{ ...snapOf('aaa', 'e7', { kind: 'episode', seriesUid: 'aaa:s3', seriesName: 'Show', season: 1, num: 2 }), ts: 90 }],
    favs: ['aaa:5'], favdata: { 'aaa:5': { ...snapOf('aaa', '5', { kind: 'live' }), ts: 80 } },
  };
  const db = newDb();
  S.mergeRecs(db, S.exportLocal(a, A.pkOf));
  assert.deepStrictEqual(Object.keys(db.recs).sort(), ['f|K1|5', 'p|K1|m1', 'r|K1|e7']);

  const b = S.applyRecs(db, empty(), B.pidOf, B.pkOf);
  assert.deepStrictEqual(b.progress, { 'bbb:m1': { t: 600, d: 6000, w: 0, ts: 100 } });
  assert.strictEqual(b.recent[0].uid, 'bbb:e7');
  assert.strictEqual(b.recent[0].pid, 'bbb');
  assert.strictEqual(b.recent[0].seriesUid, 'bbb:s3');
  assert.deepStrictEqual(b.favs, ['bbb:5']);
  assert.strictEqual(b.favdata['bbb:5'].name, 'Film 5');
  assert.strictEqual(b.favdata['bbb:5'].uid, 'bbb:5');
  // and back again, it's the same records
  assert.deepStrictEqual(S.exportLocal(b, B.pkOf), S.exportLocal(a, A.pkOf));
});

test('the newer record wins, wherever it was made', () => {
  const db = newDb();
  S.mergeRecs(db, { 'p|K1|m1': { v: { t: 100, d: 6000, w: 0 }, ts: 10 } });
  assert.strictEqual(S.mergeRecs(db, { 'p|K1|m1': { v: { t: 50, d: 6000, w: 0 }, ts: 5 } }), false, 'older: ignored');
  assert.strictEqual(S.mergeRecs(db, { 'p|K1|m1': { v: { t: 900, d: 6000, w: 0 }, ts: 20 } }), true);
  assert.strictEqual(db.recs['p|K1|m1'].v.t, 900);
  assert.strictEqual(S.mergeRecs(db, { 'p|K1|m1': { del: 1, ts: 20 } }), true, 'a removal at the same moment wins');
  assert.strictEqual(S.mergeRecs(db, { 'p|K1|m1': { v: { t: 1, d: 1, w: 0 }, ts: 20 } }), false);
});

test('something removed on one computer is removed on the others, and can come back later', () => {
  const db = newDb();
  const a = { ...empty(), favs: ['aaa:5'], favdata: { 'aaa:5': { ...snapOf('aaa', '5'), ts: 10 } } };
  S.mergeRecs(db, S.exportLocal(a, A.pkOf));
  const known = Object.keys(S.exportLocal(a, A.pkOf));
  // A removes the favorite
  const a2 = empty();
  const recs = S.exportLocal(a2, A.pkOf);
  assert.strictEqual(S.markRemoved(db, known, recs, new Set(['K1']), 50), true);
  assert.deepStrictEqual(db.recs['f|K1|5'], { del: 1, ts: 50 });
  // B still had it: it goes there too
  const b = S.applyRecs(db, { ...empty(), favs: ['bbb:5'], favdata: { 'bbb:5': { ...snapOf('bbb', '5'), ts: 10 } } }, B.pidOf, B.pkOf);
  assert.deepStrictEqual(b.favs, []);
  // B adds it again later: that is newer than the removal
  S.mergeRecs(db, S.exportLocal({ ...empty(), favs: ['bbb:5'], favdata: { 'bbb:5': { ...snapOf('bbb', '5'), ts: 60 } } }, B.pkOf));
  assert.deepStrictEqual(S.applyRecs(db, empty(), A.pidOf, A.pkOf).favs, ['aaa:5']);
});

test('removing a playlist does not remove its history on the other computers', () => {
  const db = newDb();
  const a = { ...empty(), recent: [{ ...snapOf('aaa', 'm1'), ts: 10 }] };
  S.mergeRecs(db, S.exportLocal(a, A.pkOf));
  const known = Object.keys(S.exportLocal(a, A.pkOf));
  // the playlist is gone from A: its items can't be exported, but that isn't a removal
  S.markRemoved(db, known, S.exportLocal(a, {}), new Set(), 50);
  assert.ok(!db.recs['r|K1|m1'].del);
  // ...and the records stay, ready for when the playlist is added again
  assert.strictEqual(S.applyRecs(db, empty(), A.pidOf, A.pkOf).recent[0].uid, 'aaa:m1');
});

test('items of playlists that are not synced are left alone', () => {
  const db = newDb();
  const st = { progress: { 'zzz:m9': { t: 1, d: 2, w: 0, ts: 3 } }, recent: [{ ...snapOf('zzz', 'm9'), ts: 3 }], favs: ['zzz:1'], favdata: { 'zzz:1': snapOf('zzz', '1') } };
  const out = S.applyRecs(db, st, A.pidOf, A.pkOf);
  assert.deepStrictEqual(out.progress, st.progress);
  assert.strictEqual(out.recent.length, 1);
  assert.deepStrictEqual(out.favs, ['zzz:1']);
});

test('"Clear history" on one computer clears it on all of them', () => {
  const db = newDb();
  S.mergeRecs(db, S.exportLocal({ ...empty(), recent: [{ ...snapOf('aaa', 'm1'), ts: 10 }, { ...snapOf('aaa', 'm2'), ts: 30 }] }, A.pkOf));
  S.mergePayload(db, { recs: {}, cleared: 20 });
  assert.deepStrictEqual(S.applyRecs(db, empty(), B.pidOf, B.pkOf).recent.map((r) => r.uid), ['bbb:m2']);
  S.pruneRecs(db, 40);
  assert.ok(!db.recs['r|K1|m1'], 'cleared records are dropped');
});

test('records are kept within limits', () => {
  const db = newDb();
  const recs = {};
  for (let i = 0; i < 1700; i++) recs[`p|K1|m${i}`] = { v: { t: 1, d: 2, w: 0 }, ts: 1000 + i };
  for (let i = 0; i < 250; i++) recs[`r|K1|m${i}`] = { v: snapOf('x', 'm' + i), ts: 1000 + i };
  recs['f|K1|old'] = { del: 1, ts: 1 };
  recs['f|K1|new'] = { del: 1, ts: 100 * 864e5 };
  S.mergeRecs(db, recs);
  S.pruneRecs(db, 100 * 864e5);
  const count = (ty) => Object.keys(db.recs).filter((k) => k[0] === ty).length;
  assert.strictEqual(count('p'), 1500);
  assert.strictEqual(count('r'), 200);
  assert.ok(db.recs['p|K1|m1699'] && !db.recs['p|K1|m0'], 'the newest are kept');
  assert.ok(!db.recs['f|K1|old'] && db.recs['f|K1|new'], 'old removals are forgotten');
  const applied = S.applyRecs(db, empty(), A.pidOf, A.pkOf);
  assert.strictEqual(Object.keys(applied.progress).length, 500);
  assert.strictEqual(applied.recent.length, 60);
});
