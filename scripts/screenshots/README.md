# Website screenshots

The pictures on the website (`docs/`) come from the real app, running against a made-up provider. Every channel, movie, series, person and poster in them is invented, so the site shows nobody else's content.

```
node scripts/screenshots/capture.js            # all screenshots + the sharing image
node scripts/screenshots/capture.js live movie # just these
```

Needs Node 18+, ffmpeg on the `PATH`, and Playwright with Chromium (`npm i -D playwright && npx playwright install chromium` if you don't have it). Run `npm run setup` first so the player libraries are in `public/vendor/`.

| File | What it does |
|---|---|
| `catalog.js` | The demo catalogue: channels, movies, series, programme names |
| `art.js` | Draws posters, backdrops, episode stills, channel logos and on-screen graphics as SVG |
| `render-assets.js` | Renders that artwork to images and makes the video clips with ffmpeg (first run takes a few minutes) |
| `demo-server.js` | A tiny Xtream Codes stand-in that serves the catalogue, guide, artwork and clips |
| `capture.js` | Starts the app's server and the demo provider, opens the app in Chromium, and saves each view as WebP in `docs/img/` |

Rendered artwork, clips and full-size PNGs are kept in `scripts/screenshots/.cache/` (not committed). Delete it to start over.

The screenshots are taken at 20:30 in a time zone picked for the moment you run it, so the guide shows prime time.
