#!/usr/bin/env node
'use strict';
/**
 * AG Horizon – tiny local server (no dependencies, Node 18+).
 *
 *  - serves the web app in ./public
 *  - /api/fetch   fetches playlists / Xtream API responses (avoids browser CORS limits)
 *  - /api/epg     downloads + parses an XMLTV guide (plain or .gz) into compact JSON
 *  - /api/stream  proxies live streams; HLS manifests are rewritten so segments also pass through
 *  - /api/shared  several Multi view pictures take turns on one provider connection (experimental)
 *  - /api/local   plays finished downloads (desktop app only), and their subtitles
 *  - /api/subs    OpenSubtitles.com search / download (subtitles.js)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const HOST = '127.0.0.1';   // only the desktop app talks to this server
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/* ---------------------------------------------------------------- helpers */

const httpError = (status, message) => Object.assign(new Error(message), { status });

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

function friendlyError(e) {
  if (e.status) return { status: e.status, message: e.message };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return { status: 504, message: 'The provider took too long to respond' };
  const code = e.cause && (e.cause.code || e.cause.message);
  if (code === 'ENOTFOUND') return { status: 502, message: 'Host not found – check the server address' };
  if (code === 'ECONNREFUSED') return { status: 502, message: 'Connection refused – check the server address and port' };
  if (code) return { status: 502, message: `Could not reach the provider (${code})` };
  return { status: 502, message: e.message || 'Request failed' };
}

async function upstream(urlStr, { ua, range, signal } = {}) {
  const u = checkUrl(urlStr);
  const headers = { 'User-Agent': ua || DEFAULT_UA, Accept: '*/*' };
  if (range) headers.Range = range;
  return fetch(u, { headers, redirect: 'follow', signal });
}

function maybeGunzip(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  return buf;
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ fetch */

async function handleFetch(req, res, q) {
  const r = await upstream(q.get('url'), { ua: q.get('ua'), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw httpError(r.status === 401 || r.status === 403 ? r.status : 502, `Provider answered HTTP ${r.status}`);
  const buf = maybeGunzip(Buffer.from(await r.arrayBuffer()));
  send(res, 200, buf, { 'Content-Type': 'text/plain; charset=utf-8' });
}

/* ------------------------------------------------------------------- EPG */

// keep identical to normName in public/js/core.js, which sends the channel names the guide is matched by
const normName = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  if (!s) return '';
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

// "20261023203000 +0200" -> epoch ms
function parseXmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(s || '');
  if (!m) return null;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) {
    const sign = m[7][0] === '-' ? -1 : 1;
    t -= sign * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(3, 5), 10)) * 60000;
  }
  return t;
}

const attr = (attrs, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`).exec(attrs);
  return m ? m[2] : '';
};
const tag = (body, name) => {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? decode(m[1]) : '';
};

// XMLTV text arrives piece by piece (push), so a guide of hundreds of MB is never one string (V8 caps strings at
// ~512 MB) and the server can answer other requests in between. Only whole <channel> / <programme> elements are
// parsed; the unfinished end of a piece waits for the next one.
function xmltvParser(fromMs, toMs) {
  const chNames = {}; // channel id -> [normalised display names]
  const programmes = {};
  let count = 0, rest = '', isTv = false;
  const parse = (xml) => {
    const chRe = /<channel\b[^>]*?\bid\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/channel>/g;
    let m;
    while ((m = chRe.exec(xml))) {
      const names = [];
      const nRe = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g;
      let n;
      while ((n = nRe.exec(m[3]))) { const k = normName(decode(n[1])); if (k) names.push(k); }
      chNames[decode(m[2])] = names;
    }
    const pRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
    while ((m = pRe.exec(xml))) {
      const start = parseXmltvTime(attr(m[1], 'start'));
      const stop = parseXmltvTime(attr(m[1], 'stop'));
      if (start == null || stop == null || stop < fromMs || start > toMs) continue;
      const ch = decode(attr(m[1], 'channel'));
      if (!ch) continue;
      (programmes[ch] ||= []).push([start, stop, tag(m[2], 'title'), tag(m[2], 'desc').slice(0, 400)]);
      count++;
    }
  };
  return {
    push(text) {
      rest += text;
      if (!isTv) {
        isTv = /<tv\b/i.test(rest);
        if (!isTv && rest.length > 1e6) throw httpError(502, 'That URL did not return an XMLTV guide');
      }
      const p = rest.lastIndexOf('</programme>'), c = rest.lastIndexOf('</channel>');
      const cut = Math.max(p < 0 ? -1 : p + 12, c < 0 ? -1 : c + 10);
      if (cut < 0) return;
      parse(rest.slice(0, cut));
      rest = rest.slice(cut);
    },
    end() {
      if (!isTv && !/<tv\b/i.test(rest)) throw httpError(502, 'That URL did not return an XMLTV guide');
      parse(rest);
      rest = '';
      for (const id in programmes) programmes[id].sort((a, b) => a[0] - b[0]);
      return { chNames, programmes, count, parsedAt: Date.now() };
    },
  };
}

// The guide file (plain or gzipped) as ~1 MB pieces of text, letting the event loop run between pieces.
async function* guideText(buf) {
  const dec = new TextDecoder();
  const pieces = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b
    ? Readable.from([buf]).pipe(zlib.createGunzip({ chunkSize: 1 << 20 }))
    : (function* () { for (let i = 0; i < buf.length; i += 1 << 20) yield buf.subarray(i, i + (1 << 20)); })();
  for await (const piece of pieces) {
    yield dec.decode(piece, { stream: true });
    await new Promise(setImmediate);
  }
  yield dec.decode();
}

async function parseXmltv(buf, fromMs, toMs) {
  const parser = xmltvParser(fromMs, toMs);
  for await (const text of guideText(buf)) parser.push(text);
  return parser.end();
}

const epgCache = new Map(); // url -> { t, full }
const EPG_TTL = 30 * 60 * 1000;
const epgLoading = new Map(); // url -> promise, so two playlists asking for the same guide at once download it once

function loadEpg(url, ua, force) {
  const hit = epgCache.get(url);
  if (hit && !force && Date.now() - hit.t < EPG_TTL) return hit.full;
  if (epgLoading.has(url)) return epgLoading.get(url);
  const job = downloadEpg(url, ua).finally(() => epgLoading.delete(url));
  epgLoading.set(url, job);
  return job;
}
async function downloadEpg(url, ua) {
  const r = await upstream(url, { ua, signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw httpError(502, `Guide download failed (HTTP ${r.status})`);
  const now = Date.now();
  const full = await parseXmltv(Buffer.from(await r.arrayBuffer()), now - 3 * 3600e3, now + 36 * 3600e3);
  epgCache.set(url, { t: now, full });
  while (epgCache.size > 6) epgCache.delete(epgCache.keys().next().value);
  return full;
}

// Only send the browser the channels it actually has (keeps the payload small).
function filterEpg(full, ids, names) {
  const idSet = new Set(ids.map((s) => String(s).toLowerCase()));
  const nameSet = new Set(names);
  const programmes = {};
  const byName = {};
  for (const id in full.programmes) {
    let keep = idSet.has(id.toLowerCase());
    if (!keep) {
      for (const n of full.chNames[id] || []) {
        if (nameSet.has(n)) { keep = true; if (!(n in byName)) byName[n] = id; }
      }
    }
    if (keep) programmes[id] = full.programmes[id];
  }
  return { programmes, byName, totalChannels: Object.keys(full.programmes).length, parsedAt: full.parsedAt };
}

async function handleEpg(req, res) {
  const body = JSON.parse((await readBody(req)) || '{}');
  if (!body.url) throw httpError(400, 'Missing guide URL');
  const full = await loadEpg(body.url, body.ua, !!body.force);
  sendJson(res, 200, filterEpg(full, body.ids || [], body.names || []));
}

/* ----------------------------------------------------------------- stream */

// src: the channel's own address, passed on to its playlists and segments, so what tsSniffer reads from a segment
// is kept under the channel (the player asks /api/tracks for it by that address).
function rewriteM3u8(text, baseUrl, ua, src) {
  const prox = (u) => {
    if (/^data:/i.test(u)) return u;
    const abs = new URL(u, baseUrl).href;
    return `/api/stream?url=${encodeURIComponent(abs)}${ua ? `&ua=${encodeURIComponent(ua)}` : ''}${src ? `&src=${encodeURIComponent(src)}` : ''}`;
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${prox(u)}"`);
      return prox(line.trim());
    })
    .join('\n');
}

