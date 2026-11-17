'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseXmltvTime, rewriteM3u8 } = require('../server');

test('guide times honour their time zone', () => {
  assert.strictEqual(parseXmltvTime('20261023203000 +0200'), Date.UTC(2026, 9, 23, 18, 30));
  assert.strictEqual(parseXmltvTime('20261023203000 -0130'), Date.UTC(2026, 9, 23, 22, 0));
  assert.strictEqual(parseXmltvTime('202610232030'), Date.UTC(2026, 9, 23, 20, 30));   // no seconds, no zone: UTC
  assert.strictEqual(parseXmltvTime('garbage'), null);
});

test('package.json names the GitHub repository the installed app updates from', () => {
  // electron/updater.js reads only "repository": electron-builder strips "build" from the installed app
  assert.match(require('../package.json').repository.url, /github\.com\/[^/]+\/[^/.]+/);
});

test('HLS playlists route segments and keys back through the proxy', () => {
  const out = rewriteM3u8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nseg1.ts\n\nhttps://cdn.example/seg2.ts', 'http://host.example/live/a/index.m3u8', 'VLC').split('\n');
  const prox = (u) => `/api/stream?url=${encodeURIComponent(u)}&ua=VLC`;
  assert.deepStrictEqual(out, [
    '#EXTM3U',
    `#EXT-X-KEY:METHOD=AES-128,URI="${prox('http://host.example/live/a/key.bin')}"`,
    prox('http://host.example/live/a/seg1.ts'),
    '',
    prox('https://cdn.example/seg2.ts'),
  ]);
});

test('the local server refuses requests from other websites (DNS rebinding, cross-site)', async (t) => {
  const http = require('http');
  const { start, server } = require('../server');
  const port = await start(0);
  t.after(() => server.close());
  const status = (headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/capabilities', headers }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  const self = `127.0.0.1:${port}`;
  assert.strictEqual(await status({ Host: self }), 200);
  assert.strictEqual(await status({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` }), 200);
  assert.strictEqual(await status({ Host: `evil.example:${port}` }), 403);                     // a rebound domain
  assert.strictEqual(await status({ Host: self, Origin: 'http://evil.example' }), 403);        // fetch from another site
  assert.strictEqual(await status({ Host: self, 'Sec-Fetch-Site': 'cross-site' }), 403);       // <img> / no-cors from another site
  assert.strictEqual(await status({ Host: self, Origin: 'null' }), 403);                       // sandboxed page or file://
});

test('the guide parses the same however the text is split into pieces', () => {
  const { xmltvParser } = require('../server');
  const xml = '<?xml version="1.0"?><tv>'
    + '<channel id="one.tv"><display-name>One HD</display-name><display-name>1</display-name></channel>'
    + '<channel id="two.tv"><display-name>Two &amp; Co</display-name></channel>'
    + '<programme start="20261023200000 +0000" stop="20261023210000 +0000" channel="one.tv"><title>Late</title><desc>B</desc></programme>'
    + '<programme start="20261023190000 +0000" stop="20261023200000 +0000" channel="one.tv"><title>News &amp; weather</title></programme>'
    + '<programme start="20261023190000 +0000" stop="20261023200000 +0000" channel="two.tv"><title><![CDATA[Film <3>]]></title></programme>'
    + '<programme start="20201023190000 +0000" stop="20201023200000 +0000" channel="two.tv"><title>Too old</title></programme>'
    + '</tv>';
  const from = Date.UTC(2026, 9, 23), to = Date.UTC(2026, 9, 24);
  const run = (size) => { const p = xmltvParser(from, to); for (let i = 0; i < xml.length; i += size) p.push(xml.slice(i, i + size)); const r = p.end(); delete r.parsedAt; return r; };
  const whole = run(xml.length);
  assert.deepStrictEqual(whole.chNames, { 'one.tv': ['onehd', '1'], 'two.tv': ['twoco'] });
  assert.deepStrictEqual(whole.programmes['one.tv'].map((x) => x[2]), ['News & weather', 'Late']);   // sorted by start
  assert.deepStrictEqual(whole.programmes['two.tv'].map((x) => x[2]), ['Film <3>']);
  assert.strictEqual(whole.count, 3);
  for (const size of [1, 7, 50, 333]) assert.deepStrictEqual(run(size), whole, `pieces of ${size}`);

  assert.throws(() => { const p = xmltvParser(from, to); p.push('<html>not a guide</html>'); p.end(); }, /did not return an XMLTV guide/);
});

test('two requests for the same guide at once download it once', async (t) => {
  const http = require('http');
  const zlib = require('zlib');
  const { start, server } = require('../server');
  let hits = 0;
  const guide = zlib.gzipSync('<tv><channel id="a"><display-name>A</display-name></channel></tv>');
  const files = http.createServer((req, res) => { hits++; setTimeout(() => res.end(guide), 50); }).listen(0, '127.0.0.1');
  await new Promise((r) => files.once('listening', r));
  const port = await start(0);
  t.after(() => { server.close(); files.close(); });
  const ask = () => fetch(`http://127.0.0.1:${port}/api/epg`, { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${files.address().port}/same.xml.gz`, ids: ['a'] }) }).then((r) => r.status);
  assert.deepStrictEqual(await Promise.all([ask(), ask()]), [200, 200]);
  assert.strictEqual(hits, 1);
});

test('every page script parses', () => {
  // the page scripts run only in the app window, so nothing else would notice a syntax error in them
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const dirs = [path.join(__dirname, '..', 'public'), path.join(__dirname, '..', 'public', 'js')];
  const files = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));
  assert.ok(files.length > 5);
  for (const f of files) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }), f);
});

