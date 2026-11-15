'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { start, server, tsStitcher, shareTuning } = require('../server');

// A made-up transport stream: every 40 ms of it is one packet with the clock (PCR) and two with "video".
// Each packet says which channel and which 40 ms it belongs to, so a stream can be checked byte for byte.
const STEP = 0.04;
function packet(pid, ch, n, k, pcrTicks) {
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
const opening = (ch) => packet(0, ch, 0, 9);   // what a connection sends before its first clock packet (think PAT / PMT)
const group = (ch, n, shift = 0) => Buffer.concat([packet(0x100, ch, n, 0, n * STEP * 27e6 + shift), packet(0x101, ch, n, 1), packet(0x101, ch, n, 2)]);
const groups = (ch, from, to, shift) => Buffer.concat(Array.from({ length: to - from + 1 }, (_, i) => group(ch, from + i, shift)));

function stitch(pieces) {
  const out = [];
  const s = tsStitcher((b) => out.push(b));
  for (const [data, size] of pieces) {
    for (let i = 0; i < data.length; i += size) s.push(data.subarray(i, i + size));
    s.cut();
  }
  return { out: Buffer.concat(out), st: s.st };
}

test('shared connection: two connections that overlap become one unbroken stream', () => {
  // odd piece sizes: packets arrive split anywhere
  const { out, st } = stitch([[Buffer.concat([opening(1), groups(1, 0, 59)]), 1000], [Buffer.concat([opening(1), groups(1, 40, 99)]), 777]]);
  // the last 40 ms of each connection is held back (its end was not seen), and brought by the next one
  assert.ok(out.equals(Buffer.concat([opening(1), groups(1, 0, 98)])));
  assert.deepStrictEqual([st.joins, st.rough, st.missing], [1, 0, 0]);
});

test('shared connection: a connection that starts too late is joined with the hole counted', () => {
  const { out, st } = stitch([[Buffer.concat([opening(1), groups(1, 0, 59)]), 4096], [Buffer.concat([opening(1), groups(1, 70, 99)]), 4096]]);
  assert.ok(out.equals(Buffer.concat([opening(1), groups(1, 0, 58), opening(1), groups(1, 70, 98)])));
  assert.strictEqual(st.joins, 0);
  assert.ok(Math.abs(st.missing - 11 * STEP) < 1e-6);
});

test('shared connection: a stream built anew per connection is joined past the old end', () => {
  const { out, st } = stitch([[Buffer.concat([opening(1), groups(1, 0, 59)]), 4096], [Buffer.concat([opening(1), groups(1, 40, 99, 1)]), 4096]]);
  assert.ok(out.equals(Buffer.concat([opening(1), groups(1, 0, 58), groups(1, 59, 98, 1)])));
  assert.deepStrictEqual([st.joins, st.rough, st.missing], [0, 1, 0]);
});

test('shared connection: two pictures take turns on one provider connection and neither misses a packet', async (t) => {
  // A provider like the measured one: each connection starts 8 s back, sends that at once, then goes on in real time.
  const epoch = Date.now();
  const onAir = () => Math.floor((Date.now() - epoch) / (STEP * 1000)) + 100000;
  let open = 0, most = 0, connects = 0;
  const provider = http.createServer((q, r) => {
    const ch = Number(/(\d+)\.ts$/.exec(q.url)[1]);
    most = Math.max(most, ++open);
    connects++;
    r.writeHead(200, { 'content-type': 'video/mp2t' });
    let n = onAir() - 200;
    r.write(opening(ch));
    const send = () => { const to = onAir(); if (to >= n) { r.write(groups(ch, n, to)); n = to + 1; } };
    send();
    const iv = setInterval(send, 20);
    r.on('close', () => { clearInterval(iv); open--; });
  });
  await new Promise((res) => provider.listen(0, '127.0.0.1', res));
  const port = await start(0);
  const revisit = shareTuning.revisit;
  shareTuning.revisit = 0.4;   // the real 3 s would make this test take half a minute
  t.after(() => { shareTuning.revisit = revisit; provider.closeAllConnections(); provider.close(); server.closeAllConnections(); server.close(); });

  const watch = (ch) => {
    const got = [];
    const src = `http://127.0.0.1:${provider.address().port}/live/u/p/${ch}.ts`;
    const req = http.get({ host: '127.0.0.1', port, path: `/api/shared?url=${encodeURIComponent(src)}&group=list1` }, (r) => r.on('data', (c) => got.push(c)));
    req.on('error', () => {});
    return { ch, req, data: () => Buffer.concat(got) };
  };
  const pictures = [watch(1), watch(2)];
  await new Promise((res) => setTimeout(res, 3500));
  const stats = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: '/api/shared/stats' }, (r) => {
    let s = ''; r.on('data', (c) => { s += c; }); r.on('end', () => res(JSON.parse(s)));
  }).on('error', rej));
  pictures.forEach((p) => p.req.destroy());

  assert.strictEqual(most, 1, 'never more than one connection to the provider');
  assert.ok(connects >= 4, `the connection went round (${connects} connections)`);
  for (const p of pictures) {
    const data = p.data();
    const count = (data.length - 188) / (3 * 188);
    assert.ok(Number.isInteger(count) && count > (8 + 2) / STEP, `picture ${p.ch} got the burst and kept up (${count * STEP} s)`);
    const first = data.readUInt32BE(188 + 24);
    assert.ok(data.equals(Buffer.concat([opening(p.ch), groups(p.ch, first, first + count - 1)])), `picture ${p.ch} is one unbroken stream of its own channel`);
  }
  assert.strictEqual(stats.length, 1);
  assert.strictEqual(stats[0].pictures.length, 2);
  for (const s of stats[0].pictures) {
    assert.ok(s.joins >= 1 && s.rough === 0 && s.missing === 0, JSON.stringify(s));
    // 8 s came with the first burst and the picture has played in real time since: more would mean the playback clock stands still
    assert.ok(s.reserve > 4 && s.reserve < 9, `a comfortable, believable reserve (${s.reserve} s)`);
  }
});

test('shared connection: a channel that only has HLS is refused, so the picture can fall back', async (t) => {
  const provider = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); r.end('#EXTM3U\n'); });
  await new Promise((res) => provider.listen(0, '127.0.0.1', res));
  const port = server.listening ? server.address().port : await start(0);
  t.after(() => { provider.close(); server.closeAllConnections(); server.close(); });
  const src = `http://127.0.0.1:${provider.address().port}/live/u/p/1.ts`;
  const status = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: `/api/shared?url=${encodeURIComponent(src)}&group=list2` }, (r) => { r.resume(); res(r.statusCode); }).on('error', rej));
  assert.strictEqual(status, 415);
});
