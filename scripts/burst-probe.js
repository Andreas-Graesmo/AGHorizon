'use strict';
/*
 * Does the provider burst? Connects to one live MPEG-TS channel a few times in a row and compares
 * seconds of video received (the stream's own PCR clock) with seconds waited.
 * Sharing one connection between Multi view pictures (they take turns) only pays off when a fresh
 * connection delivers much faster than real time, and when reconnecting right away works.
 *
 *   node scripts/burst-probe.js <channel .ts address> [seconds per visit = 8] [visits = 3]
 *   node scripts/burst-probe.js <address> <address> … [seconds = 60]
 *   The addresses can also come from IPTV_URL (separated by spaces or line breaks), which keeps the login out of the shell history.
 *
 * With several addresses it rehearses the sharing itself: one connection goes round the channels, takes each
 * one's burst and leaves, while every picture "plays" in real time. It reports whether any picture ran dry.
 */
const assert = require('node:assert');
const { DEFAULT_UA } = require('../server');   // the same User-Agent the app plays with

// The PCR (the stream's clock) of the 188-byte packet at o, in seconds; null when the packet carries none.
function pcr(b, o) {
  if (!(b[o + 3] & 0x20) || b[o + 4] < 7 || !(b[o + 5] & 0x10)) return null;
  return (b.readUInt32BE(o + 6) * 2 + (b[o + 10] >> 7)) / 90000;
}
{
  const p = Buffer.alloc(188);
  p[0] = 0x47; p[3] = 0x20; p[4] = 7; p[5] = 0x10; p.writeUInt32BE(45000, 6);
  assert.strictEqual(pcr(p, 0), 1);
  p[5] = 0;
  assert.strictEqual(pcr(p, 0), null);
}

