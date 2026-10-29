#!/usr/bin/env node
'use strict';
/**
 * AG Horizon – tiny local server (no dependencies, Node 18+).
 *
 *  - serves the web app in ./public
 *  - /api/fetch   fetches playlists / Xtream API responses (avoids browser CORS limits)
 *  - /api/epg     downloads + parses an XMLTV guide (plain or .gz) into compact JSON
 *  - /api/stream  proxies live streams; HLS manifests are rewritten so segments also pass through
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
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
  let u;
  try { u = new URL(urlStr); } catch { throw httpError(400, 'Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpError(400, 'Only http(s) URLs are supported');
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

function parseXmltv(xml, fromMs, toMs) {
  const chNames = {}; // channel id -> [normalised display names]
  const chRe = /<channel\b[^>]*?\bid\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = chRe.exec(xml))) {
    const names = [];
    const nRe = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g;
    let n;
    while ((n = nRe.exec(m[3]))) { const k = normName(decode(n[1])); if (k) names.push(k); }
    chNames[decode(m[2])] = names;
  }

  const programmes = {};
  let count = 0;
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
  for (const id in programmes) programmes[id].sort((a, b) => a[0] - b[0]);
  return { chNames, programmes, count, parsedAt: Date.now() };
}

const epgCache = new Map(); // url -> { t, full }
const EPG_TTL = 30 * 60 * 1000;

async function loadEpg(url, ua, force) {
  const hit = epgCache.get(url);
  if (hit && !force && Date.now() - hit.t < EPG_TTL) return hit.full;
  const r = await upstream(url, { ua, signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw httpError(502, `Guide download failed (HTTP ${r.status})`);
  const xml = maybeGunzip(Buffer.from(await r.arrayBuffer())).toString('utf8');
  if (!/<tv\b/i.test(xml)) throw httpError(502, 'That URL did not return an XMLTV guide');
  const now = Date.now();
  const full = parseXmltv(xml, now - 3 * 3600e3, now + 36 * 3600e3);
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

function rewriteM3u8(text, baseUrl, ua) {
  const prox = (u) => {
    if (/^data:/i.test(u)) return u;
    const abs = new URL(u, baseUrl).href;
    return `/api/stream?url=${encodeURIComponent(abs)}${ua ? `&ua=${encodeURIComponent(ua)}` : ''}`;
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
      return send(res, 200, rewriteM3u8(text, r.url, ua), { 'Content-Type': 'application/vnd.apple.mpegurl' });
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
  Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
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
  sendJson(res, 200, { ffmpeg: !!ffmpeg() });
}

// Reports duration and codecs so the UI can choose between "copy video" and "re-encode video".
function handleProbe(req, res, q) {
  const bin = ffmpeg();
  if (!bin) throw httpError(501, 'ffmpeg is not installed');
  const url = checkUrl(q.get('url'));
  const proc = spawn(bin, ffmpegInput(url, q.get('ua'), ['-analyzeduration', '4000000', '-probesize', '4000000']), { stdio: ['ignore', 'ignore', 'pipe'] });
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
    });
  });
  res.on('close', () => proc.kill('SIGKILL'));
}

let activeConversions = 0;
const MAX_CONVERSIONS = 3;

function handleTranscode(req, res, q) {
  const bin = ffmpeg();
  if (!bin) throw httpError(501, 'ffmpeg is not installed');
  if (activeConversions >= MAX_CONVERSIONS) throw httpError(429, 'Too many conversions are running – wait a moment and try again');
  const url = checkUrl(q.get('url'));
  const start = Math.max(0, Number(q.get('start')) || 0);
  const copyVideo = q.get('video') === 'copy';

  const args = [
    ...ffmpegInput(url, q.get('ua'), ['-analyzeduration', '5000000', '-probesize', '10000000', ...(start ? ['-ss', String(Math.floor(start))] : [])]),
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    ...(copyVideo
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
         '-vf', "scale=-2:'min(1080,ih)'", '-g', '50', '-keyint_min', '50', '-sc_threshold', '0']),
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2', // stereo AAC plays everywhere (and downmixes DTS / AC-3 5.1)
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ];

  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  activeConversions++;
  let started = false;
  let finished = false;
  let err = '';
  const finish = () => { if (finished) return false; finished = true; activeConversions--; return true; };

  proc.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  proc.stdout.on('data', (chunk) => {
    if (!started) {
      started = true;
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' });
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
  res.on('close', () => proc.kill('SIGKILL')); // browser navigated away / switched channel
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
    fs.createReadStream(file).pipe(res);
  });
}

/* ----------------------------------------------------------------- server */

function requestAllowed(req) {
  // Guard against DNS-rebinding / other websites using the local proxy.
  if (LOOPBACK) {
    const hostname = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return false;
  }
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
    else if (url.pathname === '/api/capabilities' && req.method === 'GET') handleCapabilities(req, res);
    else if (url.pathname === '/api/probe' && req.method === 'GET') handleProbe(req, res, url.searchParams);
    else if (url.pathname === '/api/transcode' && req.method === 'GET') handleTranscode(req, res, url.searchParams);
    else send(res, 404, 'Not found');
  } catch (e) {
    if (res.headersSent) return res.destroy();
    const { status, message } = friendlyError(e);
    sendJson(res, status, { error: message });
  }
});

// Start listening. Resolves with the port actually used (pass 0 for "any free port").
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

module.exports = { start, server };

// `node server.js` runs it as a plain web server; the desktop app (electron/main.js) calls start() instead.
if (require.main === module) {
  start().then((port) => {
    const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`AG Horizon running at http://${shown}:${port}`);
    if (!LOOPBACK) console.log('Warning: listening on a non-local address – anyone on your network can use this proxy.');
  }).catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use – set another with PORT=9000` : e.message);
    process.exit(1);
  });
}
