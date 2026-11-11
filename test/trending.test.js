'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// trending.js runs in the page next to core.js: load it with core.js's own normName
const core = fs.readFileSync(path.join(__dirname, '../public/js/core.js'), 'utf8');
const ctx = { module: { exports: {} } };
vm.runInNewContext(/^const normName = .*$/m.exec(core)[0] + '\n' + fs.readFileSync(path.join(__dirname, '../public/js/trending.js'), 'utf8') + '\nmodule.exports.normName = normName;', ctx);
const { trendKey, matchTrending, lengthsMatch } = ctx.module.exports;

test('provider titles are cleaned up before comparing', () => {
  assert.strictEqual(trendKey('NO - Dune: Part Two [4K] (2024)'), 'duneparttwo');
  assert.strictEqual(trendKey('Buba u uhu [EX-YU] [2025]'), 'bubauuhu');
  assert.strictEqual(trendKey('EN| The Office (US) HD'), 'theoffice');
  assert.strictEqual(trendKey('Amélie'), 'amélie');
});

test('trending titles are found by TMDB id, or by title and year, never by title alone when it is ambiguous', () => {
  const a = [
    { uid: 'a1', name: 'Dune: Part Two [4K]', year: '2024' },
    { uid: 'a2', name: 'The Thing (1982)', year: '1982' },
    { uid: 'a3', name: 'The Thing', year: '2011' },
    { uid: 'a4', name: 'Some Film With Id', year: '', tmdb: '777' },
    { uid: 'a5', name: 'Lonely Title', year: '' },
    { uid: 'a6', name: 'Twice', year: '' },
    { uid: 'a7', name: 'Twice', year: '' },
  ];
  const b = [{ uid: 'b1', name: 'Dune Part Two', year: '2024' }, { uid: 'b2', name: 'Only In B', year: '2020' }];
  const trend = [
    { id: 1, title: 'Dune: Part Two', original: 'Dune: Part Two', year: '2024' },
    { id: 2, title: 'The Thing', original: 'The Thing', year: '2011' },       // the remake, not the 1982 film
    { id: 777, title: 'Renamed By The Provider', original: '', year: '2026' },
    { id: 3, title: 'Lonely Title', original: '', year: '2026' },             // no year in the playlist, but the only one
    { id: 4, title: 'Twice', original: '', year: '2026' },                    // no year and two of them: skipped
    { id: 5, title: 'Not In Any Playlist', original: '', year: '2026' },
    { id: 6, title: 'Andre navn', original: 'Only In B', year: '2020' },       // found by the original title
    { id: 7, title: 'The Thing', original: '', year: '1999' },                // wrong year: skipped
  ];
  const hits = JSON.parse(JSON.stringify(matchTrending(trend, [a, b]).map((x) => [x.t.id, x.it.uid])));   // out of the vm context
  assert.deepStrictEqual(hits, [[1, 'a1'], [2, 'a3'], [777, 'a4'], [3, 'a5'], [6, 'b2']]);   // a1, not b1: the first playlist wins
});

test('a cinema recording ([CAM], [TS]) is never shown, even when it is the only version', () => {
  const list = [
    { uid: 'cam', name: 'The Odyssey [CAM] [CZ] [2026]', year: '2026', tmdb: '9' },
    { uid: 'good', name: 'The Odyssey [4K] [2026]', year: '2026', tmdb: '9' },
    { uid: 'ts', name: 'Other Film [HDTS] [2026]', year: '2026', tmdb: '8' },
    { uid: 'ts2', name: 'Other Film [TS] [2026]', year: '2026' },
  ];
  const ids = (trend) => JSON.parse(JSON.stringify(matchTrending(trend, [list]).map((x) => x.it.uid)));
  assert.deepStrictEqual(ids([{ id: 9, title: 'The Odyssey', original: '', year: '2026' }]), ['good']);
  assert.deepStrictEqual(ids([{ id: 8, title: 'Other Film', original: '', year: '2026' }]), []);   // by id or by title
  assert.deepStrictEqual(JSON.parse(JSON.stringify(matchTrending([{ id: 9, title: 'x', original: '', year: '' }], [[list[0]]]))), []);   // the only version
});

test('a provider file much shorter or longer than the title on TMDB is left out', () => {
  assert.strictEqual(lengthsMatch(3, 173), false);     // 3 minutes of a cinema recording of a 2 h 53 min film
  assert.strictEqual(lengthsMatch(2.5, 95), false);    // a trailer
  assert.strictEqual(lengthsMatch(94, 94), true);
  assert.strictEqual(lengthsMatch(160, 173), true);    // a different cut
  assert.strictEqual(lengthsMatch(30, 45), true);      // an episode: within 15 minutes
  assert.strictEqual(lengthsMatch(20, 45), false);
  assert.strictEqual(lengthsMatch(240, 120), false);   // two films in one file, or the wrong one
  assert.strictEqual(lengthsMatch(0, 120), true);      // the provider doesn't say: kept
  assert.strictEqual(lengthsMatch(120, 0), true);      // TMDB doesn't know: kept
});
