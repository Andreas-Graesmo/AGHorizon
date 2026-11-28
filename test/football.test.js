'use strict';
// public/js/football-core.js: finding a team's matches in guide titles and channel names, without false hits.
const test = require('node:test');
const assert = require('node:assert');
const { FB_TEAMS, fbMatches, fbFindTeams, fbSearch, fbText, fbGroup, fbNorm } = require('../public/js/football-core');
const team = (id) => FB_TEAMS.find((t) => t.id === id);

test('Manchester United by every name it goes by', () => {
  const mu = team('man-utd');
  for (const s of ['Premier League: Manchester United v Liverpool', 'Man Utd - Arsenal', 'Man. Utd vs Chelsea', 'Man United – Everton',
    'EPL 03: MUN vs LIV 21:00', 'LIV - MUN', 'MUFC TV', 'Live: ManU v Spurs', 'Manchester Utd mot Brighton', 'Red Devils v Leeds (Premier League)']) {
    assert.ok(fbMatches(mu, s), s);
  }
});

test('…and not other teams, or other things', () => {
  const mu = team('man-utd');
  for (const s of ['Manchester City v Liverpool', 'Man City - Arsenal', 'Leeds United v Everton', 'West Ham United v Fulham', 'Newcastle United - Spurs',
    'Munich: the city', 'MUNICH v LIV', 'Manu Ginobili: a career', 'Red Devils (documentary)', 'The Sun v the Moon', 'Carlisle United v Barrow']) {
    assert.ok(!fbMatches(mu, s), s);
  }
  assert.ok(fbMatches(team('man-city'), 'Man City - Arsenal'));
  assert.ok(!fbMatches(team('man-city'), 'Manchester United v Liverpool'));
});

test('words that mean other things only count about football', () => {
  const brann = team('brann');
  assert.ok(fbMatches(brann, 'Brann - Molde'));
  assert.ok(fbMatches(brann, 'Eliteserien: Brann mot Rosenborg'));
  assert.ok(fbMatches(brann, 'SK Brann – sesongen'));
  assert.ok(!fbMatches(brann, 'Brann i Bergen sentrum'));
  assert.ok(!fbMatches(team('viking'), 'Vikings: Valhalla'));
  assert.ok(!fbMatches(team('viking'), 'The last Viking king'));
  assert.ok(fbMatches(team('viking'), 'Viking - Bodø/Glimt'));
  assert.ok(fbMatches(team('bodo-glimt'), 'Bodø/Glimt - Viking'));
  assert.ok(!fbMatches(team('nt-norway'), 'Norway from above'));
  assert.ok(fbMatches(team('nt-norway'), 'VM-kvalik: Norge - Italia'));
  assert.ok(fbMatches(team('nt-norway'), 'Norway v Italy'));
  assert.ok(!fbMatches(team('arsenal'), 'Arsenal of democracy'));
  assert.ok(fbMatches(team('arsenal'), 'Arsenal v Spurs'));
  assert.ok(fbMatches(team('real-madrid'), 'LaLiga: Real Madrid - Barcelona'));
  assert.ok(!fbMatches(team('real-madrid'), 'Atlético Madrid v Sevilla'));
  assert.ok(!fbMatches(team('milan'), 'Inter Milan v Roma'));
});

test('a search finds the team it means', () => {
  assert.strictEqual(fbFindTeams('mufc')[0].id, 'man-utd');
  assert.strictEqual(fbFindTeams('Man Utd')[0].id, 'man-utd');
  assert.strictEqual(fbFindTeams('glimt')[0].id, 'bodo-glimt');
  assert.strictEqual(fbFindTeams('Bodø')[0].id, 'bodo-glimt');
  assert.strictEqual(fbFindTeams('vålerenga')[0].id, 'valerenga');
  assert.deepStrictEqual(fbFindTeams(''), []);
  assert.strictEqual(fbNorm('Bodø/Glimt'), 'bodo glimt');
});

test('the guide and channel names: now, later, event channels; one row per programme', () => {
  const now = Date.parse('2026-11-28T15:00:00Z'), h = 3600e3;
  const chs = [{ name: 'Sky Sports Main Event' }, { name: 'Sky Sports Main Event HD' }, { name: 'EPL 03: Man Utd vs Liverpool 20:00' }, { name: 'NRK1' }];
  const guide = {
    'Sky Sports Main Event': [[now - h, now + h, 'Premier League: Man Utd v Liverpool', ''], [now + 3 * h, now + 5 * h, 'Arsenal v Chelsea', '']],
    'Sky Sports Main Event HD': [[now - h, now + h, 'Premier League: Man Utd v Liverpool', '']],
    NRK1: [[now - 3 * h, now - 2 * h, 'Man Utd v Spurs', 'old'], [now + h, now + 2 * h, 'Nyheter', '']],
  };
  const r = fbSearch((s) => fbMatches(team('man-utd'), s), chs, (c) => guide[c.name] || null, now);
  assert.strictEqual(r.now.length, 2);
  assert.strictEqual(r.later.length, 0);   // the old one has ended
  assert.deepStrictEqual(r.channels.map((c) => c.name), ['EPL 03: Man Utd vs Liverpool 20:00']);
  const rows = fbGroup(r.now);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].chs.length, 2);
  const t = fbSearch(fbText('arsenal chelsea'), chs, (c) => guide[c.name] || null, now);
  assert.strictEqual(t.later.length, 1);
});

