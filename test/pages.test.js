'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The page scripts (public/js) share one global scope in the window and can't be loaded here as a whole. These tests
// cut single functions or statements out of them and run those in a vm context, next to small stand-ins for what
// they call. piece() takes the shortest text from the start of the match that parses as a whole statement.
const source = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8');
function piece(file, start, { optional = false } = {}) {
  const text = source(file);
  const at = text.indexOf(start);
  if (at < 0) { if (optional) return ''; throw new Error(`${file}: "${start}" not found`); }
  for (let end = text.indexOf('}', at); end >= 0; end = text.indexOf('}', end + 1)) {
    let candidate = text.slice(at, end + 1);
    if (text[end + 1] === ')') candidate = text.slice(at, text.indexOf(';', end) + 1);   // a call: up to its ;
    try { new vm.Script(candidate); return candidate; } catch { /* not complete yet */ }
  }
  throw new Error(`${file}: no complete statement at "${start}"`);
}
const run = (code, ctx) => { vm.createContext(ctx); vm.runInContext(code, ctx); return ctx; };
const plain = (x) => JSON.parse(JSON.stringify(x));   // out of the vm context, for deepStrictEqual
const tick = () => new Promise((r) => setImmediate(r));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('workspace: a list that arrives after the user moved on does not replace the newer one', async () => {
  const loads = [];
  const ctx = run(piece('workspace.js', 'async function loadWs('), {
    ws: { pid: 'p1', mode: 'movie', items: [], errors: [], token: 0, loading: false, cat: '*' },
    state: { epg: {}, epgState: {} },
    wsPlaylist: () => ({ id: 'p1' }),
    loadItems: (p, mode) => { const d = deferred(); loads.push({ mode, d }); return d.promise; },
    renderWsChrome() {}, renderWsBody() {}, loadEpg() {},
  });
  const { ws } = ctx;
  // Movies is opened (a big list, slow), then Live TV before it arrives
  const movies = ctx.loadWs();
  ws.mode = 'live';
  const live = ctx.loadWs();
  loads[1].d.resolve([{ uid: 'ch1', group: 'News' }]);
  await live;
  assert.deepStrictEqual(plain(ws.items).map((c) => c.uid), ['ch1']);
  loads[0].d.resolve([{ uid: 'film1', group: 'Action' }]);   // the movies come in late
  await movies;
  assert.deepStrictEqual(plain(ws.items).map((c) => c.uid), ['ch1'], 'still the channels');
  assert.deepStrictEqual(plain(ws.errors), []);

  // the same when the late load fails: its error is not shown for the list that loaded fine
  ws.mode = 'series';
  const series = ctx.loadWs();
  ws.mode = 'live';
  const again = ctx.loadWs();
  loads[3].d.resolve([{ uid: 'ch2', group: 'News' }]);
  await again;
  loads[2].d.reject(new Error('The provider took too long to respond'));
  await series;
  assert.deepStrictEqual(plain(ws.items).map((c) => c.uid), ['ch2']);
  assert.deepStrictEqual(plain(ws.errors), []);
  assert.strictEqual(ws.loading, false);
});

test('player: the heart stands for the series of the episode that plays, not for the details page that is open', () => {
  const series = { uid: 's1', pid: 'p1', name: 'The Series', kind: 'series' };
  const other = { uid: 'm9', pid: 'p1', name: 'Another Film', kind: 'movie' };
  const episode = { uid: 'e1', pid: 'p1', kind: 'episode', seriesUid: 's1', seriesName: 'The Series' };
  let click = null;
  const faved = [];
  const ctx = run(`${piece('ui.js', 'function playerFavItem(', { optional: true })}\n${piece('ui.js', "$('#pFav').addEventListener('click'")}`, {
    $: (sel) => ({ addEventListener: (type, fn) => { if (sel === '#pFav' && type === 'click') click = fn; } }),
    toggleFavItem: (it) => faved.push(it),
    cardIndex: new Map(),
    ws: { detail: null },
    state: { current: null, cache: {}, favdata: {} },
  });
  const press = () => { faved.length = 0; click(); return faved[0]; };

  ctx.state.current = episode;
  ctx.ws.detail = other;                                   // the mini player plays an episode over another title's page
  ctx.cardIndex.set('s1', series);
  assert.strictEqual(press(), series);
  ctx.cardIndex.clear();
  ctx.state.cache['p1:series'] = { channels: [series] };   // the Xtream series list
  assert.strictEqual(press(), series);
  ctx.state.cache = { p1: { channels: [], movies: [], series: [series] } };   // an M3U playlist's
  assert.strictEqual(press(), series);
  ctx.state.cache = {};
  ctx.state.favdata = { s1: { ...series, ts: 1 } };       // a favourite whose list isn't loaded: the heart takes it off
  assert.strictEqual(press(), ctx.state.favdata.s1);
  ctx.state.favdata = {};
  ctx.ws.detail = series;                                  // the series' own page
  assert.strictEqual(press(), series);
  ctx.ws.detail = other;
  assert.strictEqual(press(), episode, 'the series is nowhere: the episode itself');
  ctx.state.current = other;
  assert.strictEqual(press(), other, 'a film is itself');
});

