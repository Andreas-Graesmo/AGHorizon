#!/usr/bin/env node
'use strict';
/*
 * After `tauri build` (MIGRATION_PLAN.md 5.6 / 5.7, 9.9): the files a release carries for the Tauri app, for the
 * system it ran on, under the names the website and README link to:
 *   Windows  AG-Horizon-Setup-<version>.exe (+ .sig)       the installer, which is also the update
 *   Linux    AG-Horizon-<version>.AppImage (+ .sig)         the AppImage, which is also the update
 *   macOS    AG-Horizon-<version>-universal.dmg             to install (one app: Apple silicon and Intel)
 *            AG-Horizon-<version>-universal.app.tar.gz (+ .sig)   the update, for both
 *   latest.json   what the Tauri updater (and on Windows the Electron hand-over, electron/handover.js) reads, with
 *                 this system's entries
 * A release built on several systems needs one latest.json with every system's entries:
 *   node scripts/tauri-release.js --merge <out latest.json> <latest.json>...
 * Usage: node scripts/tauri-release.js <out dir> [--base-url <url the files will be downloaded from>] [--notes <text>]
 *   --base-url defaults to https://github.com/Andreas-Graesmo/AGHorizon/releases/download/v<version>
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

if (process.argv[2] === '--merge') {
  const [outFile, ...inputs] = process.argv.slice(3);
  if (!outFile || !inputs.length) { console.error('usage: node scripts/tauri-release.js --merge <out> <latest.json>...'); process.exit(2); }
  const all = inputs.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const versions = [...new Set(all.map((j) => j.version))];
  if (versions.length !== 1) throw new Error(`the latest.json files are for different versions: ${versions.join(', ')}`);
  const merged = { ...all[0], platforms: Object.assign({}, ...all.map((j) => j.platforms)) };
  fs.writeFileSync(outFile, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`latest.json for ${versions[0]}: ${Object.keys(merged.platforms).join(', ')} → ${outFile}`);
  process.exit(0);
}

const out = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : null;
if (!out) { console.error('usage: node scripts/tauri-release.js <out dir> [--base-url <url>] [--notes <text>]'); process.exit(2); }

const version = require(path.join(root, 'package.json')).version;
// macOS: `tauri build --target universal-apple-darwin` puts it under that target
const bundle = path.join(root, 'src-tauri', 'target', ...(process.platform === 'darwin' ? ['universal-apple-darwin'] : []), 'release', 'bundle');
const base = (arg('--base-url') || `https://github.com/Andreas-Graesmo/AGHorizon/releases/download/v${version}`).replace(/\/+$/, '');

// [built file, release name, updater keys (the file is the update), or null (just a download)]
const files = {
  win32: [[path.join(bundle, 'nsis', `AG Horizon_${version}_x64-setup.exe`), `AG-Horizon-Setup-${version}.exe`, ['windows-x86_64-nsis', 'windows-x86_64']]],
  linux: [[path.join(bundle, 'appimage', `AG Horizon_${version}_amd64.AppImage`), `AG-Horizon-${version}.AppImage`, ['linux-x86_64-appimage', 'linux-x86_64']]],
  darwin: [
    [path.join(bundle, 'macos', 'AG Horizon.app.tar.gz'), `AG-Horizon-${version}-universal.app.tar.gz`, ['darwin-aarch64-app', 'darwin-aarch64', 'darwin-x86_64-app', 'darwin-x86_64']],
    [path.join(bundle, 'dmg', `AG Horizon_${version}_universal.dmg`), `AG-Horizon-${version}-universal.dmg`, null],
  ],
}[process.platform];
if (!files) throw new Error(`no release files for ${process.platform}`);

fs.mkdirSync(out, { recursive: true });
const platforms = {};
for (const [built, name, keys] of files) {
  if (!fs.existsSync(built)) throw new Error(`${path.relative(root, built)} is missing`);
  fs.copyFileSync(built, path.join(out, name));
  if (!keys) continue;
  if (!fs.existsSync(`${built}.sig`)) throw new Error(`${path.relative(root, built)}.sig is missing: was this version built with createUpdaterArtifacts and the signing key?`);
  const signature = fs.readFileSync(`${built}.sig`, 'utf8').trim();
  fs.writeFileSync(path.join(out, `${name}.sig`), signature);
  // the key with the bundle type is the one Tauri's updater looks for first; the plain one for older readers
  for (const k of keys) platforms[k] = { signature, url: `${base}/${encodeURIComponent(name)}` };
}
const latest = {
  version,
  notes: arg('--notes') || `See https://github.com/Andreas-Graesmo/AGHorizon/releases/tag/v${version}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms,
};
fs.writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`${files.map((f) => f[1]).join(', ')}, signatures and latest.json (version ${version}, from ${base}) → ${path.relative(root, out) || out}`);