test('sound tracks are read from ffmpeg’s stream list', () => {
  const { parseAudioStreams } = require('../server');
  const out = parseAudioStreams(`Input #0, mpegts, from 'http://x/live.ts':
  Duration: N/A, start: 1.400000, bitrate: N/A
  Program 1
    Metadata:
      service_name    : News
    Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p, 1920x1080, 25 fps
    Stream #0:1[0x101](nor): Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp, 125 kb/s
    Stream #0:2[0x102](eng): Audio: ac3 ([129][0][0][0] / 0x0081), 48000 Hz, 5.1(side), fltp, 384 kb/s (default)
  Program 2
    Stream #0:1[0x101](nor): Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp, 125 kb/s
  Stream #0:3(swe): Audio: eac3, 48000 Hz, 6 channels, fltp, 640 kb/s (comment)
    Metadata:
      title           : Director's commentary
  Stream #0:4: Audio: mp2, 48000 Hz, mono, s16p, 64 kb/s (visual impaired)
  Stream #0:5(nor): Subtitle: dvb_subtitle ([6][0][0][0] / 0x0006)
    Metadata:
      title           : Not a sound track
`);
  assert.deepStrictEqual(out.map((a) => [a.index, a.lang, a.codec, a.channels, a.default, a.comment, a.descr, a.title]), [
    [0, 'nor', 'aac', 'Stereo', false, false, false, ''],
    [1, 'eng', 'ac3', '5.1', true, false, false, ''],
    [2, 'swe', 'eac3', '5.1', false, true, false, "Director's commentary"],
    [3, 'und', 'mp2', 'Mono', false, false, true, ''],
  ]);
  assert.deepStrictEqual(parseAudioStreams('Stream #0:0: Video: h264, yuv420p, 320x180'), []);
  // Windows line ends
  assert.strictEqual(parseAudioStreams('  Stream #0:1(fin): Audio: aac, 44100 Hz, stereo, fltp\r\n')[0].lang, 'fin');
});

