'use strict';
// electron/handover.js: handing over to the Tauri build (MIGRATION_PLAN.md 1.3). Signature fixtures were made with
// `tauri signer` and a throwaway key (test/fixtures/handover/README.md).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('../electron/handover');

const FX = path.join(__dirname, 'fixtures', 'handover');
const pub = fs.readFileSync(path.join(FX, 'test.key.pub'), 'utf8');
const sig = fs.readFileSync(path.join(FX, 'setup.exe.sig'), 'utf8');
const file = fs.readFileSync(path.join(FX, 'setup.exe'));

test('a file signed by tauri signer verifies against its public key', () => {
  assert.deepStrictEqual(h.verify(file, sig, pub), { ok: true });
});

test('a changed file, another key or an edited trusted comment do not verify', () => {
  assert.strictEqual(h.verify(Buffer.concat([file, Buffer.from('x')]), sig, pub).ok, false);
  const other = Buffer.from(Buffer.from(pub, 'base64').toString('utf8').replace(/RWQ\S+/, (k) => { const b = Buffer.from(k, 'base64'); b[20] ^= 1; return b.toString('base64'); })).toString('base64');
  const otherKey = h.verify(file, sig, other);
  assert.strictEqual(otherKey.ok, false);
  const text = Buffer.from(sig, 'base64').toString('utf8').replace('file:setup.exe', 'file:other.exe');
  const edited = h.verify(file, Buffer.from(text).toString('base64'), pub);
  assert.deepStrictEqual(edited, { ok: false, reason: 'the trusted comment was changed' });
  assert.strictEqual(h.verify(file, 'garbage', pub).ok, false);
});

const rel = (tag, { draft = false, tauri = true, body = '' } = {}) => ({
  tag_name: tag, draft, body,
  assets: [{ name: 'AG-Horizon-Setup.exe' }, ...(tauri ? [{ name: 'latest.json', browser_download_url: `https://github.com/o/r/releases/download/${tag}/latest.json` }] : [])],
});
const fakeApi = (routes) => async (p) => {
  if (!(p in routes)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => routes[p] };
};

test('test channel: the newest published Tauri release, beta or stable, newer than this version', async () => {
  const api = fakeApi({ '/releases?per_page=30': [rel('v3.0.0-beta.2', { draft: true }), rel('v3.0.0-beta.1', { body: 'notes' }), rel('v2.9.1', { tauri: false }), rel('v2.9.0')] });
  const r = await h.findRelease({ channel: 'test', current: '2.9.0', api });
  assert.deepStrictEqual(r, { version: '3.0.0-beta.1', tag: 'v3.0.0-beta.1', notes: 'notes', latestJsonUrl: 'https://github.com/o/r/releases/download/v3.0.0-beta.1/latest.json' });
});

test('no hand-over before a Tauri release exists, or when it is not newer', async () => {
  assert.strictEqual(await h.findRelease({ channel: 'test', current: '2.9.0', api: fakeApi({ '/releases?per_page=30': [rel('v2.9.1', { tauri: false })] }) }), null);
  assert.strictEqual(await h.findRelease({ channel: 'stable', current: '3.0.0', api: fakeApi({ '/releases/latest': rel('v3.0.0') }) }), null);
  assert.strictEqual(await h.findRelease({ channel: 'stable', current: '2.9.0', api: fakeApi({}) }), null);   // no release at all
});

test('stable channel: only GitHub\'s latest release', async () => {
  const r = await h.findRelease({ channel: 'stable', current: '2.9.0', api: fakeApi({ '/releases/latest': rel('v3.0.0') }) });
  assert.strictEqual(r.version, '3.0.0');
});

test('the installer must come from this repository\'s releases over https', () => {
  const ok = { version: '3.0.0', platforms: { 'windows-x86_64': { url: 'https://github.com/O/R/releases/download/v3.0.0/AG-Horizon-Setup-3.0.0.exe', signature: 's' } } };
  assert.strictEqual(h.windowsInstaller(ok, { owner: 'o', repo: 'r' }).url, 'https://github.com/O/R/releases/download/v3.0.0/AG-Horizon-Setup-3.0.0.exe');
  const bad = (url) => h.windowsInstaller({ platforms: { 'windows-x86_64': { url, signature: 's' } } }, { owner: 'o', repo: 'r' });
  assert.strictEqual(bad('http://github.com/o/r/releases/download/v3/x.exe'), null);
  assert.strictEqual(bad('https://evil.example/o/r/releases/download/v3/x.exe'), null);
  assert.strictEqual(bad('https://github.com/other/r/releases/download/v3/x.exe'), null);
  assert.strictEqual(bad('https://github.com/o/r/releases/download/v3/x.msi'), null);
  assert.strictEqual(h.windowsInstaller({ platforms: {} }, { owner: 'o', repo: 'r' }), null);
});

