#!/usr/bin/env node
'use strict';
// Optional: download the two player libraries into public/vendor so the app works fully offline.
// (Without this, the app loads them from the jsDelivr CDN the first time you play a channel.)
const fs = require('fs');
const path = require('path');

const FILES = {
  'hls.min.js': 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
  'mpegts.js': 'https://cdn.jsdelivr.net/npm/mpegts.js@1/dist/mpegts.js',
};
const dir = path.join(__dirname, '..', 'public', 'vendor');

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, url] of Object.entries(FILES)) {
    process.stdout.write(`Downloading ${name} … `);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    fs.writeFileSync(path.join(dir, name), Buffer.from(await r.arrayBuffer()));
    console.log('ok');
  }
  console.log('Done – restart the app if it is running.');
})().catch((e) => { console.error('\nFailed:', e.message); process.exit(1); });
