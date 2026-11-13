'use strict';
/* AG Horizon – the sound language: the button next to the subtitles in the player, the language remembered per
   series / movie / channel, and Settings › Playback › Preferred sound language.

   Where the tracks come from:
   - movies and episodes: the check made before playing (/api/probe) lists them;
   - live channels: hls.js, when the stream has a playlist per language; otherwise, for channels marked MULTI-AUDIO
     and the like, the first click checks the stream (hanging up for that: many providers allow one connection).
   How it switches:
   - a track the player decodes, in a file it plays itself: Chromium switches (the AudioVideoTracks feature);
   - hls.js: its own audio playlists;
   - everything else (AC-3 / DTS sound, live MPEG-TS): compatibility mode, where ffmpeg picks the track. */

const AUD_PICKS = 'tuner.audioPick';   // series / movie / channel -> the language last picked for it
// tracks: [{ n, lang, codec, channels, title, def, comment, descr }], n = the track's number for ffmpeg or hls.js
const aud = { uid: '', tracks: [], source: '', want: null, cur: null, nativeMap: null, checked: false };

const audPrefLang = () => subNorm(LS.get('tuner.audioLang', ''));
const audKey = (c) => (c.kind === 'episode' && c.seriesUid) || c.uid;
const audRemembered = (c) => LS.get(AUD_PICKS, {})[audKey(c)] || '';
function audRemember(c, lang) {
  const m = LS.get(AUD_PICKS, {});
  delete m[audKey(c)];
  m[audKey(c)] = subNorm(lang) || String(lang || '');
  const keys = Object.keys(m);
  if (keys.length > 400) keys.slice(0, keys.length - 400).forEach((k) => delete m[k]);
  LS.set(AUD_PICKS, m);
}
// live channels marked as having several languages ("MULTI-AUDIO", "Dual Audio", "[MULTI]"…)
const AUD_TAG = /\b(multi|dual)[\s._-]*(audio|lang(uage)?s?)\b|[[(]multi[\])]/i;
const audTagged = (c) => !!c && !isVod(c) && (AUD_TAG.test(`${c.name} ${c.group || ''}`) || /\bMULTI\b(?![\s._-]*SUB)/.test(`${c.name} ${c.group || ''}`));
const audNativeCodec = (codec) => NATIVE_AUDIO.includes(codec) || /^pcm_/.test(codec || '');
const audTrack = (n) => aud.tracks.find((t) => t.n === n) || null;
const audDefault = () => { const d = aud.tracks.find((t) => t.def); return d ? d.n : aud.tracks.length ? aud.tracks[0].n : null; };

/* ── names ── */
const AUD_CODECS = { aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', truehd: 'Dolby TrueHD', dts: 'DTS', mp3: 'MP3', mp2: 'MP2', opus: 'Opus', flac: 'FLAC', vorbis: 'Vorbis' };
function audLang(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'qaa') return 'Original language';
  return subLabel(subNorm(c) || c);
}
function audName(t) {
  if (!t) return '';
  const lang = audLang(t.lang);
  const title = t.title && t.title.toLowerCase() !== lang.toLowerCase() && !/^(sound|audio)handler$/i.test(t.title) ? t.title : '';
  const same = aud.tracks.filter((x) => audLang(x.lang) === lang).length > 1;   // two English tracks: tell them apart
  return [lang, title, t.comment && 'Commentary', t.descr && 'Audio description',
    t.channels && (t.channels !== 'Stereo' || same) ? t.channels : '', same && AUD_CODECS[t.codec]].filter(Boolean).join(' · ');
}

/* ── which track ── */
// The track to play: picked in this video > picked for this series / movie / channel before > Settings > the default.
// Commentary and audio description only when picked by hand. Of two in the same language: the default one, then
// one the player decodes itself (no conversion needed).
function audPick(c) {
  if (aud.want != null && audTrack(aud.want)) return aud.want;
  for (const lang of [audRemembered(c), audPrefLang()].filter(Boolean)) {
    const hits = aud.tracks.filter((t) => (subNorm(t.lang) || t.lang) === lang && !t.comment && !t.descr);
    if (hits.length) return (hits.find((t) => t.def) || hits.find((t) => audNativeCodec(t.codec)) || hits[0]).n;
  }
  return audDefault();
}
// the language of the sound playing (or about to): the subtitles leave it alone when it's the one they'd show
const audLangNow = () => { const t = audTrack(aud.cur != null ? aud.cur : state.current ? audPick(state.current) : null); return t ? t.lang : ''; };

