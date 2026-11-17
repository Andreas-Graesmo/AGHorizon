'use strict';
// sidecar/entry.js with AGH_DATA_DIR: the downloads engine and folder sync answer the Tauri app over stdin/stdout
// (MIGRATION_PLAN.md 3.4 / 3.5). Runs the real entry in plain Node.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');

function startSidecar(dataDir) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'sidecar', 'entry.js'), '0'], {
    env: { ...process.env, AGH_DATA_DIR: dataDir, AGH_DOCUMENTS_DIR: dataDir, PUBLIC_DIR: path.join(__dirname, '..', 'public') },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  const events = [];
  let ready;
  const readyP = new Promise((r) => { ready = r; });
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    if (l.startsWith('READY ')) ready(Number(l.slice(6)));
    else if (l.startsWith('RPC ')) { const m = JSON.parse(l.slice(4)); const p = pending.get(m.id); pending.delete(m.id); if (p) (m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))); }
    else if (l.startsWith('EVENT ')) events.push(JSON.parse(l.slice(6)));
  });
  let id = 0;
  const call = (cmd, ...args) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    child.stdin.write(JSON.stringify({ id: n, cmd, args }) + '\n');
  });
  return { child, call, events, ready: readyP };
}

test('downloads: add, progress as events, play the file through /api/local, quit saves', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-rpc-'));
  const body = crypto.randomBytes(300 * 1024);
  const provider = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length }); res.end(body); });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  const sc = startSidecar(tmp);
  try {
    const port = await sc.ready;
    const first = await sc.call('downloads.list');
    assert.deepStrictEqual(first.items, []);
    assert.strictEqual(first.folder, path.join(tmp, 'AGHorizon'));
    const added = await sc.call('downloads.add', [{ kind: 'movie', uid: 'p1:movie:1', pid: 'p1', url: `http://127.0.0.1:${provider.address().port}/film.mp4`, ext: 'mp4', title: 'Test Film', year: '2020' }]);
    assert.strictEqual(added, 1);
    let done = null;
    for (let i = 0; i < 100 && !done; i++) {
      done = sc.events.filter((e) => e.name === 'downloads:changed').flatMap((e) => e.payload.items).find((it) => it.state === 'done') || null;
      if (!done) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(done, 'a downloads:changed event says it finished');
    assert.strictEqual(done.size, body.length);
    const local = await fetch(`http://127.0.0.1:${port}/api/local/${done.id}`);
    assert.strictEqual(local.status, 200);
    assert.ok(Buffer.from(await local.arrayBuffer()).equals(body), '/api/local serves the downloaded file byte for byte');
    const t = await sc.call('downloads.revealTarget', done.id);
    assert.ok(t.file && t.file.endsWith(path.join('Movies', 'Test Film (2020)', 'Test Film (2020).mp4')), t.file);
    await assert.rejects(sc.call('downloads.nope'), /unknown command/);
    const exited = new Promise((r) => sc.child.on('exit', r));
    await sc.call('quit');
    assert.strictEqual(await exited, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'downloads.json'), 'utf8'));
    assert.strictEqual(saved.items[0].state, 'done');
  } finally { sc.child.kill(); provider.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('folder sync: put and list carry the bytes exactly; bad names are refused', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agh-rpc-'));
  const syncDir = path.join(tmp, 'Cloud');
  const sc = startSidecar(tmp);
  try {
    await sc.ready;
    assert.strictEqual((await sc.call('sync.info')).folder, '');
    assert.strictEqual(await sc.call('sync.setFolder', syncDir), syncDir);
    assert.strictEqual((await sc.call('sync.info')).folder, syncDir);
    const vault = 'ab'.repeat(32), device = '0123456789abcdef';
    const blob = crypto.randomBytes(2048);
    await sc.call('sync.folderPut', vault, device, blob.toString('base64'));
    const list = await sc.call('sync.folderList', vault);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].device, device);
    assert.ok(Buffer.from(list[0].blob, 'base64').equals(blob), 'the same bytes come back');
    await assert.rejects(sc.call('sync.folderPut', '../../etc', device, ''), /Bad vault/);
    await assert.rejects(sc.call('sync.folderPut', vault, '../evil', ''), /Bad device/);
    await sc.call('sync.folderRemove', vault, device);
    assert.deepStrictEqual(await sc.call('sync.folderList', vault), []);
  } finally { sc.child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