// an MPEG-TS packet carrying one PSI section (the parser doesn't check CRCs: zeros will do)
function tsPacket(pid, section) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47; p[1] = 0x40 | (pid >> 8); p[2] = pid & 0xff; p[3] = 0x10; p[4] = 0;
  Buffer.from(section).copy(p, 5);
  return p;
}
function psiSection(tableId, body) {   // body: everything after section_length, without the CRC
  const len = body.length + 4;
  return [tableId, 0xb0 | (len >> 8), len & 0xff, ...body, 0, 0, 0, 0];
}
const es = (type, pid, descriptors = []) => [type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0 | (descriptors.length >> 8), descriptors.length & 0xff, ...descriptors];
const lang = (code, audioType = 0) => [0x0a, 4, ...Buffer.from(code), audioType];

test('the sound tracks of a live MPEG-TS stream are read as it passes through', () => {
  const { tsSniffer } = require('../server');
  const pat = psiSection(0x00, [0, 1, 0xc1, 0, 0, /* program 1 -> PMT 0x1000 */ 0, 1, 0xf0, 0x00]);
  const pmt = psiSection(0x02, [0, 1, 0xc1, 0, 0, 0xe1, 0x00, 0xf0, 0x00,
    ...es(0x24, 0x100),                                         // HEVC video
    ...es(0x0f, 0x101, lang('nor')),                            // AAC, Norwegian
    ...es(0x06, 0x102, [...lang('eng'), 0x6a, 1, 0]),           // AC-3 (private data + AC-3 descriptor)
    ...es(0x06, 0x103, [...lang('swe', 3), 0x05, 4, ...Buffer.from('EAC3')]),   // E-AC-3, audio description
    ...es(0x06, 0x104, [...lang('nor'), 0x59, 8, 0, 0, 0, 0, 0, 0, 0, 0]),      // DVB subtitles: not sound
    ...es(0x81, 0x105),                                         // ATSC AC-3, no language
  ]);
  // starts in the middle of a packet, and arrives in small pieces
  const stream = Buffer.concat([Buffer.from([1, 2, 3, 0x47, 9]), tsPacket(0x11, []), tsPacket(0, pat), tsPacket(0x100, []), tsPacket(0x1000, pmt), tsPacket(0x100, [])]);
  const sniff = tsSniffer();
  let out = null;
  for (let i = 0; i < stream.length && out === null; i += 50) out = sniff(stream.subarray(i, i + 50));
  assert.strictEqual(out.video, 'hevc');
  assert.deepStrictEqual(out.audios.map((a) => [a.index, a.pid, a.lang, a.codec, a.descr]), [
    [0, 0x101, 'nor', 'aac', false],
    [1, 0x102, 'eng', 'ac3', false],
    [2, 0x103, 'swe', 'eac3', true],
    [3, 0x105, 'und', 'ac3', false],
  ]);
  // not MPEG-TS (an MP4, say): gives up after a little
  const mp4 = tsSniffer();
  let r = null;
  for (let i = 0; i < 100 && r === null; i++) r = mp4(Buffer.alloc(4096, 0x20));
  assert.strictEqual(r, false);
});

test('HLS playlists pass the channel’s address on to their segments', () => {
  const out = rewriteM3u8('#EXTM3U\nseg1.ts\n', 'http://x/live/a.m3u8', '', 'http://x/live/a.m3u8');
  assert.match(out, /\/api\/stream\?url=http%3A%2F%2Fx%2Flive%2Fseg1\.ts&src=http%3A%2F%2Fx%2Flive%2Fa\.m3u8/);
});

// a raw request to the local server: also paths fetch() would clean up ("//"), and a time limit, so a request
// that is never answered fails the test instead of hanging it
function rawRequest(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (r) => {
      let text = '';
      r.setEncoding('utf8');
      r.on('data', (d) => { text += d; });
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, text }));
    });
    req.setTimeout(3000, () => req.destroy(new Error(`no answer to ${method} ${JSON.stringify(pathname)}`)));
    req.on('error', reject);
    req.end(body);
  });
}

