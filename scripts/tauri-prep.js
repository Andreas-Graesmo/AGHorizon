#!/usr/bin/env node
'use strict';
/*
 * Fills src-tauri/binaries/ before a Tauri build (MIGRATION_PLAN.md 2.3):
 *   aghorizon-server-<triple>[.exe]   the local server: the Rust one (server-rs/, MIGRATION_PLAN.md 8.5), built here
 *                                     with cargo; or, with --node-server, server.js as a Node single executable
 *                                     (sidecar/build.js), as the app shipped until 8.5
 *   ffmpeg-<triple>[.exe] + ffmpeg.LICENSE
 *       Windows: BtbN's ffmpeg 8.1 GPL build from their October 2026 month-end autobuild (kept by BtbN until
 *       2028-10), refused unless the zip and the unpacked ffmpeg.exe match their SHA-256 (MIGRATION_PLAN.md 5.9,
 *       Option B: every library in it is pinned in BtbN's public scripts, so its source can be published).
 *       Other systems (development only, until MIGRATION_PLAN.md Phase 9): FFMPEG_PATH or `ffmpeg`.
 * Usage: node scripts/tauri-prep.js [--skip-server] [--node-server]
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src-tauri', 'binaries');
const TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc', 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
};
const triple = TRIPLES[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`no target triple for ${process.platform}-${process.arch}`);
const ext = process.platform === 'win32' ? '.exe' : '';

// MIGRATION_PLAN.md 5.9 (Option B). The matching source: scripts/ffmpeg-source.sh and the release FFMPEG.sourceTag.
const FFMPEG = {
  base: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59',
  zip: { name: 'ffmpeg-n8.1.3-27-g8dca1586f4-win64-gpl-8.1.zip', sha256: '401dffcf14c301082e1fc03b0bc876b92ea676bfc521fc56e80a1537d137034f' },
  exe: { sha256: 'c46215f8889634396f0ac0acac738ef2145175e5b6caf28b3daa8ac9a9980c5f' },
  license: { sha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903' },   // GPL v3 (LICENSE.txt in the zip)
  btbnCommit: '5031c6f1082414e53688d39e521849905071070d',   // BtbN/FFmpeg-Builds at that autobuild: every library's pin
  ffmpegCommit: '8dca1586f4',                                // FFmpeg release/8.1 (n8.1.3-27-g8dca1586f4)
  sourceTag: 'ffmpeg-n8.1.3-27-g8dca1586f4-btbn-2026-10-31-source',
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
async function fetchChecked(name, want) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${FFMPEG.base}/${name}`, { signal: AbortSignal.timeout(600000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const got = sha256(buf);
      if (got !== want) throw new Error(`${name}: sha256 ${got}, expected ${want}. Refusing it.`);
      return buf;
    } catch (e) {
      if (/Refusing/.test(e.message) || i === 3) throw e;
      console.log(`  ${name}: ${e.message}, trying again`);
    }
  }
}

(async () => {
  fs.mkdirSync(out, { recursive: true });

  if (!process.argv.includes('--skip-server') && process.argv.includes('--node-server')) {
    execFileSync(process.execPath, [path.join(root, 'sidecar', 'build.js')], { stdio: 'inherit' });
    const built = path.join(root, 'sidecar', 'dist', `aghorizon-server-${triple}${ext}`);
    fs.copyFileSync(built, path.join(out, `aghorizon-server-${triple}${ext}`));
    console.log(`server sidecar (Node) → src-tauri/binaries/aghorizon-server-${triple}${ext}`);
  } else if (!process.argv.includes('--skip-server')) {
    // the same name the Node one had: tauri.conf.json's externalBin and src-tauri/src/main.rs don't change
    execFileSync('cargo', ['build', '--release', '--manifest-path', path.join(root, 'server-rs', 'Cargo.toml')], { stdio: 'inherit' });
    fs.copyFileSync(path.join(root, 'server-rs', 'target', 'release', `aghorizon-server-rs${ext}`), path.join(out, `aghorizon-server-${triple}${ext}`));
    console.log(`server sidecar (Rust) → src-tauri/binaries/aghorizon-server-${triple}${ext}`);
  }

  const ffOut = path.join(out, `ffmpeg-${triple}${ext}`);
  const licOut = path.join(out, 'ffmpeg.LICENSE');
  if (process.platform === 'win32') {
    if (fs.existsSync(ffOut) && sha256(fs.readFileSync(ffOut)) === FFMPEG.exe.sha256 && fs.existsSync(licOut) && fs.readFileSync(licOut, 'utf8').includes(FFMPEG.sourceTag)) {
      console.log('ffmpeg: already in place, checksum ok');
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-ffmpeg-'));
      const zip = path.join(tmp, FFMPEG.zip.name);
      fs.writeFileSync(zip, await fetchChecked(FFMPEG.zip.name, FFMPEG.zip.sha256));
      // Windows' own tar (bsdtar) unpacks zip files; Git Bash's GNU tar, which may come first on PATH, can't
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      const dir = FFMPEG.zip.name.replace(/\.zip$/, '');
      execFileSync(tar, ['-xf', zip, '-C', tmp, `${dir}/bin/ffmpeg.exe`, `${dir}/LICENSE.txt`], { stdio: 'inherit' });
      const exe = fs.readFileSync(path.join(tmp, dir, 'bin', 'ffmpeg.exe'));
      const lic = fs.readFileSync(path.join(tmp, dir, 'LICENSE.txt'));
      if (sha256(exe) !== FFMPEG.exe.sha256) throw new Error('ffmpeg.exe: checksum mismatch after unpacking. Refusing it.');
      if (sha256(lic) !== FFMPEG.license.sha256) throw new Error('ffmpeg LICENSE.txt: checksum mismatch. Refusing it.');
      fs.writeFileSync(ffOut, exe);
      fs.writeFileSync(licOut, `${lic.toString('utf8')}\n\n---\nffmpeg n8.1.3-27-g8dca1586f4, built by BtbN/FFmpeg-Builds (commit ${FFMPEG.btbnCommit}).\nThe complete corresponding source: https://github.com/Andreas-Graesmo/AGHorizon/releases/tag/${FFMPEG.sourceTag}\n`);
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`ffmpeg 8.1 (BtbN, GPL v3, checksums ok) → src-tauri/binaries/ffmpeg-${triple}${ext}`);
    }
  } else {
    // development builds on other systems only: the release ffmpeg for macOS/Linux is decided in Phase 9
    const src = process.env.FFMPEG_PATH || execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']).toString().split(/\r?\n/)[0].trim();
    fs.copyFileSync(src, ffOut);
    fs.chmodSync(ffOut, 0o755);
    fs.writeFileSync(licOut, `Development build: ffmpeg copied from ${src}. See its own licence.\n`);
    console.log(`ffmpeg (development: ${src}) → src-tauri/binaries/ffmpeg-${triple}${ext}`);
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
