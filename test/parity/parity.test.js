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
const FFMPEG = process.env.AGH_PARITY_FFMPEG || 'ffmpeg';   // both servers get the same one
const { spawnSync } = require('child_process');
const ff = (args) => { const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`); };

// The fixtures are made with ffmpeg and both servers run it. Without it, `npm test` skips this file; the parity
// workflow (AGH_PARITY_SERVER set) requires it.
if (spawnSync(FFMPEG, ['-version']).status !== 0) {
  if (process.env.AGH_PARITY_SERVER) throw new Error(`the parity suite needs ffmpeg (${FFMPEG}; set AGH_PARITY_FFMPEG)`);
  test('server parity suite', { skip: `needs ffmpeg (${FFMPEG} not found; set AGH_PARITY_FFMPEG)` }, () => {});
  return;
}

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
  <programme  start = '${at(2)}' stop='${at(3)}' xchannel="wrong" channel = 'tv2.no' ><title lang='no'>Quoted</title><desc lang="no">Søndag</desc></programme>
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
      case '/clip.mp4': {   // with Range, as real providers answer: ffmpeg seeks in it
        const body = fs.readFileSync(path.join(pub, 'clip.mp4'));
        const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        if (!r) return send(200, body, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': body.length });
        const a = Number(r[1]), b = r[2] ? Math.min(Number(r[2]), body.length - 1) : body.length - 1;
        if (a >= body.length) return send(416, '', { 'Content-Range': `bytes */${body.length}` });
        return send(206, body.subarray(a, b + 1), { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${body.length}`, 'Content-Length': b - a + 1 });
      }
      case '/trickle.ts': {   // a provider that sends its headers, then almost nothing: ffmpeg waits for it
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        const iv = setInterval(() => res.write(Buffer.alloc(1, 0x47)), 1000);
        res.on('close', () => clearInterval(iv));
        return undefined;
      }
      case '/dl/sub.srt': return send(200, '1\r\n00:00:01,000 --> 00:00:02,000\r\nFrom OpenSubtitles\r\n', { 'Content-Type': 'application/x-subrip' });
      case '/film.mp4': {
        const body = Buffer.from('0123456789abcdefghij');
        const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        if (!r) return send(200, body, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': body.length });
        const a = Number(r[1]), b = r[2] ? Number(r[2]) : body.length - 1;
        return send(206, body.subarray(a, b + 1), { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${body.length}`, 'Content-Length': b - a + 1 });
      }
      default:
        if (u.pathname.startsWith('/share/')) return shareLive(req, res, u);
        if (u.pathname.startsWith('/tmdb/')) return tmdb(req, res, u);
        if (u.pathname.startsWith('/os/')) return opensubs(req, res, u);
        return send(404, 'no such thing');
    }
  });
}

// a provider like the measured one, for /api/shared: each connection starts 8 s back, sends that at once, then goes
// on in real time. Every 40 ms of stream is one packet with the clock (PCR) and two with "video", each saying which
// channel and which 40 ms it belongs to (test/shared.test.js), so a stream can be checked byte for byte.
const STEP = 0.04;
function pcrPacket(pid, ch, n, k, pcrTicks) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47; p[1] = pid >> 8; p[2] = pid & 0xff;
  if (pcrTicks === undefined) p[3] = 0x10;
  else {
    p[3] = 0x20; p[4] = 183; p[5] = 0x10;
    const base = Math.floor(pcrTicks / 300), ext = pcrTicks % 300;
    p.writeUInt32BE(Math.floor(base / 2), 6);
    p[10] = ((base & 1) << 7) | 0x7e | (ext >> 8);
    p[11] = ext & 0xff;
  }
  p.writeUInt32BE(ch, 20); p.writeUInt32BE(n, 24); p[28] = k;
  return p;
}
const opening = (ch) => pcrPacket(0, ch, 0, 9);
const group = (ch, n) => Buffer.concat([pcrPacket(0x100, ch, n, 0, Math.round(n * STEP * 27e6)), pcrPacket(0x101, ch, n, 1), pcrPacket(0x101, ch, n, 2)]);
const groups = (ch, from, to) => Buffer.concat(Array.from({ length: to - from + 1 }, (_, i) => group(ch, from + i)));
const share = { epoch: Date.now(), open: 0, most: 0, connects: 0 };
function shareLive(req, res, u) {
  if (u.pathname === '/share/hls/1.ts') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n'); }
  const ch = Number(/(\d+)\.ts$/.exec(u.pathname)[1]);
  const onAir = () => Math.floor((Date.now() - share.epoch) / (STEP * 1000)) + 100000;
  share.most = Math.max(share.most, ++share.open);
  share.connects++;
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  let n = onAir() - 200;
  res.write(opening(ch));
  const send = () => { const to = onAir(); if (to >= n) { res.write(groups(ch, n, to)); n = to + 1; } };
  send();
  const iv = setInterval(send, 20);
  res.on('close', () => { clearInterval(iv); share.open--; });
}

// a fake TMDB (AGH_TMDB_BASE = <provider>/tmdb/3)
const hits = { tmdb: 0, trending: 0, os: [] };
function tmdb(req, res, u) {
  const json = (status, j) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (u.searchParams.get('api_key') !== 'parity-tmdb') return json(401, { status_message: 'Invalid API key' });
  const p = u.pathname.replace('/tmdb/3', '');
  if (p.startsWith('/trending/')) {
    hits.trending++;
    const [, , type] = p.split('/');
    const page = Number(u.searchParams.get('page'));
    const results = [
      { id: page * 10 + 1, title: `${type} ${page} a`, original_title: 'Orig', release_date: '2024-05-01', overview: 'Story', backdrop_path: '/b.jpg', name: 'ignored' },
      { id: page * 10 + 2, name: `${type} ${page} b`, original_name: 'Orig b', first_air_date: '2019-01-01', backdrop_path: null },
      { title: 'no id', release_date: 20240501 },
    ];
    return json(200, { page, results });
  }
  hits.tmdb++;
  if (p === '/movie/603') {
    assert.strictEqual(u.searchParams.get('append_to_response'), 'credits');
    return json(200, { runtime: 136, poster_path: '/m.jpg', credits: { cast: Array.from({ length: 14 }, (_, i) => ({ name: `Actor ${i}`, character: i === 1 ? '' : `Role ${i}`, profile_path: i === 2 ? null : `/p${i}.jpg` })) } });
  }
  if (p === '/tv/1399') {
    assert.strictEqual(u.searchParams.get('append_to_response'), 'aggregate_credits');
    return json(200, { episode_run_time: [], last_episode_to_air: { runtime: 58 }, aggregate_credits: { cast: [{ name: 'Sean', roles: [{ character: 'Ned' }], profile_path: '/s.jpg' }, { name: 'Nobody', roles: [] }] } });
  }
  if (p === '/movie/7') return json(200, { runtime: null });
  if (p === '/movie/500') return json(500, {});
  return json(404, { status_message: 'not found' });
}

// a fake OpenSubtitles (AGH_OPENSUBTITLES_BASE = <provider>/os/api/v1): passwords "pw"; the first token expires
// after one use, so a download logs in again
let osToken = 0;
const osUsed = new Set();
function opensubs(req, res, u) {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const json = (status, j) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    const p = u.pathname.replace('/os/api/v1', '');
    hits.os.push({ method: req.method, path: p + u.search, key: req.headers['api-key'], ua: req.headers['user-agent'], auth: req.headers.authorization || '', accept: req.headers.accept, ct: req.headers['content-type'] || '', body });
    if (req.headers['api-key'] !== 'parity-os') return json(403, { message: 'Bad key' });
    const authed = () => { const t = (req.headers.authorization || '').replace('Bearer ', ''); return t.startsWith('tok') && !osUsed.has(t); };
    if (p === '/login') {
      const b = JSON.parse(body);
      if (b.password !== 'pw') return json(401, { message: 'Wrong password' });
      return json(200, { token: `tok${++osToken}` });
    }
    if (p === '/infos/user') return authed() ? json(200, { data: { allowed_downloads: 20, remaining_downloads: 19, level: 'Sub leecher' } }) : json(401, {});
    if (p === '/subtitles') {
      if (u.searchParams.get('query') === 'broken') return json(500, { errors: ['one', 'two'] });
      return json(200, { data: [
        { attributes: { language: 'en', release: 'Clip.2024.1080p', download_count: 1234, hearing_impaired: true, from_trusted: true, files: [{ file_id: 11, file_name: 'a.srt' }] } },
        { attributes: { language: 'nb', download_count: 0, machine_translated: true, files: [{ file_id: 12, file_name: 'b.srt' }] } },
        { attributes: { language: 'sv', files: [] } },
        { attributes: { files: [{ file_id: 0 }] } },
      ] });
    }
    if (p === '/download') {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      if (!authed()) return json(401, { message: 'token expired' });
      if (t === 'tok1' || t === 'tok2') osUsed.add(t);   // the first tokens work once
      const b = JSON.parse(body);
      if (b.file_id === 99) return json(200, { message: 'quota reached' });
      return json(200, { link: `${P}/dl/sub.srt`, remaining: 18 });
    }
    return json(404, { message: 'no' });
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
  // a clip: H.264, two sound tracks (eng default; nor "Kommentar"), two text subtitles (eng; nor forced)
  const srt = (t) => `1\n00:00:01,000 --> 00:00:03,000\n${t}\n\n2\n00:00:04,000 --> 00:00:05,000\n${t} again\n`;
  fs.writeFileSync(path.join(pub, 'en.srt'), srt('Hello'));
  fs.writeFileSync(path.join(pub, 'no.srt'), srt('Hei'));
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-f', 'lavfi', '-i', 'sine=f=660:d=6',
    '-i', path.join(pub, 'en.srt'), '-i', path.join(pub, 'no.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3', '-map', '4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-c:s', 'mov_text',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=nor', '-metadata:s:a:1', 'title=Kommentar',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=nor', '-disposition:a:0', 'default', '-disposition:a:1', '0', '-disposition:s:1', 'forced',
    path.join(pub, 'clip.mp4')]);
  // downloads: <data>/downloads.json, as the downloads engine keeps it
  const dl = path.join(pub, 'Films');
  const film = path.join(dl, 'Movies', 'Clip (2024)');
  fs.mkdirSync(film, { recursive: true });
  fs.copyFileSync(path.join(pub, 'clip.mp4'), path.join(film, 'Clip (2024).mp4'));
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=64x96:d=1', '-frames:v', '1', path.join(film, 'poster.jpg')]);
  const other = path.join(dl, 'Movies', 'Other (2020)');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'Other (2020).mkv'), 'not really a film');
  for (const [name, text] of [['en', 'OS english'], ['eng', 'own english'], ['nob.forced', 'tvungen'], ['fr', 'français'], ['en.2', 'OS english 2'], ['de', null]]) {
    fs.writeFileSync(path.join(other, `Other (2020).${name}.srt`), text === null ? Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nGr\xfc\xdfe {\\an8}<font color="red">rot</font>\r\n', 'latin1') : srt(text));
  }
  fs.writeFileSync(path.join(other, 'Other (2020).en.txt'), 'not a subtitle');
  fs.writeFileSync(path.join(dl, 'empty.mp4'), '');
  const data = path.join(pub, 'data');
  fs.mkdirSync(data);
  const item = (id, file, state = 'done', posterFile = '') => ({ id, uid: `x:movie:${id}`, kind: 'movie', title: id, url: 'http://x/y', file, posterFile, state, size: 0, got: 0 });
  fs.writeFileSync(path.join(data, 'downloads.json'), JSON.stringify({ folder: dl, pauseWhileWatching: false, items: [
    item('aaaaaaaa', path.join(film, 'Clip (2024).mp4'), 'done', path.join(film, 'poster.jpg')),
    item('bbbbbbbb', path.join(other, 'Other (2020).mkv')),
    item('cccccccc', path.join(dl, 'gone.mp4')),
    item('dddddddd', path.join(dl, 'empty.mp4')),
    item('eeeeeeee', path.join(film, 'Clip (2024).mp4'), 'paused'),
  ] }));
  const tc = path.join(os.tmpdir(), 'ag-horizon-subs');
  fs.mkdirSync(tc, { recursive: true });
  fs.writeFileSync(path.join(tc, 'parity0001.0.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{\\an8}<font face="x">So far</font>\n');
  prov = provider();
  await new Promise((r) => prov.listen(0, '127.0.0.1', r));
  P = `http://127.0.0.1:${prov.address().port}`;
  const s = await startServer({
    PUBLIC_DIR: path.join(pub, 'public'), FFMPEG_PATH: FFMPEG,
    OPENSUBTITLES_API_KEY: 'parity-os', TMDB_API_KEY: 'parity-tmdb',
    AGH_TMDB_BASE: `${P}/tmdb/3`, AGH_OPENSUBTITLES_BASE: `${P}/os/api/v1`,
    AGH_DATA_DIR: path.join(pub, 'data'), AGH_DOCUMENTS_DIR: pub,
    AGH_SHARE_REVISIT: '0.4',   // the real 3 s would make the sharing test take half a minute
  });
  srv = s.child; port = s.port;
});
test.after(() => {
  if (srv) srv.kill();
  if (prov) prov.close();
  fs.rmSync(pub, { recursive: true, force: true });
  const tc = path.join(os.tmpdir(), 'ag-horizon-subs');
  for (const f of fs.readdirSync(tc).filter((n) => n.startsWith('parity'))) fs.rmSync(path.join(tc, f), { force: true });
});

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
  assert.deepStrictEqual(r.json(), { ffmpeg: true, opensubtitles: true, tmdb: true });
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
    // single quotes, spaces around =, and an attribute that only ends in "channel"
    assert.deepStrictEqual(j.programmes['tv2.no'][1].slice(2), ['Quoted', 'Søndag']);
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

/* ───────────── /api/local: finished downloads ───────────── */

test('local: a download plays with Range and HEAD, and only by its id', async () => {
  const size = fs.statSync(path.join(pub, 'clip.mp4')).size;
  let r = await req('/api/local/aaaaaaaa');
  assert.deepStrictEqual([r.status, r.headers['content-type'], r.headers['content-length'], r.headers['accept-ranges'], r.headers['cache-control'], r.body.length],
    [200, 'video/mp4', String(size), 'bytes', 'no-store', size]);
  assert.ok(r.body.equals(fs.readFileSync(path.join(pub, 'clip.mp4'))));
  r = await req('/api/local/aaaaaaaa', { method: 'HEAD' });
  assert.deepStrictEqual([r.status, r.headers['content-length'], r.body.length], [200, String(size), 0]);
  const range = async (h) => { const x = await req('/api/local/aaaaaaaa', { headers: { Range: h } }); return [x.status, x.headers['content-range'], x.headers['content-length'], x.body.length]; };
  assert.deepStrictEqual(await range('bytes=5-9'), [206, `bytes 5-9/${size}`, '5', 5]);
  assert.deepStrictEqual(await range('bytes=-10'), [206, `bytes ${size - 10}-${size - 1}/${size}`, '10', 10]);
  assert.deepStrictEqual(await range(`bytes=${size - 3}-`), [206, `bytes ${size - 3}-${size - 1}/${size}`, '3', 3]);
  assert.deepStrictEqual(await range(`bytes=0-${size + 100}`), [206, `bytes 0-${size - 1}/${size}`, String(size), size]);
  assert.deepStrictEqual((await range(`bytes=${size}-`)).filter((_, i) => i !== 2), [416, `bytes */${size}`, 0]);   // Content-Length: Node leaves it out, Rust says 0
  assert.deepStrictEqual(await range('bytes=-'), [200, undefined, String(size), size]);
  assert.deepStrictEqual(await range('items=0-1'), [200, undefined, String(size), size]);
  r = await req('/api/local/aaaaaaaa', { method: 'HEAD', headers: { Range: 'bytes=0-1' } });
  assert.deepStrictEqual([r.status, r.headers['content-length'], r.body.length], [206, '2', 0]);
  r = await req('/api/local/aaaaaaaa/poster');
  assert.deepStrictEqual([r.status, r.headers['content-type']], [200, 'image/jpeg']);
  r = await req('/api/local/dddddddd');
  assert.deepStrictEqual([r.status, r.headers['content-length'], r.headers['content-type'], r.body.length], [200, '0', 'video/mp4', 0]);
  r = await req('/api/local/dddddddd', { headers: { Range: 'bytes=0-' } });
  assert.deepStrictEqual([r.status, r.headers['content-range']], [416, 'bytes */0']);
  for (const p of ['/api/local/cccccccc', '/api/local/eeeeeeee', '/api/local/ffffffff', '/api/local/bbbbbbbb/poster', '/api/local/XYZ', '/api/local/aaaaaaaa/other']) {
    r = await req(p);
    assert.deepStrictEqual([r.status, r.json()], [404, { error: 'Not downloaded' }], p);
  }
  assert.strictEqual((await req('/api/local/aaaaaaaa', { method: 'POST', body: '' })).status, 404);
});

test('local: subtitles next to a download, the built-in ones saved as .srt once', async () => {
  // the clip has none next to it: its two text tracks are saved first (wait=1)
  let r = await req('/api/local/aaaaaaaa/subs?wait=1');
  assert.deepStrictEqual(r.json(), [
    { n: 0, lang: 'eng', forced: false, sdh: false, os: false },
    { n: 1, lang: 'nor', forced: true, sdh: false, os: false },
  ]);
  const dir = path.join(pub, 'Films', 'Movies', 'Clip (2024)');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.srt')).sort(), ['Clip (2024).eng.srt', 'Clip (2024).nor.forced.srt']);
  r = await req('/api/local/aaaaaaaa/subs/0');
  assert.deepStrictEqual([r.status, r.headers['content-type']], [200, 'text/vtt; charset=utf-8']);
  assert.match(r.text, /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:03\.000\nHello\n/);
  // one language together; the file's own before OpenSubtitles' ("eng" and "en" are one language); forced last
  r = await req('/api/local/bbbbbbbb/subs');
  assert.deepStrictEqual(r.json().map((s) => [s.n, s.lang, s.os, s.forced]), [
    [0, 'de', true, false], [1, 'eng', false, false], [2, 'en', true, false], [3, 'en', true, false], [4, 'fr', true, false], [5, 'nob', false, true],
  ]);
  assert.match((await req('/api/local/bbbbbbbb/subs/3')).text, /OS english 2/);
  // Latin-1, ASS codes and <font> cleaned
  assert.strictEqual((await req('/api/local/bbbbbbbb/subs/0')).text, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nGrüße rot\n');
  r = await req('/api/local/bbbbbbbb/subs/6');
  assert.deepStrictEqual([r.status, r.json()], [404, { error: 'No such subtitle' }]);
  r = await req('/api/local/ffffffff/subs');
  assert.deepStrictEqual([r.status, r.json()], [404, { error: 'Not downloaded' }]);
  r = await req('/api/local/aaaaaaaa/subs/x');
  assert.deepStrictEqual([r.status, r.json()], [404, { error: 'Not downloaded' }]);
});

test('tcsubs: what a running conversion has written of a subtitle track', async () => {
  let r = await req('/api/tcsubs/parity0001/0');
  assert.deepStrictEqual([r.status, r.headers['content-type'], r.text], [200, 'text/vtt; charset=utf-8', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSo far\n']);
  assert.strictEqual((await req('/api/tcsubs/parity0001/1')).text, '');
  for (const p of ['/api/tcsubs/short/0', '/api/tcsubs/parity0001/x', '/api/tcsubs/parity0001/1234', '/api/tcsubs/']) {
    r = await req(p);
    assert.deepStrictEqual([r.status, r.json()], [404, { error: 'Not found' }], p);
  }
});

/* ───────────── TMDB ───────────── */

test('tmdb: runtime and cast, once per title', async () => {
  let r = await req('/api/tmdb?type=movie&id=603');
  assert.strictEqual(r.status, 200, r.text);
  const j = r.json();
  assert.strictEqual(j.runtime, 136);
  assert.strictEqual(j.poster, 'https://image.tmdb.org/t/p/w500/m.jpg');
  assert.strictEqual(j.cast.length, 12);
  assert.deepStrictEqual(j.cast.slice(0, 3), [
    { name: 'Actor 0', role: 'Role 0', photo: 'https://image.tmdb.org/t/p/w185/p0.jpg' },
    { name: 'Actor 1', role: '', photo: 'https://image.tmdb.org/t/p/w185/p1.jpg' },
    { name: 'Actor 2', role: 'Role 2', photo: '' },
  ]);
  const before = hits.tmdb;
  assert.deepStrictEqual((await req('/api/tmdb?id=603')).json(), j);   // movie is the default type; from the cache
  assert.strictEqual(hits.tmdb, before);
  assert.deepStrictEqual((await req('/api/tmdb?type=tv&id=1399')).json(), { runtime: 58, poster: '', cast: [{ name: 'Sean', role: 'Ned', photo: 'https://image.tmdb.org/t/p/w185/s.jpg' }, { name: 'Nobody', role: '', photo: '' }] });
  assert.deepStrictEqual((await req('/api/tmdb?id=7')).json(), { runtime: 0, poster: '', cast: [] });
  for (const [qs, status, error] of [['id=404', 404, 'TMDB answered HTTP 404'], ['id=500', 502, 'TMDB answered HTTP 500'], ['id=12a', 400, 'Invalid id'], ['id=', 400, 'Invalid id'], ['', 400, 'Invalid id'], ['id=12345678901', 400, 'Invalid id']]) {
    r = await req(`/api/tmdb?${qs}`);
    assert.deepStrictEqual([r.status, r.json()], [status, { error }], qs);
  }
});

test('trending: this week\'s 40 of each, kept', async () => {
  const r = await req('/api/trending');
  assert.strictEqual(r.status, 200, r.text);
  const j = r.json();
  assert.deepStrictEqual(Object.keys(j), ['movie', 'tv']);
  assert.strictEqual(j.movie.length, 6);
  assert.deepStrictEqual(j.movie[0], { id: 11, title: 'movie 1 a', original: 'Orig', year: '2024', overview: 'Story', backdrop: 'https://image.tmdb.org/t/p/w1280/b.jpg' });
  assert.deepStrictEqual(j.tv[1], { id: 12, title: 'tv 1 b', original: 'Orig b', year: '2019', overview: '', backdrop: '' });
  assert.deepStrictEqual(j.movie[2], { title: 'no id', original: '', year: '2024', overview: '', backdrop: '' });
  assert.strictEqual(j.movie[3].id, 21);
  const before = hits.trending;
  assert.deepStrictEqual((await req('/api/trending')).json(), j);
  assert.strictEqual(hits.trending, before);
});

/* ───────────── OpenSubtitles ───────────── */

test('opensubtitles: login, search, download (saved next to a download), errors', async () => {
  const post = (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const os1 = { username: 'ann', password: 'pw' };
  let r = await post('/api/subs/login', { os: os1 });
  assert.deepStrictEqual([r.status, r.json()], [200, { allowed: 20, remaining: 19, level: 'Sub leecher' }]);
  const login = hits.os.find((h) => h.path === '/login');
  assert.deepStrictEqual([login.method, login.key, login.accept, login.ct, JSON.parse(login.body)], ['POST', 'parity-os', 'application/json', 'application/json', { username: 'ann', password: 'pw' }]);
  assert.match(login.ua, /^AGHorizon v\d+\.\d+\.\d+/);
  assert.strictEqual(login.ua, `AGHorizon v${require('../../package.json').version}`);

  r = await post('/api/subs/search', { os: os1, q: { query: 'Clip Film', year: 2024, languages: 'EN,NO', empty: '', none: null } });
  assert.deepStrictEqual(r.json(), [
    { fileId: 11, lang: 'en', release: 'Clip.2024.1080p', downloads: 1234, sdh: true, trusted: true, ai: false },
    { fileId: 12, lang: 'nb', release: 'b.srt', downloads: 0, sdh: false, trusted: false, ai: true },
  ]);
  assert.strictEqual(hits.os[hits.os.length - 1].path, '/subtitles?languages=en%2Cno&query=clip+film&year=2024');
  assert.strictEqual(hits.os[hits.os.length - 1].auth, '');
  r = await post('/api/subs/search', { q: { query: 'broken' } });
  assert.deepStrictEqual([r.status, r.json()], [502, { error: 'OpenSubtitles: one, two' }]);

  // tok1 was used by /infos/user: the download logs in again (tok2) and gets it
  r = await post('/api/subs/download', { os: os1, fileId: '11', lang: 'EN!', saveFor: 'aaaaaaaa' });
  assert.deepStrictEqual([r.status, r.json()], [200, { vtt: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nFrom OpenSubtitles\n', remaining: 18, saved: true }]);
  assert.ok(fs.existsSync(path.join(pub, 'Films', 'Movies', 'Clip (2024)', 'Clip (2024).en.srt')));
  assert.deepStrictEqual(JSON.parse(hits.os.filter((h) => h.path === '/download').pop().body), { file_id: 11 });
  r = await post('/api/subs/download', { os: os1, fileId: 11, lang: 'en', saveFor: 'aaaaaaaa' });
  assert.strictEqual(r.json().saved, true);
  assert.ok(fs.existsSync(path.join(pub, 'Films', 'Movies', 'Clip (2024)', 'Clip (2024).en.2.srt')));
  r = await post('/api/subs/download', { os: os1, fileId: 12, saveFor: 'ffffffff' });
  assert.strictEqual(r.json().saved, false);
  r = await post('/api/subs/download', { os: os1, fileId: 99 });
  assert.deepStrictEqual([r.status, r.json()], [502, { error: 'OpenSubtitles: quota reached' }]);

  for (const [p, body, status, error] of [
    ['/api/subs/login', { os: { username: 'ann', password: 'nope' } }, 401, 'OpenSubtitles: Wrong password'],
    ['/api/subs/login', {}, 400, 'Add your OpenSubtitles username and password in Settings › Subtitles'],
    ['/api/subs/download', { os: { username: 'bob' }, fileId: 1 }, 400, 'Add your OpenSubtitles username and password in Settings › Subtitles'],
  ]) {
    r = await post(p, body);
    assert.deepStrictEqual([r.status, r.json()], [status, { error }], `${p} ${JSON.stringify(body)}`);
  }
  r = await post('/api/subs/other', {});
  assert.deepStrictEqual([r.status, r.text], [404, 'Not found']);
  // too large: server.js drops the connection, the Rust server answers 413 (either way nothing is read past 64 KB)
  r = await req('/api/subs/search', { method: 'POST', body: 'x'.repeat(70 * 1024) }).catch(() => null);
  if (r && r.status) assert.deepStrictEqual([r.status, r.json()], [413, { error: 'Request too large' }]);
});

/* ───────────── compatibility mode: ffmpeg ───────────── */

test('probe: duration, codecs, sound and subtitle tracks', async () => {
  const r = await req(`/api/probe?url=${encodeURIComponent(`${P}/clip.mp4`)}`);
  assert.strictEqual(r.status, 200, r.text);
  const j = r.json();
  assert.deepStrictEqual(Object.keys(j), ['duration', 'video', 'audio', 'audios', 'subs', 'hdr']);
  assert.ok(Math.abs(j.duration - 6) < 0.2, String(j.duration));
  assert.deepStrictEqual([j.video, j.audio, j.hdr], ['h264', 'aac', false]);
  assert.deepStrictEqual(j.audios.map((a) => [a.index, a.lang, a.codec, a.title, a.default]), [[0, 'eng', 'aac', '', true], [1, 'nor', 'aac', '', false]]);   // MP4 keeps no title for a sound track
  assert.deepStrictEqual(Object.keys(j.audios[0]), ['index', 'lang', 'codec', 'channels', 'title', 'default', 'comment', 'descr']);
  assert.deepStrictEqual(j.subs, [{ index: 0, lang: 'eng', forced: false, sdh: false }, { index: 1, lang: 'nor', forced: true, sdh: false }]);
  const quick = await req(`/api/probe?quick=1&url=${encodeURIComponent(`${P}/clip.mp4`)}`);
  assert.deepStrictEqual(quick.json().audios, j.audios);
  const bad = await req('/api/probe?url=nope');
  assert.deepStrictEqual([bad.status, bad.json()], [400, { error: 'Invalid URL' }]);
  const gone = (await req(`/api/probe?url=${encodeURIComponent(`${P}/missing.mp4`)}`)).json();
  assert.deepStrictEqual(gone, { duration: 0, video: '', audio: '', audios: [], subs: [], hdr: false });
});

test('keyframe: where copied video can start', async () => {
  const kf = async (t) => (await req(`/api/keyframe?url=${encodeURIComponent(`${P}/clip.mp4`)}${t === undefined ? '' : `&t=${t}`}`)).json().t;
  assert.ok(Math.abs((await kf('3.4')) - 3) < 0.05);
  assert.strictEqual(await kf('0'), 0);
  assert.strictEqual(await kf(), 0);
  assert.strictEqual(await kf('-5'), 0);
  assert.strictEqual(await kf('abc'), 0);
  assert.strictEqual((await req(`/api/keyframe?t=2&url=${encodeURIComponent(`${P}/missing.mp4`)}`)).json().t, 2);
});

test('transcode: fragmented MP4 or Matroska, subtitles alongside, at most four at a time', async () => {
  const sid = `parity${Date.now().toString(36)}`;   // a new one per conversion, as the player makes them
  let r = await req(`/api/transcode?url=${encodeURIComponent(`${P}/clip.mp4`)}&maxh=144&sid=${sid}&subs=0,1,x`);
  assert.deepStrictEqual([r.status, r.headers['content-type'], r.headers['cache-control'], r.headers['accept-ranges']], [200, 'video/mp4', 'no-store', 'none'], r.status !== 200 ? r.text : '');
  assert.strictEqual(r.body.subarray(4, 8).toString('latin1'), 'ftyp');
  assert.ok(r.body.length > 10000);
  for (let i = 0; i < 20 && !/Hello/.test((await req(`/api/tcsubs/${sid}/0`)).text); i++) await new Promise((x) => setTimeout(x, 100));
  assert.match((await req(`/api/tcsubs/${sid}/0`)).text, /^WEBVTT[\s\S]*Hello/);
  assert.match((await req(`/api/tcsubs/${sid}/1`)).text, /Hei/);
  r = await req(`/api/transcode?url=${encodeURIComponent(`${P}/clip.mp4`)}&video=hevc&start=2&audio=1`);
  assert.deepStrictEqual([r.status, r.headers['content-type']], [200, 'video/x-matroska']);
  assert.strictEqual(r.body.subarray(0, 4).toString('hex'), '1a45dfa3');
  r = await req(`/api/transcode?url=${encodeURIComponent(`${P}/missing.mp4`)}`);
  assert.strictEqual(r.status, 502);
  assert.match(r.json().error, /^Conversion failed: .+/);
  // four that wait for a provider that sends nothing: the fifth is told to wait
  const hold = [];
  for (let i = 0; i < 4; i++) {
    const s = net.connect(port, '127.0.0.1');
    s.write(`GET /api/transcode?url=${encodeURIComponent(`${P}/trickle.ts`)} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    s.on('error', () => {});
    hold.push(s);
  }
  await new Promise((x) => setTimeout(x, 1000));
  r = await req(`/api/transcode?url=${encodeURIComponent(`${P}/clip.mp4`)}`);
  assert.deepStrictEqual([r.status, r.json()], [429, { error: 'Too many conversions are running – wait a moment and try again' }]);
  for (const s of hold) s.destroy();   // the player hangs up: ffmpeg goes, and the slots free up
  let status = 0;
  for (let i = 0; i < 50 && status !== 200; i++) {
    await new Promise((x) => setTimeout(x, 200));
    status = (await req(`/api/transcode?url=${encodeURIComponent(`${P}/clip.mp4`)}&maxh=144`)).status;
  }
  assert.strictEqual(status, 200);
});

/* ───────────── /api/shared: Multi view pictures taking turns on one provider connection ───────────── */

test('shared: two pictures take turns on one provider connection and neither misses a packet', async () => {
  const watch = (ch) => {
    const got = [];
    const src = `${P}/share/live/u/p/${ch}.ts`;
    const sock = net.connect(port, '127.0.0.1');
    sock.write(`GET /api/shared?url=${encodeURIComponent(src)}&group=list1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    sock.on('data', (c) => got.push(c));
    sock.on('error', () => {});
    return { ch, sock, raw: () => Buffer.concat(got) };
  };
  share.most = 0; share.connects = 0;
  const pictures = [watch(1), watch(2)];
  await new Promise((x) => setTimeout(x, 3500));
  const stats = (await req('/api/shared/stats')).json();
  pictures.forEach((p) => p.sock.destroy());

  assert.strictEqual(share.most, 1, 'never more than one connection to the provider');
  assert.ok(share.connects >= 4, `the connection went round (${share.connects} connections)`);
  for (const p of pictures) {
    const raw = p.raw();
    const head = raw.subarray(0, raw.indexOf('\r\n\r\n')).toString('latin1');
    assert.match(head, /^HTTP\/1\.1 200/);
    assert.match(head, /content-type: video\/mp2t/i);
    assert.match(head, /cache-control: no-store/i);
    let data = raw.subarray(raw.indexOf('\r\n\r\n') + 4);
    if (/transfer-encoding: chunked/i.test(head)) {   // de-chunk what came so far
      const out = []; let o = 0;
      for (;;) { const e = data.indexOf('\r\n', o); if (e < 0) break; const n = parseInt(data.subarray(o, e).toString(), 16); if (!n || e + 2 + n > data.length) break; out.push(data.subarray(e + 2, e + 2 + n)); o = e + 2 + n + 2; }
      data = Buffer.concat(out);
    }
    const count = Math.floor((data.length - 188) / (3 * 188));
    assert.ok(count > (8 + 2) / STEP, `picture ${p.ch} got the burst and kept up (${count * STEP} s)`);
    const first = data.readUInt32BE(188 + 24);
    assert.ok(data.subarray(0, 188 + count * 3 * 188).equals(Buffer.concat([opening(p.ch), groups(p.ch, first, first + count - 1)])), `picture ${p.ch} is one unbroken stream of its own channel`);
  }
  assert.deepStrictEqual(stats.map((g) => [g.group, g.pictures.length]), [['list1', 2]]);
  assert.ok(stats[0].connects >= 4);
  for (const s of stats[0].pictures) {
    assert.deepStrictEqual(Object.keys(s), ['reserve', 'burst', 'visits', 'errors', 'joins', 'rough', 'missing']);
    assert.ok(s.joins >= 1 && s.rough === 0 && s.missing === 0 && s.errors === 0 && s.visits >= 2, JSON.stringify(s));
    // 8 s came with the first burst and the picture has played in real time since
    assert.ok(s.reserve > 4 && s.reserve < 9, `a comfortable, believable reserve (${s.reserve} s)`);
    assert.ok(s.burst > 6 && s.burst < 10, `the burst was measured (${s.burst} s)`);
  }
  // the pictures are gone: so is the group, and the provider connection
  for (let i = 0; i < 30 && ((await req('/api/shared/stats')).json().length || share.open); i++) await new Promise((x) => setTimeout(x, 100));
  assert.deepStrictEqual((await req('/api/shared/stats')).json(), []);
  assert.strictEqual(share.open, 0);
});

test('shared: a channel without MPEG-TS is refused (the picture falls back), and bad addresses', async () => {
  let r = await req(`/api/shared?url=${encodeURIComponent(`${P}/share/hls/1.ts`)}&group=list2`);
  assert.deepStrictEqual([r.status, r.json()], [415, { error: 'This channel has no MPEG-TS stream to share' }]);
  r = await req(`/api/shared?url=${encodeURIComponent(`${P}/status?s=404`)}&group=list3`);
  assert.deepStrictEqual([r.status, r.json()], [404, { error: 'Stream answered HTTP 404' }]);   // after three tries
  r = await req('/api/shared?url=nope');
  assert.deepStrictEqual([r.status, r.json()], [400, { error: 'Invalid URL' }]);
  assert.deepStrictEqual((await req('/api/shared/stats')).json(), []);
});
