#!/usr/bin/env node
'use strict';
// Phase 0.1 media spike: make short test clips covering the codec/container combinations AG Horizon meets.
// Usage: node spike/media/gen-fixtures.js [ffmpeg path]   (default: $FFMPEG_PATH, then ffmpeg-static, then "ffmpeg")
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'fixtures');
const ffmpeg = process.argv[2] || process.env.FFMPEG_PATH || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();

const SECS = 12;
// A moving picture with a clock and a tone, so a frozen frame or missing sound is easy to see by eye too.
const SRC = ['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${SECS}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SECS}`];
const SRC2 = [...SRC, '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${SECS}`];
const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0'];
const HEVC = ['-c:v', 'libx265', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-x265-params', 'keyint=25:min-keyint=25:scenecut=0:log-level=error'];
const AAC = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'];
const MAP = ['-map', '0:v', '-map', '1:a'];

const FIXTURES = {
  'h264_aac.mp4': [...SRC, ...MAP, ...H264, ...AAC, '-movflags', '+faststart'],
  'h264_aac.mkv': [...SRC, ...MAP, ...H264, ...AAC],
  'h264_aac.ts': [...SRC, ...MAP, ...H264, ...AAC, '-f', 'mpegts'],
  'hevc_aac.mp4': [...SRC, ...MAP, ...HEVC, ...AAC, '-tag:v', 'hvc1', '-movflags', '+faststart'],
  'hevc_aac.ts': [...SRC, ...MAP, ...HEVC, ...AAC, '-f', 'mpegts'],
  'h264_ac3.ts': [...SRC, ...MAP, ...H264, '-c:a', 'ac3', '-b:a', '192k', '-f', 'mpegts'],
  'h264_eac3.ts': [...SRC, ...MAP, ...H264, '-c:a', 'eac3', '-b:a', '192k', '-f', 'mpegts'],
  'h264_ac3.mp4': [...SRC, ...MAP, ...H264, '-c:a', 'ac3', '-b:a', '192k', '-movflags', '+faststart'],
  // two sound tracks with languages: video.audioTracks
  'h264_2aac.mp4': [...SRC2, '-map', '0:v', '-map', '1:a', '-map', '2:a', ...H264, ...AAC,
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=nor', '-movflags', '+faststart'],
};

function run(args, out) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${path.basename(out)}: ${(r.stderr || r.error || '').toString().trim()}`);
}

fs.mkdirSync(OUT, { recursive: true });
console.log(`ffmpeg: ${ffmpeg}`);
for (const [name, args] of Object.entries(FIXTURES)) {
  process.stdout.write(`${name} … `);
  run(args, path.join(OUT, name));
  console.log('ok');
}
// HLS (VOD playlist, 2 s MPEG-TS segments), as an Xtream server sends it
const hls = path.join(OUT, 'hls');
fs.mkdirSync(hls, { recursive: true });
process.stdout.write('hls/index.m3u8 … ');
run(['-i', path.join(OUT, 'h264_aac.ts'), '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
  '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(hls, 'seg%03d.ts')], path.join(hls, 'index.m3u8'));
console.log('ok');
