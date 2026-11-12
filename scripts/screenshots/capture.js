'use strict';
/* Takes the website's screenshots: runs the app's page against the demo provider (demo-server.js) in Chromium and
   saves them as WebP in docs/img (full-size PNGs stay in .cache/shots).
   Usage: node scripts/screenshots/capture.js [shot names…]   (no names: all of them) */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { renderAll, slug } = require('./render-assets');
const { createDemoServer } = require('./demo-server');
const { MOVIES, SERIES, CHANNELS } = require('./catalog');

const OUT = process.env.SHOTS_OUT || path.join(__dirname, '.cache', 'shots');
const SITE_IMG = path.join(__dirname, '..', '..', 'docs', 'img');
// shot -> how many CSS pixels from the top to keep on the website (the rest is empty page)
const CROP = { movie: 640, light: 600 };
const W = 1440, H = 900;
const PID = 'demo';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// A TV app looks best at prime time: a fixed-offset time zone where it is about 20:30 right now.
const EVENING = (() => { const h = new Date().getUTCHours() + new Date().getUTCMinutes() / 60; let off = Math.round(20.5 - h); if (off > 14) off -= 24; if (off < -12) off += 24; return off ? `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}` : 'UTC'; })();

// What the desktop shell (electron/preload.js) would answer: nothing to update, no downloads, one monitor.
const desktopStub = () => {
  const never = () => new Promise(() => {});
  window.tunerDesktop = {
    displays: async () => [], focusWindow: async () => {}, appInfo: async () => ({ version: '2.2.1', platform: 'darwin' }), ready: () => {},
    updater: { status: async () => ({ state: 'idle' }), check: async () => {}, download: async () => {}, install: async () => {}, openReleases: async () => {}, onStatus: () => {} },
    downloads: { list: never, add: never, pause: never, resume: never, reorder: never, remove: never, reveal: never, openFolder: never, chooseFolder: never, setOption: never, setWatching: async () => {}, orphans: async () => [], adopt: never, onChange: () => {} },
  };
};

function seed(base) {
  const img = (f) => `${base}/img/${f}`;
  const now = Date.now();
  const ch = (n) => { const [name, group] = CHANNELS[n - 1]; return { uid: `${PID}:${n}`, pid: PID, id: String(n), kind: 'live', name, logo: img(`logo-${slug(name)}.png`), group, year: '', rating: '', seriesUid: '', seriesName: '', season: 0, num: n }; };
  const movie = (id) => { const m = MOVIES.find((x) => x.id === id); return { uid: `${PID}:m${id}`, pid: PID, id: String(id), kind: 'movie', name: m.name, logo: img(`poster-${id}.jpg`), group: m.cat, year: String(m.year), rating: String(m.rating), seriesUid: '', seriesName: '', season: 0, num: 0 }; };
  const ep = (sid, season, num) => { const s = SERIES.find((x) => x.id === sid); return { uid: `${PID}:e${sid * 1000 + season * 100 + num}`, pid: PID, id: String(sid * 1000 + season * 100 + num), kind: 'episode', name: `Episode ${num}`, logo: img(`poster-${sid}.jpg`), group: s.name, year: '', rating: '', seriesUid: `${PID}:s${sid}`, seriesName: s.name, season, num }; };
  const favs = [3, 1, 7, 12, 16, 23, 25, 29].map(ch);
  const recent = [ep(201, 2, 3), movie(105), ch(3), ep(202, 1, 5), movie(110), ch(7), ep(204, 1, 2), movie(114), ch(12), ep(206, 1, 4), movie(119), ep(208, 2, 1), movie(107), ch(1)]
    .map((s, i) => ({ ...s, ts: now - i * 3.1 * 3600e3 }));
  const progress = {};
  const pr = (uid, frac, mins) => { progress[uid] = { t: frac * mins * 60, d: mins * 60, w: 0, ts: now }; };
  pr(`${PID}:e201203`, .42, 52); pr(`${PID}:m105`, .63, 112); pr(`${PID}:m102`, .38, 116); pr(`${PID}:e202105`, .2, 47); pr(`${PID}:m110`, .81, 139);
  pr(`${PID}:e204102`, .55, 24); pr(`${PID}:m114`, .3, 131); pr(`${PID}:e206104`, .7, 49); pr(`${PID}:m119`, .5, 103);
  progress[`${PID}:e201201`] = progress[`${PID}:e201202`] = { t: 0, d: 3120, w: 1, ts: now - 864e5 };
  for (let e = 1; e <= 8; e++) progress[`${PID}:e2011${String(e).padStart(2, '0')}`] = { t: 0, d: 3120, w: 1, ts: now - 5 * 864e5 };
  const favdata = Object.fromEntries(favs.map((f) => [f.uid, f]));
  return {
    'tuner.playlists': [{ id: PID, name: 'Living room', type: 'xtream', server: base, username: 'demo', password: 'demo', format: 'm3u8', epgUrl: '', ua: '', added: now - 30 * 864e5 }],
    'tuner.lastPid': PID,
    'tuner.favs': favs.map((f) => f.uid),
    'tuner.favdata': favdata,
    'tuner.recent': recent,
    'tuner.progress': progress,
    'tuner.updDismissed': 'idle:',
  };
}

