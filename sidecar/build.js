#!/usr/bin/env node
'use strict';
/*
 * Builds the server sidecar for this machine (MIGRATION_PLAN.md 0.3):
 *   1. esbuild bundles sidecar/entry.js + server.js + subtitles.js + unicode-ln.js + package.json into one file.
 *      ffmpeg-static and secrets.json stay out: the app passes FFMPEG_PATH and the API keys as env.
 *   2. Node's single-executable support (SEA) turns the bundle into a blob, injected into a copy of this node binary.
 * Output: sidecar/dist/aghorizon-server-<target triple>[.exe], the name Tauri's bundle.externalBin expects.
 * Usage: node sidecar/build.js      (needs npx: esbuild and postject are fetched at pinned versions)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ESBUILD = 'esbuild@0.28.2';
const POSTJECT = 'postject@1.0.0-alpha.6';
const root = path.join(__dirname, '..');
const dist = path.join(__dirname, 'dist');
const TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};
const triple = TRIPLES[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`no target triple for ${process.platform}-${process.arch}`);
const exe = path.join(dist, `aghorizon-server-${triple}${process.platform === 'win32' ? '.exe' : ''}`);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (args) => execFileSync(npx, ['-y', ...args], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const bundle = path.join(dist, 'server.cjs');
run([ESBUILD, 'sidecar/entry.js', '--bundle', '--platform=node', '--target=node22', '--format=cjs',
  '--external:ffmpeg-static', '--external:./secrets.json', '--legal-comments=none', `--outfile=${bundle}`]);

const blob = path.join(dist, 'sea-prep.blob');
const config = path.join(dist, 'sea-config.json');
fs.writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

fs.copyFileSync(process.execPath, exe);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });
run([POSTJECT, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);

const mb = (n) => (n / 1048576).toFixed(1);
const packed = require('zlib').gzipSync(fs.readFileSync(exe), { level: 9 }).length;   // about what an installer adds
console.log(`\nbuilt ${path.relative(root, exe)}: ${mb(fs.statSync(exe).size)} MB, ${mb(packed)} MB compressed (bundle ${(fs.statSync(bundle).size / 1024).toFixed(0)} KB, node ${process.version})`);
