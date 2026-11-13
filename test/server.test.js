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