test("a team's own channels (MUTV, Manchester United TV): not match channels; only their live matches count", () => {
  const mu = FB_TEAMS.find((t) => t.id === 'man-utd');
  const now = Date.parse('2026-11-28T15:00:00Z'), h = 3600e3;
  const chs = [{ name: 'UK: MUTV' }, { name: 'Manchester United TV HD' }, { name: 'EPL 03: Man Utd vs Liverpool 20:00' }, { name: 'Sky Sports Main Event' }];
  const guide = {
    'UK: MUTV': [[now - h, now + h, 'Classic: Manchester United v Liverpool (1999)', ''], [now + 4 * h, now + 6 * h, 'LIVE: Pre-season friendly: Man Utd v Celtic', ''],
      [now + 7 * h, now + 9 * h, 'Man Utd v Arsenal', ''], [now + 10 * h, now + 12 * h, 'Live Replay: Man Utd v Spurs', '']],
    'Manchester United TV HD': [[now + h, now + 2 * h, 'Man Utd v Arsenal: highlights', '']],
    'Sky Sports Main Event': [[now + 2 * h, now + 4 * h, 'Man Utd v Liverpool', '']],
  };
  const r = fbSearch((s) => fbMatches(mu, s), chs, (c) => guide[c.name] || null, now);
  assert.deepStrictEqual(r.channels.map((c) => c.name), ['EPL 03: Man Utd vs Liverpool 20:00']);
  assert.strictEqual(r.now.length, 0);
  // there, only a live match (pre-season): not the classic, not a match without "live", not a replay
  assert.deepStrictEqual(r.later.map((x) => `${x.ch.name}: ${x.p[2]}`), ['Sky Sports Main Event: Man Utd v Liverpool', 'UK: MUTV: LIVE: Pre-season friendly: Man Utd v Celtic']);
});

test('replays go apart: said so, a short slot, or the same match again', () => {
  const { fbSplitReplays } = require('../public/js/football-core');
  const h = 3600e3, t0 = Date.parse('2026-11-28T12:00:00Z');
  const row = (start, mins, title, desc = '') => ({ p: [t0 + start * h, t0 + start * h + mins * 60e3, title, desc], chs: [{ name: 'x' }] });
  const s = fbSplitReplays([
    row(0, 150, 'Premier League: Man Utd v Liverpool', 'Live coverage'),      // the match
    row(5, 150, 'Man Utd v Liverpool', ''),                                     // the same match again: a replay
    row(8, 45, 'Man Utd v Liverpool: Highlights', ''),                          // said so
    row(9, 60, 'Premier League: Arsenal v Man Utd', ''),                        // a short slot
    row(20, 135, 'Man City v Man Utd', ''),                                     // one airing, long: the match
    row(22, 120, 'Man Utd v Spurs (R)', ''),                                    // (R)
    row(23, 120, 'Brann - Molde: reprise', ''),
  ]);
  assert.deepStrictEqual(s.main.map((r) => r.p[2]), ['Premier League: Man Utd v Liverpool', 'Man City v Man Utd']);
  assert.strictEqual(s.replays.length, 5);
  // the same match twice, neither marked: the first is the match, the later one the replay
  const s2 = fbSplitReplays([row(3, 120, 'Leeds v Man Utd'), row(1, 120, 'Leeds United v Manchester United')]);
  assert.deepStrictEqual(s2.main.map((r) => r.p[2]), ['Leeds United v Manchester United']);
});

test("a team's match: one stretch of time, whatever the channel's build-up; the rest apart (the owner's guide, 28 Nov)", () => {
  const { fbSplitTeam } = require('../public/js/football-core');
  const mu = FB_TEAMS.find((t) => t.id === 'man-utd');
  const at = (h, m) => Date.parse(`2026-11-28T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const row = (a, b, title, desc = '', chs = 1) => ({ p: [a, b, title, desc], chs: Array.from({ length: chs }, (_, i) => ({ name: `c${i}` })) });
  const s = fbSplitTeam([
    row(at(15, 0), at(17, 0), 'Fudbal – Engleska liga: Manchester United – Brentford', 'Svakog avgusta 20 ekipa započinje lov na najcenjeniji trofej engleskog fudbala.'),
    row(at(15, 0), at(17, 0), 'Fussball: Liverpool FC – Manchester United', 'LFC TV – Premier League 11. Spieltag.'),
    row(at(15, 5), at(16, 55), 'Fussball: Liverpool FC – Manchester United', 'LFC TV – Premier League 11. Spieltag.'),
    row(at(15, 30), at(16, 0), 'Premier League Studie', 'Se med, når vi varmer op til den forestående Premier League-kamp mellem Manchester United og Brentford'),
    row(at(15, 30), at(18, 30), 'Manchester United vs Brentford – English Premier League 2026/27', 'Manchester Utd vs Brentford At 28-11-2026, GMT 15:00', 2),
    row(Date.parse('2026-11-29T07:00:00Z'), Date.parse('2026-11-29T09:00:00Z'), 'Fudbal – Liga šampiona: Sporting – Manchester United', 'Na predlog francuskog novinara…'),
    row(Date.parse('2026-11-29T13:40:00Z'), Date.parse('2026-11-29T15:35:00Z'), 'Fussball: Sporting Clube de Portugal – Manchester United', 'UEFA Champions League, 5. Spieltag – Deutsch.'),
  ], mu);
  assert.deepStrictEqual(s.main.map((r) => r.p[2]), ['Fudbal – Engleska liga: Manchester United – Brentford', 'Manchester United vs Brentford – English Premier League 2026/27']);
  assert.strictEqual(s.replays.length, 5);
});
