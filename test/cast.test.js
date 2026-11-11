'use strict';
// Own file: node --test runs each file in its own process, so the key and the fake TMDB apply only here.
const test = require('node:test');
const assert = require('node:assert');

process.env.TMDB_API_KEY = 'test-key';
const realFetch = globalThis.fetch;
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  if (String(url).includes('/trending/')) {
    const tv = String(url).includes('/trending/tv/'), page = /page=(\d)/.exec(url)[1];
    return new Response(JSON.stringify({ results: [tv
      ? { id: 10 + +page, name: 'Show ' + page, original_name: 'Serie ' + page, first_air_date: '2025-01-02', overview: 'o', backdrop_path: '/s.jpg' }
      : { id: 20 + +page, title: 'Film ' + page, original_title: 'Film ' + page, release_date: '2026-03-04', backdrop_path: null }] }), { status: 200 });
  }
  const body = String(url).includes('/tv/')
    ? { episode_run_time: [], last_episode_to_air: { runtime: 47 }, aggregate_credits: { cast: [{ name: 'Bryan Cranston', profile_path: '/b.jpg', roles: [{ character: 'Walter White' }] }] } }
    : { runtime: 136, credits: { cast: [{ name: 'Keanu Reeves', character: 'Neo', profile_path: '/k.jpg' }, { name: 'No Photo', character: '' }] } };
  return new Response(JSON.stringify(body), { status: 200 });
};
const { start, server } = require('../server');

test('runtime and cast photos come from TMDB in one request per title, and are cached', async (t) => {
  const port = await start(0);
  t.after(() => server.close());
  const get = (q) => realFetch(`http://127.0.0.1:${port}/api/tmdb?${q}`).then(async (r) => [r.status, await r.json()]);

  assert.deepStrictEqual(await get('type=movie&id=603'), [200, { runtime: 136, cast: [
    { name: 'Keanu Reeves', role: 'Neo', photo: 'https://image.tmdb.org/t/p/w185/k.jpg' },
    { name: 'No Photo', role: '', photo: '' },
  ] }]);
  assert.deepStrictEqual(await get('type=tv&id=1396'), [200, { runtime: 47, cast: [   // a series: the latest episode's length
    { name: 'Bryan Cranston', role: 'Walter White', photo: 'https://image.tmdb.org/t/p/w185/b.jpg' },
  ] }]);
  await get('type=movie&id=603');
  assert.strictEqual(asked.length, 2);   // the second ask for 603 came from the cache
  assert.match(asked[1], /\/tv\/1396\?append_to_response=aggregate_credits&api_key=test-key$/);
  assert.strictEqual((await get('type=movie&id=1;rm'))[0], 400);
});

test('trending comes from TMDB, movies and series, and is kept for hours', async (t) => {
  const port = await start(0);
  t.after(() => server.close());
  const before = asked.length;
  const get = () => realFetch(`http://127.0.0.1:${port}/api/trending`).then((r) => r.json());
  const j = await get();
  assert.deepStrictEqual(j.movie.map((x) => [x.id, x.title, x.year, x.backdrop]), [[21, 'Film 1', '2026', ''], [22, 'Film 2', '2026', '']]);
  assert.deepStrictEqual(j.tv[0], { id: 11, title: 'Show 1', original: 'Serie 1', year: '2025', overview: 'o', backdrop: 'https://image.tmdb.org/t/p/w1280/s.jpg' });
  await get();
  assert.strictEqual(asked.length - before, 4);   // two pages each of movies and series, once
});