test('sync: on a TV, something playing waits two minutes before syncing, as on a computer', () => {
  const delays = [];
  const code = [piece('sync.js', 'const SYNC_WATCH = {'), piece('sync.js', 'const lsSetPlain = LS.set;'), piece('sync.js', 'LS.set = (k, v) => {')].join('\n');
  const ctx = run(code, {
    LS: { set() {} },
    sy: { applying: false },
    state: { current: { uid: 'm1', kind: 'movie' } },
    video: { paused: true },   // on a TV the page's <video> is never used
    TV: true,
    syncSoon: (d) => delays.push(d),
  });
  ctx.LS.set('tuner.progress', {});
  assert.deepStrictEqual(delays, [120000]);
  // a computer: only while its <video> plays
  ctx.TV = false;
  ctx.LS.set('tuner.progress', {});
  ctx.video.paused = false;
  ctx.LS.set('tuner.progress', {});
  assert.deepStrictEqual(delays, [120000, 8000, 120000]);
  // nothing playing on the TV: the usual delay
  ctx.TV = true;
  ctx.state.current = null;
  ctx.LS.set('tuner.progress', {});
  assert.strictEqual(delays[3], 8000);
});

test('account info is drawn whatever the panel sends as formats, or when it sends nothing', async () => {
  const els = {};
  const el = (sel) => (els[sel] = els[sel] || { textContent: '', innerHTML: '', hidden: false, className: '' });
  let reply;
  const ctx = run(piece('dialogs.js', 'async function openAccountInfo('), {
    $: el,
    acctDlg: { open: true, showModal() {} },
    apiJson: async () => reply,
    xt: { api: () => 'http://panel.example/player_api.php' },
    esc: (s) => String(s),
    normServer: (s) => s,
    state: { cache: {} },
  });
  const p = { id: 'p1', name: 'Panel', server: 'http://panel.example', username: 'me' };
  const body = async (r) => { reply = r; await ctx.openAccountInfo(p); return els['#acctBody'].innerHTML; };

  assert.match(await body({ user_info: { status: 'Active', allowed_output_formats: ['m3u8', 'ts'] } }), /M3U8<\/span><span class="acct-chip">TS</);
  for (const formats of ['m3u8,ts', { 0: 'ts' }, 7]) {
    const html = await body({ user_info: { status: 'Active', username: 'me', allowed_output_formats: formats }, server_info: { url: 'panel.example' } });
    assert.doesNotMatch(html, /Loading account/, JSON.stringify(formats));
    assert.match(html, /Allowed formats<\/h4><div class="acct-chips">–</);
  }
  const empty = await body(null);
  assert.doesNotMatch(empty, /Loading account/);
  assert.match(empty, /User information/);
});

test('a file playlist changed into a link or an Xtream login gives up its stored file', async () => {
  let submit = null, next = null;
  const deleted = [];
  const ctx = run(piece('dialogs.js', "form.addEventListener('submit'"), {
    form: { addEventListener: (type, fn) => { if (type === 'submit') submit = fn; } },
    readForm: () => next,
    pendingFile: null,
    idb: { put: async () => {}, del: async (k) => { deleted.push(k); } },
    state: { playlists: [] },
    ws: { pid: null },
    setFormMsg() {}, dropCaches() {}, savePlaylists() {}, closePlaylistDialog() {}, uiPlaylistsChanged() {}, openWorkspace() {}, toast() {},
  });
  const save = async (p) => { next = p; await submit({ preventDefault() {} }); };
  ctx.state.playlists = [{ id: 'a', type: 'file', name: 'A', fileName: 'a.m3u' }, { id: 'b', type: 'file', name: 'B', fileName: 'b.m3u' }, { id: 'c', type: 'm3u', name: 'C', url: 'http://x/c' }];

  await save({ id: 'a', type: 'file', name: 'A renamed', fileName: 'a.m3u' });   // still a file: kept
  await save({ id: 'c', type: 'xtream', name: 'C', server: 'http://x', username: 'u', password: 'p' });   // never was one
  await save({ id: 'n', type: 'm3u', name: 'New', url: 'http://x/n' });            // a new playlist
  assert.deepStrictEqual(deleted, []);
  await save({ id: 'a', type: 'm3u', name: 'A', url: 'http://x/a' });
  await save({ id: 'b', type: 'xtream', name: 'B', server: 'http://x', username: 'u', password: 'p' });
  assert.deepStrictEqual(deleted, ['file:a', 'file:b']);
});

test('multi view: swapping a picture with one that has not loaded yet keeps both', () => {
  const ctx = run(`${piece('multiview.js', 'function mvSave(')}\n${piece('multiview.js', 'function mvPickChoose(')}`, {
    mv: { layout: '2c', focus: 1, slots: [null, null, null, null], pending: [null, null, null, null] },
    pick: { i: -1, items: [] },
    LS: { saved: null, set(k, v) { if (k === 'tuner.mv') this.saved = v; } },
    snap: (c) => ({ uid: c.uid, pid: c.pid, name: c.name }),
    $: () => ({ close() {} }),
    mvRender() {}, mvSync() {}, mvCheckLimits() {},
  });
  const news = { uid: 'p1:news', pid: 'p1', name: 'News' };
  const sport = { uid: 'p2:sport', pid: 'p2', name: 'Sport' };   // saved, its playlist not loaded yet
  ctx.mv.slots[1] = news;
  ctx.mv.pending[0] = sport;
  ctx.pick.i = 0;                // picture 1 (Sport, waiting) is given News, which picture 2 shows
  ctx.pick.items = [news];
  ctx.mvPickChoose(0);
  assert.deepStrictEqual(plain(ctx.LS.saved.slots).map((s) => s && s.uid), ['p1:news', 'p2:sport', null, null]);
  assert.strictEqual(ctx.mv.slots[0], news);
  assert.strictEqual(ctx.mv.slots[1], null);
  assert.strictEqual(ctx.mv.pending[1], sport);
  assert.strictEqual(ctx.mv.pending[0], null);
});
