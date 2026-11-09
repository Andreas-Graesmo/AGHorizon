'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseXmltvTime, rewriteM3u8 } = require('../server');

test('guide times honour their time zone', () => {
  assert.strictEqual(parseXmltvTime('20261023203000 +0200'), Date.UTC(2026, 9, 23, 18, 30));
  assert.strictEqual(parseXmltvTime('20261023203000 -0130'), Date.UTC(2026, 9, 23, 22, 0));
  assert.strictEqual(parseXmltvTime('202610232030'), Date.UTC(2026, 9, 23, 20, 30));   // no seconds, no zone: UTC
  assert.strictEqual(parseXmltvTime('garbage'), null);
});

test('HLS playlists route segments and keys back through the proxy', () => {
  const out = rewriteM3u8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nseg1.ts\n\nhttps://cdn.example/seg2.ts', 'http://host.example/live/a/index.m3u8', 'VLC').split('\n');
  const prox = (u) => `/api/stream?url=${encodeURIComponent(u)}&ua=VLC`;
  assert.deepStrictEqual(out, [
    '#EXTM3U',
    `#EXT-X-KEY:METHOD=AES-128,URI="${prox('http://host.example/live/a/key.bin')}"`,
    prox('http://host.example/live/a/seg1.ts'),
    '',
    prox('https://cdn.example/seg2.ts'),
  ]);
});
