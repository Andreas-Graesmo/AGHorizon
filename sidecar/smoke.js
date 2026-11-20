#!/usr/bin/env node
'use strict';
/*
 * Smoke test of the built server sidecar (MIGRATION_PLAN.md 0.3), the way the Tauri app will use it:
 * start the executable with the env the app passes, wait for "READY <port>", then go through the routes the UI uses.
 * Also: a second copy on the same port must say "ERROR EADDRINUSE", and closing stdin must end the server.
 * Usage: FFMPEG_PATH=/path/to/ffmpeg node sidecar/smoke.js [executable]
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const exe = process.argv[2] || fs.readdirSync(path.join(__dirname, 'dist')).filter((f) => f.startsWith('aghorizon-server-')).map((f) => path.join(__dirname, 'dist', f))[0];
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-sidecar-'));
const results = [];
const check = (name, ok, note = '') => { results.push({ name, ok, note }); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`); };

// a "provider": serves a short clip and a playlist, on its own port
const clip = path.join(tmp, 'clip.ts');
const gen = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '25', '-c:a', 'ac3', '-f', 'mpegts', clip]);
if (gen.status !== 0) { console.error(`could not make a test clip with ${ffmpeg}: ${gen.stderr}`); process.exit(2); }
const provider = http.createServer((req, res) => {
  if (req.url.startsWith('/clip.ts')) { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return fs.createReadStream(clip).pipe(res); }
  if (req.url === '/list.m3u') { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); return res.end('#EXTM3U\n#EXTINF:-1,Test\nhttp://example.invalid/1.ts\n'); }
  res.writeHead(404); res.end();
});

function startServer(port, { watchStdin = true } = {}) {
  // API keys come as env (secrets.json is not bundled); dummy values here, only their presence is checked
  const env = { ...process.env, PUBLIC_DIR: path.join(root, 'public'), FFMPEG_PATH: ffmpeg, TMPDIR: tmp, TEMP: tmp, TMP: tmp, TMDB_API_KEY: 'smoke', OPENSUBTITLES_API_KEY: 'smoke' };
  if (!watchStdin) env.AGH_NO_STDIN_WATCH = '1';
  const t0 = Date.now();
  const child = spawn(exe, [String(port)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));
  const first = new Promise((resolve) => {
    child.stdout.on('data', (d) => { out += d; const line = out.split('\n')[0]; if (out.includes('\n')) resolve({ line: line.trim(), ms: Date.now() - t0 }); });
    child.on('exit', (code) => resolve({ line: out.trim() || `exited ${code}`, ms: Date.now() - t0, code }));
  });
  return { child, first };
}
const get = (port, p) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    const chunks = []; let n = 0;
    res.on('data', (c) => { if (n < 65536) chunks.push(c); n += c.length; if (n > 65536) req.destroy(); });
    const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), bytes: n });
    res.on('end', done); res.on('close', done);
  });
  req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  req.setTimeout(30000, () => req.destroy(new Error('timeout')));
});
const exited = (child, ms) => new Promise((resolve) => { const t = setTimeout(() => resolve(false), ms); child.on('exit', () => { clearTimeout(t); resolve(true); }); });

(async () => {
  console.log(`sidecar: ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)`);
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  const prov = `http://127.0.0.1:${provider.address().port}`;
  const enc = encodeURIComponent;

  const a = startServer(0);
  const ready = await a.first;
  const m = /^READY (\d+)$/.exec(ready.line);
  check('starts and prints READY <port>', !!m, `${ready.line}, ${ready.ms} ms`);
  if (!m) process.exit(1);
  const port = Number(m[1]);

  let r = await get(port, '/');
  check('serves the UI from PUBLIC_DIR', r.status === 200 && /<html/i.test(r.body.toString()), `HTTP ${r.status}`);
  r = await get(port, '/js/player.js');
  check('serves the app scripts', r.status === 200 && r.body.includes('function playChannel'), `HTTP ${r.status}`);
  r = await get(port, '/api/capabilities');
  const caps = JSON.parse(r.body.toString());
  check('/api/capabilities: finds ffmpeg from FFMPEG_PATH', caps.ffmpeg === true, r.body.toString());
  check('API keys from env (TMDB, OpenSubtitles)', caps.tmdb === true && caps.opensubtitles === true, r.body.toString());
  r = await get(port, `/api/fetch?url=${enc(`${prov}/list.m3u`)}`);
  check('/api/fetch: playlist', r.status === 200 && r.body.toString().startsWith('#EXTM3U'), `HTTP ${r.status}`);
  r = await get(port, `/api/stream?url=${enc(`${prov}/clip.ts`)}`);
  check('/api/stream: proxies the stream', r.status === 200 && r.body[0] === 0x47, `HTTP ${r.status}, ${r.bytes} bytes, first byte 0x${r.body[0] && r.body[0].toString(16)}`);
  r = await get(port, `/api/probe?url=${enc(`${prov}/clip.ts`)}`);
  const probe = r.status === 200 ? JSON.parse(r.body.toString()) : {};
  check('/api/probe: ffmpeg reads the codecs', probe.video === 'h264' && probe.audio === 'ac3', `video=${probe.video}, audio=${probe.audio}`);
  r = await get(port, `/api/transcode?url=${enc(`${prov}/clip.ts`)}&video=copy`);
  const box = r.body.subarray(4, 8).toString('latin1');
  check('/api/transcode: fMP4 out of ffmpeg', r.status === 200 && box === 'ftyp' && r.bytes > 10000, `HTTP ${r.status}, ${r.headers['content-type']}, first box ${box}, ${r.bytes} bytes`);
  r = await get(port, '/api/../server.js');
  check('static: no way out of PUBLIC_DIR', r.status !== 200 || !r.body.includes('createServer'), `HTTP ${r.status}`);

  // a second copy on the same port (the app's fixed 47831): the app shows an error dialog for this
  const b = startServer(port, { watchStdin: false });
  const busy = await b.first;
  check('second copy on the same port: ERROR EADDRINUSE, exit 1', /^ERROR EADDRINUSE/.test(busy.line) && (await exited(b.child, 3000) || b.child.exitCode === 1), busy.line);

  // the app went away: its end of the pipe closes
  a.child.stdin.end();
  const gone = await exited(a.child, 3000);
  check('exits when stdin closes (the app quit or was killed)', gone, gone ? `exit code ${a.child.exitCode}` : 'still running after 3 s');
  if (!gone) a.child.kill();

  // the app is killed (crash, Task Manager): nobody closes stdin, the OS breaks the pipe when the parent dies
  const parent = spawn(process.execPath, ['-e', `
    const c = require('child_process').spawn(${JSON.stringify(exe)}, ['0'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PUBLIC_DIR: ${JSON.stringify(path.join(root, 'public'))} } });
    c.stdout.on('data', (d) => { if (String(d).startsWith('READY')) console.log('CHILD ' + c.pid); });
    setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const childPid = await new Promise((resolve) => { let o = ''; parent.stdout.on('data', (d) => { o += d; const mm = /CHILD (\d+)/.exec(o); if (mm) resolve(Number(mm[1])); }); setTimeout(() => resolve(null), 10000); });
  if (!childPid) check('exits when the app is killed', false, 'the test parent never saw READY');
  else {
    parent.kill('SIGKILL');
    const alive = () => { try { process.kill(childPid, 0); return true; } catch { return false; } };
    const t0 = Date.now();
    while (alive() && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
    const ok = !alive();
    check('exits when the app is killed (no orphan)', ok, ok ? `gone ${Date.now() - t0} ms after the kill` : 'still running 5 s after the kill');
    if (!ok) try { process.kill(childPid); } catch { /* */ }
  }

  provider.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
