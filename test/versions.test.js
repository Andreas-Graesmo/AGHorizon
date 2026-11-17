'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { compare, isTest } = require('../electron/versions');

// the Android TV pages carry their own copy (public/js/tv.js): it must order versions the same way
const page = { window: undefined };
vm.createContext(page);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'tv.js'), 'utf8'), page);
const tvCompare = page.tvVersionCompare;

test('versions order like semver: test versions come before their release', () => {
  for (const cmp of [compare, tvCompare]) {
    const order = ['2.4.0', '2.4.1', '2.5.0-beta.0', '2.5.0-beta.1', '2.5.0-beta.2', '2.5.0-beta.10', '2.5.0', 'v2.10.0'];
    for (let i = 0; i < order.length - 1; i++) {
      assert.ok(cmp(order[i], order[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
      assert.ok(cmp(order[i + 1], order[i]) > 0, `${order[i + 1]} > ${order[i]}`);
    }
    assert.strictEqual(cmp('v2.4.0', '2.4.0'), 0);
    assert.strictEqual(cmp('nonsense', '2.4.0'), 0);
  }
});

test('a test version is one with a part after the dash', () => {
  assert.ok(isTest('2.5.0-beta.1'));
  assert.ok(!isTest('2.5.0'));
  assert.ok(!isTest(''));
});