test('the release public key (MIGRATION_PLAN.md 1.0) is in place, so the hand-over is on', () => {
  const key = h.parsePublicKey(h.publicKey());
  // minisign prints the key id as hex of the 8 bytes in reverse order
  assert.strictEqual(Buffer.from(key.keyId).reverse().toString('hex').toUpperCase(), 'F074C66F1E88511B');
  // the throwaway test key is a different one: a signature made with it must not pass with the release key
  assert.strictEqual(h.verify(file, sig, h.publicKey()).ok, false);
});

test('the plain-JS BLAKE2b-512 (for Electron) equals Node\'s, whole or in chunks', () => {
  const crypto = require('crypto');
  const { blake2b512, createBlake2b512 } = require('../electron/blake2b');
  for (const n of [0, 1, 127, 128, 129, 256, 1000, 70000]) {
    const d = crypto.randomBytes(n);
    const want = crypto.createHash('blake2b512').update(d).digest();
    assert.ok(blake2b512(d).equals(want), `one go, ${n} bytes`);
    const inc = createBlake2b512();
    for (let i = 0; i < n; i += 37) inc.update(d.subarray(i, i + 37));
    assert.ok(inc.digest().equals(want), `in chunks, ${n} bytes`);
  }
});

test('a signature checks out with a precomputed BLAKE2b (as download() gives)', () => {
  const { blake2b512 } = require('../electron/blake2b');
  assert.deepStrictEqual(h.verify(null, sig, pub, blake2b512(file)), { ok: true });
});

/* ─────────────── macOS and Linux (MIGRATION_PLAN.md 9.10) ─────────────── */
const os = require('os');
const { execFileSync } = require('child_process');
const latestAll = {
  version: '3.2.0',
  platforms: {
    'windows-x86_64-nsis': { url: 'https://github.com/O/R/releases/download/v3.2.0/AG-Horizon-Setup-3.2.0.exe', signature: 'w' },
    'linux-x86_64-appimage': { url: 'https://github.com/O/R/releases/download/v3.2.0/AG-Horizon-3.2.0.AppImage', signature: 'l' },
    'darwin-aarch64-app': { url: 'https://github.com/O/R/releases/download/v3.2.0/AG-Horizon-3.2.0-arm64.app.tar.gz', signature: 'm' },
  },
};

test('each system gets its own update from latest.json, and only for the Tauri builds\' processors', () => {
  const pub = { owner: 'o', repo: 'r' };
  assert.strictEqual(h.updateFor(latestAll, pub, 'linux', 'x64').signature, 'l');
  assert.strictEqual(h.updateFor(latestAll, pub, 'darwin', 'arm64').signature, 'm');
  assert.strictEqual(h.updateFor(latestAll, pub, 'win32', 'x64').signature, 'w');
  assert.strictEqual(h.updateFor(latestAll, pub, 'darwin', 'x64'), null);   // an Intel Mac: no Tauri build for it
  assert.strictEqual(h.updateFor(latestAll, pub, 'linux', 'arm64'), null);
  // the right kind of file, from this repository only
  const wrong = { platforms: { 'linux-x86_64-appimage': { url: 'https://github.com/O/R/releases/download/v3.2.0/AG-Horizon-3.2.0-arm64.app.tar.gz', signature: 'l' } } };
  assert.strictEqual(h.updateFor(wrong, pub, 'linux', 'x64'), null);
  const elsewhere = { platforms: { 'darwin-aarch64-app': { url: 'https://example.com/O/R/releases/download/v3.2.0/x.app.tar.gz', signature: 'm' } } };
  assert.strictEqual(h.updateFor(elsewhere, pub, 'darwin', 'arm64'), null);
});

