#!/usr/bin/env node
'use strict';
/*
 * MIGRATION_PLAN.md 9.9 gate, on Linux (the AppImage) and macOS (the .app): the Tauri app updates itself from N to N+1.
 * Both versions are built with a throwaway signing key (.github/workflows/tauri-update.yml); a local server stands in
 * for GitHub (AGH_UPDATER_ENDPOINT; test builds allow http). WebKit has no DevTools protocol for a test to drive the
 * page, so AGH_UPDATER_AUTO=1 makes the app check, download and install at start as the page would, and log each
 * status (src-tauri/src/updater.rs auto_for_tests). Two runs of N:
 *   1. N+1 whose file doesn't match its signature  → refused; the app on disk is unchanged
 *   2. N+1 as released                             → installed in place; the app starts again by itself as N+1
 *      (its own check then finds nothing newer), and closing it leaves nothing running
 * Usage: node e2e/tauri-update-unix.js <N: AppImage or .app> <dir with N+1's release files and latest.json>
 * (Linux needs Xvfb.)
 */
const { spawn, spawnSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const [appN, dirNext] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!appN || !dirNext) { console.error('usage: node e2e/tauri-update-unix.js <N AppImage or .app> <dir of N+1>'); process.exit(2); }
const mac = appN.endsWith('.app');
const latest = JSON.parse(fs.readFileSync(path.join(dirNext, 'latest.json'), 'utf8'));
const key = mac ? (process.arch === 'arm64' ? 'darwin-aarch64-app' : 'darwin-x86_64-app') : 'linux-x86_64-appimage';
const entry = latest.platforms[key];
if (!entry) throw new Error(`latest.json has no ${key}`);
const updateFile = path.join(dirNext, decodeURIComponent(path.basename(new URL(entry.url).pathname)));
const PORT = 47900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, note = '') => { results.push(!!ok); console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`); };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// the real path: on macOS Tauri refuses to start from a path with a symlink in it, and /var (os.tmpdir()) is one
const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agh-update-'));
const home = path.join(work, 'home');
fs.mkdirSync(home);
// the installed app: an AppImage in a folder of the user's, or the .app in ~/Applications
const installed = mac ? path.join(home, 'Applications', 'AG Horizon.app') : path.join(home, 'Apps', 'AG-Horizon.AppImage');
fs.mkdirSync(path.dirname(installed), { recursive: true });
const plistVersion = () => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(installed, 'Contents', 'Info.plist')]).toString().trim();
// what is installed: the AppImage's checksum, or the .app's version
const fingerprint = () => (mac ? plistVersion() : sha(installed));
const wantNext = mac ? latest.version : sha(updateFile);

// the stand-in for GitHub: latest.json in one of two forms, and the files
let mode = 'tampered';
const tampered = path.join(work, 'tampered.bin');
fs.writeFileSync(tampered, Buffer.concat([fs.readFileSync(updateFile), Buffer.from('not what was signed')]));
const server = http.createServer((q, r) => {
  if (q.url === '/latest.json') {
    const url = `http://127.0.0.1:${PORT}/${mode === 'tampered' ? 'tampered.bin' : path.basename(updateFile)}`;
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ ...latest, platforms: { [key]: { signature: entry.signature, url } } }));
    return;
  }
  const f = q.url === '/tampered.bin' ? tampered : path.join(dirNext, decodeURIComponent(q.url.slice(1)));
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Length': fs.statSync(f).size });
  fs.createReadStream(f).pipe(r);
}).listen(PORT, '127.0.0.1');

