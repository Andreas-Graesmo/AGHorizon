'use strict';
// Own file: node --test runs each file in its own process, so the key and the fake TMDB apply only here.
const test = require('node:test');
const assert = require('node:assert');

process.env.TMDB_API_KEY = 'test-key';
const realFetch = globalThis.fetch;
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  const cast = String(url).includes('/tv/')
    ? [{ name: 'Bryan Cranston', profile_path: '/b.jpg', roles: [{ character: 'Walter White' }] }]
    : [{ name: 'Keanu Reeves', character: 'Neo', profile_path: '/k.jpg' }, { name: 'No Photo', character: '' }];
  return new Response(JSON.stringify({ cast }), { status: 200 });
};
const { start, server } = require('../server');

test('cast photos come from TMDB, mapped for movies and series, and are cached', async (t) => {
  const port = await start(0);
  t.after(() => server.close());
  const get = (q) => realFetch(`http://127.0.0.1:${port}/api/cast?${q}`).then(async (r) => [r.status, await r.json()]);

  assert.deepStrictEqual(await get('type=movie&id=603'), [200, [
    { name: 'Keanu Reeves', role: 'Neo', photo: 'https://image.tmdb.org/t/p/w185/k.jpg' },
    { name: 'No Photo', role: '', photo: '' },
  ]]);
  assert.deepStrictEqual(await get('type=tv&id=1396'), [200, [
    { name: 'Bryan Cranston', role: 'Walter White', photo: 'https://image.tmdb.org/t/p/w185/b.jpg' },
  ]]);
  await get('type=movie&id=603');
  assert.strictEqual(asked.length, 2);   // the second ask for 603 came from the cache
  assert.match(asked[1], /\/tv\/1396\/aggregate_credits\?api_key=test-key$/);
  assert.strictEqual((await get('type=movie&id=1;rm'))[0], 400);
});
