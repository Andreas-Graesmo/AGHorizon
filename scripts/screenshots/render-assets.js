'use strict';
/* Renders the demo catalogue's artwork (posters, backdrops, episode stills, channel logos) and video clips into
   scripts/screenshots/.cache. Skips what is already there; delete the folder to start over. Needs Playwright and ffmpeg. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { MOVIES, SERIES, CHANNELS, LIVE, people } = require('./catalog');
const art = require('./art');

const CACHE = path.join(__dirname, '.cache');
const IMG = path.join(CACHE, 'img');
const VID = path.join(CACHE, 'video');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function renderAll({ force = false } = {}) {
  fs.mkdirSync(IMG, { recursive: true });
  fs.mkdirSync(VID, { recursive: true });
  const fonts = path.join(CACHE, 'fonts');
  if (!fs.existsSync(fonts)) fs.symlinkSync(path.join(__dirname, '..', '..', 'public', 'fonts'), fonts);

  const jobs = [];   // [file, html, w, h, transparent]
  for (const m of MOVIES) {
    const ppl = people(m.id, 8);
    jobs.push([`poster-${m.id}.jpg`, art.posterHtml(m, ppl, 500, 750, 'A FILM BY'), 500, 750]);
    jobs.push([`backdrop-${m.id}.jpg`, art.sceneHtml(...m.art, 1600, 900), 1600, 900]);
  }
  for (const s of SERIES) {
    const ppl = people(s.id, 8);
    jobs.push([`poster-${s.id}.jpg`, art.posterHtml({ ...s, tag: 'A new series' }, ppl, 500, 750, 'CREATED BY'), 500, 750]);
    jobs.push([`backdrop-${s.id}.jpg`, art.sceneHtml(...s.art, 1600, 900), 1600, 900]);
    for (let k = 1; k <= 6; k++) jobs.push([`still-${s.id}-${k}.jpg`, art.sceneHtml(s.art[0], s.art[1], s.art[2] * 31 + k, 640, 360), 640, 360]);
  }
  CHANNELS.forEach(([name, , logo]) => jobs.push([`logo-${slug(name)}.png`, art.logoHtml(logo), 256, 256, true]));
  // live channels: a background (unless it borrows a movie's backdrop) and what's laid over it; logos are drawn first
  CHANNELS.forEach(([name], i) => {
    const [kind, pal, seed, over] = LIVE[name];
    if (pal) jobs.push([`live-bg-${i + 1}.jpg`, art.sceneHtml(kind, pal, seed, 1600, 900), 1600, 900]);
    jobs.push([`live-ov-${i + 1}.png`, art.overlayHtml(`logo-${slug(name)}.png`, over), 1280, 720, true]);
  });

  const todo = jobs.filter(([f]) => force || !fs.existsSync(path.join(IMG, f)));
  if (todo.length) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const tmp = path.join(CACHE, 'render.html');
    for (const [file, html, w, h, transparent] of todo) {
      await page.setViewportSize({ width: w, height: h });
      fs.writeFileSync(tmp, html);
      await page.goto('file://' + tmp);
      await page.evaluate(() => document.fonts.ready);
      const out = path.join(IMG, file);
      if (transparent) await page.screenshot({ path: out, omitBackground: true });
      else await page.screenshot({ path: out, type: 'jpeg', quality: 86 });
    }
    await browser.close();
    fs.rmSync(tmp, { force: true });
    console.log(`rendered ${todo.length} images`);
  }

  // Video: a slow push-in on a backdrop, H.264 + silent AAC. Movies and episodes get an MP4, live channels HLS.
  const clips = [...MOVIES.map((m) => m.id), ...SERIES.map((s) => s.id)];
  for (const id of clips) {
    const mp4 = path.join(VID, `${id}.mp4`);
    if (!force && fs.existsSync(mp4)) continue;
    ffmpegClip(path.join(IMG, `backdrop-${id}.jpg`), mp4, 12);
    console.log('clip', id);
  }
  for (let n = 1; n <= CHANNELS.length; n++) {
    const dir = path.join(VID, `live-${n}`);
    if (!force && fs.existsSync(path.join(dir, 'index.m3u8'))) continue;
    fs.mkdirSync(dir, { recursive: true });
    const [kind, pal] = LIVE[CHANNELS[n - 1][0]];
    ffmpegClip(path.join(IMG, pal ? `live-bg-${n}.jpg` : `backdrop-${kind}.jpg`), path.join(dir, 'index.m3u8'), 30, path.join(IMG, `live-ov-${n}.png`));
    console.log('live clip', n);
  }
}

// overlay given: a live channel, as HLS, with the overlay PNG on top of the moving picture
function ffmpegClip(src, out, secs, overlay = null) {
  const fps = 25, frames = secs * fps;
  const zoom = `[0:v]scale=3200:-1,zoompan=z='1+0.08*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1280x720:fps=${fps}`;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', src, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', ...(overlay ? ['-loop', '1', '-i', overlay] : []),
    '-filter_complex', overlay ? `${zoom}[z];[z][2:v]overlay=0:0:shortest=1,format=yuv420p[v]` : `${zoom},format=yuv420p[v]`,
    '-map', '[v]', '-map', '1:a', '-t', String(secs), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', String(fps * 2), '-c:a', 'aac', '-b:a', '64k'];
  if (overlay) args.push('-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(path.dirname(out), 'seg%03d.ts'), out);
  else args.push('-movflags', '+faststart', out);
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
}

module.exports = { renderAll, CACHE, IMG, VID, slug };
if (require.main === module) renderAll({ force: process.argv.includes('--force') }).catch((e) => { console.error(e); process.exit(1); });