/* ---------------------------------------------- what's in an MPEG-TS stream */
// The sound tracks of a live channel, read from the first bytes of the stream on their way to the player: the
// programme map (PAT -> PMT) lists every track with its language. Costs nothing: no second connection to the
// provider (many allow only one), nothing to wait for. GET /api/tracks?url=<channel> answers from what was read.
const TS_VIDEO = { 0x01: 'mpeg1video', 0x02: 'mpeg2video', 0x10: 'mpeg4', 0x1b: 'h264', 0x24: 'hevc' };
const TS_AUDIO = { 0x03: 'mp2', 0x04: 'mp2', 0x0f: 'aac', 0x11: 'aac_latm', 0x81: 'ac3', 0x87: 'eac3', 0x82: 'dts', 0x85: 'dts', 0x8a: 'dts' };
const TS_PRIVATE_AUDIO = { 0x6a: 'ac3', 0x7a: 'eac3', 0x7b: 'dts', 0x7c: 'aac' };   // stream type 6 + one of these descriptors
const TS_REG_AUDIO = { 'AC-3': 'ac3', EAC3: 'eac3', DTS1: 'dts', DTS2: 'dts', DTS3: 'dts', Opus: 'opus' };   // …or a registration descriptor

function parsePmt(sec) {
  const end = 3 + (((sec[1] & 0x0f) << 8) | sec[2]) - 4;   // the CRC isn't needed
  let i = 12 + (((sec[10] & 0x0f) << 8) | sec[11]);
  let video = '';
  const audios = [];
  while (i + 5 <= end) {
    const type = sec[i];
    const pid = ((sec[i + 1] & 0x1f) << 8) | sec[i + 2];
    const len = ((sec[i + 3] & 0x0f) << 8) | sec[i + 4];
    let codec = TS_AUDIO[type] || '';
    let lang = 'und';
    let descr = false;
    for (let d = i + 5; d + 2 <= i + 5 + len && d + 2 + sec[d + 1] <= sec.length;) {
      const tag = sec[d], dl = sec[d + 1], body = sec.subarray(d + 2, d + 2 + dl);
      if (tag === 0x0a && dl >= 4) {   // ISO 639 language (+ audio type: 3 = for the visually impaired)
        lang = body.subarray(0, 3).toString('latin1').toLowerCase().replace(/[^a-z]/g, '') || 'und';
        descr = body[3] === 3;
      } else if (type === 0x06 && TS_PRIVATE_AUDIO[tag]) codec = TS_PRIVATE_AUDIO[tag];
      else if (type === 0x06 && tag === 0x05 && dl >= 4 && TS_REG_AUDIO[body.subarray(0, 4).toString('latin1')]) codec = TS_REG_AUDIO[body.subarray(0, 4).toString('latin1')];
      d += 2 + dl;
    }
    if (TS_VIDEO[type] && !video) video = TS_VIDEO[type];
    if (codec) audios.push({ index: audios.length, pid, lang, codec, channels: '', title: '', default: false, comment: false, descr });
    i += 5 + len;
  }
  return { video, audios };
}