async function main(only) {
  await renderAll();
  fs.mkdirSync(OUT, { recursive: true });
  const demo = createDemoServer();
  const base = await demo.listen(0);
  const app = require('../../server.js');
  const port = await app.start(0);
  const origin = `http://127.0.0.1:${port}`;
  console.log('demo provider', base, '· app', origin);

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const store = seed(base);

  // a fresh page for each shot, with storage seeded (plus the shot's own changes) and TMDB answered by the demo
  async function open(extra = {}) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-GB', timezoneId: EVENING });
    await ctx.addInitScript(desktopStub);
    await ctx.addInitScript((items) => { if (!sessionStorage.getItem('seeded')) { localStorage.clear(); for (const [k, v] of Object.entries(items)) localStorage.setItem(k, JSON.stringify(v)); sessionStorage.setItem('seeded', '1'); } }, { ...store, ...extra });
    await ctx.route('**/api/trending', (r) => r.fulfill({ json: demo.trending() }));
    await ctx.route('**/api/tmdb?*', (r) => r.fulfill({ json: { runtime: demo.runtimeOf(new URL(r.request().url()).searchParams.get('id')), cast: [] } }));
    await ctx.route('**/api/capabilities', (r) => r.fulfill({ json: { ffmpeg: true, opensubtitles: false, tmdb: true } }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('  page error:', e.message));
    await page.goto(origin + '/');
    await page.waitForFunction(() => document.querySelector('#heroBox h1'), null, { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    return { page, ctx };
  }
  const settle = async (page, ms = 1200) => {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.evaluate(() => Promise.all([...document.images].filter((i) => !i.complete && i.offsetParent).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 4000); }))));
    await wait(ms);
  };
  const save = async (page, name, cropTo = CROP[name]) => {
    const png = path.join(OUT, name + '.png');
    await page.screenshot({ path: png });
    fs.mkdirSync(SITE_IMG, { recursive: true });
    const keep = cropTo ? `crop=iw:ih*${cropTo}/${H}:0:0,` : '';
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', png, '-vf', `${keep}scale=2200:-1:flags=lanczos`, '-quality', '82', path.join(SITE_IMG, name + '.webp')]);
    console.log('  saved', name);
  };
  const hideCursor = (page) => page.addStyleTag({ content: '*{cursor:none!important} .toast{display:none!important}' });

  const shots = {
    async dashboard() {
      const { page, ctx } = await open();
      await hideCursor(page);
      await settle(page, 1500);
      await page.evaluate(() => { hero.paused = true; hero.i = 0; renderHero(); });
      await settle(page, 800);
      await save(page, 'dashboard');
      await ctx.close();
    },
    async live() {
      const { page, ctx } = await open();
      await hideCursor(page);
      await page.evaluate(() => openWorkspace('demo', 'live'));
      await page.waitForFunction(() => state.epgState.demo === 'ready', null, { timeout: 30000 });
      await page.evaluate(() => { ws.cat = '*fav'; renderLive(); const ch = state.cache.demo.channels.find((c) => c.name === 'Northwind News'); playChannel(ch); scrollLiveTo(ch.uid); });
      await page.waitForFunction(() => { const v = document.querySelector('#video'); return v && v.currentTime > 2.5; }, null, { timeout: 30000 });
      await settle(page, 300);
      await save(page, 'live');
      await ctx.close();
    },
    async guide() {
      const { page, ctx } = await open();
      await hideCursor(page);
      await page.evaluate(() => openWorkspace('demo', 'guide'));
      await page.waitForFunction(() => state.epgState.demo === 'ready', null, { timeout: 30000 });
      await settle(page, 1200);
      await save(page, 'guide');
      await ctx.close();
    },
    async movies() {
      const { page, ctx } = await open();
      await hideCursor(page);
      await page.evaluate(() => openWorkspace('demo', 'movie'));
      await page.waitForFunction(() => document.querySelectorAll('#vodGrid .card').length > 10, null, { timeout: 20000 });
      await settle(page, 1200);
      await save(page, 'movies');
      await ctx.close();
    },
    async movie() {
      const { page, ctx } = await open();
      await hideCursor(page);
      await page.evaluate(() => openWorkspace('demo', 'movie'));
      await page.waitForFunction(() => (state.cache['demo:movie'] || {}).channels, null, { timeout: 20000 });
      await page.evaluate(() => openDetail(state.cache['demo:movie'].channels.find((m) => m.id === '102')));
      await page.waitForFunction(() => document.querySelector('#wsDetail .dt-plot'), null, { timeout: 20000 });
      await settle(page, 1200);
      await save(page, 'movie');
      await ctx.close();
    },
    async series() {
      const { page, ctx } = await open();
      await hideCursor(page);
      await page.evaluate(() => openWorkspace('demo', 'series'));
      await page.waitForFunction(() => (state.cache['demo:series'] || {}).channels, null, { timeout: 20000 });
      await page.evaluate(() => { const s = state.cache['demo:series'].channels.find((m) => m.id === '201'); state.season[s.uid] = 2; openDetail(s); });
      await page.waitForFunction(() => document.querySelectorAll('#wsDetail .ep').length, null, { timeout: 20000 });
      await settle(page, 1200);
      // the episode list is the point here: scroll it up under the top bar, and keep the picture down to its last row
      const bottom = await page.evaluate(() => {
        const d = $('#wsDetail');
        d.querySelector('.detail-in').style.paddingBottom = '900px';   // room to scroll the list all the way up
        const head = [...d.querySelectorAll('.dt-sec h3')].find((h) => /Episodes/.test(h.textContent));
        d.scrollTop += head.getBoundingClientRect().top - d.getBoundingClientRect().top - 28;
        const eps = d.querySelectorAll('.ep');
        return Math.ceil(eps[eps.length - 1].getBoundingClientRect().bottom + 28);
      });
      await settle(page, 600);
      await save(page, 'series', Math.min(H, bottom));
      await ctx.close();
    },
    // Settings › Sync, turned on with three computers (drawn from made-up state: nothing is synced)
    async sync() {
      const now = Date.now();
      const { codeFromSecret, newSyncSecret } = require('../../public/js/sync-core.js');
      const { page, ctx } = await open({
        'tuner.syncCode': codeFromSecret(newSyncSecret()),
        'tuner.sync': { on: true, mode: 'cloud', device: 'aaaaaaaaaaaaaaaa', last: { at: now - 40e3, ok: true },
          devices: { aaaaaaaaaaaaaaaa: { name: 'Living room PC', at: new Date(now - 40e3).toISOString() }, bbbbbbbbbbbbbbbb: { name: 'Laptop', at: new Date(now - 26 * 60e3).toISOString() }, cccccccccccccccc: { name: 'Office', at: new Date(now - 2 * 864e5).toISOString() } } },
      });
      await hideCursor(page);
      await page.evaluate(() => { clearTimeout(sy.timer); sy.keys = null; sy.showCode = true; sy.info = { host: 'Living room PC' }; go('settings'); });
      await settle(page, 400);
      const box = await page.evaluate(() => { const c = document.getElementById('set-sync'); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.x - 12, y: r.y - 12, width: r.width + 24, height: r.height + 24 }; });
      await settle(page, 300);
      const png = path.join(OUT, 'sync.png');
      await page.screenshot({ path: png, clip: box });
      execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', png, '-vf', 'scale=1600:-1:flags=lanczos', '-quality', '85', path.join(SITE_IMG, 'sync.webp')]);
      console.log('  saved sync');
      await ctx.close();
    },
    async multiview() {
      const { page, ctx } = await open();
      await hideCursor(page);
      await page.evaluate(() => openWorkspace('demo', 'live'));
      await page.waitForFunction(() => state.epgState.demo === 'ready', null, { timeout: 30000 });
      await page.evaluate(() => { for (const n of ['Northwind News', 'Arena Sports 1', 'Velo Live', 'Wildlife HD']) mvAdd(state.cache.demo.channels.find((c) => c.name === n)); go('multiview'); });
      await page.waitForFunction(() => [...document.querySelectorAll('#v-multiview video')].filter((v) => v.currentTime > 2).length >= 4, null, { timeout: 40000 });
      await settle(page, 300);
      await save(page, 'multiview');
      await ctx.close();
    },
    async light() {
      const { page, ctx } = await open({ 'tuner.theme': 'light', 'tuner.lightPalette': 'bright', 'tuner.accent': 'blue' });
      await hideCursor(page);
      await page.evaluate(() => openWorkspace('demo', 'movie'));
      await page.waitForFunction(() => document.querySelectorAll('#vodGrid .card').length > 5, null, { timeout: 20000 });
      await settle(page, 1200);
      await save(page, 'light');
      await ctx.close();
    },
  };

  // The picture shown when the site is shared (1200 × 630): the logo's colours, the name and the dashboard.
  shots.og = async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    const docs = path.join(__dirname, '..', '..', 'docs');
    fs.writeFileSync(path.join(docs, '.og.html'), `<!doctype html><html><head><style>
      @font-face { font-family: 'DM Sans'; font-weight: 400 800; src: url(fonts/dm-sans-latin.woff2) format('woff2'); }
      html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; font-family: 'DM Sans'; color: #eef1f8;
        background: radial-gradient(70% 90% at 78% 30%, rgba(255,122,89,.55), transparent 60%), linear-gradient(160deg, #12304f, #070b14 70%); }
      .t { position: absolute; left: 64px; top: 70px; width: 470px; }
      .b { display: flex; align-items: center; gap: 14px; font-weight: 800; font-size: 30px; }
      .b img { width: 56px; height: 56px; border-radius: 13px; }
      h1 { font-size: 64px; line-height: 1.02; letter-spacing: -.035em; margin: 46px 0 0; }
      h1 span { color: #ff8f6e; }
      p { font-size: 22px; color: #c3cbdc; margin: 22px 0 0; line-height: 1.4; }
      .s { position: absolute; left: 580px; top: 92px; width: 860px; border-radius: 14px; box-shadow: 0 30px 80px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.1); }
    </style></head><body><div class="t"><div class="b"><img src="icon.svg">AG Horizon</div>
      <h1>All your TV.<br><span>One calm place.</span></h1><p>Live TV with a real guide, movies and series, multi view. Free for Windows, macOS &amp; Linux.</p></div>
      <img class="s" src="img/dashboard.webp"></body></html>`);
    await page.goto('file://' + path.join(docs, '.og.html'));
    await page.evaluate(() => document.fonts.ready);
    await wait(300);
    await page.screenshot({ path: path.join(SITE_IMG, 'og.png') });
    fs.rmSync(path.join(docs, '.og.html'));
    await page.close();
    console.log('  saved og');
  };

  for (const [name, fn] of Object.entries(shots)) {
    if (only.length && !only.includes(name)) continue;
    console.log(name);
    try { await fn(); } catch (e) { console.log('  failed:', e.message); }
  }
  await browser.close();
  app.server.close();
  demo.server.close();
}

main(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