function audReset(c) {
  Object.assign(aud, { uid: c ? c.uid : '', tracks: [], source: '', want: null, cur: null, nativeMap: null, checked: false });
  audRender();
}
// the tracks from the check before playing (/api/probe)
function audSetTracks(c, info) {
  if (!c || aud.uid !== c.uid || !info || !Array.isArray(info.audios) || !info.audios.length) return;
  if (aud.source === 'hls') return;
  aud.tracks = info.audios.map((a) => ({ n: a.index, lang: a.lang, codec: a.codec, channels: a.channels, title: a.title, def: a.default, comment: a.comment, descr: a.descr }));
  aud.source = 'probe';
  audRender();
}

/* ── playing ── */
// What startPlayback should try for a live channel: compatibility mode when a track other than the stream's own
// is wanted (only ffmpeg can pick it out of an MPEG-TS stream). Movies decide in startPlayback, which knows more.
function audPlan(c, plan) {
  if (isVod(c) || aud.source !== 'probe' || !state.ffmpeg || compatMode() === 'off') return plan;
  const n = audPick(c);
  return n != null && n !== audDefault() ? ['tc'] : plan;
}
// Called by playChannel: for a marked channel with a wish (Settings, or picked before), know its tracks first
// (a quick check that hangs up again), so it starts in the right language.
async function audStart(c, token) {
  let plan = playPlan(c);
  if (audTagged(c) && state.ffmpeg && compatMode() !== 'off' && (audRemembered(c) || audPrefLang())) {
    let info = probeCache.get(c.url);
    if (!info || !info.audios) {
      teardown();   // the previous channel's connection first
      showOverlay('loading', 'Tuning in…');
      info = await probeOf(c, playlistById(c.pid), { quick: true });
      if (token !== playToken) return;
    }
    aud.checked = true;
    audSetTracks(c, info);
    plan = audPlan(c, plan);
    if (aud.source === 'probe') aud.cur = audPick(c);   // what it starts with (compatibility mode sets it again)
  }
  startPlayback(c, plan, token);
}
// compatibility mode is starting: the track it should take (null: the stream's first)
function audTcTrack(c, info) {
  audSetTracks(c, info);
  aud.cur = aud.source === 'probe' ? audPick(c) : null;
  audRender();
  return aud.source === 'probe' ? aud.cur : null;
}
// Can a file play directly with the track wanted? (Its video is checked by the caller.)
const audNativeOk = (c) => { const t = audTrack(audPick(c)); return !t || audNativeCodec(t.codec); };

// A file the player plays itself: line its tracks up with ffmpeg's (it lists only those it can decode, in the same
// order) and switch to the one wanted. Chromium changes track at the next seek.
video.addEventListener('loadedmetadata', () => {
  const c = state.current;
  const list = video.audioTracks;
  if (!c || tcState.on || hlsPlayer || tsPlayer || !list || !list.length || aud.uid !== c.uid) return;
  if (aud.source === 'probe') {
    const natives = aud.tracks.filter((t) => audNativeCodec(t.codec));
    aud.nativeMap = natives.length === list.length ? natives.map((t) => t.n) : null;
  } else if (list.length > 1) {   // no check before playing (no ffmpeg): what the player sees
    aud.tracks = [...list].map((t, i) => ({ n: i, lang: t.language || 'und', codec: '', channels: '', title: /handler$/i.test(t.label) ? '' : t.label, def: i === 0, comment: t.kind === 'commentary', descr: t.kind === 'descriptions' }));
    aud.source = 'native';
    aud.nativeMap = aud.tracks.map((t) => t.n);
  }
  if (!aud.nativeMap) { audRender(); return; }
  const want = aud.nativeMap.indexOf(audPick(c));
  const on = [...list].findIndex((t) => t.enabled);
  if (want >= 0 && want !== on) {
    for (let k = 0; k < list.length; k++) list[k].enabled = k === want;
    video.currentTime = video.currentTime;
  }
  aud.cur = aud.nativeMap[want >= 0 ? want : Math.max(0, on)];
  audRender();
});

// hls.js found audio playlists (one per language)
function audFromHls(c, h) {
  if (state.current !== c || aud.uid !== c.uid) return;
  const list = h.audioTracks || [];
  if (list.length < 2) return;
  aud.source = 'hls';
  aud.tracks = list.map((t, i) => ({
    n: i, lang: t.lang || 'und', codec: '', channels: t.channels === '6' ? '5.1' : '', title: t.name || '',
    def: !!t.default, comment: /commentary/i.test(t.characteristics || ''), descr: /describes-video/i.test(t.characteristics || ''),
  }));
  const n = audPick(c);
  if (n != null && n !== h.audioTrack) h.audioTrack = n;
  aud.cur = n;
  audRender();
}