// Feed it the stream's bytes; it returns the tracks once the PMT has come by, null while it hasn't, false when
// this isn't MPEG-TS (or nothing came in the first 2 MB).
function tsSniffer() {
  let buf = Buffer.alloc(0);
  let seen = 0;
  let synced = false;
  let pmtPid = -1;
  const parts = new Map();   // pid -> the section being put together
  const section = (pid, payload, start) => {
    let part = parts.get(pid);
    if (start) {
      const pointer = payload[0];
      part = Buffer.from(payload.subarray(1 + pointer));
    } else if (part) part = Buffer.concat([part, payload]);
    else return null;
    if (part.length >= 3 && part.length >= 3 + (((part[1] & 0x0f) << 8) | part[2])) { parts.delete(pid); return part; }
    parts.set(pid, part);
    return null;
  };
  return (chunk) => {
    seen += chunk.length;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!synced) {   // first byte of a packet: 0x47, and again 188 bytes on
      let i = 0;
      while (i + 188 < buf.length && !(buf[i] === 0x47 && buf[i + 188] === 0x47)) i++;
      if (i + 188 >= buf.length) { if (seen > 65536) return false; buf = buf.subarray(i); return null; }
      buf = buf.subarray(i);
      synced = true;
    }
    let o = 0;
    for (; o + 188 <= buf.length; o += 188) {
      if (buf[o] !== 0x47) return false;
      const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
      if (pid !== 0 && pid !== pmtPid) continue;
      const afc = (buf[o + 3] >> 4) & 3;
      if (!(afc & 1)) continue;
      const start = o + 4 + (afc & 2 ? 1 + buf[o + 4] : 0);
      if (start >= o + 188) continue;
      const sec = section(pid, buf.subarray(start, o + 188), !!(buf[o + 1] & 0x40));
      if (!sec) continue;
      if (pid === 0 && sec[0] === 0x00) {   // PAT: the first programme's PMT
        for (let i = 8; i + 4 <= 3 + (((sec[1] & 0x0f) << 8) | sec[2]) - 4; i += 4) {
          if (((sec[i] << 8) | sec[i + 1]) !== 0) { pmtPid = ((sec[i + 2] & 0x1f) << 8) | sec[i + 3]; break; }
        }
      } else if (pid === pmtPid && sec[0] === 0x02) return parsePmt(sec);
    }
    buf = buf.subarray(o);
    return seen > 2 * 1024 * 1024 ? false : null;
  };
}

const tsTracks = new Map();   // channel address -> { video, audios, hls, t }
function rememberTracks(key, info) {
  tsTracks.delete(key);
  tsTracks.set(key, info);
  if (tsTracks.size > 300) tsTracks.delete(tsTracks.keys().next().value);
}
function handleTracks(req, res, q) {
  const i = tsTracks.get(q.get('url') || '');
  sendJson(res, 200, i ? { video: i.video, audios: i.audios, hls: i.hls } : {});
}

async function handleStream(req, res, q) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const ua = q.get('ua') || '';
  const headerTimer = setTimeout(() => ac.abort(), 20000);
  let r;
  try {
    r = await upstream(q.get('url'), { ua, range: req.headers.range, signal: ac.signal });
  } finally {
    clearTimeout(headerTimer);
  }
  if (!r.ok && r.status !== 206) throw httpError(r.status === 404 ? 404 : 502, `Stream answered HTTP ${r.status}`);

  const ct = r.headers.get('content-type') || '';
  const looksM3u8 = /mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(r.url);
  if (looksM3u8 || /^text\//i.test(ct)) {
    const text = await r.text();
    if (looksM3u8 || /^#EXTM3U/.test(text)) {
      return send(res, 200, rewriteM3u8(text, r.url, ua, q.get('src') || q.get('url')), { 'Content-Type': 'application/vnd.apple.mpegurl' });
    }
    return send(res, 200, text, { 'Content-Type': ct });
  }

  const headers = { 'Cache-Control': 'no-store' };
  for (const k of ['content-type', 'content-range', 'accept-ranges']) {
    const v = r.headers.get(k);
    if (v) headers[k] = v;
  }
  if (!r.headers.get('content-encoding') && r.headers.get('content-length')) headers['content-length'] = r.headers.get('content-length');
  res.writeHead(r.status, headers);
  if (!r.body) return res.end();
  const body = Readable.fromWeb(r.body);
  // a live stream (or an HLS segment of one, src = its channel): note its sound tracks as they pass
  const key = q.get('src') || q.get('url');
  const known = tsTracks.get(key);
  if (!req.headers.range && (!q.get('src') || !known || Date.now() - known.t > 10 * 60e3)) {
    const sniff = tsSniffer();
    const onData = (chunk) => {
      const info = sniff(chunk);
      if (info === null) return;
      body.off('data', onData);
      if (info) rememberTracks(key, { ...info, hls: !!q.get('src'), t: Date.now() });
    };
    body.on('data', onData);
  }
  body.on('error', () => res.destroy()).pipe(res);
}

/* ------------------------------------------ one connection, several pictures */
/*
 * Experimental (Settings › Playback). Multi view pictures from the same playlist take turns on ONE provider
 * connection. A fresh connection to a live MPEG-TS channel opens with a burst: what the provider has buffered,
 * often 10–25 s, sent as fast as the line allows. A picture takes its burst, hands the connection to the next
 * picture and plays what it got meanwhile. Every new connection sends part of what the picture already has
 * once more; that overlap is dropped, so the browser gets one unbroken stream per picture.
 * The rules were tried against a real provider with scripts/burst-probe.js first.
 */
const shareTuning = {
  revisit: 3,    // seconds before a picture is worth another visit: it can only gain what was broadcast meanwhile
  visitMax: 4,   // seconds a visit may last while another picture waits
};
const shareNow = () => performance.now() / 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The clock (PCR) of the 188-byte packet at o, in 27 MHz ticks; null when the packet carries none.
function tsPcr(b, o) {
  if (!(b[o + 3] & 0x20) || b[o + 4] < 7 || !(b[o + 5] & 0x10)) return null;
  return (b.readUInt32BE(o + 6) * 2 + (b[o + 10] >> 7)) * 300 + (((b[o + 10] & 1) << 8) | b[o + 11]);
}