// burstOnly: leave as soon as the provider stops sending faster than real time (or goes quiet).
async function visit(url, secs, burstOnly = false) {
  const ac = new AbortController();
  const t0 = performance.now();
  const since = () => (performance.now() - t0) / 1000;
  const timer = setTimeout(() => ac.abort(), (secs + (burstOnly ? 4 : 15)) * 1000);   // also covers a provider that never answers
  let quiet = 0;
  let mark = { wall: 0, video: 0 };
  const v = { ttfb: null, wall: 0, bytes: 0, first: null, last: null, marks: [] };
  try {
    const r = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*' }, redirect: 'follow', signal: ac.signal });
    if (!r.ok) return { error: `the provider answered HTTP ${r.status}` };
    if (/mpegurl/i.test(r.headers.get('content-type') || '') || /\.m3u8?(\?|$)/i.test(r.url)) {
      return { error: 'this address is HLS (.m3u8); sharing needs the MPEG-TS address (Xtream: the same address ending in .ts)' };
    }
    let carry = Buffer.alloc(0);
    let pid = -1;
    for await (const chunk of r.body) {
      if (v.ttfb === null) v.ttfb = since();
      v.wall = since() - v.ttfb;
      v.bytes += chunk.length;
      const b = carry.length ? Buffer.concat([carry, chunk]) : Buffer.from(chunk);
      let o = 0;
      while (o + 188 <= b.length) {
        if (b[o] !== 0x47 || (o + 188 < b.length && b[o + 188] !== 0x47)) { o++; continue; }   // not on a packet edge
        const id = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
        const t = pid < 0 || id === pid ? pcr(b, o) : null;
        if (t !== null) { pid = id; if (v.first === null) v.first = t; v.last = t; }
        o += 188;
      }
      carry = b.subarray(o);
      if (v.first !== null && v.wall >= v.marks.length + 1) v.marks.push({ wall: v.wall, video: v.last - v.first });
      if (v.wall >= secs) break;
      if (burstOnly) {
        const video = v.first === null ? 0 : v.last - v.first;
        const begun = video >= 2 || v.wall >= 1.5;   // a high-bitrate burst starts slowly: don't mistake that for its end
        clearTimeout(quiet);
        quiet = setTimeout(() => ac.abort(), begun ? 300 : 1500);
        if (v.wall - mark.wall >= 0.3) {
          if (begun && video - mark.video < 2 * (v.wall - mark.wall)) break;
          mark = { wall: v.wall, video };
        }
      }
    }
  } catch (e) {
    if (v.ttfb === null) return { error: e.name === 'AbortError' ? 'no answer' : (e.cause && e.cause.code) || e.message };
  } finally {
    clearTimeout(timer);
    clearTimeout(quiet);
    ac.abort();
  }
  if (v.first === null) return { error: `no MPEG-TS clock found in ${v.bytes} bytes (not a transport stream?)` };
  v.video = v.last - v.first;
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REVISIT = 3;   // seconds before a picture is worth visiting again: it can only gain what was broadcast meanwhile

// One connection takes turns between the channels; each picture plays what it has in real time.
async function rotate(urls, secs) {
  const f = (n) => n.toFixed(1);
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  // end: the stream clock at the end of what the picture holds; reserve: seconds it holds beyond what it has played
  // depth: how far back a fresh connection starts (the size of its burst) – stay away longer and video goes missing
  const tiles = urls.map(() => ({ end: null, reserve: 0, depth: 0, t: 0, last: -REVISIT, visits: 0, errors: 0, stalls: 0, stalled: 0, missing: 0, restarts: 0, low: Infinity, bytes: 0, video: 0 }));
  const drain = (x) => {
    if (x.end === null) return;
    const dt = now() - x.t;
    x.t += dt;
    if (dt <= x.reserve) { x.reserve -= dt; return; }
    if (x.reserve > 0) x.stalls++;
    x.stalled += dt - x.reserve;
    x.reserve = 0;
  };
  // Seconds until the picture is in trouble: it runs dry, or the provider's buffer no longer reaches back to what it holds
  // (0.6: a burst often stops short of live, so the real reach is shorter than the burst). Not started yet goes first,
  // unless it keeps failing.
  const need = (x) => (x.end === null ? x.errors - 1 : Math.min(x.reserve, 0.6 * x.depth - (now() - x.last)));
  console.log(`Rehearsing ${urls.length} pictures on one connection to ${new URL(urls[0]).host} for ${secs} s.\n`);

  let connects = 0;
  let failsInRow = 0;
  while (now() < secs) {
    tiles.forEach(drain);
    const i = tiles.reduce((b, x, k) => (need(x) < need(tiles[b]) ? k : b), 0);
    const x = tiles[i];
    const wait = x.last + REVISIT - now();
    if (wait > 0) { await sleep(Math.min(wait, 0.5) * 1000); continue; }
    const started = now();
    const v = await visit(urls[i], 4, true);
    connects++;
    x.last = now();
    x.visits++;
    if (v.error) {
      x.errors++;
      console.log(`${f(now()).padStart(5)} s  picture ${i + 1}  failed – ${v.error}`);
      if (++failsInRow >= 5) { console.log('\nFive failures in a row: stopping so the provider is not hammered.'); break; }
      await sleep(1000);
      continue;
    }
    failsInRow = 0;
    x.bytes += v.bytes;
    x.video += v.video;
    let gain = v.video;
    let note = '';
    if (x.end === null) x.t = now();   // the picture starts playing now
    else {
      drain(x);
      x.low = Math.min(x.low, x.reserve);
      const overlap = x.end - v.first;
      if (Math.abs(overlap) > 120) { x.restarts++; note = '  (clock restarted)'; }
      else if (overlap >= 0) gain = Math.max(0, v.last - x.end);
      else { x.missing -= overlap; note = `  (${f(-overlap)} s missing)`; }
    }
    x.reserve += gain;
    x.end = v.last;
    x.depth = v.video;
    tiles.forEach(drain);
    console.log(`${f(now()).padStart(5)} s  picture ${i + 1}  +${f(gain)} s in ${f(now() - started)} s  reserves: ${tiles.map((y) => (y.end === null ? '–' : f(y.reserve))).join(' | ')}${note}`);
  }

  console.log('');
  tiles.forEach((x, i) => {
    console.log(`Picture ${i + 1}: ${x.video ? f(x.bytes * 8 / 1e6 / x.video) : '?'} Mbit/s, ${x.visits} visits, ${x.errors} failed, last burst ${f(x.depth)} s, lowest reserve ${Number.isFinite(x.low) ? f(x.low) + ' s' : '–'}, froze ${x.stalls}× (${f(x.stalled)} s), ${f(x.missing)} s missing${x.restarts ? `, clock restarted ${x.restarts}×` : ''}`);
  });
  const bad = tiles.some((x) => x.errors || x.stalls || x.missing > 0.5 || x.end === null);
  console.log(`\n${connects} connections in ${f(now())} s (${Math.round(connects * 60 / now())} a minute). ` + (bad
    ? 'Not clean: see the pictures above that failed, froze or missed video.'
    : `All ${urls.length} pictures kept playing without a gap.`));
}

(async () => {
  let args = process.argv.slice(2);
  if (!args.some((a) => /^https?:/i.test(a))) args = [...(process.env.IPTV_URL || '').split(/\s+/), ...args];
  const urls = args.filter((a) => /^https?:/i.test(a));
  const nums = args.map(Number).filter((n) => n > 0);
  if (!urls.length) { console.log('Usage: node scripts/burst-probe.js <channel .ts address> [seconds per visit = 8] [visits = 3]\n       node scripts/burst-probe.js <address> <address> … [seconds = 60]'); process.exit(1); }
  if (urls.length > 1) { await rotate(urls, nums[0] || 60); process.exit(0); }
  const url = urls[0];
  const secs = nums[0] || 8;
  const visits = nums[1] || 3;
  console.log(`Probing ${new URL(url).host}: ${visits} visits of ${secs} s, reconnecting straight away.\n`);

  let prev = null;
  let best = 0;
  for (let i = 1; i <= visits; i++) {
    const v = await visit(url, secs);
    if (v.error) { console.log(`Visit ${i}: failed – ${v.error}`); prev = null; continue; }
    const f = (n) => n.toFixed(1);
    console.log(`Visit ${i}: first data after ${f(v.ttfb)} s, then ${f(v.video)} s of video in ${f(v.wall)} s (${f(v.bytes * 8 / 1e6 / Math.max(v.video, 0.1))} Mbit/s stream, ${f(v.bytes * 8 / 1e6 / Math.max(v.wall, 0.1))} Mbit/s line)`);
    console.log('  video received after each second: ' + v.marks.map((m) => f(m.video)).join('  '));
    if (prev) {
      const overlap = prev.last - v.first;
      console.log(Math.abs(overlap) > 120
        ? '  the clock does not continue from the previous visit (timestamps restart per connection)'
        : overlap >= 0 ? `  re-sent ${f(overlap)} s that the previous visit already had`
          : `  ${f(-overlap)} s missing between the previous visit and this one`);
    }
    for (const m of v.marks) best = Math.max(best, m.video / (v.ttfb + m.wall));   // connecting counts as waiting
    prev = v;
  }

  console.log('');
  if (!best) console.log('No usable measurement.');
  else if (best < 1.5) console.log(`Best case ${best.toFixed(1)}× real time: no burst. Sharing a connection would not work with this provider.`);
  else console.log(`Best case ${best.toFixed(1)}× real time: the provider bursts. Roughly ${Math.floor(best)} picture${Math.floor(best) === 1 ? '' : 's'} of this bitrate could share one connection (a rough ceiling, not a promise).`);
  process.exit(0);   // requiring ../server may leave handles open
})();
