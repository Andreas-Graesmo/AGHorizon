'use strict';
/* AG Horizon – the Football page: your teams' matches, from the TV guide and the channel names (football-core.js
   finds them), each team on its own; a search for any team or match; and picking the teams. The rail's ball icon. */

const fb = { q: '', picking: false };
const fbTeamsChosen = () => LS.get('tuner.fbTeams', []).map((id) => FB_TEAMS.find((t) => t.id === id)).filter(Boolean);
function fbToggleTeam(id) {
  const ids = LS.get('tuner.fbTeams', []);
  LS.set('tuner.fbTeams', ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  renderFootball();
}

// The live channels of every playlist that has loaded; the current one is loaded, with its guide, if it hasn't been.
function fbChannels() {
  const pid = curPid();
  const p = pid && playlistById(pid);
  if (p && !state.cache[p.id] && !fb.loading) {
    fb.loading = true;
    loadPlaylist(p).catch(() => {}).finally(() => { fb.loading = false; if (ui.route === 'football') renderFootball(); });
  }
  if (p && state.cache[p.id] && !state.epg[p.id] && !state.epgState[p.id]) loadEpg(p);
  const out = [];
  for (const pl of state.playlists) { const info = state.cache[pl.id]; if (info && info.channels) out.push(...info.channels); }
  return out;
}
// The guide and channel names, ready to search: built again when a playlist or its guide changes, a few hundred
// channels at a time with a pause between (100: a TV does them in well under a tenth of a second), so the page (and a TV's remote) stays responsive while it builds.
function fbIndex() {
  const chans = fbChannels();
  const key = state.playlists.map((p) => `${p.id}:${state.cache[p.id] ? state.cache[p.id].channels.length : 0}:${state.epg[p.id] ? Object.keys(state.epg[p.id].programmes).length : 0}`).join('|');
  if (fb.index && fb.index.key === key) return fb.index.done ? fb.index.data : null;
  if (fb.index && fb.index.key !== key && fb.index.job) clearTimeout(fb.index.job);
  const job = { key, data: fbNewIndex(), done: false, job: 0 };
  fb.index = job;
  const now = Date.now();
  let i = 0;
  const step = () => {
    if (fb.index !== job) return;
    const end = Math.min(chans.length, i + 100);
    for (; i < end; i++) fbIndexAdd(job.data, chans[i], (ch) => programmesFor(ch), now);
    if (i < chans.length) { job.job = setTimeout(step, 0); return; }
    job.done = true;
    if (ui.route === 'football') fbRefresh();
  };
  step();
  return job.done ? job.data : null;
}
// Each team's real matches from TheSportsDB (/api/fixtures), which tell a match from last weekend's replay: kept 6 hours
// (here and across restarts), a failed lookup 10 minutes. TheSportsDB's name for a team, where it differs from ours:
const FB_TSDB_NAMES = { brighton: 'Brighton and Hove Albion', athletic: 'Athletic Bilbao', inter: 'Inter Milan', psg: 'Paris SG', atletico: 'Atletico Madrid' };
const fbFold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ø/g, 'o').replace(/Ø/g, 'O').replace(/æ/g, 'ae').replace(/å/g, 'a');
fb.fx = LS.get('tuner.fbFixtures', {});
function fbFixtures(team) {
  const c = fb.fx[team.id];
  if (c && Date.now() - c.t < (c.v ? 6 * 3600e3 : c.miss ? 864e5 : 10 * 60e3)) return c.v;
  if (c && c.busy) return c.v || null;
  fb.fx[team.id] = { ...(c || {}), busy: true, t: c ? c.t : 0 };
  const names = [...new Set([FB_TSDB_NAMES[team.id], team.name, fbFold(team.name)].filter(Boolean))];
  (async () => {
    let v = null, miss = true;
    for (const n of names) {
      const r = await fetch(`/api/fixtures?q=${enc(n)}`).catch(() => null);
      if (r && r.ok) { v = await r.json().catch(() => null); if (v) break; }
      if (!r || r.status !== 404) { miss = false; break; }   // TheSportsDB is down: not "no such team"; try again soon
    }
    fb.fx[team.id] = { t: Date.now(), v, miss: !v && miss };
    const keep = {};
    for (const [id, x] of Object.entries(fb.fx)) if (x.v || x.miss) keep[id] = { t: x.t, v: x.v, miss: x.miss };
    LS.set('tuner.fbFixtures', keep);
    if (ui.route === 'football' && v) fbRefresh();
  })();
  return (c && c.v) || null;
}
const fbVs = (f) => `${f.home} – ${f.away}`;
function fbFixtureLine(team) {
  const fx = fbFixtures(team);
  if (!fx) return '';
  const { next, last } = fbNextLast([...fx.next, ...fx.last], Date.now());
  const part = (label, f, extra) => f ? `<span><b>${label}</b> ${esc(fbVs(f))}${extra}<small class="muted"> · ${esc(f.league)}</small></span>` : '';
  const html = part(next && next.at <= Date.now() ? 'Now:' : 'Next:', next, next ? ` <span class="muted">${esc(fbWhen(next.at))}</span>` : '') + part('Last:', last, last ? ` <b class="fb-score">${esc(last.score)}</b>` : '');
  return html ? `<div class="fb-fx">${html}</div>` : '';
}