// Joins what a picture gets from one connection after another. Forwarding always stops just before a packet
// that carries a PCR, and picks up at the packet with that very PCR in the next connection: the provider sends
// the same bytes again, so the join is exact.
// shortcut: a provider that builds the stream anew for every connection (other PCR values, or a clock that
// starts over) is joined at the first PCR past the old end, and the picture may stumble there. Join at a key
// frame and renumber the timestamps if such a provider turns up ("rough" in /api/shared/stats counts these).
function tsStitcher(write) {
  const HZ = 27e6;
  let carry = Buffer.alloc(0);
  let pid = -1;         // the PID that carries the clock
  let held = [];        // packets since the last PCR packet (or the connection's opening ones): not forwarded yet
  let heldPcr = null;   // the PCR held[0] carries, when forwarding
  let resume = null;    // the PCR where forwarding stopped; null while forwarding
  let fresh = true;     // no PCR seen in this connection yet
  // first … end: what has been forwarded (seconds on the stream's clock). from … to: what this connection has sent.
  const st = { first: null, end: null, from: null, to: null, joins: 0, rough: 0, missing: 0 };
  return {
    st,
    push(chunk) {
      const b = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const out = [];
      let o = 0;
      while (o + 188 <= b.length) {
        if (b[o] !== 0x47 || (o + 188 < b.length && b[o + 188] !== 0x47)) { o++; continue; }   // not on a packet edge
        const at = o;
        o += 188;
        const id = ((b[at + 1] & 0x1f) << 8) | b[at + 2];
        const pcr = pid < 0 || id === pid ? tsPcr(b, at) : null;
        if (pcr === null) {
          if (resume === null || fresh) held.push(b.subarray(at, o));
          continue;
        }
        pid = id;
        const opening = fresh;
        fresh = false;
        if (opening) st.from = pcr / HZ;
        st.to = pcr / HZ;
        if (resume !== null) {
          const ahead = pcr - resume;
          if (ahead < 0 && ahead > -120 * HZ) { held = []; continue; }   // still what the picture already has
          if (ahead === 0) { st.joins++; held = []; }                    // the very packet forwarding stopped before
          else if (opening && ahead > 0 && ahead < 120 * HZ) st.missing += ahead / HZ;   // the provider no longer reaches back that far: keep its opening packets
          else { st.rough++; if (!opening) held = []; }
          resume = null;
        }
        for (const p of held) out.push(p);
        held = [b.subarray(at, o)];
        heldPcr = pcr;
        st.end = pcr / HZ;
        if (st.first === null) st.first = st.end;
      }
      carry = b.subarray(o);
      if (out.length) write(Buffer.concat(out));
    },
    // The connection is closing. What is held was not forwarded; the next connection brings it again.
    cut() {
      if (heldPcr !== null) resume = heldPcr;
      held = [];
      heldPcr = null;
      carry = Buffer.alloc(0);
      fresh = true;
      st.from = st.to = null;
    },
  };
}

const shareGroups = new Map();   // playlist id -> { members, ac, cur, connects }: the pictures on one connection

// Seconds of stream the picture has been given, and how much of that it has not played yet.
const shareAvail = (m) => { const s = m.stitch.st; return s.first === null ? 0 : s.end - s.first - s.missing; };
function shareReserve(m) {   // the picture plays in real time from its first data on, as far as what it has reaches
  if (m.t === null) return 0;
  const now = shareNow();
  m.played = Math.min(shareAvail(m), m.played + now - m.t);
  m.t = now;
  return shareAvail(m) - m.played;
}
// Seconds until the picture is in trouble: it runs dry, or the provider's buffer no longer reaches back to what it
// holds (0.6: a burst often stops short of live, so the real reach is shorter than the burst). A picture that has
// not started goes first, unless it keeps failing.
const shareNeed = (m) => (m.t === null ? m.errors - 1 : Math.min(shareReserve(m), 0.6 * m.depth - (shareNow() - m.last)));

