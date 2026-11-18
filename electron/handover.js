'use strict';
/**
 * Handing over to the Tauri build (MIGRATION_PLAN.md 1.3; macOS and Linux: 9.10).
 * When the newest release on the person's update channel is a Tauri build for this system — its latest.json names
 * one — this Electron version offers it as an ordinary update. It downloads it, checks its minisign signature against
 * the public key shipped in electron/tauri-updater.key.pub, saves the person's data for the new app (migration.js),
 * and puts it in place:
 *   Windows  runs Tauri's installer, which replaces this app and starts the new one
 *   Linux    the new AppImage replaces this one under the same file name ($APPIMAGE), so menus and shortcuts keep
 *            working; started once this app has quit
 *   macOS    the new .app replaces this one in its folder (as Tauri's own updater does, no Apple signature needed);
 *            started once this app has quit
 * Where that can't be done (an AppImage-less Linux, a Mac app on the disk image or translocated, a folder that can't
 * be written to), the person gets the release page instead, as before.
 *
 * Without electron/tauri-updater.key.pub this is all switched off: the key pair is made in MIGRATION_PLAN.md 5.1.
 * Pure functions are exported for test/handover.test.js; nothing here needs Electron.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const versions = require('./versions');
const { createBlake2b512 } = require('./blake2b');

// BLAKE2b-512: Node's own when it has it; Electron's crypto (BoringSSL) doesn't, so then the plain-JS one.
const nativeBlake = (() => { try { crypto.createHash('blake2b512'); return true; } catch { return false; } })();
const blakeHasher = () => (nativeBlake ? crypto.createHash('blake2b512') : createBlake2b512());

const PUBKEY_FILE = path.join(__dirname, 'tauri-updater.key.pub');
const publicKey = () => { try { return fs.readFileSync(PUBKEY_FILE, 'utf8').trim(); } catch { return ''; } };

/* ─────────────── minisign, as written by `tauri signer` ─────────────── */
// A key or signature file as Tauri stores it: base64 of the minisign text ("untrusted comment: …\n<base64>…").
const lines = (b64) => Buffer.from(String(b64).trim(), 'base64').toString('utf8').split(/\r?\n/);

function parsePublicKey(b64) {
  const raw = Buffer.from(lines(b64)[1] || '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('not a minisign public key');
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

// Is `data` (a Buffer) signed by the key? The signature line is "ED" (BLAKE2b-512 of the file is signed) or "Ed"
// (the file itself, legacy); the global signature covers that signature plus the trusted comment.
// prehash: the file's BLAKE2b-512 when already known (download() works it out as the file arrives).
function verify(data, sigB64, pubB64, prehash = null) {
  try {
    const pub = parsePublicKey(pubB64);
    const l = lines(sigB64);
    const sig = Buffer.from(l[1] || '', 'base64');
    const trusted = /^trusted comment: /.test(l[2] || '') ? l[2].slice('trusted comment: '.length) : null;
    const global = Buffer.from(l[3] || '', 'base64');
    if (sig.length !== 74) return { ok: false, reason: 'malformed signature' };
    const alg = sig.subarray(0, 2).toString('latin1');
    if (!sig.subarray(2, 10).equals(pub.keyId)) return { ok: false, reason: 'signed with another key' };
    const keyObj = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub.key]), format: 'der', type: 'spki' });
    const message = alg === 'ED' ? (prehash || blakeHasher().update(data).digest()) : alg === 'Ed' ? data : null;
    if (!message) return { ok: false, reason: `unknown signature algorithm ${alg}` };
    if (!crypto.verify(null, message, keyObj, sig.subarray(10))) return { ok: false, reason: 'the file does not match its signature' };
    if (trusted == null || global.length !== 64) return { ok: false, reason: 'no trusted comment' };
    if (!crypto.verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted, 'utf8')]), keyObj, global)) return { ok: false, reason: 'the trusted comment was changed' };
    return { ok: true };
  } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

/* ─────────────── which release ─────────────── */
const hasUpdaterJson = (rel) => (rel.assets || []).find((a) => a.name === 'latest.json');

// The newest published release on the channel that is a Tauri build and newer than this version, or null.
// test: the newest of every published release and pre-release (as updater.js manualCheck); stable: GitHub's latest.
// api(path) is a fetch of https://api.github.com/repos/<owner>/<repo><path>.
async function findRelease({ channel, current, api }) {
  let rels;
  if (channel === 'test') {
    const r = await api('/releases?per_page=30');
    if (!r.ok) throw new Error('GitHub answered ' + r.status);
    rels = await r.json();
  } else {
    const r = await api('/releases/latest');
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub answered ' + r.status);
    rels = [await r.json()];
  }
  let best = null;
  for (const rel of rels) {
    const tag = String(rel.tag_name || '');
    if (rel.draft || !versions.parse(tag) || !hasUpdaterJson(rel)) continue;
    if (!best || versions.compare(tag, best.tag_name) > 0) best = rel;
  }
  if (!best || versions.compare(best.tag_name, current) <= 0) return null;
  return { version: String(best.tag_name).replace(/^v/i, ''), tag: best.tag_name, notes: String(best.body || ''), latestJsonUrl: hasUpdaterJson(best).browser_download_url };
}

