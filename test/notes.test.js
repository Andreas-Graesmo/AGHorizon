'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// notesHtml and setLinks live in ui.js, next to the page: lift them out with core.js's own esc
const read = (f) => fs.readFileSync(path.join(__dirname, '../public/js', f), 'utf8');
const ui = read('ui.js');
const core = read('core.js');
const ctx = { module: { exports: {} } };
vm.runInNewContext([
  /^const ESC = .*$/m.exec(core)[0],
  /^const esc = .*$/m.exec(core)[0],
  /^function notesHtml\(md\) \{[\s\S]*?^\}/m.exec(ui)[0],
  /^function setLinks\(html\) \{[\s\S]*?^\}/m.exec(ui)[0],
  'module.exports = { esc, notesHtml, setLinks };',
].join('\n'), ctx);
const { esc, notesHtml, setLinks } = ctx.module.exports;

test('What’s new shows release notes: headings, lists, bold and italic, and nothing a release could smuggle in', () => {
  assert.strictEqual(
    notesHtml('## Sync\r\n\r\n- **Follows you.** Under *Settings › Sync*.\n- Two\n\nA line.\n## Next\n* star item'),
    '<h3>Sync</h3><ul><li><b>Follows you.</b> Under <i>Settings › Sync</i>.</li><li>Two</li></ul><p>A line.</p><h3>Next</h3><ul><li>star item</li></ul>');
  assert.strictEqual(notesHtml('<img src=x onerror=alert(1)> **b**'), '<p>&lt;img src=x onerror=alert(1)&gt; <b>b</b></p>');
  assert.strictEqual(notesHtml(''), '');
});

test('a message that names a Settings page links to it', () => {
  assert.strictEqual(setLinks(esc('Off in Settings › Playback.')), 'Off in <button class="link set-open" data-set-open="Playback">Settings › Playback</button>.');
  assert.match(setLinks(esc('See Settings › About & updates')), /data-set-open="About &amp; updates">Settings › About &amp; updates<\/button>$/);
  assert.strictEqual(setLinks(esc('Settings › Nowhere')), 'Settings › Nowhere');   // not a page: left as text
});