// One turn on the connection for picture m. Resolves with an error when the provider gave nothing.
async function shareVisit(g, m) {
  const ac = (g.ac = new AbortController());
  g.cur = m;
  g.connects++;
  m.visits++;
  const s = m.stitch.st;
  const t0 = shareNow();
  let firstData = null, lastData = null, begun = false, slow = false, depthKnown = false, dead = null;
  let mark = { wall: 0, video: 0 };
  const sent = () => (s.to === null ? 0 : s.to - s.from);   // seconds of stream this connection has sent, overlap included
  const watch = setInterval(() => {
    const now = shareNow();
    if (lastData === null ? now - t0 > 8 : now - lastData > 10) { dead = httpError(504, 'The provider took too long to respond'); ac.abort(); return; }
    if (lastData === null) return;
    const over = begun && (slow || now - lastData > 0.3);   // the burst is spent: from here on it is real time
    if (over && !depthKnown) { depthKnown = true; m.depth = sent(); }
    const waiting = [...g.members].some((x) => x !== m && now - x.last >= shareTuning.revisit);
    if (waiting && (over || now - t0 > shareTuning.visitMax)) ac.abort();   // nobody waiting: staying costs nothing
  }, 100);
  try {
    const r = await upstream(m.url, { ua: m.ua, signal: ac.signal });
    if (!r.ok) throw httpError(r.status === 404 ? 404 : 502, `Stream answered HTTP ${r.status}`);
    if (!r.body || /mpegurl|^text\//i.test(r.headers.get('content-type') || '')) throw Object.assign(httpError(415, 'This channel has no MPEG-TS stream to share'), { final: true });
    for await (const chunk of r.body) {
      lastData = shareNow();
      m.stitch.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (firstData === null) { firstData = lastData; mark = { wall: 0, video: sent() }; }
      const wall = lastData - firstData;
      begun = sent() >= 2 || wall >= 1.5;   // a high-bitrate burst starts slowly: don't mistake that for its end
      if (wall - mark.wall >= 0.3) { slow = sent() - mark.video < 2 * (wall - mark.wall); mark = { wall, video: sent() }; }
    }
    if (lastData === null) throw httpError(502, 'The stream ended without sending anything');
  } catch (e) {
    if (dead || !ac.signal.aborted) return dead || e;
  } finally {
    clearInterval(watch);
    ac.abort();
    if (!depthKnown && s.to !== null) m.depth = sent();
    m.stitch.cut();
    m.last = shareNow();
    g.cur = null;
  }
  return null;
}

async function shareRun(key, g) {
  try {
    while (g.members.size) {
      const now = shareNow();
      const ready = [...g.members].filter((m) => now - m.last >= shareTuning.revisit);
      if (!ready.length) { await wait(100); continue; }
      const m = ready.reduce((a, b) => (shareNeed(b) < shareNeed(a) ? b : a));
      const err = await shareVisit(g, m);
      await wait(100);   // let the provider notice the connection is gone before the next one opens: it allows only one
      if (!err) { m.errors = 0; continue; }
      if (!g.members.has(m)) continue;   // the picture was closed meanwhile
      if (!err.final && ++m.errors < 3) { await wait(1000); continue; }   // don't hammer a provider that says no
      g.members.delete(m);   // give up: the picture falls back to a connection of its own
      if (m.res.headersSent) m.res.destroy();
      else { const { status, message } = friendlyError(err); sendJson(m.res, status, { error: message }); }
    }
  } finally {
    if (shareGroups.get(key) === g) shareGroups.delete(key);
    for (const m of g.members) m.res.destroy();
  }
}

function handleShared(req, res, q) {
  const url = checkUrl(q.get('url'));
  const key = q.get('group') || new URL(url).host;
  let g = shareGroups.get(key);
  const isNew = !g;
  if (isNew) shareGroups.set(key, (g = { members: new Set(), ac: null, cur: null, connects: 0 }));
  const write = (buf) => {
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
    if (m.t === null) m.t = shareNow();   // the picture starts playing
    res.write(buf);
    // The reader (the player, or ffmpeg for a converted picture) takes a burst in its own time, so nothing is held
    // back here. But one that has stopped reading altogether must not fill the memory.
    if (res.writableLength > 256 * 1024 * 1024) res.destroy();
  };
  // last: when its latest visit ended. t / played: the playback clock (see shareReserve; t is null until the first data).
  // depth: seconds its last burst held.
  const m = { url, ua: q.get('ua') || '', res, last: -Infinity, t: null, played: 0, depth: 0, errors: 0, visits: 0, stitch: tsStitcher(write) };
  g.members.add(m);
  res.on('error', () => {});
  res.on('close', () => { g.members.delete(m); if (g.cur === m && g.ac) g.ac.abort(); });
  if (isNew) shareRun(key, g);
}

// How the sharing is going (no addresses): for the tests, and for finding out why a picture freezes or skips.
function handleSharedStats(req, res) {
  sendJson(res, 200, [...shareGroups].map(([group, g]) => ({
    group,
    connects: g.connects,
    pictures: [...g.members].map((m) => {
      const s = m.stitch.st;
      return { reserve: shareReserve(m), burst: m.depth, visits: m.visits, errors: m.errors, joins: s.joins, rough: s.rough, missing: s.missing };
    }),
  })));
}

/* ------------------------------------------------- ffmpeg compatibility mode */
/*
 * Browsers can't decode everything (HEVC video, DTS / AC-3 audio, odd containers).
 * When that happens the UI asks us to run the stream through ffmpeg and hands the
 * browser a fragmented MP4 with H.264 video + stereo AAC audio instead.
 */
const { spawn, spawnSync } = require('child_process');

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const p = require('ffmpeg-static'); // optional dependency, bundled with the desktop app
    if (p) {
      // Inside a packaged Electron app the binary lives next to the asar archive, not inside it.
      const real = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      if (fs.existsSync(real)) return real;
    }
  } catch { /* not installed – fall back to PATH */ }
  return 'ffmpeg';
}

let ffmpegBin; // undefined = not checked yet, null = unavailable
function ffmpeg() {
  if (ffmpegBin === undefined) {
    const bin = findFfmpeg();
    try { ffmpegBin = spawnSync(bin, ['-version'], { timeout: 8000 }).status === 0 ? bin : null; } catch { ffmpegBin = null; }
  }
  return ffmpegBin;
}

function checkUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw httpError(400, 'Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpError(400, 'Only http(s) URLs are supported');
  return u.href;
}

function ffmpegInput(url, ua, extra = []) {
  return [
    '-hide_banner', '-nostdin',
    '-protocol_whitelist', 'http,https,tcp,tls,crypto', // never let a playlist make ffmpeg read local files
    '-user_agent', ua || DEFAULT_UA,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-fflags', '+genpts',
    ...extra,
    '-i', url,
  ];
}

function handleCapabilities(req, res) {
  sendJson(res, 200, { ffmpeg: !!ffmpeg(), opensubtitles: subs.osAvailable, tmdb: !!TMDB_KEY });
}

