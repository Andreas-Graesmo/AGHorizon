#!/usr/bin/env node
'use strict';
/*
 * The bridge's update files for a stable Tauri release (MIGRATION_PLAN.md 7.3).
 *
 * Electron apps older than the bridge (before 2.5.0 on Windows, before 2.6.0 on macOS and Linux) can't hand over to
 * the Tauri app themselves: they update with electron-updater, which looks in GitHub's latest release for
 * latest.yml / latest-mac.yml / latest-linux.yml. A Tauri release has none of those, so once a Tauri release is the
 * latest one, those apps would only get an update error. So each stable Tauri release carries the bridge release's
 * three files, with every download pointing back at the bridge release: the old app updates to the bridge, and the
 * bridge hands over to the Tauri app. Apps on the bridge already see nothing newer in them (and hand over through
 * latest.json).
 *
 * electron-updater asks for each file at <releases>/download/<the release it read the file from>/<name>, so a name is
 * made relative to it: "../v2.6.0/AG-Horizon-2.6.0-arm64-mac.zip" (the browser's URL rules take the "..").
 *
 * Usage: node scripts/bridge-feed.js <bridge tag, e.g. v2.6.0> <yml files…>   (rewrites them in place)
 */
const fs = require('fs');

function rewrite(text, bridgeTag) {
  if (!/^v\d+\.\d+\.\d+$/.test(bridgeTag)) throw new Error(`not a stable tag: ${bridgeTag}`);
  // the files' "url:" entries and the old single "path:": a plain file name each (with its quotes, if any)
  const out = text.replace(/^(\s*-\s*url:\s*|path:\s*)(['"]?)([^'"\s/][^'"\s]*)\2\s*$/gm, (_m, key, q, name) => `${key}${q}../${bridgeTag}/${name}${q}`);
  if (!/url:\s*['"]?\.\.\//.test(out)) throw new Error('no file entries found');
  return `# the update files of ${bridgeTag}, the bridge release: older Electron apps update to it, and it hands over\n# to this app (scripts/bridge-feed.js, MIGRATION_PLAN.md 7.3)\n${out}`;
}

module.exports = { rewrite };

if (require.main === module) {
  const [tag, ...files] = process.argv.slice(2);
  if (!tag || !files.length) { console.error('usage: node scripts/bridge-feed.js <bridge tag> <yml files…>'); process.exit(2); }
  for (const f of files) {
    fs.writeFileSync(f, rewrite(fs.readFileSync(f, 'utf8'), tag));
    console.log(`${f}: points at ${tag}`);
  }
}
