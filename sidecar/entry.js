'use strict';
/*
 * AG Horizon server as a separate program (MIGRATION_PLAN.md 0.3 / 2.4): the Tauri app starts it as a sidecar.
 *   aghorizon-server [port]        port 0 = any free port
 * Env: PUBLIC_DIR (the app's public/ folder), FFMPEG_PATH, TMPDIR, TMDB_API_KEY, OPENSUBTITLES_API_KEY.
 * Prints one line the app waits for: "READY <port>" or "ERROR <code> <message>" (then exits with 1).
 * Exits when its stdin closes, so it cannot outlive the app that started it (even if the app is killed).
 */
const port = process.argv[2] != null ? Number(process.argv[2]) : 47831;

process.on('uncaughtException', (e) => console.error('uncaught:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('unhandled:', (e && e.stack) || e));

const { start } = require('../server');

start(port).then(
  (p) => console.log(`READY ${p}`),
  (e) => { console.log(`ERROR ${(e && e.code) || 'START'} ${(e && e.message) || e}`); process.exit(1); },
);

if (!process.env.AGH_NO_STDIN_WATCH) {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.resume();
}