const fbRefresh = () => { if ($('#fbBody')) $('#fbBody').innerHTML = fbBody(); };

const fbGuideState = () => {
  const pid = curPid();
  return fb.loading ? 'loading' : String((pid && state.epgState[pid]) || '');
};

function fbWhen(ms) {
  const d = new Date(ms), today = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(today)) / 86400e3);
  const label = diff === 0 ? '' : diff === 1 ? 'Tomorrow ' : d.toLocaleDateString([], { weekday: 'short' }) + ' ';
  return label + fmtTime(ms);
}

const FB_MAX_CHANNELS = 6;
function fbRow(r, now, replay = false) {
  const live = r.p[0] <= now && !replay;
  const chs = r.chs.slice(0, FB_MAX_CHANNELS).map((ch) => `<button class="chip-btn fb-ch" data-fb-play="${esc(ch.uid)}" title="Watch on ${esc(ch.name)}">${esc(ch.name)}</button>`).join('');
  const more = r.chs.length > FB_MAX_CHANNELS ? `<span class="muted">+${r.chs.length - FB_MAX_CHANNELS} more</span>` : '';
  const pct = live ? Math.max(0, Math.min(100, ((now - r.p[0]) / (r.p[1] - r.p[0])) * 100)) : 0;
  return `<div class="fb-row${live ? ' live' : ''}${replay ? ' replay' : ''}">
    <div class="fb-when">${live ? '<span class="live-badge"><i></i>LIVE</span>' : esc(fbWhen(r.p[0]))}<small>${esc(fmtTime(r.p[0]))} – ${esc(fmtTime(r.p[1]))}</small>${live ? `<div class="bar"><i style="width:${pct.toFixed(0)}%"></i></div>` : ''}</div>
    <div class="fb-what"><b>${esc(r.p[2] || '')}</b>${r.fx ? `<span class="fb-ok" title="Kick-off ${esc(fbWhen(r.fx.at))}: ${esc(fbVs(r.fx))}">✓ ${esc(r.fx.league || 'Match')}</span>` : ''}${r.p[3] ? `<p class="muted">${esc(String(r.p[3]).slice(0, 160))}</p>` : ''}</div>
    <div class="fb-chs">${chs}${more}</div></div>`;
}

// What the guide and the channel names have for a test (a team, or a text): now, later, and channels named after it.
function fbResults(test, emptyText, all = false, team = null) {
  const now = Date.now();
  const index = fbIndex();
  if (!index) return '<p class="muted fb-none">Searching the TV guide…</p>';
  const r = fbSearchIndex(test, index, now, all);
  const rows = fbGroup([...r.now, ...r.later]);
  const fx = team && fbFixtures(team);
  const split = team ? fbSplitTeam(rows, team, fx ? [...fx.next, ...fx.last] : null) : fbSplitReplays(rows);
  const nowRows = split.main.filter((x) => x.p[0] <= now), later = split.main.filter((x) => x.p[0] > now).slice(0, 30);
  const replays = split.replays.sort((a, b) => a.p[0] - b.p[0]).slice(0, 30);
  const named = r.channels.filter((ch) => !r.now.some((h) => h.ch === ch) && !r.later.some((h) => h.ch === ch)).slice(0, 24);
  if (!nowRows.length && !later.length && !named.length && !replays.length) {
    const g = fbGuideState();
    const why = g === 'loading' ? 'Loading the TV guide…' : g === 'none' ? 'This playlist has no TV guide, so only channel names are searched.' : g.startsWith('error') ? `The TV guide could not be loaded (${esc(g.slice(7))}): only channel names are searched.` : '';
    return `<p class="muted fb-none">${emptyText}${why ? ` ${why}` : ''}</p>`;
  }
  // the channels named after a match first (owner's request), then the matches; replays and highlights last
  return `${named.length ? `<h4 class="fb-sub">Channels</h4><div class="fb-chs wrap">${named.map((ch) => `<button class="chip-btn fb-ch" data-fb-play="${esc(ch.uid)}">${esc(ch.name)}</button>`).join('')}</div>` : ''}
    ${nowRows.length ? `<h4 class="fb-sub">On now</h4><div class="fb-list">${nowRows.map((x) => fbRow(x, now)).join('')}</div>` : ''}
    ${later.length ? `<h4 class="fb-sub">Coming up</h4><div class="fb-list">${later.map((x) => fbRow(x, now)).join('')}</div>` : ''}
    ${replays.length ? `<h4 class="fb-sub">Replays, highlights and shows</h4><div class="fb-list fb-replays">${replays.map((x) => fbRow(x, now, true)).join('')}</div>` : ''}`;
}