// This system's update named in a Tauri latest.json (scripts/tauri-release.js), only if it comes from this
// repository's releases over https.
const UPDATE = {
  win32: { keys: ['windows-x86_64-nsis', 'windows-x86_64'], file: /\.exe$/i },
  linux: { keys: ['linux-x86_64-appimage', 'linux-x86_64'], file: /\.AppImage$/i },
  darwin: { keys: ['darwin-aarch64-app', 'darwin-aarch64'], file: /\.app\.tar\.gz$/i },
};
function updateFor(latest, { owner, repo }, platform = process.platform, arch = process.arch) {
  const want = UPDATE[platform];
  // the Tauri builds: Windows and Linux x64, macOS Apple silicon
  if (!want || (platform === 'darwin' ? arch !== 'arm64' : arch !== 'x64')) return null;
  const p = (latest && latest.platforms) || {};
  const entry = want.keys.map((k) => p[k]).find(Boolean);
  if (!entry || !entry.url || !entry.signature) return null;
  let u;
  try { u = new URL(entry.url); } catch { return null; }
  const prefix = `/${owner}/${repo}/releases/download/`.toLowerCase();
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || !u.pathname.toLowerCase().startsWith(prefix) || !want.file.test(u.pathname)) return null;
  return { url: u.href, signature: entry.signature, version: String(latest.version || '') };
}
const windowsInstaller = (latest, pub) => updateFor(latest, pub, 'win32', 'x64');

/* ─────────────── download and run ─────────────── */
// Saves the file and returns its BLAKE2b-512, hashed chunk by chunk as it arrives (no second pass that would
// hold up the app's window on a large installer).
async function download(url, dest, onProgress) {
  const r = await fetch(url, { headers: { 'User-Agent': 'AG-Horizon' }, signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!r.ok || !r.body) throw new Error('Download failed: HTTP ' + r.status);
  const total = Number(r.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  const hash = blakeHasher();
  let got = 0, last = -1;
  try {
    for await (const chunk of r.body) {
      got += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (onProgress && pct !== last) { last = pct; onProgress(pct); }
    }
  } finally { await new Promise((res) => out.end(res)); }
  return { file: dest, blake2b512: hash.digest() };
}

// Tauri's NSIS installer: /P = passive (progress bar, no questions). It replaces this app (MIGRATION_PLAN.md 6.5)
// and starts the new one. Detached, so it keeps running when this app quits right after.
function runInstaller(file) {
  const child = spawn(file, ['/P'], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

/* ─────────────── macOS and Linux: put it in place ─────────────── */
// Where this app is and whether it can be replaced there; null when it can't (then: the release page).
//   Linux: the AppImage it was started from ($APPIMAGE), in a folder this user can write to
//   macOS: the .app, not on a disk image (/Volumes) or a translocated copy (an app opened where it was downloaded),
//          in a folder this user can write to
function target({ platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  const writable = (dir) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };
  if (platform === 'linux') {
    const file = env.APPIMAGE;
    return file && fs.existsSync(file) && writable(path.dirname(file)) ? { kind: 'appimage', path: file } : null;
  }
  if (platform === 'darwin') {
    const app = execPath.split('/Contents/MacOS/')[0];
    if (!app.endsWith('.app') || app.startsWith('/Volumes/') || app.includes('/AppTranslocation/')) return null;
    return writable(path.dirname(app)) ? { kind: 'app', path: app } : null;
  }
  return null;
}

// Where the download goes: next to what it replaces (the same disk, so it moves into place in one step)
const stagingFile = (t, version) => path.join(path.dirname(t.path), `.ag-horizon-${version}-${process.pid}${t.kind === 'appimage' ? '.AppImage' : '.app.tar.gz'}`);

// A shell that waits for this app (pid) to quit, then removes what is left of it and starts the new one.
function startAfterQuit(pid, open, remove) {
  const script = `while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.3; done; ${remove ? 'rm -rf -- "$2"; ' : ''}exec ${open} "$1"`;
  return script;
}

// Puts the verified download in place of this app and starts the new one once this app has quit. Throws (leaving
// this app as it was) if it can't. file: the download; t: target().
function install(file, t, { pid = process.pid, spawnFn = spawn, env = process.env } = {}) {
  const dir = path.dirname(t.path);
  // the new app's environment: not this AppImage's (its runtime sets its own)
  const cleanEnv = { ...env };
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete cleanEnv[k];
  if (t.kind === 'appimage') {
    fs.chmodSync(file, 0o755);
    fs.renameSync(file, t.path);   // the running AppImage keeps its (now unnamed) file until it quits
    spawnFn('/bin/sh', ['-c', startAfterQuit(pid, '', false), 'sh', t.path], { detached: true, stdio: 'ignore', env: cleanEnv }).unref();
    return;
  }
  // macOS: unpack next to the app, then swap the two bundles (renames: the old one runs on until it quits)
  const unpack = fs.mkdtempSync(path.join(dir, '.ag-horizon-update-'));
  try {
    const tar = spawnSync('/usr/bin/tar', ['-xzf', file, '-C', unpack], { stdio: 'ignore' });
    const app = fs.readdirSync(unpack).find((n) => n.endsWith('.app'));
    if (tar.status !== 0 || !app) throw new Error('the update could not be unpacked');
    const old = path.join(dir, `.ag-horizon-old-${pid}.app`);
    fs.renameSync(t.path, old);
    try { fs.renameSync(path.join(unpack, app), t.path); } catch (e) { fs.renameSync(old, t.path); throw e; }
    spawnFn('/bin/sh', ['-c', startAfterQuit(pid, '/usr/bin/open -n', true), 'sh', t.path, old], { detached: true, stdio: 'ignore', env: cleanEnv }).unref();
  } finally {
    fs.rmSync(unpack, { recursive: true, force: true });
    fs.rmSync(file, { force: true });
  }
}

module.exports = { PUBKEY_FILE, publicKey, parsePublicKey, verify, findRelease, updateFor, windowsInstaller, download, runInstaller, target, stagingFile, startAfterQuit, install };
