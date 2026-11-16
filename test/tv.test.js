'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// public/js/tv.js is a page script: run it in a made-up page (no TV shell) and pick out the function that decides
// where the focus goes when an arrow is pressed on the remote.
const page = { innerWidth: 1120, innerHeight: 630, document: { elementFromPoint: () => null } };
page.window = undefined;   // not inside the TV app: the script must leave everything alone
vm.createContext(page);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'tv.js'), 'utf8'), page);
const { tvNext } = page;

// Something the focus can be on: where it is, and which part of the app it belongs to.
function item(name, x, y, w, h, { nav = false, top = false, column = null, onScreen = true } = {}) {
  const el = {
    name, onScreen,
    getBoundingClientRect: () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }),
    contains: (other) => other === el,
    closest: (sel) => (sel === '#nav' ? (nav ? el : null) : sel === '#topbar' ? (top ? el : null) : column),
  };
  return el;
}
page.document.elementFromPoint = (x, y) => all.find((el) => { const r = el.getBoundingClientRect(); return el.onScreen && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }) || null;
let all = [];
const go = (from, dir) => { const to = tvNext(from, dir, all); return to ? to.name : null; };

test('tv.js does nothing outside the TV app', () => {
  assert.strictEqual(vm.runInContext('TV', page), false);
  assert.strictEqual(page.tunerDesktop, undefined);
});

test('the remote: arrows move through a grid of tiles', () => {
  const grid = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) grid.push(item(`t${r}${c}`, 100 + c * 160, 100 + r * 220, 150, 210));
  all = grid;
  const at = (n) => grid.find((g) => g.name === n);
  assert.strictEqual(go(at('t00'), 'right'), 't01');
  assert.strictEqual(go(at('t01'), 'down'), 't11');
  assert.strictEqual(go(at('t11'), 'left'), 't10');
  assert.strictEqual(go(at('t11'), 'up'), 't01');
  assert.strictEqual(go(at('t03'), 'right'), null, 'the end of a row stays in the row');
  assert.strictEqual(go(at('t23'), 'down'), null);
});

test('the remote: a short last row is reached from the column above it', () => {
  all = [item('a', 100, 100, 150, 200), item('b', 260, 100, 150, 200), item('c', 420, 100, 150, 200), item('d', 100, 310, 150, 200)];
  assert.strictEqual(go(all[2], 'down'), 'd');
});

test('the remote: the end of a row of tiles does not jump to a tile scrolled out of another row', () => {
  const last = item('last', 900, 100, 200, 100);
  const hidden = item('hidden', 1300, 260, 200, 100, { onScreen: false });   // further right in the row below, off screen
  all = [last, hidden, item('below', 900, 260, 200, 100)];
  assert.strictEqual(go(last, 'right'), null);
  assert.strictEqual(go(last, 'down'), 'below');
});

test('the remote: the rail of icons is entered sideways, not by running off the end of a page', () => {
  const rail = [item('home', 6, 50, 34, 34, { nav: true }), item('settings', 6, 590, 34, 34, { nav: true })];
  const play = item('play', 400, 220, 110, 44);
  const bar = item('search', 270, 5, 360, 32, { top: true });
  all = [...rail, play, bar];
  assert.strictEqual(go(play, 'down'), null, 'nothing below: stays (the page scrolls instead)');
  assert.strictEqual(go(play, 'left'), 'home', 'sideways the rail is reached, also when no icon is at that height');
  assert.strictEqual(go(play, 'up'), 'search', 'the top bar, when the page has nothing more above');
  assert.strictEqual(go(rail[0], 'down'), 'settings');
  assert.strictEqual(go(bar, 'down'), 'play');
});

test('the remote: up and down stay in their column', () => {
  const cats = { id: 'cats' }, list = { id: 'list' };
  const lastChannel = item('channel', 270, 200, 270, 56, { column: list });
  all = [item('cat1', 60, 100, 180, 30, { column: cats }), item('cat9', 60, 400, 180, 30, { column: cats }), lastChannel];
  assert.strictEqual(go(lastChannel, 'down'), null);
  assert.strictEqual(go(lastChannel, 'left'), 'cat1');
});

test('the remote: something in the page wins over the top bar when going up', () => {
  const hero = item('details', 90, 330, 110, 40);
  const banner = item('download', 800, 60, 160, 36);
  const bar = item('playlist', 55, 5, 170, 32, { top: true });
  all = [hero, banner, bar];
  assert.strictEqual(go(hero, 'up'), 'download');
  assert.strictEqual(go(banner, 'up'), 'playlist');
});