function fbPicker() {
  const chosen = new Set(LS.get('tuner.fbTeams', []));
  return `<section class="sec fb-picker"><div class="rail-head"><h3>Your teams</h3><span class="muted">Pick as many as you like: each gets its own part of this page.</span>
      ${chosen.size ? '<button class="btn ghost" data-fb-act="done">Done</button>' : ''}</div>
    ${FB_LEAGUES.map((lg) => `<h4 class="fb-sub">${esc(lg)}</h4><div class="fb-chs wrap">${FB_TEAMS.filter((t) => t.league === lg).map((t) =>
      `<button class="chip-btn${chosen.has(t.id) ? ' on' : ''}" data-fb-team="${t.id}">${chosen.has(t.id) ? '✓ ' : ''}${esc(t.name)}</button>`).join('')}</div>`).join('')}</section>`;
}

function fbSearchHtml() {
  const q = fb.q.trim();
  if (!q) return '';
  const teams = fbFindTeams(q).slice(0, 6);
  const chosen = new Set(LS.get('tuner.fbTeams', []));
  const t = teams[0];
  // a team's name: all its names; anything else: the words, anywhere in a title, a description or a channel's name
  const test = t ? (doc) => fbMatchDoc(t, doc) : fbText(q);
  const add = teams.length ? `<div class="fb-chs wrap">${teams.map((x) => chosen.has(x.id) ? '' : `<button class="chip-btn" data-fb-team="${x.id}">＋ Add ${esc(x.name)}</button>`).join('')}</div>` : '';
  return `<section class="sec fb-team"><div class="rail-head"><h3>${t ? esc(t.name) : `“${esc(q)}”`}</h3>${t ? `<span class="muted">${esc(t.league)}</span>` : ''}</div>
    ${t ? fbFixtureLine(t) : ''}${add}${fbResults(test, `Nothing for ${esc(t ? t.name : q)} in the TV guide or the channel names right now.`, !t, t)}</section>`;
}

function fbBody() {
  const teams = fbTeamsChosen();
  if (fb.picking || (!teams.length && !fb.q.trim())) return fbSearchHtml() + fbPicker();
  return fbSearchHtml() + teams.map((t) => `<section class="sec fb-team" data-team="${t.id}">
      <div class="rail-head"><h3>${esc(t.name)}</h3><span class="muted">${esc(t.league)}</span><div class="grow"></div>
        <button class="icon-btn sm" data-fb-team="${t.id}" title="Remove ${esc(t.name)}" aria-label="Remove ${esc(t.name)}"><svg class="ic"><use href="#i-x"/></svg></button></div>
      ${fbFixtureLine(t)}
      ${fbResults((doc) => fbMatchDoc(t, doc), `No ${esc(t.name)} match in the TV guide or the channel names right now. The guide covers about the next day and a half.`, false, t)}</section>`).join('');
}

function renderFootball() {
  const el = $('#v-football');
  if (!$('#fbBody', el)) {
    el.innerHTML = `<div class="page">${pageHead('Football', 'Your teams’ matches, from the TV guide and the channel names', '<button class="btn ghost" data-fb-act="teams">Your teams</button>')}
      <label class="fb-search"><svg class="ic"><use href="#i-search"/></svg><input id="fbInput" type="search" placeholder="Search a team or a match, e.g. Man Utd, mufc, Brann – Molde" spellcheck="false" autocomplete="off"></label>
      <div id="fbBody"></div></div>`;
  }
  $('#fbInput').value = fb.q;
  $('#fbBody').innerHTML = fbBody();   // only the results: the search box keeps its focus and caret
}

$('#v-football').addEventListener('input', (e) => {
  if (e.target.id !== 'fbInput') return;
  fb.q = e.target.value;
  clearTimeout(fb.t);
  fb.t = setTimeout(fbRefresh, 250);
});
$('#v-football').addEventListener('click', (e) => {
  const play = e.target.closest('[data-fb-play]');
  if (play) {
    const ch = (fb.index && fb.index.data.chans.find((c) => c.ch.uid === play.dataset.fbPlay) || {}).ch;
    if (ch) playChannel(ch);
    return;
  }
  const team = e.target.closest('[data-fb-team]');
  if (team) { fbToggleTeam(team.dataset.fbTeam); return; }
  const act = e.target.closest('[data-fb-act]');
  if (act) { fb.picking = act.dataset.fbAct === 'teams' ? !fb.picking : false; renderFootball(); }
});
// the guide arrived, or the minute changed: what is on now moves on
setInterval(() => { if (ui.route === 'football' && document.activeElement !== $('#fbInput')) renderFootball(); }, 60e3);
