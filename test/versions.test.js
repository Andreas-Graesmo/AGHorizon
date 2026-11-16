'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compare, isTest } = require('../electron/versions');

test('versions order like semver: test versions come before their release', () => {
  const order = ['2.4.0', '2.4.1', '2.5.0-beta.0', '2.5.0-beta.1', '2.5.0-beta.2', '2.5.0-beta.10', '2.5.0', 'v2.10.0'];
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(compare(order[i], order[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
    assert.ok(compare(order[i + 1], order[i]) > 0, `${order[i + 1]} > ${order[i]}`);
  }
  assert.strictEqual(compare('v2.4.0', '2.4.0'), 0);
  assert.strictEqual(compare('nonsense', '2.4.0'), 0);
});

test('a test version is one with a part after the dash', () => {
  assert.ok(isTest('2.5.0-beta.1'));
  assert.ok(!isTest('2.5.0'));
  assert.ok(!isTest(''));
});