test('what can be replaced: an AppImage in a writable folder; a Mac app not on a disk image or translocated', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-target-'));
  const img = path.join(d, 'AG-Horizon.AppImage');
  fs.writeFileSync(img, 'x');
  assert.deepStrictEqual(h.target({ platform: 'linux', env: { APPIMAGE: img } }), { kind: 'appimage', path: img });
  assert.strictEqual(h.target({ platform: 'linux', env: {} }), null);                       // not started as an AppImage
  assert.strictEqual(h.target({ platform: 'linux', env: { APPIMAGE: path.join(d, 'gone.AppImage') } }), null);
  const app = path.join(d, 'AG Horizon.app');
  assert.deepStrictEqual(h.target({ platform: 'darwin', execPath: `${app}/Contents/MacOS/AG Horizon` }), { kind: 'app', path: app });
  assert.strictEqual(h.target({ platform: 'darwin', execPath: '/Volumes/AG Horizon/AG Horizon.app/Contents/MacOS/AG Horizon' }), null);
  assert.strictEqual(h.target({ platform: 'darwin', execPath: '/private/var/folders/x/AppTranslocation/1/d/AG Horizon.app/Contents/MacOS/AG Horizon' }), null);
  assert.strictEqual(h.target({ platform: 'win32' }), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('Linux: the new AppImage takes the old one\'s name, and starts once this app has quit', { skip: process.platform === 'win32' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-install-'));
  const img = path.join(d, 'AG-Horizon.AppImage');
  fs.writeFileSync(img, 'old');
  const t = { kind: 'appimage', path: img };
  const staged = h.stagingFile(t, '3.2.0');
  assert.strictEqual(path.dirname(staged), d);   // next to it: one rename puts it in place
  fs.writeFileSync(staged, 'new');
  const runs = [];
  h.install(staged, t, { pid: 4242, env: { APPIMAGE: img, APPDIR: '/tmp/.mount', HOME: '/home/x' }, spawnFn: (cmd, args, opts) => { runs.push({ cmd, args, opts }); return { unref() {} }; } });
  assert.strictEqual(fs.readFileSync(img, 'utf8'), 'new');
  assert.ok(fs.statSync(img).mode & 0o100, 'executable');
  assert.ok(!fs.existsSync(staged));
  assert.strictEqual(runs.length, 1);
  assert.match(runs[0].args[1], /kill -0 4242/);   // waits for this app to quit first (the port, the file)
  assert.strictEqual(runs[0].args[3], img);
  assert.strictEqual(runs[0].opts.env.APPIMAGE, undefined);   // not this AppImage's environment
  assert.strictEqual(runs[0].opts.env.HOME, '/home/x');
  fs.rmSync(d, { recursive: true, force: true });
});

test('macOS: the new .app takes the old one\'s place; the old one is removed after this app has quit', { skip: !fs.existsSync('/usr/bin/tar') }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-install-'));
  const app = path.join(d, 'AG Horizon.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'version'), 'old');
  // the update as Tauri makes it: "AG Horizon.app" in a .tar.gz
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-src-'));
  fs.mkdirSync(path.join(src, 'AG Horizon.app', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(src, 'AG Horizon.app', 'Contents', 'version'), 'new');
  const t = { kind: 'app', path: app };
  const staged = h.stagingFile(t, '3.2.0');
  execFileSync('tar', ['-czf', staged, '-C', src, 'AG Horizon.app']);
  const runs = [];
  h.install(staged, t, { pid: 4242, env: {}, spawnFn: (cmd, args) => { runs.push(args); return { unref() {} }; } });
  assert.strictEqual(fs.readFileSync(path.join(app, 'Contents', 'version'), 'utf8'), 'new');
  const left = fs.readdirSync(d).sort();
  assert.deepStrictEqual(left, ['.ag-horizon-old-4242.app', 'AG Horizon.app']);   // the old one, until this app quits
  assert.match(runs[0][1], /kill -0 4242.*rm -rf -- "\$2".*open -n "\$1"/);
  assert.deepStrictEqual(runs[0].slice(3), [app, path.join(d, '.ag-horizon-old-4242.app')]);
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test('macOS: an update that can\'t be unpacked leaves the app as it was', { skip: !fs.existsSync('/usr/bin/tar') }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-install-'));
  const app = path.join(d, 'AG Horizon.app');
  fs.mkdirSync(app);
  const t = { kind: 'app', path: app };
  const staged = h.stagingFile(t, '3.2.0');
  fs.writeFileSync(staged, 'not a tar.gz');
  assert.throws(() => h.install(staged, t, { pid: 1, env: {}, spawnFn: () => assert.fail('nothing may start') }), /unpacked/);
  assert.deepStrictEqual(fs.readdirSync(d), ['AG Horizon.app']);
  fs.rmSync(d, { recursive: true, force: true });
});
