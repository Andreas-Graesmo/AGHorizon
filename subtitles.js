'use strict';
/**
 * AG Horizon – subtitles, used by server.js.
 *
 *  - Text subtitles inside a downloaded file are saved once as .srt files next to the video, named the way
 *    Plex / Kodi / VLC expect ("Movie (2020).nob.srt", "….eng.forced.srt"), so they also work in those apps.
 *  - OpenSubtitles.com finds subtitles for everything else, with the person's own API key and account.
 *  - The player gets WebVTT (srtToVtt).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

// Picture-based subtitles (PGS, DVD, DVB) can't become text, so only these are saved.
const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

const baseOf = (video) => video.slice(0, video.length - path.extname(video).length);

// The .srt files that belong to a video: "<name>.<lang>[.forced][.sdh][.2].srt"
async function listSrt(video) {
  const dir = path.dirname(video);
  const base = path.basename(baseOf(video));
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  return names
    .filter((n) => n.startsWith(base + '.') && n.toLowerCase().endsWith('.srt'))
    .map((n) => {
      const tags = n.slice(base.length + 1, -4).split('.');
      const k = Number(tags.find((t) => /^\d+$/.test(t))) || 1;
      return { file: path.join(dir, n), lang: tags[0] || '', forced: tags.includes('forced'), sdh: tags.includes('sdh'), k };
    })
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.forced - b.forced || a.sdh - b.sdh || a.k - b.k);
}

// Subtitle streams of a file, from ffmpeg's stream listing. index = position among the subtitle streams (0:s:index).
function probeSubs(bin, video) {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['-hide_banner', '-nostdin', '-i', video], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      const out = [];
      for (const line of err.split(/\r?\n/)) {   // ffmpeg ends lines with \r\n on Windows
        const m = /Stream #\d+:\d+(?:\[\w+\])?(?:\((\w+)\))?: Subtitle: (\w+)(.*)$/.exec(line);
        if (m) out.push({ index: out.length, lang: (m[1] || 'und').toLowerCase(), codec: m[2].toLowerCase(), forced: /\(forced\)/.test(m[3]), sdh: /\(hearing impaired\)/.test(m[3]) });
      }
      resolve(out);
    });
  });
}

// Save the text subtitles inside a video as .srt files (one ffmpeg pass; reads the whole file, ~10 s for 5 GB).
const extracting = new Map(); // video -> promise, so two requests don't extract twice
async function extractEmbedded(bin, video) {
  if (extracting.has(video)) return extracting.get(video);
  const job = (async () => {
    const tracks = (await probeSubs(bin, video)).filter((t) => TEXT_CODECS.has(t.codec));
    if (!tracks.length) return 0;
    const used = new Set((await listSrt(video)).map((s) => path.basename(s.file)));
    const base = baseOf(video);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', video];
    for (const t of tracks) {
      const tag = `${t.lang}${t.forced ? '.forced' : ''}${t.sdh ? '.sdh' : ''}`;
      let name = `${path.basename(base)}.${tag}.srt`;
      for (let k = 2; used.has(name); k++) name = `${path.basename(base)}.${tag}.${k}.srt`;
      used.add(name);
      args.push('-map', `0:s:${t.index}`, '-c:s', 'srt', path.join(path.dirname(video), name));
    }
    await new Promise((resolve) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
      proc.on('error', resolve);
      proc.on('close', resolve);
    });
    return tracks.length;
  })();
  extracting.set(video, job);
  try { return await job; } finally { extracting.delete(video); }
}

// The subtitles of a downloaded file; the first time, the built-in ones are saved as .srt.
const checked = new Set();
async function localSubs(bin, video) {
  let list = await listSrt(video);
  if (!list.length && bin && !checked.has(video)) {
    checked.add(video);   // a file without text subtitles isn't read again this session
    await extractEmbedded(bin, video);
    list = await listSrt(video);
  }
  return list;
}

// Save an OpenSubtitles download next to the video as "<name>.<lang>.srt" (or ".<lang>.2.srt" …).
async function saveSrt(video, lang, srt) {
  const base = baseOf(video);
  let file = `${base}.${lang}.srt`;
  for (let k = 2; fs.existsSync(file); k++) file = `${base}.${lang}.${k}.srt`;
  await fsp.writeFile(file, srt);
  return file;
}

// SRT text -> WebVTT. Also drops ASS override codes ("{\an8}") that survive conversion from .ass.
function srtToVtt(buf) {
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1');   // older subtitles are often Windows-1252
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(text)) return text;
  return 'WEBVTT\n\n' + text
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?font[^>]*>/gi, '');   // WebVTT has no <font>; ffmpeg adds it when converting .ass
}

/* --------------------------------------------------------- OpenSubtitles.com */
// REST API v1. The API key belongs to the app (OpenSubtitles allows one key per app, not one per user); people
// log in with their own account to download, and each download counts against that account's daily limit.
// The key isn't in the repository: the release build writes secrets.json from a GitHub secret. For running from
// source, put { "opensubtitlesApiKey": "…" } in secrets.json next to this file, or set OPENSUBTITLES_API_KEY.
const OS_KEY = process.env.OPENSUBTITLES_API_KEY || (() => { try { return require('./secrets.json').opensubtitlesApiKey || ''; } catch { return ''; } })();
const OS_API = 'https://api.opensubtitles.com/api/v1';
const OS_UA = `AGHorizon v${require('./package.json').version}`;   // the consumer's name on opensubtitles.com
const osTokens = new Map(); // username -> token

