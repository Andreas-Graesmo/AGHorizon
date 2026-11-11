'use strict';
// Own file: electron is replaced by a stand-in here, with the download folder in a temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-dl-'));
const noop = () => {};
require.cache[require.resolve('electron')] = {
  id: 'electron', loaded: true,
  exports: { app: { getPath: () => tmp, on: noop }, ipcMain: { handle: noop, on: noop }, BrowserWindow: { getAllWindows: () => [] }, dialog: {}, shell: {} },
};
const downloads = require('../electron/downloads');
downloads.init();   // reads downloads.json (none) -> download folder <tmp>/AGHorizon
const root = path.join(tmp, 'AGHorizon');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mk = (dir, ...files) => { fs.mkdirSync(dir, { recursive: true }); for (const f of files) fs.writeFileSync(path.join(dir, f), 'x'); return dir; };

test('removing a download deletes only empty folders inside the download folder', async () => {
  const onlyPoster = mk(path.join(root, 'Series', 'Show', 'Season 01'));
  mk(path.join(root, 'Series', 'Show'), 'poster.jpg');
  const keep = mk(path.join(root, 'Movies', 'Keep'), 'poster.jpg', 'Keep.srt');
  const outside = mk(path.join(tmp, 'Elsewhere'));
  const lookalike = mk(path.join(tmp, 'AGHorizon2', 'Empty'));   // starts with the folder's name, but isn't in it

  await downloads.removeEmptyDirs(onlyPoster);
  assert.ok(!fs.existsSync(path.join(root, 'Series')), 'empty season, the show with only a poster, and Series go');
  assert.ok(fs.existsSync(root), 'the download folder itself stays');

  await downloads.removeEmptyDirs(keep);
  assert.ok(fs.existsSync(path.join(keep, 'Keep.srt')), 'a folder with another file stays');

  await downloads.removeEmptyDirs(outside);
  await downloads.removeEmptyDirs(lookalike);
  assert.ok(fs.existsSync(outside) && fs.existsSync(lookalike), 'nothing outside the download folder is touched');
});

test('download file names stay inside the download folder', () => {
  const m = downloads.targetFile({ kind: 'movie', title: '../../../Windows/evil', year: '2020', ext: 'mkv' });
  assert.ok(m.startsWith(path.join(root, 'Movies') + path.sep), m);
  const e = downloads.targetFile({ kind: 'episode', seriesName: '..\\..\\x', season: 1, episode: 2, epTitle: '/etc/passwd', ext: '../exe' });
  assert.ok(e.startsWith(path.join(root, 'Series') + path.sep), e);
  assert.ok(e.endsWith('.mp4'), 'an odd extension falls back to mp4');
});
