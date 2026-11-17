#!/usr/bin/env node
'use strict';
/*
 * Fills src-tauri/binaries/ before a Tauri build (MIGRATION_PLAN.md 2.3):
 *   aghorizon-server-<triple>[.exe]   server.js as a single executable (sidecar/build.js)
 *   ffmpeg-<triple>[.exe] + ffmpeg.LICENSE
 *       Windows: the pinned gyan.dev 6.1.1 build that the app ships today (decision 0.4), refused unless its
 *       SHA-256 matches. Other systems (development only, until MIGRATION_PLAN.md Phase 9): FFMPEG_PATH or `ffmpeg`.
 * Usage: node scripts/tauri-prep.js [--skip-server]
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src-tauri', 'binaries');
const TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc', 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
};
const triple = TRIPLES[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`no target triple for ${process.platform}-${process.arch}`);
const ext = process.platform === 'win32' ? '.exe' : '';

// MIGRATION_PLAN.md 0.4: github.com/eugeneware/ffmpeg-static release b6.1.1 (gyan.dev 6.1.1 essentials, GPL v3)
const FFMPEG = {
  base: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1',
  gz: { name: 'ffmpeg-win32-x64.gz', sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77' },
  exe: { sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00' },
  license: { name: 'win32-x64.LICENSE', sha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903' },
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
async function fetchChecked(name, want) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${FFMPEG.base}/${name}`, { signal: AbortSignal.timeout(120000) });
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

  if (!process.argv.includes('--skip-server')) {
    execFileSync(process.execPath, [path.join(root, 'sidecar', 'build.js')], { stdio: 'inherit' });
    const built = path.join(root, 'sidecar', 'dist', `aghorizon-server-${triple}${ext}`);
    fs.copyFileSync(built, path.join(out, `aghorizon-server-${triple}${ext}`));
    console.log(`server sidecar → src-tauri/binaries/aghorizon-server-${triple}${ext}`);
  }

  const ffOut = path.join(out, `ffmpeg-${triple}${ext}`);
  const licOut = path.join(out, 'ffmpeg.LICENSE');
  if (process.platform === 'win32') {
    if (fs.existsSync(ffOut) && sha256(fs.readFileSync(ffOut)) === FFMPEG.exe.sha256 && fs.existsSync(licOut)) {
      console.log('ffmpeg: already in place, checksum ok');
    } else {
      const exe = zlib.gunzipSync(await fetchChecked(FFMPEG.gz.name, FFMPEG.gz.sha256));
      if (sha256(exe) !== FFMPEG.exe.sha256) throw new Error('ffmpeg.exe: checksum mismatch after unpacking. Refusing it.');
      fs.writeFileSync(ffOut, exe);
      fs.writeFileSync(licOut, await fetchChecked(FFMPEG.license.name, FFMPEG.license.sha256));
      console.log(`ffmpeg 6.1.1 (gyan.dev, GPL v3, checksums ok) → src-tauri/binaries/ffmpeg-${triple}${ext}`);
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
