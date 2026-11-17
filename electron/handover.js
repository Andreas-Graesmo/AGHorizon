'use strict';
/**
 * Handing over to the Tauri build (MIGRATION_PLAN.md 1.3), Windows only.
 * When the newest release on the person's update channel is a Tauri build — it carries the Tauri updater's
 * latest.json — this Electron version offers it as an ordinary update. It downloads the Windows installer, checks its
 * minisign signature against the public key shipped in electron/tauri-updater.key.pub, saves the person's data for
 * the new app (migration.js), and runs the installer.
 *
 * Without electron/tauri-updater.key.pub this is all switched off: the key pair is made in MIGRATION_PLAN.md 5.1.
 * Pure functions are exported for test/handover.test.js; nothing here needs Electron.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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

// The Windows installer named in a Tauri latest.json, only if it comes from this repository's releases.
function windowsInstaller(latest, { owner, repo }) {
  const p = (latest && latest.platforms) || {};
  const entry = p['windows-x86_64-nsis'] || p['windows-x86_64'];
  if (!entry || !entry.url || !entry.signature) return null;
  let u;
  try { u = new URL(entry.url); } catch { return null; }
  const prefix = `/${owner}/${repo}/releases/download/`.toLowerCase();
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || !u.pathname.toLowerCase().startsWith(prefix) || !/\.exe$/i.test(u.pathname)) return null;
  return { url: u.href, signature: entry.signature, version: String(latest.version || '') };
}

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

module.exports = { PUBKEY_FILE, publicKey, parsePublicKey, verify, findRelease, windowsInstaller, download, runInstaller };
