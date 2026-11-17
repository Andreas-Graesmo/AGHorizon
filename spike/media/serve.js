#!/usr/bin/env node
'use strict';
// Phase 0.1 media spike server. Runs AG Horizon's real server.js request handler on the app's origin
// (http://127.0.0.1:47831) and adds:
//   /spike/            the test page (page/)
//   /spike/fx/...      the fixtures (with HTTP Range), also used as "provider" URLs for /api/stream and /api/transcode
//   POST /spike/results   the page posts its JSON here; written to results/<label>.json
// Usage: node spike/media/serve.js [--label linux-webkitgtk] [--exit-after-results]
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const LABEL = opt('--label', 'unlabelled');
const EXIT_AFTER = args.includes('--exit-after-results');
const PORT = Number(process.env.TUNER_PORT) || 47831;

const { server: app } = require('../../server');
const appHandler = app.listeners('request')[0];

const PAGE = path.join(__dirname, 'page');
const FX = path.join(__dirname, 'fixtures');
const RESULTS = path.join(__dirname, 'results');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.ts': 'video/mp2t', '.m3u8': 'application/vnd.apple.mpegurl',
};

const CLIP_SECONDS = 12;   // gen-fixtures.js
// ?live=1: send at the clip's own bit rate after a 2 s head start, like a provider's live channel. Sent all at once,
// mpegts.js (liveBufferLatencyChasing) would rightly jump to the end of a 12 s buffer.
function sendLive(res, file, size, type) {
  const perTick = Math.ceil(size / CLIP_SECONDS / 10);   // 100 ms ticks
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  let off = Math.min(size, perTick * 20);
  res.write(buf.subarray(0, off));
  const iv = setInterval(() => {
    if (off >= size) { clearInterval(iv); return res.end(); }
    res.write(buf.subarray(off, off + perTick));
    off += perTick;
  }, 100);
  res.on('close', () => clearInterval(iv));
}

function sendFile(req, res, file, live = false) {
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  if (live) return sendLive(res, file, st.size, type);
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function inside(root, rel) {
  const p = path.normalize(path.join(root, decodeURIComponent(rel)));
  return p.startsWith(root + path.sep) || p === root ? p : null;
}

function summary(r) {
  const lines = [`\n=== ${r.label} — ${r.ua}`];
  for (const t of r.tests) lines.push(`${t.status.padEnd(4)}  ${t.name}${t.note ? `  (${t.note})` : ''}`);
  return lines.join('\n');
}

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  if (u.pathname === '/spike') { res.writeHead(302, { Location: '/spike/' }); return res.end(); }
  if (u.pathname === '/spike/progress' && req.method === 'POST') {   // one line per finished test, so a hang shows where
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { console.log(`[${LABEL}] ${body.slice(0, 500)}`); res.writeHead(204); res.end(); });
    return;
  }
  if (u.pathname === '/spike/results' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4e6) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); }
      data.label = LABEL;
      fs.mkdirSync(RESULTS, { recursive: true });
      const file = path.join(RESULTS, `${LABEL}.json`);
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      console.log(summary(data));
      console.log(`\nwritten: ${file}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      if (EXIT_AFTER) setTimeout(() => process.exit(0), 300);
    });
    return;
  }
  if (u.pathname.startsWith('/spike/fx/')) {
    const f = inside(FX, u.pathname.slice('/spike/fx/'.length));
    if (!f) { res.writeHead(403); return res.end(); }
    return sendFile(req, res, f, u.searchParams.has('live'));
  }
  if (u.pathname.startsWith('/spike/')) {
    const f = inside(PAGE, u.pathname.slice('/spike/'.length) || 'index.html');
    if (!f) { res.writeHead(403); return res.end(); }
    return sendFile(req, res, f);
  }
  return appHandler(req, res);   // the real app: /api/*, /vendor/*, the UI
});

srv.listen(PORT, '127.0.0.1', () => console.log(`media spike on http://127.0.0.1:${PORT}/spike/  label=${LABEL}  ffmpeg=${process.env.FFMPEG_PATH || '(server.js default)'}`));