const osError = (status, message) => Object.assign(new Error(message), { status });

async function osRequest(cfg, pathAndQuery, { method = 'GET', body, auth = false } = {}) {
  if (!OS_KEY) throw osError(501, 'OpenSubtitles isn’t available in this build of AG Horizon');
  cfg = cfg || {};
  const headers = { 'Api-Key': OS_KEY, 'User-Agent': OS_UA, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) headers.Authorization = 'Bearer ' + (await osToken(cfg));
  const r = await fetch(OS_API + pathAndQuery, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && auth && !cfg.retried) {   // token expired: log in again once
    osTokens.delete(cfg.username);
    return osRequest({ ...cfg, retried: true }, pathAndQuery, { method, body, auth });
  }
  if (!r.ok) {
    const msg = j.message || (Array.isArray(j.errors) ? j.errors.join(', ') : '') || `HTTP ${r.status}`;
    throw osError(r.status === 401 || r.status === 403 ? 401 : 502, `OpenSubtitles: ${msg}`);
  }
  return j;
}

async function osToken(cfg) {
  const key = cfg.username;
  if (osTokens.has(key)) return osTokens.get(key);
  if (!cfg.username || !cfg.password) throw osError(400, 'Add your OpenSubtitles username and password in Settings › Subtitles');
  const j = await osRequest(cfg, '/login', { method: 'POST', body: { username: cfg.username, password: cfg.password } });
  if (!j.token) throw osError(401, 'OpenSubtitles: login failed');
  osTokens.set(key, j.token);
  return j.token;
}

// q: { tmdb_id | parent_tmdb_id + season_number + episode_number | query (+ year), languages: "en,no" }
async function osSearch(cfg, q) {
  const params = Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v).toLowerCase()])
    .sort(([a], [b]) => (a < b ? -1 : 1));   // the API wants parameters sorted and lower case (it redirects otherwise)
  const j = await osRequest(cfg, '/subtitles?' + new URLSearchParams(params));
  return (j.data || []).map((s) => {
    const a = s.attributes || {};
    const f = (a.files || [])[0] || {};
    return { fileId: f.file_id, lang: a.language || '', release: a.release || f.file_name || '', downloads: a.download_count || 0, sdh: !!a.hearing_impaired, trusted: !!a.from_trusted, ai: !!(a.ai_translated || a.machine_translated) };
  }).filter((s) => s.fileId);
}

async function osDownload(cfg, fileId) {
  const j = await osRequest(cfg, '/download', { method: 'POST', body: { file_id: Number(fileId) }, auth: true });
  if (!j.link) throw osError(502, `OpenSubtitles: ${j.message || 'no download link'}`);
  const r = await fetch(j.link, { headers: { 'User-Agent': OS_UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw osError(502, `OpenSubtitles: download failed (HTTP ${r.status})`);
  return { srt: Buffer.from(await r.arrayBuffer()), remaining: j.remaining };
}

async function osLogin(cfg) {
  osTokens.delete(cfg.username);
  await osToken(cfg);
  const j = await osRequest(cfg, '/infos/user', { auth: true }).catch(() => ({}));   // the quota is a bonus
  const u = j.data || {};
  return { allowed: u.allowed_downloads, remaining: u.remaining_downloads, level: u.level || '' };
}

module.exports = { localSubs, saveSrt, srtToVtt, osSearch, osDownload, osLogin, osAvailable: !!OS_KEY };
