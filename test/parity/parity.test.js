'use strict';
/*
 * The local server's HTTP API, tested from the outside (MIGRATION_PLAN.md Phase 8): the same tests run against
 * server.js and against its Rust port (server-rs/), so the page can't tell them apart.
 *   AGH_PARITY_SERVER=node (default; part of `npm test`)   sidecar/entry.js, i.e. server.js
 *   AGH_PARITY_SERVER=rust                                  server-rs/target/release/aghorizon-server-rs[.exe]
 * A fake provider on 127.0.0.1 serves playlists, guides, HLS and MPEG-TS. Routes the Rust server doesn't have yet
 * are not tested here.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const KIND = process.env.AGH_PARITY_SERVER || 'node';
const root = path.join(__dirname, '..', '..');
const RUST = path.join(root, 'server-rs', 'target', 'release', `aghorizon-server-rs${process.platform === 'win32' ? '.exe' : ''}`);

/* ───────────── a fake provider ───────────── */

// MPEG-TS: a PAT, a PMT (H.264; AC-3 "eng"; AC-3 as private data "nor" for the visually impaired; AAC "swe"),
// then filler packets
function packet(pid, payload, start = true) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47; p[1] = (start ? 0x40 : 0) | (pid >> 8); p[2] = pid & 0xff; p[3] = 0x10;
  payload.copy(p, 4);
  return p;
}
function section(tableId, body) {   // body: from after section_length to before the CRC
  const len = body.length + 4;
  return Buffer.concat([Buffer.from([0, tableId, 0xb0 | (len >> 8), len & 0xff]), body, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);   // pointer 0 first
}
function tsFixture() {
  const pat = section(0x00, Buffer.from([0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00]));   // program 1 -> PMT PID 0x1000
  const es = (type, pid, desc) => Buffer.concat([Buffer.from([type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0 | (desc.length >> 8), desc.length & 0xff]), desc]);
  const lang = (code, kind) => Buffer.from([0x0a, 4, ...Buffer.from(code, 'latin1'), kind]);
  const pmt = section(0x02, Buffer.concat([
    Buffer.from([0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00]),   // program 1, PCR PID 0x100, no program info
    es(0x1b, 0x100, Buffer.alloc(0)),
    es(0x81, 0x101, lang('eng', 0)),
    es(0x06, 0x102, Buffer.concat([Buffer.from([0x6a, 1, 0x00]), lang('NOR', 3)])),
    es(0x0f, 0x103, lang('swe', 0)),
  ]));
  const filler = Array.from({ length: 40 }, () => packet(0x1fff, Buffer.alloc(0), false));
  return Buffer.concat([packet(0, pat), packet(0x1000, pmt), ...filler]);
}

const xt = (d) => {   // XMLTV time, UTC
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
};
function guide() {
  const now = Date.now();
  const at = (h) => xt(new Date(now + h * 3600e3));
  return `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="parity">
  <channel id="nrk1.no"><display-name>NRK1 HD</display-name><display-name lang="no">NRK 1</display-name></channel>
  <channel id='tv2.no'><display-name>TV 2 &amp; Co</display-name></channel>
  <channel id="123"><display-name>Numbered</display-name></channel>
  <channel id="other"><display-name>NRK1 HD</display-name></channel>
  <programme start="${at(1)}" stop="${at(2)}" channel="nrk1.no"><title lang="no">Second</title><desc>${'x'.repeat(500)}</desc></programme>
  <programme start="${at(0)}" stop="${at(1)}" channel="nrk1.no"><title><![CDATA[First & foremost]]></title></programme>
  <programme start="${at(0)}" stop="${at(1)}" channel="tv2.no"><title>Nyheter &#xe6;&#248;&#229; &amp;amp; &bogus;</title><desc>  spaced  </desc></programme>
  <programme start="${at(0)}" stop="${at(1)}" channel="other"><title>Other</title></programme>
  <programme start="${at(0)}" stop="${at(1)}" channel="123"><title>Numbered show</title></programme>
  <programme start="${at(-10)}" stop="${at(-9)}" channel="nrk1.no"><title>Too old</title></programme>
  <programme start="${at(48)}" stop="${at(49)}" channel="nrk1.no"><title>Too far ahead</title></programme>
  <programme start="garbage" stop="${at(1)}" channel="nrk1.no"><title>Bad time</title></programme>
  <programme start="${at(0)}" stop="${at(1)}"><title>No channel</title></programme>
</tv>`;
}

const ts = tsFixture();
function provider() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (status, body, headers = {}) => { res.writeHead(status, headers); res.end(body); };
    switch (u.pathname) {
      case '/plain.m3u': return send(200, '#EXTM3U\n#EXTINF:-1,One\nhttp://x/1.ts\n', { 'Content-Type': 'application/octet-stream' });
      case '/gz': return send(200, zlib.gzipSync('gzipped playlist ✓'), { 'Content-Type': 'application/octet-stream' });
      case '/ua': return send(200, `ua=${req.headers['user-agent']}|accept=${req.headers.accept}|range=${req.headers.range || ''}`, { 'Content-Type': 'text/plain' });
      case '/status': return send(Number(u.searchParams.get('s')), 'nope');
      case '/guide.xml': return send(200, guide(), { 'Content-Type': 'application/xml' });
      case '/guide.xml.gz': return send(200, zlib.gzipSync(guide()), { 'Content-Type': 'application/octet-stream' });
      case '/notguide': return send(200, '<html><body>login</body></html>', { 'Content-Type': 'text/html' });
      case '/hls/index.m3u8': return send(200, '#EXTM3U\r\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1\r\n#EXTINF:6,\r\nseg1.ts\r\n\r\n  https://cdn.example/seg2.ts?a=1&b=2  \r\n#EXT-X-MAP:URI="data:text/plain,x"\r\n../up.ts', { 'Content-Type': 'application/vnd.apple.mpegurl' });
      case '/redirect': res.writeHead(302, { Location: '/hls/index.m3u8' }); return res.end();
      case '/m3u-as-text': return send(200, '#EXTM3U\nchunk.ts', { 'Content-Type': 'text/plain; charset=utf-8' });
      case '/note.txt': return send(200, 'just text ✓', { 'Content-Type': 'text/plain; charset=utf-8' });
      case '/live.ts': return send(200, ts, { 'Content-Type': 'video/mp2t' });
      case '/seg.ts': return send(200, ts, { 'Content-Type': 'video/mp2t' });
      case '/film.mp4': {
        const body = Buffer.from('0123456789abcdefghij');
        const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        if (!r) return send(200, body, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': body.length });
        const a = Number(r[1]), b = r[2] ? Number(r[2]) : body.length - 1;
        return send(206, body.subarray(a, b + 1), { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${body.length}`, 'Content-Length': b - a + 1 });
      }
      default: return send(404, 'no such thing');
    }
  });
}

/* ───────────── the server under test ───────────── */

let srv, prov, port, P, pub;

function startServer(env) {
  const [cmd, args] = KIND === 'rust' ? [RUST, ['0']] : [process.execPath, [path.join(root, 'sidecar', 'entry.js'), '0']];
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /READY (\d+)/.exec(out);
      if (m) resolve({ child, port: Number(m[1]) });
      if (/ERROR/.test(out)) reject(new Error(out));
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
}

test.before(async () => {
  pub = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-parity-'));
  fs.mkdirSync(path.join(pub, 'public', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'public', 'index.html'), '<!doctype html><title>parity</title>');
  fs.writeFileSync(path.join(pub, 'public', 'style.css'), 'body{}');
  fs.writeFileSync(path.join(pub, 'public', 'sub', 'a b.js'), 'x=1');
  fs.writeFileSync(path.join(pub, 'public', 'data.bin'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(pub, 'secret.txt'), 'outside');
  prov = provider();
  await new Promise((r) => prov.listen(0, '127.0.0.1', r));
  P = `http://127.0.0.1:${prov.address().port}`;
  const s = await startServer({
    PUBLIC_DIR: path.join(pub, 'public'), FFMPEG_PATH: path.join(pub, 'no-ffmpeg'),
    OPENSUBTITLES_API_KEY: 'parity-os', TMDB_API_KEY: '', AGH_DATA_DIR: '',
  });
  srv = s.child; port = s.port;
});
test.after(() => { if (srv) srv.kill(); if (prov) prov.close(); fs.rmSync(pub, { recursive: true, force: true }); });

// a raw request (so Host, Origin and odd paths go out exactly as written)
function req(pathAndQuery, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const h = { Host: `127.0.0.1:${port}`, Connection: 'close', ...headers };
    if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
    const head = `${method} ${pathAndQuery} HTTP/1.1\r\n${Object.entries(h).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
    sock.write(head);
    if (body !== undefined) sock.write(body);
    const chunks = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('error', reject);
    sock.on('end', () => {
      const raw = Buffer.concat(chunks);
      const sep = raw.indexOf('\r\n\r\n');
      const lines = raw.subarray(0, sep).toString('latin1').split('\r\n');
      const status = Number(lines[0].split(' ')[1]);
      const hd = {};
      for (const l of lines.slice(1)) { const i = l.indexOf(':'); hd[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
      let b = raw.subarray(sep + 4);
      if (/chunked/i.test(hd['transfer-encoding'] || '')) {   // de-chunk
        const out = []; let o = 0;
        for (;;) { const e = b.indexOf('\r\n', o); const n = parseInt(b.subarray(o, e).toString(), 16); if (!n) break; out.push(b.subarray(e + 2, e + 2 + n)); o = e + 2 + n + 2; }
        b = Buffer.concat(out);
      }
      resolve({ status, headers: hd, body: b, text: b.toString('utf8'), json: () => JSON.parse(b.toString('utf8')) });
    });
  });
}
const q = (u, extra = '') => `/api/stream?url=${encodeURIComponent(u)}${extra}`;
const epg = (body) => req('/api/epg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/* ───────────── the guard ───────────── */

test('only the app itself may use the server', async () => {
  const st = async (headers) => (await req('/api/capabilities', { headers })).status;
  assert.strictEqual(await st({}), 200);
  assert.strictEqual(await st({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` }), 200);
  assert.strictEqual(await st({ Host: 'localhost' }), 200);
  assert.strictEqual(await st({ 'Sec-Fetch-Site': 'same-origin' }), 200);
  assert.strictEqual(await st({ 'Sec-Fetch-Site': 'none' }), 200);
  assert.strictEqual(await st({ Host: `evil.example:${port}` }), 403);   // DNS rebinding
  assert.strictEqual(await st({ Host: '127.0.0.2' }), 403);
  assert.strictEqual(await st({ Origin: 'http://evil.example' }), 403);
  assert.strictEqual(await st({ Origin: `http://localhost:${port}` }), 403);   // a different host than the Host header
  assert.strictEqual(await st({ Origin: 'null' }), 403);
  assert.strictEqual(await st({ 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.strictEqual(await st({ 'Sec-Fetch-Site': 'same-site' }), 403);
  const r = await req('/', { headers: { Host: 'evil.example' } });
  assert.strictEqual(r.text, 'Forbidden');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
});

/* ───────────── static files ───────────── */

test('static files: types, index, missing, outside the folder', async () => {
  let r = await req('/');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.strictEqual(r.headers['cache-control'], 'no-cache');
  assert.strictEqual(r.headers['content-length'], String(r.body.length));
  assert.strictEqual(r.text, '<!doctype html><title>parity</title>');
  assert.strictEqual((await req('/style.css')).headers['content-type'], 'text/css; charset=utf-8');
  assert.strictEqual((await req('/data.bin')).headers['content-type'], 'application/octet-stream');
  r = await req('/sub/a%20b.js');
  assert.deepStrictEqual([r.status, r.headers['content-type'], r.text], [200, 'text/javascript; charset=utf-8', 'x=1']);
  r = await req('/nope.html');
  assert.deepStrictEqual([r.status, r.text, r.headers['cache-control']], [404, 'Not found', 'no-store']);
  assert.strictEqual((await req('/sub')).status, 404);                     // a folder
  assert.strictEqual((await req('/../secret.txt')).status, 404);            // dot segments go before the folder is chosen
  assert.strictEqual((await req('/sub/../../secret.txt')).status, 404);
  assert.strictEqual((await req('/%2e%2e/secret.txt')).status, 404);        // WHATWG URL parsing reads %2e%2e as .. too
  assert.strictEqual((await req('/..%2fsecret.txt')).status, 403);           // …but an encoded slash gets past it: caught here
  assert.strictEqual((await req('/sub/..%2f..%2fsecret.txt')).status, 403);
  assert.strictEqual((await req('/sub/..%2fstyle.css')).status, 200);        // inside the folder after all
  assert.strictEqual((await req('/%00')).status, 400);
  assert.strictEqual((await req('/%E0%A4%A')).status, 400);                 // not valid percent-encoding / UTF-8
  assert.strictEqual((await req('/index.html', { method: 'POST', body: '' })).status, 200);   // any method
});

/* ───────────── capabilities, unknown routes ───────────── */

test('capabilities, and what isn\'t there', async () => {
  const r = await req('/api/capabilities');
  assert.strictEqual(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepStrictEqual(r.json(), { ffmpeg: false, opensubtitles: true, tmdb: false });
  for (const [m, p] of [['GET', '/api/nothing'], ['POST', '/api/fetch'], ['GET', '/api/epg'], ['POST', '/api/capabilities']]) {
    const x = await req(p, { method: m, body: m === 'POST' ? '{}' : undefined });
    assert.deepStrictEqual([x.status, x.text], [404, 'Not found'], `${m} ${p}`);
  }
});

/* ───────────── /api/fetch ───────────── */

test('fetch: playlists, gzip, the player\'s user agent, errors', async () => {
  let r = await req(`/api/fetch?url=${encodeURIComponent(`${P}/plain.m3u`)}`);
  assert.deepStrictEqual([r.status, r.headers['content-type'], r.headers['cache-control'], r.text], [200, 'text/plain; charset=utf-8', 'no-store', '#EXTM3U\n#EXTINF:-1,One\nhttp://x/1.ts\n']);
  assert.strictEqual((await req(`/api/fetch?url=${encodeURIComponent(`${P}/gz`)}`)).text, 'gzipped playlist ✓');
  assert.strictEqual((await req(`/api/fetch?url=${encodeURIComponent(`${P}/ua`)}`)).text, 'ua=VLC/3.0.20 LibVLC/3.0.20|accept=*/*|range=');
  assert.strictEqual((await req(`/api/fetch?url=${encodeURIComponent(`${P}/ua`)}&ua=Kodi+19`)).text, 'ua=Kodi 19|accept=*/*|range=');
  const err = async (u, status, message) => {
    const x = await req(`/api/fetch?url=${encodeURIComponent(u)}`);
    assert.deepStrictEqual([x.status, x.json()], [status, { error: message }], u);
    assert.strictEqual(x.headers['content-type'], 'application/json; charset=utf-8');
  };
  await err(`${P}/status?s=403`, 403, 'Provider answered HTTP 403');
  await err(`${P}/status?s=401`, 401, 'Provider answered HTTP 401');
  await err(`${P}/status?s=500`, 502, 'Provider answered HTTP 500');
  await err(`${P}/missing`, 502, 'Provider answered HTTP 404');
  await err('not a url', 400, 'Invalid URL');
  await err('ftp://example.com/x', 400, 'Only http(s) URLs are supported');
  await err('file:///etc/passwd', 400, 'Only http(s) URLs are supported');
  const closed = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  await err(`http://127.0.0.1:${closed}/x`, 502, 'Connection refused – check the server address and port');
  await err('http://no-such-host.invalid/x', 502, 'Host not found – check the server address');
  const none = await req('/api/fetch');
  assert.deepStrictEqual([none.status, none.json()], [400, { error: 'Invalid URL' }]);
});

/* ───────────── /api/epg ───────────── */

test('guide: channels by id or name, the time window, decoding, gzip', async () => {
  for (const file of ['guide.xml', 'guide.xml.gz']) {
    const r = await epg({ url: `${P}/${file}`, ids: ['NRK1.NO', '123'], names: ['tv2co', 'nrk1hd'], force: true });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.headers['content-type'], 'application/json; charset=utf-8');
    const j = r.json();
    assert.deepStrictEqual(Object.keys(j).sort(), ['byName', 'parsedAt', 'programmes', 'totalChannels']);
    assert.strictEqual(j.totalChannels, 4);
    assert.ok(Math.abs(j.parsedAt - Date.now()) < 60000);
    assert.deepStrictEqual(Object.keys(j.programmes).sort(), ['123', 'nrk1.no', 'other', 'tv2.no']);
    // "nrk1hd" belongs to nrk1.no and to "other": the first in the object's order wins ("123" sorts first, then insertion)
    assert.deepStrictEqual(j.byName, { tv2co: 'tv2.no', nrk1hd: 'other' });
    const nrk = j.programmes['nrk1.no'];
    assert.deepStrictEqual(nrk.map((p) => p[2]), ['First & foremost', 'Second']);   // sorted by start
    assert.strictEqual(nrk[1][3], 'x'.repeat(400));
    assert.strictEqual(nrk[0][3], '');
    assert.ok(nrk[0][0] < nrk[1][0] && nrk[0][1] === nrk[1][0]);
    assert.deepStrictEqual(j.programmes['tv2.no'][0].slice(2), ['Nyheter æøå &amp; &bogus;', 'spaced']);
  }
  const none = (await epg({ url: `${P}/guide.xml`, ids: [], names: [] })).json();
  assert.deepStrictEqual([none.programmes, none.byName, none.totalChannels], [{}, {}, 4]);
});

test('guide: errors', async () => {
  const e = async (body, status, message, raw) => {
    const r = raw !== undefined ? await req('/api/epg', { method: 'POST', body: raw }) : await epg(body);
    assert.deepStrictEqual([r.status, r.json()], [status, { error: message }], JSON.stringify(body) + raw);
  };
  await e({}, 400, 'Missing guide URL');
  await e({ url: '' }, 400, 'Missing guide URL');
  await e(null, 400, 'The request body is not valid JSON', '{nope');
  await e(null, 400, 'Missing guide URL', '');
  await e(null, 400, 'The request body is not a JSON object', '"text"');
  await e(null, 400, 'The request body is not a JSON object', '12');
  await e({ url: `${P}/notguide`, force: true }, 502, 'That URL did not return an XMLTV guide');
  await e({ url: `${P}/status?s=500`, force: true }, 502, 'Guide download failed (HTTP 500)');
  await e({ url: 'ftp://x/y' }, 400, 'Only http(s) URLs are supported');
});

/* ───────────── /api/stream and /api/tracks ───────────── */

test('stream: HLS playlists are rewritten through the proxy', async () => {
  const base = `${P}/hls/index.m3u8`;
  const prox = (u, src = base) => `/api/stream?url=${encodeURIComponent(u)}&ua=Kodi&src=${encodeURIComponent(src)}`;
  const expected = [
    '#EXTM3U',
    `#EXT-X-KEY:METHOD=AES-128,URI="${prox(`${P}/hls/key.bin`)}",IV=0x1`,
    '#EXTINF:6,',
    prox(`${P}/hls/seg1.ts`),
    '',
    prox('https://cdn.example/seg2.ts?a=1&b=2'),
    '#EXT-X-MAP:URI="data:text/plain,x"',
    prox(`${P}/up.ts`),
  ].join('\n');
  let r = await req(q(base, '&ua=Kodi'));
  assert.deepStrictEqual([r.status, r.headers['content-type'], r.headers['cache-control']], [200, 'application/vnd.apple.mpegurl', 'no-store']);
  assert.strictEqual(r.text, expected);
  // redirected: relative addresses resolve against where the playlist really is; src stays the channel's address
  r = await req(q(`${P}/redirect`, '&ua=Kodi'));
  assert.strictEqual(r.text, expected.split(encodeURIComponent(base)).join(encodeURIComponent(`${P}/redirect`)));
  // a segment's own playlist keeps the channel as src
  r = await req(q(base, `&ua=Kodi&src=${encodeURIComponent('http://chan/1')}`));
  assert.ok(r.text.includes(`&src=${encodeURIComponent('http://chan/1')}`));
  // no ua: none added
  r = await req(q(`${P}/m3u-as-text`));
  assert.deepStrictEqual([r.headers['content-type'], r.text], ['application/vnd.apple.mpegurl', `#EXTM3U\n/api/stream?url=${encodeURIComponent(`${P}/chunk.ts`)}&src=${encodeURIComponent(`${P}/m3u-as-text`)}`]);
});

test('stream: text, bytes, ranges and errors pass through', async () => {
  let r = await req(q(`${P}/note.txt`));
  assert.deepStrictEqual([r.status, r.headers['content-type'], r.text], [200, 'text/plain; charset=utf-8', 'just text ✓']);
  r = await req(q(`${P}/film.mp4`));
  assert.deepStrictEqual([r.status, r.headers['content-type'], r.headers['accept-ranges'], r.headers['content-length'], r.headers['cache-control'], r.text],
    [200, 'video/mp4', 'bytes', '20', 'no-store', '0123456789abcdefghij']);
  r = await req(q(`${P}/film.mp4`), { headers: { Range: 'bytes=5-9' } });
  assert.deepStrictEqual([r.status, r.headers['content-range'], r.headers['content-length'], r.text], [206, 'bytes 5-9/20', '5', '56789']);
  r = await req(q(`${P}/ua`, '&ua=X'), { headers: { Range: 'bytes=0-' } });
  assert.strictEqual(r.text, 'ua=X|accept=*/*|range=bytes=0-');
  for (const [s, status] of [[404, 404], [500, 502], [403, 502]]) {
    r = await req(q(`${P}/status?s=${s}`));
    assert.deepStrictEqual([r.status, r.json()], [status, { error: `Stream answered HTTP ${s}` }]);
  }
  r = await req('/api/stream?url=nope');
  assert.deepStrictEqual([r.status, r.json()], [400, { error: 'Invalid URL' }]);
});

test('tracks: the sound tracks of an MPEG-TS stream, read as it passes', async () => {
  const live = `${P}/live.ts`;
  assert.deepStrictEqual((await req(`/api/tracks?url=${encodeURIComponent(live)}`)).json(), {});
  const r = await req(q(live));
  assert.strictEqual(r.body.length, ts.length);
  assert.ok(r.body.equals(ts));
  const audios = [
    { index: 0, pid: 0x101, lang: 'eng', codec: 'ac3', channels: '', title: '', default: false, comment: false, descr: false },
    { index: 1, pid: 0x102, lang: 'nor', codec: 'ac3', channels: '', title: '', default: false, comment: false, descr: true },
    { index: 2, pid: 0x103, lang: 'swe', codec: 'aac', channels: '', title: '', default: false, comment: false, descr: false },
  ];
  assert.deepStrictEqual((await req(`/api/tracks?url=${encodeURIComponent(live)}`)).json(), { video: 'h264', audios, hls: false });
  // an HLS segment: kept under its channel (src), marked hls
  await req(q(`${P}/seg.ts`, `&src=${encodeURIComponent('http://chan/9')}`));
  assert.deepStrictEqual((await req(`/api/tracks?url=${encodeURIComponent('http://chan/9')}`)).json(), { video: 'h264', audios, hls: true });
  // a Range request is not sniffed
  await req(q(`${P}/live.ts?r`), { headers: { Range: 'bytes=0-' } });
  assert.deepStrictEqual((await req(`/api/tracks?url=${encodeURIComponent(`${P}/live.ts?r`)}`)).json(), {});
});
