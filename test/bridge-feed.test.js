'use strict';
// scripts/bridge-feed.js: a stable Tauri release carries the bridge's update files, so that Electron apps older than
// the bridge update to it (and it hands over). Checked with electron-updater's own parsing and file resolution, as an
// old app on each system would read the files from the Tauri release.
const test = require('node:test');
const assert = require('node:assert');
const { rewrite } = require('../scripts/bridge-feed');
const { parseUpdateInfo, resolveFiles } = require('electron-updater/out/providers/Provider');
const { newUrlFromBase } = require('electron-updater/out/util');

// 2.6.0's files as published (latest-mac.yml as released; the others in the same shape)
const MAC = `version: 2.6.0
files:
  - url: AG-Horizon-2.6.0-arm64-mac.zip
    sha512: ezb9lt4EjYNkul/Q6TGsKN0hVXIxODi7VcPB4XCEtX+eG3KPpQJbqxAIMrU+Sig0Rm9BGmPZblcq5xUiSJt+cg==
    size: 136843653
  - url: AG-Horizon-2.6.0-arm64.dmg
    sha512: fzH7QxI2C6RckJpMkAkUR5Hjr707DTractitYJtqFquDHXLlS/khy9nCyTK14hOMYXv3TMBI0VJZuyPm/ANHQg==
    size: 141038850
path: AG-Horizon-2.6.0-arm64-mac.zip
sha512: ezb9lt4EjYNkul/Q6TGsKN0hVXIxODi7VcPB4XCEtX+eG3KPpQJbqxAIMrU+Sig0Rm9BGmPZblcq5xUiSJt+cg==
releaseDate: '2026-11-18T08:35:23.554Z'
`;
const WIN = `version: 2.6.0
files:
  - url: AG-Horizon-Setup-2.6.0.exe
    sha512: aaaa
    size: 144450717
path: AG-Horizon-Setup-2.6.0.exe
sha512: aaaa
releaseDate: '2026-11-18T08:35:23.554Z'
`;

// GitHubProvider.resolveFiles: <releases>/download/<tag of the release the file was read from>/<name>
const resolve = (yml, file, tag) => {
  const info = { tag, ...parseUpdateInfo(yml, file, new URL(`https://github.com/o/r/releases/download/${tag}/${file}`)) };
  return resolveFiles(info, new URL('https://github.com'), (p) => `/o/r/releases/download/${info.tag}/${p.replace(/ /g, '-')}`)
    .map((f) => f.url.href);
};

test('read from the Tauri release, the bridge\'s files point at the bridge release', () => {
  const mac = rewrite(MAC, 'v2.6.0');
  assert.deepStrictEqual(resolve(mac, 'latest-mac.yml', 'v3.1.0'), [
    'https://github.com/o/r/releases/download/v2.6.0/AG-Horizon-2.6.0-arm64-mac.zip',
    'https://github.com/o/r/releases/download/v2.6.0/AG-Horizon-2.6.0-arm64.dmg',
  ]);
  assert.deepStrictEqual(resolve(rewrite(WIN, 'v2.6.0'), 'latest.yml', 'v3.1.0'), ['https://github.com/o/r/releases/download/v2.6.0/AG-Horizon-Setup-2.6.0.exe']);
  // the version an old app compares with its own: the bridge's, so 2.5.x updates and 2.6.0 doesn't
  assert.strictEqual(parseUpdateInfo(mac, 'latest-mac.yml', new URL('https://x/latest-mac.yml')).version, '2.6.0');
  // the checksums are the bridge's files', untouched
  assert.ok(mac.includes('sha512: ezb9lt4EjYNkul/Q6TGsKN0hVXIxODi7VcPB4XCEtX+eG3KPpQJbqxAIMrU+Sig0Rm9BGmPZblcq5xUiSJt+cg=='));
  // the blockmap (a differential download) is looked for next to the file, in the bridge release too
  assert.strictEqual(newUrlFromBase('/o/r/releases/download/v3.1.0/../v2.6.0/AG-Horizon-Setup-2.6.0.exe.blockmap', new URL('https://github.com')).href,
    'https://github.com/o/r/releases/download/v2.6.0/AG-Horizon-Setup-2.6.0.exe.blockmap');
});

test('quoted names, and what is refused', () => {
  assert.match(rewrite(`version: 2.6.0\nfiles:\n  - url: 'A-B.zip'\n    sha512: x\npath: "A-B.zip"\n`, 'v2.6.0'), /url: '\.\.\/v2\.6\.0\/A-B\.zip'[\s\S]*path: "\.\.\/v2\.6\.0\/A-B\.zip"/);
  assert.throws(() => rewrite(MAC, 'v3.1.0-beta.9'), /not a stable tag/);
  assert.throws(() => rewrite('version: 2.6.0\n', 'v2.6.0'), /no file entries/);
});
