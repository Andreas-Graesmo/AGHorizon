'use strict';
/* AG Horizon – football: the teams, and finding their matches in the TV guide and in channel names (football.js
   shows them). No page here: the tests load this file too (test/football.test.js).

   Each team has the names it goes by. Most are taken as they stand ("manchester united", "mufc"). Some are words
   that also mean other things ("brann" is Norwegian for fire, "arsenal", "wolves", "norway", the three-letter codes):
   those only count when the text is about football too (a "v" between two names, "Premier League", "fotball"…).
   "not" lists names that contain a team's name but are another team ("man city" for Manchester United's "man"). */

const FB_LEAGUES = ['England', 'Norway', 'Spain', 'Italy', 'Germany', 'France', 'National teams'];

// [id, name, league, names, names that only count about football, three-letter codes (only in "MUN v LIV"),
//  other teams' names to ignore]
const FB_TEAMS = [
  // England
  ['arsenal', 'Arsenal', 'England', ['arsenal fc', 'the gunners'], ['arsenal'], ['ARS', 'AFC']],
  ['aston-villa', 'Aston Villa', 'England', ['aston villa', 'avfc'], ['villa'], ['AVL']],
  ['bournemouth', 'Bournemouth', 'England', ['bournemouth', 'afc bournemouth', 'the cherries'], [], ['BOU']],
  ['brentford', 'Brentford', 'England', ['brentford'], [], ['BRE']],
  ['brighton', 'Brighton & Hove Albion', 'England', ['brighton and hove albion', 'brighton hove albion', 'brighton', 'bhafc'], ['seagulls'], ['BHA', 'BRI']],
  ['burnley', 'Burnley', 'England', ['burnley'], [], ['BUR']],
  ['chelsea', 'Chelsea', 'England', ['chelsea fc', 'cfc'], ['chelsea'], ['CHE']],
  ['crystal-palace', 'Crystal Palace', 'England', ['crystal palace', 'cpfc'], ['palace'], ['CRY']],
  ['everton', 'Everton', 'England', ['everton', 'efc', 'the toffees'], [], ['EVE']],
  ['fulham', 'Fulham', 'England', ['fulham', 'ffc'], [], ['FUL']],
  ['ipswich', 'Ipswich Town', 'England', ['ipswich town', 'ipswich', 'itfc'], [], ['IPS']],
  ['leeds', 'Leeds United', 'England', ['leeds united', 'leeds utd', 'lufc'], ['leeds'], ['LEE']],
  ['leicester', 'Leicester City', 'England', ['leicester city', 'leicester', 'lcfc', 'the foxes'], [], ['LEI']],
  ['liverpool', 'Liverpool', 'England', ['liverpool fc', 'lfctv', 'lfc'], ['liverpool', 'the reds'], ['LIV']],
  ['man-city', 'Manchester City', 'England', ['manchester city', 'man city', 'mcfc', 'man c'], ['citizens'], ['MCI'], ['manchester united', 'man united', 'man utd']],
  ['man-utd', 'Manchester United', 'England', ['manchester united', 'manchester utd', 'man united', 'man utd', 'man u', 'mufc', 'mutv'], ['manu', 'red devils'], ['MUN'], ['manchester city', 'man city', 'leeds united', 'west ham united', 'newcastle united', 'sheffield united']],
  ['newcastle', 'Newcastle United', 'England', ['newcastle united', 'newcastle utd', 'newcastle', 'nufc', 'the magpies'], [], ['NEW']],
  ['nottingham-forest', 'Nottingham Forest', 'England', ['nottingham forest', 'nottm forest', 'notts forest', 'nffc'], ['forest'], ['NFO']],
  ['southampton', 'Southampton', 'England', ['southampton', 'saints fc'], ['saints'], ['SOU']],
  ['sunderland', 'Sunderland', 'England', ['sunderland', 'safc', 'black cats'], [], ['SUN']],
  ['tottenham', 'Tottenham Hotspur', 'England', ['tottenham hotspur', 'tottenham', 'thfc'], ['spurs'], ['TOT']],
  ['west-ham', 'West Ham United', 'England', ['west ham united', 'west ham', 'whufc', 'the hammers'], ['hammers'], ['WHU']],
  ['wolves', 'Wolverhampton Wanderers', 'England', ['wolverhampton wanderers', 'wolverhampton', 'wwfc'], ['wolves'], ['WOL']],
  // Norway
  ['aalesund', 'Aalesund', 'Norway', ['aalesund', 'aafk', 'aalesunds fk'], ['alesund'], []],
  ['bodo-glimt', 'Bodø/Glimt', 'Norway', ['bodo glimt', 'fk bodo glimt', 'glimt'], ['bodo'], []],
  ['brann', 'Brann', 'Norway', ['sk brann'], ['brann'], []],
  ['bryne', 'Bryne', 'Norway', ['bryne fk'], ['bryne'], []],
  ['fredrikstad', 'Fredrikstad', 'Norway', ['fredrikstad fk', 'fredrikstad', 'fffk'], [], ['FFF']],
  ['hamkam', 'HamKam', 'Norway', ['hamkam', 'ham kam', 'hamarkameratene'], [], []],
  ['haugesund', 'Haugesund', 'Norway', ['fk haugesund', 'haugesund'], [], ['FKH']],
  ['kfum', 'KFUM Oslo', 'Norway', ['kfum oslo', 'kfum'], [], []],
  ['kristiansund', 'Kristiansund', 'Norway', ['kristiansund bk', 'kristiansund', 'kbk'], [], []],
  ['lillestrom', 'Lillestrøm', 'Norway', ['lillestrom', 'lsk'], [], []],
  ['molde', 'Molde', 'Norway', ['molde fk', 'mfk'], ['molde'], []],
  ['odd', 'Odd', 'Norway', ['odds bk', 'odd bk', 'odd ballklubb'], ['odd'], []],
  ['rosenborg', 'Rosenborg', 'Norway', ['rosenborg', 'rbk'], [], []],
  ['sandefjord', 'Sandefjord', 'Norway', ['sandefjord fotball', 'sandefjord'], [], ['SIF']],
  ['sarpsborg', 'Sarpsborg 08', 'Norway', ['sarpsborg 08', 'sarpsborg'], [], ['S08']],
  ['start', 'Start', 'Norway', ['ik start'], ['start'], []],
  ['stromsgodset', 'Strømsgodset', 'Norway', ['stromsgodset', 'godset', 'sif'], [], []],
  ['tromso', 'Tromsø', 'Norway', ['tromso il', 'til'], ['tromso'], []],
  ['valerenga', 'Vålerenga', 'Norway', ['valerenga', 'vif'], [], []],
  ['viking', 'Viking', 'Norway', ['viking fk'], ['viking'], []],
  // Spain
  ['athletic', 'Athletic Club', 'Spain', ['athletic club', 'athletic bilbao'], ['bilbao'], ['ATH']],
  ['atletico', 'Atlético Madrid', 'Spain', ['atletico madrid', 'atletico de madrid', 'atleti'], ['atletico'], ['ATM']],
  ['barcelona', 'Barcelona', 'Spain', ['fc barcelona', 'barcelona', 'barca'], [], ['FCB', 'BAR']],
  ['real-betis', 'Real Betis', 'Spain', ['real betis', 'betis'], [], ['BET']],
  ['real-madrid', 'Real Madrid', 'Spain', ['real madrid', 'real madrid cf'], [], ['RMA'], ['atletico madrid', 'atletico de madrid']],
  ['real-sociedad', 'Real Sociedad', 'Spain', ['real sociedad', 'la real'], ['sociedad'], ['RSO']],
  ['sevilla', 'Sevilla', 'Spain', ['sevilla fc', 'sevilla'], [], ['SEV']],
  ['valencia', 'Valencia', 'Spain', ['valencia cf'], ['valencia'], ['VAL']],
  ['villarreal', 'Villarreal', 'Spain', ['villarreal'], [], ['VIL']],
  // Italy
  ['atalanta', 'Atalanta', 'Italy', ['atalanta'], [], ['ATA']],
  ['inter', 'Inter', 'Italy', ['inter milan', 'internazionale', 'fc internazionale'], ['inter'], ['INT']],
  ['juventus', 'Juventus', 'Italy', ['juventus', 'juve'], [], ['JUV']],
  ['lazio', 'Lazio', 'Italy', ['ss lazio', 'lazio'], [], ['LAZ']],
  ['milan', 'AC Milan', 'Italy', ['ac milan'], ['milan'], ['ACM', 'MIL'], ['inter milan']],
  ['napoli', 'Napoli', 'Italy', ['ssc napoli', 'napoli'], [], ['NAP']],
  ['roma', 'Roma', 'Italy', ['as roma'], ['roma'], ['ROM']],
  // Germany
  ['bayern', 'Bayern Munich', 'Germany', ['bayern munich', 'bayern munchen', 'fc bayern', 'bayern'], [], ['FCB', 'BAY']],
  ['dortmund', 'Borussia Dortmund', 'Germany', ['borussia dortmund', 'dortmund', 'bvb'], [], ['DOR']],
  ['frankfurt', 'Eintracht Frankfurt', 'Germany', ['eintracht frankfurt'], ['frankfurt'], ['SGE']],
  ['gladbach', "Borussia M'gladbach", 'Germany', ['borussia monchengladbach', 'monchengladbach', 'gladbach'], [], ['BMG']],
  ['leipzig', 'RB Leipzig', 'Germany', ['rb leipzig', 'rasenballsport leipzig'], ['leipzig'], ['RBL']],
  ['leverkusen', 'Bayer Leverkusen', 'Germany', ['bayer leverkusen', 'leverkusen', 'bayer 04'], [], ['B04', 'LEV']],
  ['stuttgart', 'VfB Stuttgart', 'Germany', ['vfb stuttgart'], ['stuttgart'], ['VFB']],
  // France
  ['lille', 'Lille', 'France', ['losc lille', 'losc'], ['lille'], []],
  ['lyon', 'Lyon', 'France', ['olympique lyonnais', 'olympique lyon', 'lyon'], [], ['OL']],
  ['marseille', 'Marseille', 'France', ['olympique de marseille', 'olympique marseille', 'marseille'], [], ['OM']],
  ['monaco', 'Monaco', 'France', ['as monaco'], ['monaco'], []],
  ['nice', 'Nice', 'France', ['ogc nice'], ['nice'], []],
  ['psg', 'Paris Saint-Germain', 'France', ['paris saint germain', 'paris sg', 'psg'], [], []],
  // National teams (only about football: "Norway" alone is a documentary as often as a match)
  ['nt-norway', 'Norway', 'National teams', ['norges landslag', 'norway national team'], ['norway', 'norge'], ['NOR']],
  ['nt-england', 'England', 'National teams', ['three lions'], ['england'], ['ENG']],
  ['nt-scotland', 'Scotland', 'National teams', [], ['scotland'], ['SCO']],
  ['nt-wales', 'Wales', 'National teams', [], ['wales'], ['WAL']],
  ['nt-sweden', 'Sweden', 'National teams', [], ['sweden', 'sverige'], ['SWE']],
  ['nt-denmark', 'Denmark', 'National teams', [], ['denmark', 'danmark'], ['DEN']],
  ['nt-germany', 'Germany', 'National teams', [], ['germany', 'tyskland'], ['GER']],
  ['nt-france', 'France', 'National teams', [], ['france', 'frankrike'], ['FRA']],
  ['nt-spain', 'Spain', 'National teams', [], ['spain', 'spania'], ['ESP']],
  ['nt-italy', 'Italy', 'National teams', [], ['italy', 'italia'], ['ITA']],
  ['nt-netherlands', 'Netherlands', 'National teams', [], ['netherlands', 'nederland', 'holland'], ['NED']],
  ['nt-portugal', 'Portugal', 'National teams', [], ['portugal'], ['POR']],
  ['nt-belgium', 'Belgium', 'National teams', [], ['belgium', 'belgia'], ['BEL']],
  ['nt-croatia', 'Croatia', 'National teams', [], ['croatia', 'kroatia'], ['CRO']],
  ['nt-brazil', 'Brazil', 'National teams', [], ['brazil', 'brasil'], ['BRA']],
  ['nt-argentina', 'Argentina', 'National teams', [], ['argentina'], ['ARG']],
  ['nt-usa', 'USA', 'National teams', ['usmnt'], ['united states'], ['USA']],
].map(([id, name, league, names, weak, codes, not = []]) => ({
  id, name, league, names, weak, codes, not,
  // made once: a code only as providers name their match channels, "MUN v LIV", "LIV - MUN", in capitals
  // made once, as searched for: " name ", and for the words that need a pairing " word vs ", " vs word "
  notPad: not.map((n) => ` ${n} `),
  weakPad: weak.map((n) => [` ${n} `, ` ${n} vs `, ` vs ${n} `]),
  namesPad: names.map((n) => ` ${n} `),
  codeRe: codes.length ? new RegExp(`(^|[^A-Za-z0-9])((${codes.join('|')})\\s*(v|vs\\.?|-|–|@)\\s*[A-Z0-9]{2,3}|[A-Z0-9]{2,3}\\s*(v|vs\\.?|-|–|@)\\s*(${codes.join('|')}))(?![A-Za-z0-9])`) : null,
}));

