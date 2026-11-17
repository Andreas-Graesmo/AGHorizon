#!/usr/bin/env node
'use strict';
// Plan task 0.7: plays a film in the real UI in Chromium, which can't decode HEVC, while the page claims HEVC support
// (the "says yes, can't decode" case), and prints which way playback goes. With the watchdog in player.js the last
// line is "transcode video=h264" with a picture; without it playback stays on "transcode video=hevc picture=0x0".
// Needs the spike server: node spike/media/serve.js   Usage: node spike/media/check-hevc-watchdog.js [fixture]
const FIXTURE = process.argv[2] || 'hevc_aac.mp4';
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await b.newPage();
  await page.addInitScript(() => {
    // stand-in for electron/preload.js: the renderer expects window.tunerDesktop at load
    const ok = (v) => () => Promise.resolve(v);
    window.tunerDesktop = {
      displays: ok([]), focusWindow: ok(), appInfo: ok({ version: 'test', updater: false, channel: 'stable' }), ready() {}, titleBar() {},
      updater: { status: ok({ state: 'idle' }), check: ok({ state: 'idle' }), download: ok(), install: ok(), openReleases: ok(), notes: ok({}), setChannel: ok('stable'), onStatus() {} },
      downloads: { list: ok({ items: [], folder: '', pauseWhileWatching: false, held: false, free: 0 }), add: ok(0), pause: ok(), resume: ok(), reorder: ok(), remove: ok(), reveal: ok(), openFolder: ok(''), chooseFolder: ok(null), setOption: ok(), setWatching: ok(), orphans: ok([]), adopt: ok(0), onChange() {} },
      sync: { info: ok({ host: 'test', keychain: false, folder: '' }), getCode: ok(''), setCode: ok(), chooseFolder: ok(''), folderList: ok([]), folderPut: ok(''), folderRemove: ok() },
    };
    const orig = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (t) => (/hvc1|hev1/.test(t) ? true : orig(t));   // a webview that claims HEVC
  });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto('http://127.0.0.1:47831/');
  await page.waitForFunction(() => typeof playChannel === 'function' && state.ffmpeg === true, null, { timeout: 20000 });
  await page.evaluate((fx) => playChannel({ uid: 'spike-hevc', pid: null, kind: 'movie', name: 'HEVC test',
    url: `${location.origin}/spike/fx/${fx}` }), FIXTURE);
  let last = '';
  for (let i = 0; i < 50; i++) {
    const s = await page.evaluate(() => {
      const v = document.querySelector('#video');
      const m = /\/api\/transcode\?.*?video=(\w+)/.exec(v.currentSrc || '');
      return `${m ? `transcode video=${m[1]}` : 'native'} picture=${v.videoWidth}x${v.videoHeight}`;
    });
    if (s !== last) { console.log(`${(i / 2).toFixed(1).padStart(5)} s  ${s}`); last = s; }
    await page.waitForTimeout(500);
  }
  await b.close();
})();