let xvfb = null;
const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, '.local', 'share'), AGH_NO_DIALOG: '1', AGH_UPDATER_AUTO: '1', AGH_UPDATER_ENDPOINT: `http://127.0.0.1:${PORT}/latest.json` };
if (!mac) {
  // our own X server: xvfb-run would stop it when the first app exits to start the new version
  xvfb = spawn('Xvfb', [':97', '-screen', '0', '1280x800x24'], { stdio: 'ignore' });
  env.DISPLAY = ':97';
  env.APPIMAGE_EXTRACT_AND_RUN = '1';   // no FUSE on a CI runner: the AppImage unpacks itself to run
}
const exe = () => (mac ? path.join(installed, 'Contents', 'MacOS', 'ag-horizon') : installed);
const running = () => {
  const pat = mac ? installed : 'appimage_extracted|AG-Horizon.AppImage|ag-horizon';
  return spawnSync('pgrep', ['-f', pat]).stdout.toString().split('\n').filter(Boolean)
    .map((pid) => spawnSync('ps', ['-o', 'pid=,command=', '-p', pid]).stdout.toString().trim()).filter((l) => l && !/pgrep|e2e\/tauri-update-unix/.test(l));
};
function launch(logName) {
  const logFile = path.join(work, logName);
  const fd = fs.openSync(logFile, 'w');
  spawn(exe(), [], { env, stdio: ['ignore', fd, fd], detached: true }).unref();
  return () => fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('[updater-auto]')).map((l) => JSON.parse(l.slice('[updater-auto] '.length)));
}
async function waitFor(fn, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) { const v = fn(); if (v) return v; }
  return null;
}
// stop every copy the checks above count (SIGTERM, as closing it; the app stops its server)
async function killAll() {
  const pids = () => running().map((l) => l.split(/\s+/)[0]);
  for (const pid of pids()) { try { process.kill(Number(pid), 'SIGTERM'); } catch {} }
  await waitFor(() => running().length === 0, 15000);
}

(async () => {
  try {
    if (mac) execFileSync('cp', ['-R', appN, installed]); else { fs.copyFileSync(appN, installed); fs.chmodSync(installed, 0o755); }
    const before = fingerprint();
    await sleep(mac ? 0 : 1000);

    // 1. a file that doesn't match its signature
    let statuses = launch('run1.log');
    const refused = await waitFor(() => statuses().find((s) => s.state === 'error' || s.state === 'ready' || s.state === 'idle'), 120000);
    check('N+1 is offered', statuses().some((s) => s.state === 'available' && s.version === latest.version), JSON.stringify(statuses()[0] || null));
    check('a file that doesn\'t match its signature is refused', refused && refused.state === 'error', JSON.stringify(refused));
    await sleep(1000);
    check('the installed app is unchanged', fingerprint() === before);
    await killAll();

    // 2. as released: installed, and the app starts again as N+1
    mode = 'good';
    statuses = launch('run2.log');
    const done = await waitFor(() => { const s = statuses(); return s.some((x) => x.state === 'idle') && s; }, 180000);
    check('N+1 is downloaded and installed', !!done, JSON.stringify(statuses()));
    const replaced = await waitFor(() => fingerprint() === wantNext, 30000);
    check(`the installed app is now N+1 (${latest.version})`, !!replaced, mac ? plistVersion() : '');
    if (mac) {
      // macOS starts it again through LaunchServices, which passes on neither this test's environment nor its log:
      // see that a new copy runs from the updated .app (whose version was checked above)
      const back = await waitFor(() => running().some((l) => l.includes(path.join(installed, 'Contents', 'MacOS', 'ag-horizon'))), 60000);
      check('it started again by itself, from the updated .app', !!back, running().join(' | '));
    } else {
      // the new version checks again at its start: nothing newer than itself
      const again = await waitFor(() => statuses().filter((s) => s.state === 'current').length > 0, 120000);
      check('it started again by itself and finds nothing newer', !!again, JSON.stringify(statuses().slice(-2)));
    }
    // the app's own program (its command line may be just "ag-horizon"), not the AppImage runtime or the server.
    // The old copy may still be on its way out just after the new one has started: give it a moment to go, so this
    // fails on two copies that stay, not on the overlap of a restart.
    const apps = () => running().filter((l) => /(^\d+\s+|\/)ag-horizon(\s|$)/.test(l));
    const one = await waitFor(() => apps().length === 1, 15000);
    check('exactly one copy of the app runs', !!one, running().join(' | '));
  } finally {
    await killAll();
    const left = running();
    check('nothing left running after closing', left.length === 0, left.join(' | '));
    for (const l of left) { try { process.kill(Number(l.split(/\s+/)[0]), 'SIGKILL'); } catch {} }
    server.close();
    if (xvfb) xvfb.kill();
  }
  const failed = results.filter((ok) => !ok).length;
  if (failed) {
    for (const f of ['run1.log', 'run2.log']) {
      const p = path.join(work, f);
      if (fs.existsSync(p)) console.log(`--- ${f} (tail) ---\n${fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/plugin loader failed|DRI3|accelerated/.test(l)).slice(-25).join('\n')}`);
    }
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`OK: ${mac ? 'the .app' : 'the AppImage'} updated itself from N to ${latest.version}`);
})().catch(async (e) => { console.error(e); await killAll(); if (xvfb) xvfb.kill(); process.exit(1); });
