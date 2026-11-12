'use strict';
/* A tiny stand-in for an Xtream Codes provider, serving the fictional demo catalogue (catalog.js) with the artwork and
   clips from render-assets.js. Only for the website screenshots: it listens on 127.0.0.1 and accepts any login. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { MOVIES, SERIES, EP_TITLES, EP_PLOTS, CHANNELS, SHOWS, SHOW_DESC, people } = require('./catalog');
const { IMG, VID, slug } = require('./render-assets');

const DAY = 864e5;
const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.ts': 'video/mp2t', '.m3u8': 'application/vnd.apple.mpegurl' };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const cats = (list) => [...new Set(list.map((x) => x.cat || x[1]))].map((name, i) => ({ category_id: String(i + 1), category_name: name, parent_id: 0 }));
const catId = (all, name) => all.find((c) => c.category_name === name).category_id;
const epId = (sid, season, ep) => sid * 1000 + season * 100 + ep;

// A day's schedule per channel, the same on every request: from yesterday 00:00 to the day after tomorrow.
function schedule(chIndex) {
  const [name, group] = CHANNELS[chIndex];
  const r = rng(chIndex * 977 + 13);
  const shows = SHOWS[group] || SHOWS.Entertainment;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  let t = start.getTime() - DAY;
  const out = [];
  while (t < start.getTime() + 2 * DAY) {
    const len = group === 'News' ? [30, 30, 60][Math.floor(r() * 3)] : group === 'Movies' ? [95, 105, 120][Math.floor(r() * 3)] : [30, 45, 60, 60, 90][Math.floor(r() * 5)];
    out.push({ start: t, stop: t + len * 60e3, title: shows[Math.floor(r() * shows.length)], desc: SHOW_DESC[Math.floor(r() * SHOW_DESC.length)], ch: name });
    t += len * 60e3;
  }
  return out;
}
const xmlTime = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const xesc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function createDemoServer() {
  let base = '';   // http://127.0.0.1:<port>, set once listening
  const img = (f) => `${base}/img/${f}`;
  const vodCats = cats(MOVIES), serCats = cats(SERIES), liveCats = cats(CHANNELS);
  const now = Math.floor(Date.now() / 1000);
  // newest first in the order the dashboard's slideshow should show them
  const heroOrder = [101, 201, 102, 202, 103];
  const addedOf = (id) => { const k = heroOrder.indexOf(id); return now - (k >= 0 ? k * 3600 : 86400 * (5 + (id % 40))); };

  const movieInfo = (m) => {
    const ppl = people(m.id, 8);
    return {
      info: {
        name: m.name, o_name: m.name, plot: m.plot, cast: ppl.slice(1, 7).join(', '), director: ppl[0], genre: m.genre, releasedate: `${m.year}-0${1 + (m.id % 9)}-1${m.id % 9}`,
        rating: String(m.rating), duration_secs: m.mins * 60, duration: `0${Math.floor(m.mins / 60)}:${String(m.mins % 60).padStart(2, '0')}:00`, country: 'Norway',
        movie_image: img(`poster-${m.id}.jpg`), backdrop_path: [img(`backdrop-${m.id}.jpg`)], tmdb_id: String(900000 + m.id),
      },
      movie_data: { stream_id: m.id, name: m.name, container_extension: 'mp4', category_id: catId(vodCats, m.cat) },
    };
  };
  const seriesInfo = (s) => {
    const ppl = people(s.id, 8);
    const episodes = {};
    for (let season = 1; season <= s.seasons; season++) {
      episodes[season] = [];
      for (let e = 1; e <= s.eps; e++) {
        const k = (s.id * 7 + season * 11 + e * 3) % EP_TITLES.length;
        episodes[season].push({
          id: String(epId(s.id, season, e)), episode_num: e, season, title: EP_TITLES[k], container_extension: 'mp4',
          info: { movie_image: img(`still-${s.id}-${1 + ((season * 3 + e) % 6)}.jpg`), plot: EP_PLOTS[(k + season) % EP_PLOTS.length], duration_secs: (s.epMins + (e % 5) - 2) * 60, duration: `00:${s.epMins}:00` },
        });
      }
    }
    return {
      seasons: Object.keys(episodes).map((n) => ({ season_number: Number(n), name: `Season ${n}`, episode_count: s.eps })),
      info: {
        name: s.name, cover: img(`poster-${s.id}.jpg`), plot: s.plot, cast: ppl.slice(1, 7).join(', '), director: ppl[0], genre: s.genre, releaseDate: `${s.year}-03-01`,
        rating: String(s.rating), backdrop_path: [img(`backdrop-${s.id}.jpg`)], episode_run_time: String(s.epMins), tmdb_id: String(900000 + s.id),
      },
      episodes,
    };
  };

  const api = {
    get_live_categories: () => liveCats,
    get_live_streams: () => CHANNELS.map(([name, group], i) => ({ num: i + 1, name, stream_type: 'live', stream_id: 1 + i, stream_icon: img(`logo-${slug(name)}.png`), epg_channel_id: `${slug(name)}.demo`, category_id: catId(liveCats, group), tv_archive: 0 })),
    get_vod_categories: () => vodCats,
    get_vod_streams: () => MOVIES.map((m, i) => ({ num: i + 1, name: m.name, stream_type: 'movie', stream_id: m.id, stream_icon: img(`poster-${m.id}.jpg`), rating: String(m.rating), added: String(addedOf(m.id)), category_id: catId(vodCats, m.cat), container_extension: 'mp4', year: String(m.year), tmdb: String(900000 + m.id) })),
    get_series_categories: () => serCats,
    get_series: () => SERIES.map((s, i) => ({ num: i + 1, name: s.name, series_id: s.id, cover: img(`poster-${s.id}.jpg`), plot: s.plot, cast: people(s.id, 8).slice(1, 5).join(', '), genre: s.genre, releaseDate: `${s.year}-03-01`, last_modified: String(addedOf(s.id)), rating: String(s.rating), episode_run_time: String(s.epMins), category_id: catId(serCats, s.cat), tmdb: String(900000 + s.id) })),
    get_vod_info: (q) => { const m = MOVIES.find((x) => String(x.id) === q.get('vod_id')); return m ? movieInfo(m) : {}; },
    get_series_info: (q) => { const s = SERIES.find((x) => String(x.id) === q.get('series_id')); return s ? seriesInfo(s) : {}; },
    get_short_epg: (q) => {
      const i = Number(q.get('stream_id')) - 1;
      const b64 = (s) => Buffer.from(s).toString('base64');
      const list = CHANNELS[i] ? schedule(i).filter((p) => p.stop > Date.now()).slice(0, Number(q.get('limit')) || 4) : [];
      return { epg_listings: list.map((p) => ({ title: b64(p.title), description: b64(p.desc), start_timestamp: String(p.start / 1000), stop_timestamp: String(p.stop / 1000) })) };
    },
  };

  const sendFile = (req, res, file) => {
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
        const end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
        fs.createReadStream(file, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(file).pipe(res);
      }
    });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (p === '/player_api.php') {
      const action = url.searchParams.get('action');
      if (!action) return json({ user_info: { username: 'demo', password: 'demo', auth: 1, status: 'Active', exp_date: String(now + 300 * 86400), is_trial: '0', active_cons: '0', created_at: String(now - 400 * 86400), max_connections: '4', allowed_output_formats: ['m3u8', 'ts'] }, server_info: { url: '127.0.0.1', port: String(server.address().port), server_protocol: 'http', timezone: 'UTC', timestamp_now: now } });
      return json(api[action] ? api[action](url.searchParams) : []);
    }
    if (p === '/xmltv.php') {
      let x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="AG Horizon demo">\n';
      CHANNELS.forEach(([name]) => { x += `<channel id="${slug(name)}.demo"><display-name>${xesc(name)}</display-name></channel>\n`; });
      CHANNELS.forEach(([name], i) => schedule(i).forEach((pr) => {
        x += `<programme start="${xmlTime(pr.start)}" stop="${xmlTime(pr.stop)}" channel="${slug(name)}.demo"><title>${xesc(pr.title)}</title><desc>${xesc(pr.desc)}</desc></programme>\n`;
      }));
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end(x + '</tv>\n');
    }
    if (p.startsWith('/img/')) return sendFile(req, res, path.join(IMG, path.basename(p)));
    let m;
    if ((m = /^\/movie\/[^/]+\/[^/]+\/(\d+)\.\w+$/.exec(p))) return sendFile(req, res, path.join(VID, `${m[1]}.mp4`));
    if ((m = /^\/series\/[^/]+\/[^/]+\/(\d+)\.\w+$/.exec(p))) return sendFile(req, res, path.join(VID, `${Math.floor(Number(m[1]) / 1000)}.mp4`));
    if ((m = /^\/live\/[^/]+\/[^/]+\/(\d+)\.\w+$/.exec(p))) {
      const clip = m[1];
      const text = fs.readFileSync(path.join(VID, `live-${clip}`, 'index.m3u8'), 'utf8').replace(/^(seg\d+\.ts)$/gm, `${base}/hls/${clip}/$1`);
      res.writeHead(200, { 'Content-Type': MIME['.m3u8'] });
      return res.end(text);
    }
    if ((m = /^\/hls\/(\d+)\/(seg\d+\.ts)$/.exec(p))) return sendFile(req, res, path.join(VID, `live-${m[1]}`, m[2]));
    res.writeHead(404); res.end();
  });

  return {
    server,
    listen: (port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(base); })),
    trending: () => ({
      movie: [102, 110, 103, 105, 117, 101, 109].map((id) => { const m = MOVIES.find((x) => x.id === id); return { id: 900000 + id, title: m.name, original: m.name, year: String(m.year), overview: m.plot, backdrop: img(`backdrop-${id}.jpg`) }; }),
      tv: [202, 201, 206, 205, 203, 208].map((id) => { const s = SERIES.find((x) => x.id === id); return { id: 900000 + id, title: s.name, original: s.name, year: String(s.year), overview: s.plot, backdrop: img(`backdrop-${id}.jpg`) }; }),
    }),
    runtimeOf: (tmdbId) => { const id = Number(tmdbId) - 900000; const m = MOVIES.find((x) => x.id === id); const s = SERIES.find((x) => x.id === id); return m ? m.mins : s ? s.epMins : 0; },
  };
}

module.exports = { createDemoServer };
