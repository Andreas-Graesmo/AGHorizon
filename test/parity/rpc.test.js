'use strict';
/*
 * The downloads engine and the folder sync over stdin/stdout (MIGRATION_PLAN.md 3.4 / 3.5 / 8.5), tested from the
 * outside: the same tests run against sidecar/entry.js (server.js + desktop/) and the Rust server.
 *   AGH_PARITY_SERVER=node (default; part of `npm test`) | rust
 * A fake provider serves films (with Range, slowly when asked, cut off once when asked), posters and errors.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');

const KIND = process.env.AGH_PARITY_SERVER || 'node';
const root = path.join(__dirname, '..', '..');
const RUST = path.join(root, 'server-rs', 'target', 'release', `aghorizon-server-rs${process.platform === 'win32' ? '.exe' : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────── a fake provider ───────────── */
const SIZE = 400 * 1024;
const bytes = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 7 + (i >> 8)) & 255; return b; };
const FILM = bytes(SIZE);
const seen = [];   // { path, range }
const cutOnce = new Set();
let P;
const provider = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  seen.push({ path: u.pathname, range: req.headers.range || '', ua: req.headers['user-agent'] });
  if (u.pathname === '/poster.jpg') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.from('JPEGDATA')); }
  if (u.pathname === '/notimage.jpg') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>'); }
  if (u.pathname === '/404.mp4') { res.writeHead(404); return res.end(); }
  if (u.pathname === '/403.mp4') { res.writeHead(403); return res.end(); }
  if (u.pathname === '/hls.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U'); }
  if (u.pathname === '/page.mp4') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>login</html>'); }
  if (!u.pathname.endsWith('.mp4')) { res.writeHead(404); return res.end(); }
  // a film: Range; ?slow=1 trickles it; ?cut=<key> drops the connection halfway, once
  const r = /^bytes=(\d+)-$/.exec(req.headers.range || '');
  const from = r ? Number(r[1]) : 0;
  if (from >= SIZE) { res.writeHead(416, { 'Content-Range': `bytes */${SIZE}` }); return res.end(); }
  res.writeHead(r ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': SIZE - from, ...(r ? { 'Content-Range': `bytes ${from}-${SIZE - 1}/${SIZE}` } : {}) });
  const cut = u.searchParams.get('cut');
  const slow = u.searchParams.get('slow');
  let o = from;
  const step = () => {
    if (res.destroyed) return;
    if (cut && !cutOnce.has(cut) && o >= SIZE / 2) { cutOnce.add(cut); res.destroy(); return; }
    const n = Math.min(slow ? 8192 : 65536, SIZE - o);
    res.write(FILM.subarray(o, o + n));
    o += n;
    if (o >= SIZE) res.end(); else setTimeout(step, slow ? 50 : 0);
  };
  step();
});

