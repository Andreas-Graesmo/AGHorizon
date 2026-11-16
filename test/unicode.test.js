'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normName, isLetterOrNumber, unicode } = require('../unicode-ln');

// unicode-ln.js stands in for /[\p{L}\p{N}]/u where Node.js has no Unicode tables (the Android TV app).
// (Compared only on a Node.js that knows the same Unicode version as the table: each version adds characters.)
test('the table of letters and numbers agrees with \\p{L} and \\p{N} for every character', { skip: process.versions.unicode !== unicode && `the table is Unicode ${unicode}, this Node.js has ${process.versions.unicode}` }, () => {
  const re = /[\p{L}\p{N}]/u;
  const wrong = [];
  for (let cp = 0; cp < 0x110000 && wrong.length < 5; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (re.test(String.fromCodePoint(cp)) !== isLetterOrNumber(cp)) wrong.push(cp.toString(16));
  }
  assert.deepStrictEqual(wrong, [], 'run node scripts/gen-unicode-ln.js after a Node.js update');
});

test('channel names are compared the same way with and without the Unicode tables', () => {
  const builtIn = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  for (const name of ['BBC One HD', 'TV 2 Sport ᴴᴰ', 'NRK1 | Østlandet', 'Первый канал ★', 'قناة الجزيرة', '🇳🇴 TV Norge +1', 'CANAL+ Séries (FHD)', '中央电视台-1', '']) {
    assert.strictEqual(normName(name), builtIn(name), name);
  }
});