// The sound tracks ffmpeg lists for an input, in the order "-map 0:a:N" counts them: [{ index (that N), lang,
// codec, channels ("Stereo", "5.1"…), title, default, comment, descr }]. HLS inputs list a stream once per
// program it belongs to: each stream is counted once.
const LAYOUTS = { mono: 'Mono', stereo: 'Stereo', '1 channels': 'Mono', '2 channels': 'Stereo', '6 channels': '5.1', '8 channels': '7.1' };
function parseAudioStreams(stderr) {
  const byNum = new Map();
  let cur = null;
  for (const line of String(stderr).split(/\r?\n/)) {
    const st = /^\s*Stream #\d+:(\d+)(?:\[\w+\])?(?:\((\w+)\))?: (\w+): (.*)$/.exec(line);
    if (st) {
      const num = Number(st[1]);
      if (st[3] !== 'Audio') { cur = null; continue; }
      if (byNum.has(num)) { cur = null; continue; }   // the same stream again, under another program
      const rest = st[4];
      const layout = (/\d+ Hz, ([^,]+)/.exec(rest) || [])[1] || '';
      const lay = layout.trim().toLowerCase().replace(/\(.*\)$/, '');
      cur = {
        num,
        lang: (st[2] || 'und').toLowerCase(),
        codec: (/^(\w+)/.exec(rest) || [])[1].toLowerCase(),
        channels: LAYOUTS[lay] || (/^\d\.\d$/.test(lay) ? lay : ''),
        title: '',
        default: /\(default\)/.test(rest),
        comment: /\(comment\)/.test(rest),
        descr: /\(visual impaired\)/.test(rest),
      };
      byNum.set(num, cur);
      continue;
    }
    if (/^\s*(Stream #|Program |Input #|Output #)/.test(line)) { cur = null; continue; }
    const t = cur && !cur.title && /^\s+title\s*:\s*(.+?)\s*$/.exec(line);
    if (t) cur.title = t[1];
  }
  return [...byNum.values()].sort((a, b) => a.num - b.num).map(({ num, ...a }, index) => ({ index, ...a }));
}

// Reports duration and codecs so the UI can choose between "copy video" and "re-encode video", and the sound and
// subtitle tracks for their menus. ?quick=1: just the track list, for a live channel (less to read, sooner).
function handleProbe(req, res, q) {
  const bin = ffmpeg();
  if (!bin) throw httpError(501, 'ffmpeg is not installed');
  const url = checkUrl(q.get('url'));
  const size = q.get('quick') ? '1500000' : '4000000';
  const proc = spawn(bin, ffmpegInput(url, q.get('ua'), ['-analyzeduration', size, '-probesize', size]), { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  let finished = false;
  const finish = (status, body) => { if (finished) return; finished = true; clearTimeout(timer); sendJson(res, status, body); };
  const timer = setTimeout(() => proc.kill('SIGKILL'), 15000);
  proc.stderr.on('data', (d) => { err = (err + d).slice(-60000); });
  proc.on('error', (e) => finish(502, { error: 'Could not run ffmpeg: ' + e.message }));
  proc.on('close', () => {
    const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
    const v = /Stream #\d+:\d+[^\n]*?Video:\s*([a-z0-9_]+)/i.exec(err);
    const a = /Stream #\d+:\d+[^\n]*?Audio:\s*([a-z0-9_]+)/i.exec(err);
    finish(200, {
      duration: dur ? +dur[1] * 3600 + +dur[2] * 60 + +dur[3] : 0,
      video: v ? v[1].toLowerCase() : '',
      audio: a ? a[1].toLowerCase() : '',
      audios: parseAudioStreams(err),
      // text subtitles in the stream: the CC menu lists them, the conversion writes them (subs + sid below)
      subs: subs.parseSubStreams(err).filter((t) => t.text).map(({ index, lang, forced, sdh }) => ({ index, lang, forced, sdh })),
    });
  });
  res.on('close', () => proc.kill('SIGKILL'));
}

// Time of the keyframe at or before ?t. Copied video can only start on a keyframe, so the player starts the
// conversion there: otherwise the picture starts up to a few seconds early and the sound only at ?t.
function handleKeyframe(req, res, q) {
  const bin = ffmpeg();
  if (!bin) throw httpError(501, 'ffmpeg is not installed');
  const url = checkUrl(q.get('url'));
  const t = Math.max(0, Number(q.get('t')) || 0);
  const args = [
    ...ffmpegInput(url, q.get('ua'), ['-noaccurate_seek', '-ss', String(t)]),
    '-copyts', '-start_at_zero', '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-f', 'framecrc', 'pipe:1',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  let finished = false;
  const finish = (body) => { if (finished) return; finished = true; clearTimeout(timer); sendJson(res, 200, body); };
  const timer = setTimeout(() => proc.kill('SIGKILL'), 15000);
  proc.stdout.on('data', (d) => { out += d; });
  proc.on('error', () => finish({ t }));
  proc.on('close', () => {
    // framecrc: "#tb 0: 1/1000" then "0, dts, pts, duration, size, crc"
    const tb = /^#tb 0: (\d+)\/(\d+)/m.exec(out);
    const pkt = /^0,\s*-?\d+,\s*(-?\d+),/m.exec(out);
    const kf = tb && pkt ? (Number(pkt[1]) * Number(tb[1])) / Number(tb[2]) : NaN;
    finish({ t: isFinite(kf) && kf >= 0 && kf <= t + 0.5 ? kf : t });   // anything odd: start where asked, as before
  });
  res.on('close', () => proc.kill('SIGKILL'));
}

let activeConversions = 0;
const MAX_CONVERSIONS = 4;   // Multi view's 2 × 2 grid

function handleTranscode(req, res, q) {
  const bin = ffmpeg();
  if (!bin) throw httpError(501, 'ffmpeg is not installed');
  if (activeConversions >= MAX_CONVERSIONS) throw httpError(429, 'Too many conversions are running – wait a moment and try again');
  const url = checkUrl(q.get('url'));
  const start = Math.max(0, Number(q.get('start')) || 0);
  const keepHevc = q.get('video') === 'hevc';   // the player decodes HEVC itself
  const copyVideo = q.get('video') === 'copy' || keepHevc;
  const maxH = Math.min(1080, Math.max(240, Number(q.get('maxh')) || 1080));   // Multi view asks for less: smaller pictures, less CPU
  // which sound track (the language menu): by its MPEG-TS id when the player knows it (exact), else by its place
  const apid = /^\d{1,4}$/.test(q.get('apid') || '') ? Number(q.get('apid')) : null;
  const audio = /^\d{1,2}$/.test(q.get('audio') || '') ? Number(q.get('audio')) : 0;

  const args = [
    ...ffmpegInput(url, q.get('ua'), ['-analyzeduration', '5000000', '-probesize', '10000000',
      // copied video starts on the keyframe before ?start: start the sound there too (the player asks /api/keyframe where that is)
      ...(start ? [...(copyVideo ? ['-noaccurate_seek'] : []), '-ss', start.toFixed(3)] : [])]),
    '-map', '0:v:0', '-map', apid != null ? `0:i:${apid}` : `0:a:${audio}?`, '-sn', '-dn',
    ...(copyVideo
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
         '-vf', `scale=-2:'min(${maxH},ih)'`, '-g', '50', '-keyint_min', '50', '-sc_threshold', '0']),
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2', // stereo AAC plays everywhere (and downmixes DTS / AC-3 5.1)
    // Chromium shows copied HEVC about a GOP late in fragmented MP4 (sound runs ~2 s ahead), but in sync in Matroska
    ...(keepHevc ? ['-f', 'matroska', '-live', '1'] : ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4']),
    'pipe:1',
    // ?subs=0,3&sid=…: also write these text subtitle tracks, read through /api/tcsubs/<sid>/<track>
    ...subs.tcSubArgs(q.get('sid'), (q.get('subs') || '').split(',').filter((n) => /^\d{1,3}$/.test(n)).slice(0, 64), start),
  ];
  const sid = q.get('sid');

  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  activeConversions++;
  let started = false;
  let finished = false;
  let counted = true;
  let err = '';
  const release = () => { if (counted) { counted = false; activeConversions--; } };
  const finish = () => { if (finished) return false; finished = true; release(); return true; };
  proc.on('exit', release); // 'close' never comes while stdout is paused for a browser that already hung up
  proc.on('exit', () => subs.tcSubCleanup(sid));

  proc.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  proc.stdout.on('data', (chunk) => {
    if (!started) {
      started = true;
      res.writeHead(200, { 'Content-Type': keepHevc ? 'video/x-matroska' : 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' });
    }
    if (!res.write(chunk)) { proc.stdout.pause(); res.once('drain', () => proc.stdout.resume()); }
  });
  proc.on('error', (e) => {
    if (!finish()) return;
    if (!started) sendJson(res, 502, { error: 'Could not run ffmpeg: ' + e.message }); else res.destroy();
  });
  proc.on('close', () => {
    if (!finish()) return;
    if (started) return res.end();
    const last = err.trim().split('\n').filter(Boolean).pop() || 'unknown error';
    sendJson(res, 502, { error: 'Conversion failed: ' + last });
  });
  res.on('close', () => { proc.kill('SIGKILL'); proc.stdout.destroy(); }); // browser navigated away / switched channel / seeked
}

/* --------------------------------------------------------- local downloads */
/*
 * The desktop app plays finished downloads from here, so the normal player (and compatibility mode,
 * which hands ffmpeg this http address) works offline. Only files the download manager hands out by id.
 */
let localFiles = null; // (id, 'video' | 'poster') -> absolute path or null; set by the desktop app
const setLocalFiles = (fn) => { localFiles = fn; };
const LOCAL_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.ts': 'video/mp2t', '.avi': 'video/x-msvideo', '.jpg': 'image/jpeg',
};

function handleLocal(req, res, pathname) {
  const m = /^\/api\/local\/([a-f0-9]{8,32})(\/poster)?$/.exec(pathname);
  const file = m && localFiles ? localFiles(m[1], m[2] ? 'poster' : 'video') : null;
  if (!file) throw httpError(404, 'Not downloaded');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const type = LOCAL_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1;
    if (r && (r[1] || r[2])) {
      if (r[1]) { start = Number(r[1]); if (r[2]) end = Math.min(end, Number(r[2])); } else start = Math.max(0, st.size - Number(r[2]));
      if (start > end) return send(res, 416, '', { 'Content-Range': `bytes */${st.size}` });
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    }
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

/* -------------------------------------------------------------- subtitles */
const subs = require('./subtitles');

// GET /api/local/<id>/subs      -> [{ n, lang, forced, sdh }]  (the first time, built-in subtitles are saved as .srt)
// GET /api/local/<id>/subs/<n>  -> WebVTT
async function handleLocalSubs(req, res, pathname, q) {
  const m = /^\/api\/local\/([a-f0-9]{8,32})\/subs(?:\/(\d+))?$/.exec(pathname);
  const video = m && localFiles ? localFiles(m[1], 'video') : null;
  if (!video) throw httpError(404, 'Not downloaded');
  const list = await subs.localSubs(ffmpeg(), video, { wait: q.get('wait') === '1' });
  if (m[2] === undefined) return sendJson(res, 200, list.map((s, n) => ({ n, lang: s.lang, forced: s.forced, sdh: s.sdh, os: s.os })));
  const s = list[Number(m[2])];
  if (!s) throw httpError(404, 'No such subtitle');
  send(res, 200, subs.srtToVtt(await fs.promises.readFile(s.file)), { 'Content-Type': 'text/vtt; charset=utf-8' });
}

// GET /api/tcsubs/<sid>/<track> -> what a running conversion has written of that subtitle track so far (WebVTT)
async function handleTcSubs(req, res, pathname) {
  const m = /^\/api\/tcsubs\/([a-z0-9]{8,40})\/(\d{1,3})$/i.exec(pathname);
  if (!m) throw httpError(404, 'Not found');
  send(res, 200, await subs.tcSubText(m[1], m[2]), { 'Content-Type': 'text/vtt; charset=utf-8' });
}

// OpenSubtitles, with the account from Settings (sent in the body, never in a URL):
// POST /api/subs/login     { os }                                   -> { allowed, remaining }
// POST /api/subs/search    { os, q }                                -> [{ fileId, lang, release, downloads, … }]
// POST /api/subs/download  { os, fileId, lang, saveFor? }           -> { vtt, remaining, saved }
//   saveFor: a download id – the subtitle is also saved next to that file, for offline viewing
async function handleSubsApi(req, res, pathname) {
  const body = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
  if (pathname === '/api/subs/login') return sendJson(res, 200, await subs.osLogin(body.os || {}));
  if (pathname === '/api/subs/search') return sendJson(res, 200, await subs.osSearch(body.os, body.q || {}));
  if (pathname === '/api/subs/download') {
    const { srt, remaining } = await subs.osDownload(body.os, body.fileId);
    const video = body.saveFor && localFiles ? localFiles(String(body.saveFor), 'video') : null;
    if (video) await subs.saveSrt(video, String(body.lang || '').toLowerCase().replace(/[^a-z-]/g, '') || 'und', srt);
    return sendJson(res, 200, { vtt: subs.srtToVtt(srt), remaining, saved: !!video });
  }
  send(res, 404, 'Not found');
}

/* ------------------------------------------------------------- TMDB */
// GET /api/tmdb?type=movie|tv&id=<tmdb id> -> { runtime, cast: [{ name, role, photo }] }, one TMDB request per title.
// runtime: minutes (a series: per episode), 0 when TMDB doesn't know. Providers' own runtimes are often wrong.
// (TMDB, with the app's key like OpenSubtitles: env TMDB_API_KEY or "tmdbApiKey" in secrets.json, written by the release build)
const TMDB_KEY = process.env.TMDB_API_KEY || (() => { try { return require('./secrets.json').tmdbApiKey || ''; } catch { return ''; } })();
const tmdbCache = new Map();   // "movie:603" -> { runtime, cast }
async function handleTmdb(req, res, q) {
  if (!TMDB_KEY) throw httpError(501, 'TMDB isn’t available in this build');
  const type = q.get('type') === 'tv' ? 'tv' : 'movie';
  const id = q.get('id') || '';
  if (!/^\d{1,10}$/.test(id)) throw httpError(400, 'Invalid id');
  const key = `${type}:${id}`;
  if (!tmdbCache.has(key)) {
    // series: aggregate_credits lists everyone across all seasons, with their character names under roles
    const credits = type === 'tv' ? 'aggregate_credits' : 'credits';
    const r = await fetch(`https://api.themoviedb.org/3/${type}/${id}?append_to_response=${credits}&api_key=${encodeURIComponent(TMDB_KEY)}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw httpError(r.status === 404 ? 404 : 502, `TMDB answered HTTP ${r.status}`);
    const j = await r.json();
    const runtime = Number(type === 'tv' ? (j.episode_run_time || [])[0] || (j.last_episode_to_air && j.last_episode_to_air.runtime) : j.runtime) || 0;
    const cast = ((j[credits] && j[credits].cast) || []).slice(0, 12).map((c) => ({
      name: c.name || '',
      role: c.character || (c.roles && c.roles[0] && c.roles[0].character) || '',
      photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : '',
    }));
    tmdbCache.set(key, { runtime, cast });
    if (tmdbCache.size > 200) tmdbCache.delete(tmdbCache.keys().next().value);
  }
  sendJson(res, 200, tmdbCache.get(key));
}

// GET /api/trending -> { movie: [...], tv: [...] }, this week's 40 most popular of each on TMDB, best first:
// { id, title, original, year, overview, backdrop }. The page matches them against the playlists. Kept 6 hours.
let trending = null;   // { t, job }
const TRENDING_TTL = 6 * 3600e3;
async function loadTrending() {
  const one = async (type, page) => {
    const r = await fetch(`https://api.themoviedb.org/3/trending/${type}/week?page=${page}&api_key=${encodeURIComponent(TMDB_KEY)}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw httpError(502, `TMDB answered HTTP ${r.status}`);
    return ((await r.json()).results || []).map((x) => ({
      id: x.id,
      title: x.title || x.name || '',
      original: x.original_title || x.original_name || '',
      year: String(x.release_date || x.first_air_date || '').slice(0, 4),
      overview: x.overview || '',
      backdrop: x.backdrop_path ? `https://image.tmdb.org/t/p/w1280${x.backdrop_path}` : '',
    }));
  };
  const [m1, m2, t1, t2] = await Promise.all([one('movie', 1), one('movie', 2), one('tv', 1), one('tv', 2)]);
  return { movie: [...m1, ...m2], tv: [...t1, ...t2] };
}
async function handleTrending(req, res) {
  if (!TMDB_KEY) throw httpError(501, 'Trending isn’t available in this build');
  if (!trending || Date.now() - trending.t > TRENDING_TTL) {
    trending = { t: Date.now(), job: loadTrending() };
    trending.job.catch(() => { trending = null; });   // a failed ask is tried again next time
  }
  sendJson(res, 200, await trending.job);
}

/* ----------------------------------------------------------------- static */

function serveStatic(req, res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);   // e.g. the file went away after stat: an unhandled error would crash the app
  });
}

/* ----------------------------------------------------------------- server */

function requestAllowed(req) {
  // Guard against DNS-rebinding / other websites using the local proxy.
  // An <img> or no-cors fetch from another site sends no Origin, but browsers mark it in Sec-Fetch-Site.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const hostname = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; }
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (!requestAllowed(req)) return send(res, 403, 'Forbidden');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  try {
    if (url.pathname === '/api/fetch' && req.method === 'GET') await handleFetch(req, res, url.searchParams);
    else if (url.pathname === '/api/epg' && req.method === 'POST') await handleEpg(req, res);
    else if (url.pathname === '/api/stream' && req.method === 'GET') await handleStream(req, res, url.searchParams);
    else if (url.pathname === '/api/shared' && req.method === 'GET') handleShared(req, res, url.searchParams);
    else if (url.pathname === '/api/shared/stats' && req.method === 'GET') handleSharedStats(req, res);
    else if (url.pathname === '/api/tracks' && req.method === 'GET') handleTracks(req, res, url.searchParams);
    else if (url.pathname === '/api/capabilities' && req.method === 'GET') handleCapabilities(req, res);
    else if (url.pathname === '/api/tmdb' && req.method === 'GET') await handleTmdb(req, res, url.searchParams);
    else if (url.pathname === '/api/trending' && req.method === 'GET') await handleTrending(req, res);
    else if (url.pathname === '/api/probe' && req.method === 'GET') handleProbe(req, res, url.searchParams);
    else if (url.pathname === '/api/keyframe' && req.method === 'GET') handleKeyframe(req, res, url.searchParams);
    else if (url.pathname === '/api/transcode' && req.method === 'GET') handleTranscode(req, res, url.searchParams);
    else if (/^\/api\/local\/[a-f0-9]{8,32}\/subs/.test(url.pathname) && req.method === 'GET') await handleLocalSubs(req, res, url.pathname, url.searchParams);
    else if (url.pathname.startsWith('/api/tcsubs/') && req.method === 'GET') await handleTcSubs(req, res, url.pathname);
    else if (url.pathname.startsWith('/api/local/') && (req.method === 'GET' || req.method === 'HEAD')) handleLocal(req, res, url.pathname);
    else if (url.pathname.startsWith('/api/subs/') && req.method === 'POST') await handleSubsApi(req, res, url.pathname);
    else send(res, 404, 'Not found');
  } catch (e) {
    if (res.headersSent) return res.destroy();
    const { status, message } = friendlyError(e);
    sendJson(res, status, { error: message });
  }
});

// Start listening. Resolves with the port actually used (pass 0 for "any free port").
function start(port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

module.exports = { start, server, setLocalFiles, DEFAULT_UA, parseXmltvTime, xmltvParser, rewriteM3u8, parseAudioStreams, tsSniffer, tsStitcher, shareTuning };   // the last seven for test/
