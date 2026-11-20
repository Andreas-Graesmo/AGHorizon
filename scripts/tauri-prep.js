#!/usr/bin/env node
'use strict';
/*
 * Fills src-tauri/binaries/ before a Tauri build (MIGRATION_PLAN.md 2.3):
 *   aghorizon-server-<triple>[.exe]   the local server: the Rust one (server-rs/, MIGRATION_PLAN.md 8.5), built here
 *                                     with cargo; or, with --node-server, server.js as a Node single executable
 *                                     (sidecar/build.js), as the app shipped until 8.5
 *   ffmpeg-<triple>[.exe] + ffmpeg.LICENSE
 *       Windows and Linux x64: BtbN's ffmpeg 8.1 GPL build from their October 2026 month-end autobuild (kept by BtbN
 *       until 2028-10), refused unless the archive and the unpacked ffmpeg match their SHA-256 (MIGRATION_PLAN.md
 *       5.9, Option B: every library in it is pinned in BtbN's public scripts, so its source can be published).
 *       macOS arm64: our own build of the same FFmpeg commit with BtbN's library pins (scripts/ffmpeg-macos.sh,
 *       MIGRATION_PLAN.md 9.8), from this repository's release, checked the same way.
 *       FFMPEG_PATH overrides it (any system: development only).
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
// macOS: one universal app for Apple silicon and Intel (owner's decision 2026-11-19; `tauri build --target
// universal-apple-darwin`). Each program is both in one file (lipo), under Tauri's universal name, and under each
// processor's name too, which a plain `cargo build` on a Mac looks for.
const mac = process.platform === 'darwin';
const MAC_TRIPLES = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
const names = (prog) => (mac ? ['universal-apple-darwin', ...MAC_TRIPLES] : [triple]).map((t) => path.join(out, `${prog}-${t}${ext}`));
const place = (file, prog) => { for (const n of names(prog)) { fs.copyFileSync(file, n); fs.chmodSync(n, 0o755); } };

// MIGRATION_PLAN.md 5.9 (Option B). The matching source: scripts/ffmpeg-source.sh and the release FFMPEG.sourceTag.
const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59';
const OWN = 'https://github.com/Andreas-Graesmo/AGHorizon/releases/download';
const FFMPEG = {
  // Windows and Linux: the same BtbN autobuild (MIGRATION_PLAN.md 9.8), one source release for both.
  // macOS: our build (scripts/ffmpeg-macos.sh), its release carrying its own complete source.
  builds: {
    'win32-x64': { base: BTBN, archive: 'ffmpeg-n8.1.3-27-g8dca1586f4-win64-gpl-8.1.zip', sha256: '401dffcf14c301082e1fc03b0bc876b92ea676bfc521fc56e80a1537d137034f', exe: 'bin/ffmpeg.exe', exeSha256: 'c46215f8889634396f0ac0acac738ef2145175e5b6caf28b3daa8ac9a9980c5f', license: 'LICENSE.txt' },
    'linux-x64': { base: BTBN, archive: 'ffmpeg-n8.1.3-27-g8dca1586f4-linux64-gpl-8.1.tar.xz', sha256: '41e9c565594c390622cf968d82fa4135d9e9a11d06c1515644288cbc844e3380', exe: 'bin/ffmpeg', exeSha256: '6ad8e7b802374502e927fdcf6de8019f4f24cac3c80fbfe3b41eda6f08648b55', license: 'LICENSE.txt' },
    darwin: {   // build 3: one program for both processors (Apple silicon and Intel)
      base: `${OWN}/ffmpeg-n8.1.3-27-g8dca1586f4-macos-universal-3`, archive: 'ffmpeg-n8.1.3-27-g8dca1586f4-macos-universal.tar.xz',
      sha256: '5632299012dbb5f2a98c7c65715d38e40d166d9839ab3f8c1ec3dc31662bf2fa', exe: 'ffmpeg', exeSha256: '764ff1eb70c24dd410f17b1abebb4b96877b64f5667a7ae872ddf5db63f06328', license: 'LICENSE',
      builtBy: 'scripts/ffmpeg-macos.sh (x264, dav1d and OpenSSL at BtbN/FFmpeg-Builds\' pins)',
      sourceUrl: `${OWN}/ffmpeg-n8.1.3-27-g8dca1586f4-macos-universal-3`.replace('/download/', '/tag/'),
    },
  },
  license: { sha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903' },   // GPL v3 (LICENSE.txt in the zip)
  btbnCommit: '5031c6f1082414e53688d39e521849905071070d',   // BtbN/FFmpeg-Builds at that autobuild: every library's pin
  ffmpegCommit: '8dca1586f4',                                // FFmpeg release/8.1 (n8.1.3-27-g8dca1586f4)
  sourceTag: 'ffmpeg-n8.1.3-27-g8dca1586f4-btbn-2026-10-31-source',
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
async function fetchChecked(base, name, want) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(600000) });
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
    const manifest = path.join(root, 'server-rs', 'Cargo.toml');
    if (mac) {
      // both processors (rustup target add aarch64-apple-darwin x86_64-apple-darwin), joined into one program
      const built = MAC_TRIPLES.map((t) => {
        execFileSync('cargo', ['build', '--release', '--target', t, '--manifest-path', manifest], { stdio: 'inherit' });
        return path.join(root, 'server-rs', 'target', t, 'release', 'aghorizon-server-rs');
      });
      const uni = path.join(os.tmpdir(), `aghorizon-server-universal-${process.pid}`);
      execFileSync('lipo', ['-create', ...built, '-output', uni], { stdio: 'inherit' });
      place(uni, 'aghorizon-server');
      fs.rmSync(uni, { force: true });
      console.log('server sidecar (Rust, Apple silicon + Intel) → src-tauri/binaries/aghorizon-server-universal-apple-darwin');
    } else {
      execFileSync('cargo', ['build', '--release', '--manifest-path', manifest], { stdio: 'inherit' });
      place(path.join(root, 'server-rs', 'target', 'release', `aghorizon-server-rs${ext}`), 'aghorizon-server');
      console.log(`server sidecar (Rust) → src-tauri/binaries/aghorizon-server-${triple}${ext}`);
    }
  }

  const ffOut = names('ffmpeg')[0];
  const licOut = path.join(out, 'ffmpeg.LICENSE');
  const ff = FFMPEG.builds[mac ? 'darwin' : `${process.platform}-${process.arch}`];
  if (ff && !process.env.FFMPEG_PATH) {
    const sourceUrl = ff.sourceUrl || `https://github.com/Andreas-Graesmo/AGHorizon/releases/tag/${FFMPEG.sourceTag}`;
    if (fs.existsSync(ffOut) && sha256(fs.readFileSync(ffOut)) === ff.exeSha256 && fs.existsSync(licOut) && fs.readFileSync(licOut, 'utf8').includes(sourceUrl)) {
      console.log('ffmpeg: already in place, checksum ok');
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-ffmpeg-'));
      const archive = path.join(tmp, ff.archive);
      fs.writeFileSync(archive, await fetchChecked(ff.base, ff.archive, ff.sha256));
      // Windows' own tar (bsdtar) unpacks zip files; Git Bash's GNU tar, which may come first on PATH, can't
      const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      const dir = ff.archive.replace(/\.(zip|tar\.xz)$/, '');
      execFileSync(tar, ['-xf', archive, '-C', tmp, `${dir}/${ff.exe}`, `${dir}/${ff.license}`], { stdio: 'inherit' });
      const exe = fs.readFileSync(path.join(tmp, dir, ff.exe));
      const lic = fs.readFileSync(path.join(tmp, dir, ff.license));
      if (sha256(exe) !== ff.exeSha256) throw new Error(`${ff.exe}: checksum mismatch after unpacking. Refusing it.`);
      if (sha256(lic) !== FFMPEG.license.sha256) throw new Error('ffmpeg LICENSE.txt: checksum mismatch. Refusing it.');
      fs.writeFileSync(path.join(tmp, 'ffmpeg-checked'), exe);
      place(path.join(tmp, 'ffmpeg-checked'), 'ffmpeg');
      const builtBy = ff.builtBy || `BtbN/FFmpeg-Builds (commit ${FFMPEG.btbnCommit})`;
      fs.writeFileSync(licOut, `${lic.toString('utf8')}\n\n---\nffmpeg n8.1.3-27-g8dca1586f4, built by ${builtBy}.\nThe complete corresponding source: ${sourceUrl}\n`);
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`ffmpeg 8.1 (${ff.builtBy ? 'our macOS build' : 'BtbN'}, GPL v3, checksums ok) → ${path.relative(root, ffOut)}`);
    }
  } else {
    // FFMPEG_PATH (any system), or a system with no pinned build (e.g. an Intel Mac): development only
    const src = process.env.FFMPEG_PATH || execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']).toString().split(/\r?\n/)[0].trim();
    place(src, 'ffmpeg');
    fs.writeFileSync(licOut, `Development build: ffmpeg copied from ${src}. See its own licence.\n`);
    console.log(`ffmpeg (development: ${src}) → ${path.relative(root, ffOut)}`);
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