// lower case, no accents, Norwegian letters spelt out, everything but letters and digits a space: "Bodø/Glimt" -> "bodo glimt"
function fbNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// The text is about football: a competition, or the word itself.
const FB_CONTEXT = / (fotball|football|soccer|fc|premier league|epl|eliteserien|obos ligaen|la ?liga|serie a|bundesliga|ligue 1|champions league|ucl|europa league|conference league|fa cup|carabao cup|league cup|efl|nm cup|norgesmesterskapet|landskamp|vm|em|world cup|euro \d{4}|nations league|kvalik|qualifier|qualifiers|derby|matchday|kampdag) /;
// "A v B", "A - B", "A vs. B", "A mot B": one " vs " between the names
const fbVersus = (raw) => String(raw || '').replace(/\s+(v|vs\.?|mot|-|–|—|@)\s+/gi, ' vs ');

// A text made ready to search once (normalising is the slow part; the guide has tens of thousands of programmes):
// raw as it was, t lower case with " vs " between the names of a match.
const fbDoc = (raw) => ({ raw: String(raw || ''), t: ` ${fbNorm(fbVersus(raw))} ` });
const fbIsMatchName = (doc) => doc.t.includes(' vs ');
// On a team's own channel (MUTV…) most matches are old ones; a match there counts when it says it is live (a pre-season
// friendly, a tour) and doesn't say it is a replay.
const FB_LIVE = / (live|direkte|pre season|preseason|friendly|friendlies|treningskamp|privatkamp|tour) /;
const FB_REPLAY = / (classic|classics|replay|re live|relive|rewind|highlights|full match|archive|delayed|repeat|reprise|repris|opptak|19\d\d) /;
const fbLiveMatch = (doc) => fbIsMatchName(doc) && FB_LIVE.test(doc.t) && !FB_REPLAY.test(doc.t);   // "EPL 03: Man Utd vs Liverpool": a match, not a channel's own name

