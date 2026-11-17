#!/usr/bin/env node
'use strict';
/* Writes ../unicode-ln.js: which characters are letters or numbers (\p{L} and \p{N}), for a Node.js that was built
   without the Unicode tables (the one inside the Android TV app). server.js uses it there to compare channel names
   the same way the page does. Run it again after a Node.js update brings a newer Unicode:  node scripts/gen-unicode-ln.js */
const fs = require('fs');
const path = require('path');

const re = /[\p{L}\p{N}]/u;
const ranges = [];
let start = -1;
for (let cp = 0; cp <= 0x110000; cp++) {
  const yes = cp < 0x110000 && !(cp >= 0xd800 && cp <= 0xdfff) && re.test(String.fromCodePoint(cp));
  if (yes && start < 0) start = cp;
  else if (!yes && start >= 0) { ranges.push([start, cp - 1]); start = -1; }
}
// each range as "gap from the end of the one before, length - 1", in base 36
let prev = 0;
const packed = ranges.map(([a, b]) => { const s = `${(a - prev).toString(36)},${(b - a).toString(36)}`; prev = b; return s; }).join(' ');

const out = `'use strict';
/* Letters and numbers (\\p{L} and \\p{N}, Unicode ${process.versions.unicode}), for a Node.js built without the Unicode tables: the one
   inside the Android TV app can't run /[^\\p{L}\\p{N}]/u. Made by scripts/gen-unicode-ln.js – don't edit by hand.
   Each range is "gap from the end of the one before, length - 1" in base 36. */
const PACKED = '${packed}';

const starts = [];
const ends = [];
let at = 0;
for (const r of PACKED.split(' ')) {
  const [gap, len] = r.split(',');
  at += parseInt(gap, 36);
  starts.push(at);
  at += parseInt(len, 36);
  ends.push(at);
}

function isLetterOrNumber(cp) {
  let lo = 0, hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < starts[mid]) hi = mid - 1;
    else if (cp > ends[mid]) lo = mid + 1;
    else return true;
  }
  return false;
}

// The same as String(s).toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '')
function normName(s) {
  let out = '';
  for (const ch of String(s).toLowerCase()) if (isLetterOrNumber(ch.codePointAt(0))) out += ch;
  return out;
}

module.exports = { normName, isLetterOrNumber, unicode: '${process.versions.unicode}' };
`;
fs.writeFileSync(path.join(__dirname, '..', 'unicode-ln.js'), out);
console.log(`unicode-ln.js: ${ranges.length} ranges, ${out.length} bytes (Unicode ${process.versions.unicode})`);