test('an empty download is answered, not read with a stream that cannot start', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { start, server, setLocalFiles } = require('../server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-empty-'));
  const file = path.join(dir, 'film.mp4');
  fs.writeFileSync(file, '');   // a provider that answered 200 with no body
  setLocalFiles((id) => (id === 'abcdef0123' ? file : null));
  const port = await start(0);
  t.after(() => { server.close(); setLocalFiles(null); fs.rmSync(dir, { recursive: true, force: true }); });

  const whole = await rawRequest(port, '/api/local/abcdef0123');
  assert.strictEqual(whole.status, 200);
  assert.strictEqual(whole.headers['content-length'], '0');
  assert.strictEqual(whole.text, '');
  assert.strictEqual((await rawRequest(port, '/api/local/abcdef0123', { method: 'HEAD' })).status, 200);
  const ranged = await rawRequest(port, '/api/local/abcdef0123', { headers: { Range: 'bytes=0-' } });   // what <video> asks for
  assert.strictEqual(ranged.status, 416);
  assert.strictEqual(ranged.headers['content-range'], 'bytes */0');
  // and the server is still there
  assert.strictEqual((await rawRequest(port, '/api/capabilities')).status, 200);
});

test('a request path that cannot be read gets 400, and only from this computer', async (t) => {
  const { start, server } = require('../server');
  const port = await start(0);
  t.after(() => server.close());
  assert.strictEqual((await rawRequest(port, '//')).status, 400);              // new URL() can't parse it
  assert.strictEqual((await rawRequest(port, '/%00')).status, 400);            // a null byte in a file name
  assert.strictEqual((await rawRequest(port, '/js/a%00.js')).status, 400);
  assert.strictEqual((await rawRequest(port, '//', { headers: { Host: 'evil.example' } })).status, 403);   // other sites first get no further
  assert.strictEqual((await rawRequest(port, '/')).status, 200);
});

test('a request body that is not a JSON object is the caller’s mistake (400), not the provider’s', async (t) => {
  const { start, server } = require('../server');
  const port = await start(0);
  t.after(() => server.close());
  for (const route of ['/api/epg', '/api/subs/login', '/api/subs/search', '/api/subs/download']) {
    for (const body of ['not json', '{"url":', 'null', '"text"', '42']) {
      const r = await rawRequest(port, route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.strictEqual(r.status, 400, `${route} with ${body}: ${r.text}`);
      assert.doesNotMatch(r.text, /Unexpected token|Unexpected end|Cannot read prop/, `${route} with ${body}`);
    }
  }
});

test('a guide that was just downloaded again is the newest in the cache, not the next one thrown out', async (t) => {
  const http = require('http');
  const zlib = require('zlib');
  const { start, server } = require('../server');
  const hits = {};
  const guide = zlib.gzipSync('<tv><channel id="a"><display-name>A</display-name></channel></tv>');
  const files = http.createServer((req, res) => { hits[req.url] = (hits[req.url] || 0) + 1; res.end(guide); }).listen(0, '127.0.0.1');
  await new Promise((r) => files.once('listening', r));
  const port = await start(0);
  t.after(() => { server.close(); files.close(); });
  const ask = async (name, force = false) => {
    const r = await rawRequest(port, '/api/epg', { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${files.address().port}/cache-${name}.xml.gz`, ids: ['a'], force }) });
    assert.strictEqual(r.status, 200, r.text);
  };
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) await ask(n);   // the cache keeps six guides
  await ask('a', true);   // refreshed: a is now the newest
  await ask('g');         // a seventh: the oldest (b) goes
  await ask('a');
  assert.strictEqual(hits['/cache-a.xml.gz'], 2, 'the refreshed guide came from the cache');
  await ask('b');
  assert.strictEqual(hits['/cache-b.xml.gz'], 2, 'the oldest guide was the one thrown out');
});
