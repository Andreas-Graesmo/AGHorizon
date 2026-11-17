'use strict';
/* AG Horizon for Android TV: starts the app's own server (the same server.js as the desktop app) inside the app.
   Started by NodeServer.kt with: the port, and a folder for temporary files. */
const port = Number(process.argv[2]) || 47831;
if (process.argv[3]) process.env.TMPDIR = process.argv[3];   // before subtitles.js asks for os.tmpdir()
process.env.AG_HORIZON_TV = '1';

// Node runs inside the app's process here: an error that would end a desktop server must not take the app with it.
process.on('uncaughtException', (e) => console.error('uncaught:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('unhandled:', (e && e.stack) || e));

require('./server').start(port).then(
  (p) => console.log('AG Horizon server listening on ' + p),
  (e) => console.error('AG Horizon server could not start: ' + ((e && e.message) || e)),   // no process.exit: that would end the whole app; it shows the error instead
);