/* ───────────── the server under test ───────────── */
function startServer(dataDir) {
  const [cmd, args] = KIND === 'rust' ? [RUST, ['0']] : [process.execPath, [path.join(root, 'sidecar', 'entry.js'), '0']];
  const child = spawn(cmd, args, {
    env: { ...process.env, AGH_DATA_DIR: dataDir, AGH_DOCUMENTS_DIR: dataDir, PUBLIC_DIR: path.join(root, 'public') },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  const events = [];
  let ready;
  const readyP = new Promise((r) => { ready = r; });
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    if (l.startsWith('READY ')) ready(Number(l.slice(6)));
    else if (l.startsWith('RPC ')) { const m = JSON.parse(l.slice(4)); const p = pending.get(m.id); pending.delete(m.id); if (p) (m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))); }
    else if (l.startsWith('EVENT ')) events.push(JSON.parse(l.slice(6)));
  });
  let id = 0;
  const call = (cmd, ...a) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    child.stdin.write(JSON.stringify({ id: n, cmd, args: a }) + '\n');
  });
  const snapshot = () => { const e = events.filter((x) => x.name === 'downloads:changed').pop(); return e && e.payload; };
  // wait until the latest snapshot (or list()) satisfies f
  const until = async (f, what, ms = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const s = await call('downloads.list');
      if (f(s)) return s;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s.items.map((i) => [i.title, i.state, i.error, i.received]))}`);
      await sleep(100);
    }
  };
  return { child, call, events, snapshot, until, ready: readyP };
}

const film = (o) => ({ kind: 'movie', uid: `p1:movie:${o.title}`, pid: 'p1', url: `${P}/${o.file || 'film.mp4'}${o.q ? `?${o.q}` : ''}`, ext: 'mp4', year: '2020', ...o });
const savedList = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'downloads.json'), 'utf8'));
const by = (s, title) => s.items.find((i) => i.title === title);

let tmp, sc, port;
test.before(async () => {
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  P = `http://127.0.0.1:${provider.address().port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-rpc-'));
  sc = startServer(tmp);
  port = await sc.ready;
});
test.after(() => { if (sc) sc.child.kill(); provider.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('downloads: an empty list, then a film with its poster, played through /api/local', async () => {
  const first = await sc.call('downloads.list');
  assert.deepStrictEqual(Object.keys(first), ['items', 'folder', 'pauseWhileWatching', 'held', 'free']);
  assert.deepStrictEqual([first.items, first.folder, first.pauseWhileWatching, first.held], [[], path.join(tmp, 'AGHorizon'), true, false]);
  assert.ok(first.free > 0);
  assert.strictEqual(await sc.call('downloads.currentFolder'), path.join(tmp, 'AGHorizon'));
  assert.strictEqual(await sc.call('downloads.add', [film({ title: 'Test Film', poster: `${P}/poster.jpg`, plot: 'x'.repeat(1300), seasonless: 1 })]), 1);
  const s = await sc.until((x) => by(x, 'Test Film') && by(x, 'Test Film').state === 'done', 'the film');
  const it = by(s, 'Test Film');
  assert.deepStrictEqual(Object.keys(it), ['id', 'uid', 'pid', 'kind', 'title', 'year', 'plot', 'ext', 'seriesUid', 'seriesName', 'season', 'episode', 'epTitle', 'poster', 'hasPoster', 'state', 'error', 'size', 'received', 'speed', 'addedAt', 'doneAt']);
  assert.deepStrictEqual([it.uid, it.pid, it.kind, it.year, it.plot.length, it.ext, it.seriesUid, it.season, it.episode, it.epTitle, it.poster, it.hasPoster, it.error, it.size, it.received, it.speed],
    ['p1:movie:Test Film', 'p1', 'movie', '2020', 1200, 'mp4', '', 0, 0, '', `${P}/poster.jpg`, true, '', SIZE, 0, 0]);
  assert.match(it.id, /^[0-9a-f]{16}$/);
  assert.ok(it.doneAt >= it.addedAt && it.addedAt > Date.now() - 60000);
  assert.ok(sc.events.some((e) => e.name === 'downloads:changed' && e.payload.items.some((x) => x.state === 'downloading')), 'progress came as events');
  const file = path.join(tmp, 'AGHorizon', 'Movies', 'Test Film (2020)', 'Test Film (2020).mp4');
  assert.ok(fs.readFileSync(file).equals(FILM));
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'AGHorizon', 'Movies', 'Test Film (2020)', 'poster.jpg'), 'utf8'), 'JPEGDATA');
  const local = await fetch(`http://127.0.0.1:${port}/api/local/${it.id}`);
  assert.ok(Buffer.from(await local.arrayBuffer()).equals(FILM), '/api/local serves it byte for byte');
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/local/${it.id}/poster`)).status, 200);
  assert.deepStrictEqual(await sc.call('downloads.revealTarget', it.id), { file, folder: path.join(tmp, 'AGHorizon') });
  assert.deepStrictEqual(await sc.call('downloads.revealTarget', 'nope'), { file: null, folder: path.join(tmp, 'AGHorizon') });
  // the same title again, or what isn't a download: nothing added
  assert.strictEqual(await sc.call('downloads.add', [film({ title: 'Test Film' }), { kind: 'live', url: `${P}/x.mp4` }, { kind: 'movie', url: 'ftp://x/y' }, null]), 0);
  const saved = savedList(tmp).items.find((x) => x.title === 'Test Film');
  assert.deepStrictEqual(Object.keys(saved), ['id', 'uid', 'pid', 'kind', 'url', 'ua', 'ext', 'title', 'year', 'plot', 'poster', 'seriesUid', 'seriesName', 'season', 'episode', 'epTitle', 'state', 'size', 'received', 'addedAt', 'file', 'error', 'speed', 'posterFile', 'tries', 'doneAt']);
  assert.strictEqual(seen.find((x) => x.path === '/film.mp4').ua, 'VLC/3.0.20 LibVLC/3.0.20');
});

test('downloads: Plex-style names, never two downloads in one file', async () => {
  const eps = [
    { kind: 'episode', uid: 'p1:ep:1', url: `${P}/e1.mp4`, ext: 'MKV', seriesName: 'Show: The Return?', season: 1, episode: 2, epTitle: 'Pilot' },
    { kind: 'episode', uid: 'p1:ep:2', url: `${P}/e2.mp4`, ext: 'mp4', seriesName: 'Show: The Return?', season: '1', episode: 3, epTitle: 'Show The Return S01E03' },
    { kind: 'episode', uid: 'p1:ep:3', url: `${P}/e3.mp4`, seriesName: '', season: 10, episode: 11, epTitle: 'show the return: finale' },
    { kind: 'movie', uid: 'p1:movie:dup', url: `${P}/d.mp4`, title: 'Test Film', year: '2020', ext: 'weird.ext' },
    { kind: 'movie', uid: 'p1:movie:con', url: `${P}/c.mp4`, title: 'con', ext: 'mp4' },
    { kind: 'movie', uid: 'p1:movie:year', url: `${P}/y.mp4`, title: 'Already (1999) here', year: '1999', ext: 'avi' },
  ];
  assert.strictEqual(await sc.call('downloads.add', eps), eps.length);
  await sc.until((x) => eps.every((e) => x.items.some((i) => i.uid === e.uid && i.state === 'done')), 'the episodes');
  const files = savedList(tmp).items.filter((x) => eps.some((e) => e.uid === x.uid)).map((x) => path.relative(path.join(tmp, 'AGHorizon'), x.file));
  assert.deepStrictEqual(files, [
    path.join('Series', 'Show The Return', 'Season 01', 'Show The Return - S01E02 - Pilot.mkv'),
    path.join('Series', 'Show The Return', 'Season 01', 'Show The Return - S01E03.mp4'),
    path.join('Series', 'Series', 'Season 10', 'Series - S10E11 - show the return finale.mp4'),
    path.join('Movies', 'Test Film (2020)', 'Test Film (2020) (2).mp4'),
    path.join('Movies', '_con', '_con.mp4'),
    path.join('Movies', 'Already (1999) here', 'Already (1999) here.avi'),
  ]);
});

test('downloads: refused by the provider, HLS, a web page; and tried again', async () => {
  await sc.call('downloads.add', [
    film({ title: 'Gone', file: '404.mp4' }), film({ title: 'Refused', file: '403.mp4' }),
    film({ title: 'Pieces', file: 'hls.m3u8' }), film({ title: 'Page', file: 'page.mp4' }),
  ]);
  const s = await sc.until((x) => ['Gone', 'Refused', 'Pieces', 'Page'].every((t) => by(x, t) && by(x, t).state === 'failed'), 'the failures');
  assert.deepStrictEqual(['Gone', 'Refused', 'Pieces', 'Page'].map((t) => by(s, t).error), [
    'This title is no longer available from the provider.',
    'The provider refused the download. Check that the subscription is active.',
    'This title is streamed in small pieces (HLS) and can’t be downloaded.',
    'The provider sent a web page instead of the video. The connection limit may be used up.',
  ]);
  await sc.call('downloads.resume', by(s, 'Gone').id);
  const again = await sc.until((x) => by(x, 'Gone').state === 'failed' && seen.filter((v) => v.path === '/404.mp4').length >= 2, 'the second try');
  assert.strictEqual(by(again, 'Gone').error, 'This title is no longer available from the provider.');
  // add() of a failed one queues it again
  assert.strictEqual(await sc.call('downloads.add', [film({ title: 'Refused', file: '403.mp4' })]), 1);
  for (const t of ['Gone', 'Refused', 'Pieces', 'Page']) await sc.call('downloads.remove', by(await sc.call('downloads.list'), t).id, false);
});

test('downloads: pause and resume carry on from the same byte; a dropped connection is resumed by itself', async () => {
  await sc.call('downloads.add', [film({ title: 'Slow', q: 'slow=1' })]);
  await sc.until((x) => by(x, 'Slow').state === 'downloading' && by(x, 'Slow').received > 40000, 'some of it');
  const id = by(await sc.call('downloads.list'), 'Slow').id;
  await sc.call('downloads.pause', id);
  const paused = await sc.call('downloads.list');
  assert.strictEqual(by(paused, 'Slow').state, 'paused');
  const part = savedList(tmp).items.find((x) => x.id === id).file + '.part';
  const have = fs.statSync(part).size;
  assert.ok(have > 0 && have < SIZE);
  await sc.call('downloads.resume', id);
  await sc.until((x) => by(x, 'Slow').state === 'done', 'the rest', 30000);
  assert.ok(seen.some((v) => v.path === '/film.mp4' && v.range === `bytes=${have}-`), 'asked for the rest only');
  assert.ok(fs.readFileSync(savedList(tmp).items.find((x) => x.id === id).file).equals(FILM));
  // the provider drops the connection halfway: it goes back in the queue and continues (after 5 s)
  await sc.call('downloads.add', [film({ title: 'Dropped', q: 'cut=a' })]);
  const done = await sc.until((x) => by(x, 'Dropped').state === 'done', 'the resumed one', 30000);
  assert.strictEqual(by(done, 'Dropped').size, SIZE);
  assert.ok(seen.some((v) => v.path === '/film.mp4' && /^bytes=\d+-$/.test(v.range) && v.range !== `bytes=${have}-`), 'resumed with Range');
  assert.ok(fs.readFileSync(savedList(tmp).items.find((x) => x.title === 'Dropped').file).equals(FILM));
  assert.strictEqual(savedList(tmp).items.find((x) => x.title === 'Dropped').tries, 0);
});

test('downloads: held while a video plays, reordered, one at a time', async () => {
  await sc.call('downloads.add', [film({ title: 'A', q: 'slow=1&a' }), film({ title: 'B', q: 'slow=1&b' })]);
  await sc.until((x) => by(x, 'A').state === 'downloading', 'A downloading');
  await sc.call('downloads.setWatching', true);
  let s = await sc.call('downloads.list');
  assert.deepStrictEqual([s.held, by(s, 'A').state, by(s, 'B').state], [true, 'queued', 'queued']);
  await sleep(300);
  assert.strictEqual(by(await sc.call('downloads.list'), 'A').state, 'queued', 'nothing starts while held');
  await sc.call('downloads.setOption', 'pauseWhileWatching', false);
  s = await sc.until((x) => !x.held && by(x, 'A').state === 'downloading', 'A again');
  assert.strictEqual(s.pauseWhileWatching, false);
  // B first: it takes over, A waits with its partial file
  await sc.call('downloads.reorder', [by(s, 'B').id, by(s, 'A').id, 'unknown']);
  s = await sc.until((x) => by(x, 'B').state === 'downloading', 'B takes over');
  assert.strictEqual(by(s, 'A').state, 'queued');
  assert.deepStrictEqual(s.items.filter((i) => ['A', 'B'].includes(i.title)).map((i) => i.title), ['B', 'A']);
  assert.strictEqual(s.items.filter((i) => i.state === 'downloading').length, 1);
  await sc.call('downloads.setWatching', false);
  await sc.call('downloads.setOption', 'pauseWhileWatching', true);
  await sc.until((x) => by(x, 'A').state === 'done' && by(x, 'B').state === 'done', 'both', 40000);
});

test('downloads: removing, with and without the file; empty folders go, the download folder stays', async () => {
  const s = await sc.call('downloads.list');
  const film1 = savedList(tmp).items.find((x) => x.title === 'Test Film');
  const dir = path.dirname(film1.file);
  fs.writeFileSync(film1.file.replace(/\.mp4$/, '.en.srt'), 'sub');
  fs.writeFileSync(film1.file.replace(/\.mp4$/, '.en.2.srt'), 'sub');
  fs.writeFileSync(path.join(dir, 'Other.en.srt'), 'not this one');
  const dup = savedList(tmp).items.find((x) => x.uid === 'p1:movie:dup');
  await sc.call('downloads.remove', dup.id, false);   // keeps its file
  assert.ok(fs.existsSync(dup.file));
  await sc.call('downloads.remove', by(s, 'Test Film').id, true);
  assert.ok(!fs.existsSync(film1.file));
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['Other.en.srt', 'Test Film (2020) (2).mp4', 'poster.jpg']);
  fs.rmSync(path.join(dir, 'Other.en.srt'));
  fs.rmSync(dup.file);   // the one kept above: gone, so the folder can empty
  const dupNow = { ...dup };
  await sc.call('downloads.add', [{ kind: 'movie', uid: dup.uid, url: dup.url, title: dup.title, year: dup.year, ext: 'mp4' }]);   // it's back
  const back = await sc.until((x) => x.items.some((i) => i.uid === dup.uid && i.state === 'done'), 'the duplicate again');
  await sc.call('downloads.remove', back.items.find((i) => i.uid === dup.uid).id, true);
  assert.ok(!fs.existsSync(dir), 'a folder with only its poster left goes too');
  assert.ok(fs.existsSync(path.join(tmp, 'AGHorizon', 'Movies')) || fs.existsSync(path.join(tmp, 'AGHorizon')));
  assert.ok(fs.existsSync(path.join(tmp, 'AGHorizon')), 'never the download folder itself');
  assert.ok(dupNow);
  assert.strictEqual(await sc.call('downloads.remove', 'nope', true), null);
});

test('downloads: files the list doesn\'t know are found and taken back; moved files are found again', async () => {
  const folder = path.join(tmp, 'AGHorizon');
  fs.mkdirSync(path.join(folder, 'Movies', 'Orphan (2019)'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'Movies', 'Orphan (2019)', 'Orphan (2019).MKV'), 'abc');
  fs.writeFileSync(path.join(folder, 'Movies', 'Orphan (2019)', 'notes.txt'), 'x');
  fs.mkdirSync(path.join(folder, 'Series', 'Lost Show', 'Season 02'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'Series', 'Lost Show', 'Season 02', 'Lost Show - S02E03.mp4'), 'abcd');
  fs.writeFileSync(path.join(folder, 'Series', 'Lost Show', 'Season 02', 'Lost Show - Extras.mp4'), 'x');
  fs.mkdirSync(path.join(folder, 'Series', 'Lost Show', 'Extras'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'Series', 'Lost Show', 'Extras', 'Show - S01E01.mp4'), 'x');
  const orphans = await sc.call('downloads.orphans');
  assert.deepStrictEqual(orphans, [
    { file: path.join(folder, 'Movies', 'Orphan (2019)', 'Orphan (2019).MKV'), ext: 'mkv', size: 3, kind: 'movie', folderName: 'Orphan (2019)' },
    { file: path.join(folder, 'Series', 'Lost Show', 'Season 02', 'Lost Show - S02E03.mp4'), ext: 'mp4', size: 4, kind: 'episode', seriesName: 'Lost Show', season: 2, episode: 3 },
  ]);
  const n = await sc.call('downloads.adopt', [
    { file: orphans[0].file, meta: { kind: 'movie', uid: 'p1:movie:orphan', url: `${P}/o.mp4`, title: 'Orphan', year: '2019' } },
    { file: orphans[1].file, meta: { kind: 'episode', uid: 'p1:ep:lost', url: `${P}/l.mp4`, seriesName: 'Lost Show', season: 2, episode: 3 } },
    { file: path.join(tmp, 'elsewhere.mp4'), meta: { kind: 'movie', uid: 'x', url: `${P}/x.mp4` } },
    { file: orphans[0].file, meta: { kind: 'movie', uid: 'p1:movie:orphan2', url: `${P}/o.mp4` } },
  ]);
  assert.strictEqual(n, 2);
  let s = await sc.call('downloads.list');
  const o = s.items.find((i) => i.uid === 'p1:movie:orphan');
  assert.deepStrictEqual([o.state, o.size, o.ext], ['done', 3, 'mkv']);
  assert.ok(o.addedAt === o.doneAt && o.addedAt > 0);
  assert.deepStrictEqual(await sc.call('downloads.orphans'), []);
  // the folder is moved (the drive unplugged…): the download is hidden, kept, and found again where it now is
  const moved = path.join(tmp, 'Moved');
  fs.renameSync(folder, moved);
  s = await sc.call('downloads.list');
  assert.ok(!s.items.some((i) => i.uid === 'p1:movie:orphan'), 'hidden while missing');
  assert.ok(savedList(tmp).items.some((i) => i.uid === 'p1:movie:orphan'), 'but kept');
  assert.strictEqual(await sc.call('downloads.setFolder', moved), moved);
  s = await sc.call('downloads.list');
  assert.deepStrictEqual(s.items.find((i) => i.uid === 'p1:movie:orphan').state, 'done');
  assert.strictEqual(savedList(tmp).items.find((i) => i.uid === 'p1:movie:orphan').file, path.join(moved, 'Movies', 'Orphan (2019)', 'Orphan (2019).MKV'));
  assert.strictEqual(await sc.call('downloads.setFolder', ''), moved);
  assert.strictEqual(await sc.call('downloads.ensureFolder'), moved);
});

test('folder sync: put and list carry the bytes exactly; bad names are refused', async () => {
  const syncDir = path.join(tmp, 'Cloud');
  const info = await sc.call('sync.info');
  assert.deepStrictEqual(Object.keys(info), ['host', 'folder']);
  assert.strictEqual(info.folder, '');
  assert.strictEqual(info.host, os.hostname().replace(/\.(local|lan|home)$/i, ''));
  const vault = 'ab'.repeat(32);
  await assert.rejects(sc.call('sync.folderList', vault), /No sync folder chosen/);
  assert.strictEqual(await sc.call('sync.setFolder', ''), '');
  assert.strictEqual(await sc.call('sync.setFolder', syncDir), syncDir);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'sync.json'), 'utf8'), JSON.stringify({ folder: syncDir }, null, 2));
  assert.strictEqual((await sc.call('sync.info')).folder, syncDir);
  const blob = require('crypto').randomBytes(2048);
  const when = await sc.call('sync.folderPut', vault, '0123456789abcdef', blob.toString('base64'));
  assert.match(when, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  await sc.call('sync.folderPut', vault, 'fedcba9876543210', Buffer.from('two').toString('base64'));
  fs.writeFileSync(path.join(syncDir, 'AG Horizon Sync', vault.slice(0, 16), 'README.txt'), 'not ours');
  const list = await sc.call('sync.folderList', vault);
  assert.deepStrictEqual(list.map((x) => x.device), ['0123456789abcdef', 'fedcba9876543210']);
  assert.deepStrictEqual(Object.keys(list[0]), ['device', 'updated', 'blob']);
  assert.ok(Buffer.from(list[0].blob, 'base64').equals(blob), 'the same bytes come back');
  assert.match(list[0].updated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  await assert.rejects(sc.call('sync.folderPut', '../../etc', '0123456789abcdef', ''), /Bad vault/);
  await assert.rejects(sc.call('sync.folderPut', vault, '../evil', ''), /Bad device/);
  await assert.rejects(sc.call('sync.folderList', 'AB'.repeat(32)), /Bad vault/);
  await sc.call('sync.folderRemove', vault, '0123456789abcdef');
  assert.deepStrictEqual((await sc.call('sync.folderList', vault)).map((x) => x.device), ['fedcba9876543210']);
  await sc.call('sync.folderRemove', vault, null);
  assert.ok(!fs.existsSync(path.join(syncDir, 'AG Horizon Sync', vault.slice(0, 16))));
  assert.deepStrictEqual(await sc.call('sync.folderList', vault), []);
  await assert.rejects(sc.call('downloads.nope'), /unknown command downloads\.nope/);
});

test('quit saves; a new start carries on with what was waiting', async () => {
  await sc.call('downloads.add', [film({ title: 'Later', q: 'slow=1&later' })]);
  await sc.until((x) => by(x, 'Later').state === 'downloading', 'Later downloading');
  const exited = new Promise((r) => sc.child.on('exit', r));
  assert.strictEqual(await sc.call('quit'), true);
  assert.strictEqual(await exited, 0);
  assert.strictEqual(savedList(tmp).items.find((x) => x.title === 'Later').state, 'queued');
  sc = startServer(tmp);
  port = await sc.ready;
  await sc.until((x) => by(x, 'Later').state === 'done', 'Later after the restart', 30000);
  // closing stdin is a quit too
  const gone = new Promise((r) => sc.child.on('exit', r));
  sc.child.stdin.end();
  assert.strictEqual(await gone, 0);
});
