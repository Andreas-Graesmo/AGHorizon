#!/usr/bin/env node
'use strict';
/*
 * After `tauri build` on Windows (MIGRATION_PLAN.md 5.6 / 5.7): the files a release carries for the Tauri app.
 *   AG-Horizon-Setup-<version>.exe        the installer, under the name the website and README link to
 *   AG-Horizon-Setup-<version>.exe.sig    its updater signature (made by the build with TAURI_SIGNING_PRIVATE_KEY)
 *   latest.json                           what the Tauri updater and the Electron hand-over (electron/handover.js) read
 * Usage: node scripts/tauri-release.js <out dir> [--base-url <url the files will be downloaded from>] [--notes <text>]
 *   --base-url defaults to https://github.com/Andreas-Graesmo/AGHorizon/releases/download/v<version>
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const out = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : null;
if (!out) { console.error('usage: node scripts/tauri-release.js <out dir> [--base-url <url>] [--notes <text>]'); process.exit(2); }

const version = require(path.join(root, 'package.json')).version;
const nsis = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const built = path.join(nsis, `AG Horizon_${version}_x64-setup.exe`);
for (const f of [built, `${built}.sig`]) if (!fs.existsSync(f)) throw new Error(`${path.relative(root, f)} is missing: was this version built with createUpdaterArtifacts and the signing key?`);

const name = `AG-Horizon-Setup-${version}.exe`;
const base = (arg('--base-url') || `https://github.com/Andreas-Graesmo/AGHorizon/releases/download/v${version}`).replace(/\/+$/, '');
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(built, path.join(out, name));
const signature = fs.readFileSync(`${built}.sig`, 'utf8').trim();
fs.writeFileSync(path.join(out, `${name}.sig`), signature);
const entry = { signature, url: `${base}/${encodeURIComponent(name)}` };
const latest = {
  version,
  notes: arg('--notes') || `See https://github.com/Andreas-Graesmo/AGHorizon/releases/tag/v${version}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  // the -nsis key is the one Tauri's updater looks for first on Windows; the plain one for older readers
  platforms: { 'windows-x86_64-nsis': entry, 'windows-x86_64': entry },
};
fs.writeFileSync(path.join(out, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`${name}, ${name}.sig and latest.json (version ${version}, from ${base}) → ${path.relative(root, out) || out}`);
