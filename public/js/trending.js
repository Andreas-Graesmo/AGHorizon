'use strict';
/* Trending on the dashboard: this week's most popular titles on TMDB that are also in your playlists.
   Pure functions (the page loads them as globals, test/trending.test.js through module.exports). Uses normName from core.js. */

// A provider's title cleaned up for comparing: "NO - Dune: Part Two [4K] (2024)" -> "duneparttwo"
function trendKey(name) {
  return normName(String(name || '')
    .replace(/^\s*[A-Z]{2,4}\s*[-|:]\s+/, '')       // a language or country prefix: "NO - ", "EN| "
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')         // [EX-YU] [PRE] [2025] (2024)
    .replace(/\b(4k|uhd|fhd|hd|sd|hevc|h265|multi[- ]?subs?)\b/gi, ' '));
}

const isCam = (name) => /\[(hd)?(cam|ts|tc|telesync)\]/i.test(name || '');

// One catalogue (a playlist's movies or series) -> lookups by TMDB id and by cleaned title. Built once per list:
// ~20-40 ms for 40,000 titles, then reused until the playlist reloads (a reload makes a new list).
const trendIndexes = new WeakMap();
function trendIndex(items) {
  let ix = trendIndexes.get(items);
  if (!ix) {
    ix = { byId: new Map(), byKey: new Map() };
    for (const it of items) {
      if (isCam(it.name)) continue;   // filmed in a cinema ([CAM], [TS]): not worth showing
      if (it.tmdb && !ix.byId.has(String(it.tmdb))) ix.byId.set(String(it.tmdb), it);
      const k = trendKey(it.name);
      if (!k) continue;
      if (!ix.byKey.has(k)) ix.byKey.set(k, []);
      ix.byKey.get(k).push(it);
    }
    trendIndexes.set(items, ix);
  }
  return ix;
}

// The trending titles (TMDB's order) found in the catalogues (the preferred playlist first) -> [{ it, t }].
// By TMDB id when the provider sends it; otherwise by title and year. A title without a year counts only when it's
// the only one of that name, so a remake or another film with the same name isn't shown by mistake.
function matchTrending(trend, catalogues) {
  const out = [];
  const seen = new Set();
  for (const t of trend || []) {
    let hit = null;
    for (const items of catalogues) {
      const ix = trendIndex(items);
      hit = ix.byId.get(String(t.id)) || null;
      if (!hit) {
        const keys = [...new Set([trendKey(t.title), trendKey(t.original)])].filter(Boolean);
        const cands = keys.flatMap((k) => ix.byKey.get(k) || []);
        hit = cands.find((it) => it.year && String(it.year) === t.year) || (cands.length === 1 && !cands[0].year ? cands[0] : null);
      }
      if (hit) break;
    }
    if (hit && !seen.has(hit.uid)) { seen.add(hit.uid); out.push({ it: hit, t }); }
  }
  return out;
}

// Does the provider's length (minutes) fit TMDB's? Off by more than 15 minutes and a quarter: no (a trailer, part of a
// cinema recording, the wrong film). Unknown on either side: yes.
const lengthsMatch = (ours, tmdb) => !ours || !tmdb || Math.abs(ours - tmdb) <= Math.max(15, tmdb * 0.25);

if (typeof module !== 'undefined') module.exports = { trendKey, matchTrending, lengthsMatch };