/* ── the button ── */
function audRender() {
  const b = $('#pAudio');
  if (!b) return;
  const c = state.current;
  const many = aud.tracks.length > 1;
  b.hidden = !c || !(many || (audTagged(c) && !aud.checked));
  b.classList.toggle('on', many && aud.cur != null && aud.cur !== audDefault());
  const t = audTrack(aud.cur);
  b.title = many && t ? `Sound: ${audName(t)}` : 'Sound language';
}

function audSelect(n) {
  const c = state.current;
  const t = audTrack(n);
  if (!c || !t) return;
  aud.want = n;
  audRemember(c, t.lang);
  osd(`Sound: ${audName(t)}`);
  if (aud.source === 'hls' && hlsPlayer) { hlsPlayer.audioTrack = n; aud.cur = n; audRender(); return; }
  const list = video.audioTracks;
  const i = aud.nativeMap ? aud.nativeMap.indexOf(n) : -1;
  if (!tcState.on && !hlsPlayer && !tsPlayer && list && i >= 0 && i < list.length) {
    for (let k = 0; k < list.length; k++) list[k].enabled = k === i;
    video.currentTime = video.currentTime;   // Chromium switches at the next seek
    aud.cur = n;
    audRender();
    return;
  }
  if (aud.source === 'native') return;   // can't happen: every track the player listed has a place in nativeMap
  if (!state.ffmpeg || compatMode() === 'off') {
    toast(!state.ffmpeg ? 'This sound track needs ffmpeg, which wasn’t found' : 'This sound track needs compatibility mode, which is off in Settings › Playback', 'err');
    return;
  }
  // into compatibility mode (or back out of it, when this track plays directly), where the picture is
  if (isVod(c) && isFinite(curTime()) && curTime() > 0) resumeAt = curTime();
  startPlayback(c, audPlan(c, playPlan(c)), playToken);
}

// A marked live channel whose tracks aren't known: hang up, check the stream, start again, then show the menu.
async function audCheck(anchor) {
  const c = state.current;
  if (!c) return;
  if (!state.ffmpeg) { toast('Finding the languages needs ffmpeg, which wasn’t found', 'err'); return; }
  const token = playToken;
  teardown();
  showOverlay('loading', 'Checking the languages…');
  const info = await probeOf(c, playlistById(c.pid), { quick: true });
  if (token !== playToken) return;
  aud.checked = true;
  audSetTracks(c, info);
  if (aud.source === 'probe') aud.cur = audPick(c);
  startPlayback(c, audPlan(c, playPlan(c)), token);
  audRender();
  if (aud.tracks.length > 1) audMenu(anchor);
  else toast(aud.tracks.length ? 'This channel has one language' : 'Couldn’t find the languages in this channel');
}

function audMenu(anchor) {
  const c = state.current;
  if (!c) return;
  if (aud.tracks.length < 2) { if (audTagged(c) && !aud.checked) audCheck(anchor); return; }
  const mark = (on) => (on ? '✓  ' : '      ');
  showMenu(anchor, [{ heading: true, label: 'Sound' }, ...aud.tracks.map((t) => ({ label: mark(t.n === aud.cur) + audName(t), run: () => audSelect(t.n) }))]);
}
$('#pAudio').addEventListener('click', (e) => audMenu(e.currentTarget));

/* ── Settings ── */
const LANG_CHOICES = ['ar', 'bs', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'hu', 'is', 'it', 'ja', 'ko', 'ku', 'nl', 'no', 'pa', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'so', 'sq', 'sr', 'sv', 'ta', 'th', 'tr', 'uk', 'ur', 'vi', 'zh'];
function langSelect(key, offLabel) {
  const cur = subNorm(LS.get('tuner.' + key, ''));
  const opts = LANG_CHOICES.map((c) => [c, subLabel(c)]).sort((a, b) => a[1].localeCompare(b[1]));
  return `<select data-langpref="${key}"><option value="">${offLabel}</option>${opts.map(([c, l]) => `<option value="${c}"${c === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
const audSettingsRow = () => `<div class="set-row"><div><b>Preferred sound language</b><p class="muted">When a movie, episode or channel has several sound tracks, this language is picked. What you pick in the player is remembered for that series, movie or channel.</p></div>${langSelect('audioLang', 'The video’s own default')}</div>`;
$('#v-settings').addEventListener('change', (e) => { const k = e.target.dataset.langpref; if (k) LS.set('tuner.' + k, e.target.value); });
