#!/usr/bin/env node
'use strict';
// Phase 0.1 media spike: put several results/<label>.json side by side as a Markdown table.
// Usage: node spike/media/report.js results/a.json results/b.json ... > report.md
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: report.js <results.json>...'); process.exit(1); }
const runs = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const MARK = { pass: '✅', part: '🟡', fail: '❌', skip: '➖', info: '' };
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

const out = [];
out.push(`| Test | ${runs.map((r) => r.label).join(' | ')} |`);
out.push(`|---|${runs.map(() => '---').join('|')}|`);
const keys = [];
for (const r of runs) for (const t of r.tests) {
  if (t.status === 'info') continue;
  const k = `${t.group} / ${t.name}`;
  if (!keys.includes(k)) keys.push(k);
}
for (const k of keys) {
  const cols = runs.map((r) => {
    const t = r.tests.find((x) => `${x.group} / ${x.name}` === k);
    return t ? `${MARK[t.status]} ${cell(t.note).slice(0, 140)}` : '—';
  });
  out.push(`| ${cell(k)} | ${cols.join(' | ')} |`);
}

out.push('', '**Capabilities**', '');
out.push(`| | ${runs.map((r) => r.label).join(' | ')} |`);
out.push(`|---|${runs.map(() => '---').join('|')}|`);
const capKeys = [];
for (const r of runs) for (const t of r.tests) if (t.status === 'info' && t.group === 'caps' && !capKeys.includes(t.name)) capKeys.push(t.name);
for (const k of capKeys) {
  out.push(`| ${cell(k)} | ${runs.map((r) => { const t = r.tests.find((x) => x.group === 'caps' && x.name === k); return t ? cell(t.note) : '—'; }).join(' | ')} |`);
}
out.push('', '**User agents**', '');
for (const r of runs) out.push(`- ${r.label}: \`${r.ua}\` (${r.seconds} s, ${path.basename(files[runs.indexOf(r)])})`);
console.log(out.join('\n'));