// Is the text (a programme's title and description, or a channel's name) about this team?
function fbMatchDoc(team, doc) {
  let t = doc.t;
  for (const n of team.notPad) if (t.includes(n)) t = t.split(n).join(' · ');   // another team whose name holds this one's
  for (const n of team.namesPad) if (t.includes(n)) return true;
  // a word that also means other things: in a pairing ("Brann vs Molde"), or in a text about football
  for (const [w, a, b] of team.weakPad) if (t.includes(w) && (t.includes(a) || t.includes(b) || FB_CONTEXT.test(t))) return true;
  return !!team.codeRe && team.codes.some((c) => doc.raw.includes(c)) && team.codeRe.test(doc.raw);   // the costly test only where a code is
}
const fbMatches = (team, raw) => fbMatchDoc(team, fbDoc(raw));

// The teams a search could mean: by any of their names (or the start of one), best first.
function fbFindTeams(q) {
  const s = fbNorm(q);
  if (!s) return [];
  const score = (t) => {
    const all = [fbNorm(t.name), ...t.names, ...t.weak, ...t.codes.map((c) => c.toLowerCase())];
    if (all.includes(s)) return 3;
    if (all.some((n) => n.startsWith(s))) return 2;
    if (all.some((n) => n.includes(s))) return 1;
    return 0;
  };
  return FB_TEAMS.map((t) => [t, score(t)]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

// The guide and the channel names, made ready to search (fbIndexAdd, a channel at a time: the page builds it in
// small steps, so a TV stays responsive), and searched as often as wanted.
//   guide(ch) -> [[start, stop, title, description], …] or null
// sport: the programmes that look like a match (a pairing, or a competition named): a team is only looked for in
// those, a small part of a guide (most of it is news, films and shows); a plain text search goes through them all.
const fbNewIndex = () => ({ chans: [], progs: [], sport: [] });
function fbIndexAdd(index, ch, guide, now) {
  index.chans.push({ ch, doc: fbDoc(ch.name) });
  const list = guide(ch);
  if (!list) return;
  for (const p of list) {
    if (p[1] <= now) continue;
    // the title, and the start of the description (where a match names its teams, if the title doesn't)
    const h = { ch, p, doc: fbDoc(`${p[2] || ''} ${String(p[3] || '').slice(0, 140)}`) };
    index.progs.push(h);
    if (fbIsMatchName(h.doc) || FB_CONTEXT.test(h.doc.t)) index.sport.push(h);
  }
}
//   test(doc) -> true for a hit
//   -> { now: [{ ch, p }], later: [{ ch, p }], channels: [ch] }: the programmes that haven't ended, and the channels
//      named after a match (event channels, which often have no guide). On a channel that is the team's own (MUTV,
//      "Manchester United TV": its name is about the team, but no match) only a live match counts (pre-season):
//      the rest there are old matches and club shows.
function fbSearchIndex(test, index, now, all = false) {
  const out = { now: [], later: [], channels: [] };
  const own = new Set();
  for (const c of index.chans) {
    if (!test(c.doc)) continue;
    if (fbIsMatchName(c.doc)) out.channels.push(c.ch); else own.add(c.ch);
  }
  for (const h of all ? index.progs : index.sport) {
    if (h.p[1] <= now || !test(h.doc) || (own.has(h.ch) && !fbLiveMatch(h.doc))) continue;
    (h.p[0] <= now ? out.now : out.later).push({ ch: h.ch, p: h.p });
  }
  out.later.sort((a, b) => a.p[0] - b.p[0]);
  return out;
}
// the same, in one go (the tests)
function fbSearch(test, channels, guide, now) {
  const index = fbNewIndex();
  for (const ch of channels) fbIndexAdd(index, ch, guide, now);
  return fbSearchIndex((doc) => test(doc.raw), index, now, true);
}
// a plain text search: every word in the title, description or channel name
const fbText = (q) => { const words = fbNorm(q).split(' ').filter(Boolean); return (raw) => { const t = typeof raw === 'object' ? raw.t : ` ${fbNorm(raw)} `; return words.every((w) => t.includes(w)); }; };

// The same programme on several channels (an HD and an SD feed, two providers' sport channels): one row, with
// each channel to pick.
function fbGroup(hits) {
  const rows = new Map();
  for (const h of hits) {
    const key = `${h.p[0]}|${fbNorm(h.p[2])}`;
    const r = rows.get(key) || { p: h.p, chs: [] };
    if (!r.chs.includes(h.ch)) r.chs.push(h.ch);
    rows.set(key, r);
  }
  return [...rows.values()];
}

// Replays: a match from last weekend shown again looks like any other in the guide. What tells them apart, from the
// strongest sign: it says so ("Replay", "Highlights", "(R)", "Reprise"…); it says it is live ("Live", "Direkte", "(L)");
// a short slot (a live match with its build-up takes at least 100 minutes; highlights and cut-down replays less); the
// same match on again at another time (an airing marked live is the match, else the first one).
// -> { main: rows, replays: rows } (rows from fbGroup)
const FB_SAYS_REPLAY = / (lfc tv|lfctv|mutv|club tv|chelsea tv|barca tv|real madrid tv|bvb tv|inter tv|milan tv|juventus tv|replay|replays|re run|rerun|repeat|repeated|classic|classics|re live|relive|rewind|highlights|extended highlights|full match|match of the day|goals|delayed|archive|reprise|repris|opptak|sammendrag|hoydepunkter|hoydepunktene|hele kampen) /;
const FB_SAYS_LIVE = / (live|direkte|live coverage|kick off|kickoff) /;
const FB_LIVE_MIN = 100 * 60e3;
function fbSplitReplays(rows) {
  const info = rows.map((r) => {
    const doc = fbDoc(`${r.p[2] || ''} ${String(r.p[3] || '').slice(0, 140)}`);
    const raw = doc.raw;
    const replay = FB_SAYS_REPLAY.test(doc.t) || /\((r|rpt|repeat|repris)\)/i.test(raw);
    const live = !replay && (FB_SAYS_LIVE.test(doc.t) || /\((l|live)\)/i.test(raw));
    // the match: its two teams (whatever the competition says in front), else its title
    const title = fbDoc(r.p[2] || '');
    const teams = FB_TEAMS.filter((t) => fbMatchDoc(t, title)).map((t) => t.id).sort();
    return { r, replay, live, key: teams.length >= 2 ? teams.join('|') : fbNorm(r.p[2] || '') };
  });
  const first = new Map(), liveOn = new Set();
  for (const x of info) {
    if (x.replay) continue;
    if (x.live) liveOn.add(x.key);
    if (!first.has(x.key) || x.r.p[0] < first.get(x.key)) first.set(x.key, x.r.p[0]);
  }
  const out = { main: [], replays: [] };
  for (const x of info) {
    const short = x.r.p[1] - x.r.p[0] < FB_LIVE_MIN;
    const again = liveOn.has(x.key) ? !x.live : x.r.p[0] > first.get(x.key);
    (x.replay || (!x.live && (short || again)) ? out.replays : out.main).push(x.r);
  }
  return out;
}

// For one team: a team plays one match at a time, and at most one in the guide's day and a half. So its match is
// one stretch of time: the airings that overlap (the same match starts at 15:00 on one channel and 15:30 on
// another, with a different build-up), between the same teams: the stretch on the most channels at once (a live
// match is carried widely; a replay mostly by one channel); and any other airing that says it is live. Everything else
// about the team is apart: replays (said so, a club's channel, a short slot, another day or opponent) and shows
// (a studio, a magazine: no match in the title).
// -> { main: rows, replays: rows }
function fbSplitTeam(rows, team) {
  const info = rows.map((r) => {
    const doc = fbDoc(`${r.p[2] || ''} ${String(r.p[3] || '').slice(0, 140)}`);
    const replay = FB_SAYS_REPLAY.test(doc.t) || /\((r|rpt|repeat|repris)\)/i.test(doc.raw);
    const live = !replay && (FB_SAYS_LIVE.test(doc.t) || /\((l|live)\)/i.test(doc.raw));
    const title = fbDoc(r.p[2] || '');
    const teams = FB_TEAMS.filter((t) => fbMatchDoc(t, title)).map((t) => t.id);
    if (!teams.includes(team.id)) teams.push(team.id);
    return { r, replay, live, match: title.t.includes(' vs '), short: r.p[1] - r.p[0] < FB_LIVE_MIN, key: teams.sort().join('|') };
  });
  // the stretches of overlapping airings that could be the match
  const cands = info.filter((x) => !x.replay && x.match && (x.live || !x.short)).sort((a, b) => a.r.p[0] - b.r.p[0]);
  let best = null, bestScore = -1;
  for (let i = 0; i < cands.length;) {
    let end = cands[i].r.p[1], j = i;
    while (j < cands.length && cands[j].r.p[0] < end) { end = Math.max(end, cands[j].r.p[1]); j++; }
    const byKey = new Map();
    for (const x of cands.slice(i, j)) {
      const k = byKey.get(x.key) || { xs: [], score: 0 };
      k.xs.push(x);
      k.score += x.r.chs.length;   // (an airing that says it is live is added below, whatever this picks)
      byKey.set(x.key, k);
    }
    for (const k of byKey.values()) if (k.score > bestScore) { bestScore = k.score; best = k.xs; }
    i = j;
  }
  const main = new Set(best || []);
  // a match that says it is live is a match too (the next one, on another day; a replay rarely says so)
  for (const x of cands) if (x.live && !main.has(x)) main.add(x);
  // one row per match: its airings together, whatever each channel calls it ("Manchester United v Liverpool",
  // "Man Utd v Liverpool"), from the first one's start
  const merged = new Map();
  for (const x of [...main].sort((a, b) => a.r.p[0] - b.r.p[0])) {
    const key = [...merged.keys()].find((k) => k.key === x.key && x.r.p[0] < k.end) ;
    if (key) { const m = merged.get(key); for (const c of x.r.chs) if (!m.chs.includes(c)) m.chs.push(c); key.end = Math.max(key.end, x.r.p[1]); }
    else merged.set({ key: x.key, end: x.r.p[1] }, { p: x.r.p, chs: [...x.r.chs] });
  }
  const out = { main: [...merged.values()], replays: [] };
  for (const x of info) if (!main.has(x)) out.replays.push(x.r);
  return out;
}

if (typeof module !== 'undefined') module.exports = { FB_TEAMS, FB_LEAGUES, fbNorm, fbDoc, fbMatches, fbMatchDoc, fbFindTeams, fbNewIndex, fbIndexAdd, fbSearchIndex, fbSearch, fbText, fbGroup, fbSplitReplays, fbSplitTeam };
