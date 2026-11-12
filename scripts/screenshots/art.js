'use strict';
/* Procedural artwork for the demo catalogue: landscapes in the spirit of the AG Horizon logo, drawn as SVG and
   rendered to images by render-assets.js. Same seed, same picture. */

const PAL = {
  dusk:    { sky: ['#1d1b4a', '#6b3a78', '#f08a6b'], sun: '#ffd9a6', layers: ['#9a5a86', '#6c3f6f', '#45284f', '#241631'] },
  night:   { sky: ['#03061a', '#0b1840', '#1d3a6e'], sun: '#eef3ff', layers: ['#1d3358', '#152645', '#0d1a33', '#060d1f'], night: true },
  violet:  { sky: ['#07041a', '#1c1150', '#5b3fb8'], sun: '#cbb8ff', layers: ['#3c2b85', '#2a1f63', '#1a1342', '#0b0822'], night: true },
  ember:   { sky: ['#1a0a12', '#7a2a2a', '#f5864a'], sun: '#ffe1a8', layers: ['#a8452f', '#7a2f25', '#4d1d19', '#25100e'] },
  steel:   { sky: ['#0f1a24', '#33505f', '#9fb6bf'], sun: '#e9f2f4', layers: ['#5d7783', '#415966', '#2b3e49', '#16232b'] },
  neon:    { sky: ['#0a0222', '#3a0a5e', '#ff3d8b'], sun: '#ffb3d4', layers: ['#5b1f7a', '#3d1458', '#240c38', '#10051c'], night: true },
  desert:  { sky: ['#5a2a1c', '#e0794a', '#fcd9a5'], sun: '#fff3dc', layers: ['#e39a62', '#c4733f', '#97502b', '#5c2e19'] },
  moss:    { sky: ['#06120f', '#163b31', '#6f9c86'], sun: '#e3f1e2', layers: ['#2f5a4b', '#21443a', '#142e27', '#081a16'], night: true },
  twin:    { sky: ['#2a0f1f', '#a0414a', '#ffc27a'], sun: '#fff0cf', layers: ['#c26a4c', '#93473a', '#622c2a', '#331718'], twin: true },
  plum:    { sky: ['#12061e', '#4a1c4f', '#d36a7e'], sun: '#ffd0a8', layers: ['#7a3462', '#57244b', '#391735', '#1d0b1d'], night: true },
  sunset:  { sky: ['#2b0f3a', '#c2416c', '#ffb36b'], sun: '#fff1c9', layers: ['#a33c6b', '#7a2b56', '#521c3c', '#2b0e21'] },
  gold:    { sky: ['#20160a', '#7a5520', '#f2c46d'], sun: '#fff4d6', layers: ['#a8793a', '#7d5829', '#523a1b', '#2a1d0d'] },
  crimson: { sky: ['#12030a', '#4a0d1c', '#c2334a'], sun: '#ffd3c4', layers: ['#5e1626', '#45101d', '#2d0a13', '#160409'], night: true },
  spring:  { sky: ['#2f6f8f', '#8cc7d6', '#f3e9c7'], sun: '#fffbe6', layers: ['#7fb28a', '#5a9468', '#3d744d', '#24532f'] },
  arctic:  { sky: ['#0a2a40', '#3f86a8', '#c9e9f2'], sun: '#ffffff', layers: ['#8db8cc', '#6597b0', '#3d6e88', '#1c445a'] },
  pearl:   { sky: ['#3b4a5c', '#9aa7b6', '#efe4d6'], sun: '#fffaf0', layers: ['#8b96a3', '#6c7785', '#4c5664', '#2d3540'] },
  teal:    { sky: ['#031a1f', '#0f4e57', '#5fb7b0'], sun: '#e8fff9', layers: ['#2c7a78', '#1e5c5c', '#133f41', '#082426'] },
  snow:    { sky: ['#4f7fb3', '#a9cbe8', '#f2f7fb'], sun: '#ffffff', layers: ['#dfeaf4', '#b9cfe2', '#8aa8c4', '#4f6f90'] },
};

function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A ridge line across the picture by midpoint displacement; returns a closed path down to the bottom.
function ridge(r, w, h, y, rough, steps = 7, shape = null) {
  let pts = [[0, y + (r() - .5) * rough], [w, y + (r() - .5) * rough]];
  let amp = rough;
  for (let s = 0; s < steps; s++) {
    const next = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      next.push(pts[i], [(x1 + x2) / 2, (y1 + y2) / 2 + (r() - .5) * amp]);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
    amp *= .55;
  }
  if (shape) pts = pts.map(([x, yy]) => [x, yy + shape(x / w)]);
  return `M0 ${h} ` + pts.map(([x, yy]) => `L${x.toFixed(1)} ${yy.toFixed(1)}`).join(' ') + ` L${w} ${h} Z`;
}
// A smooth hill line from a few sine waves.
function wave(r, w, h, y, amp, n = 3) {
  const ph = [r() * 6, r() * 6, r() * 6], fr = [1 + r() * 1.5, 2.5 + r() * 2, 5 + r() * 3];
  let d = `M0 ${h}`;
  for (let x = 0; x <= w; x += w / 60) {
    const t = x / w;
    let yy = y;
    for (let k = 0; k < n; k++) yy += Math.sin(t * Math.PI * fr[k] + ph[k]) * amp / (k + 1);
    d += ` L${x.toFixed(1)} ${yy.toFixed(1)}`;
  }
  return d + ` L${w} ${h} Z`;
}

function stars(r, w, h, n, maxY) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const big = r() < .08;
    s += `<circle cx="${(r() * w).toFixed(1)}" cy="${(r() * maxY).toFixed(1)}" r="${(big ? 1.4 : .5 + r() * .7) * (w / 800)}" fill="#fff" opacity="${(.35 + r() * .65).toFixed(2)}"/>`;
  }
  return s;
}

function sunDisc(id, cx, cy, rad, color, glow = 3.2) {
  return `<radialGradient id="${id}g"><stop offset="0" stop-color="${color}" stop-opacity=".55"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>
    <circle cx="${cx}" cy="${cy}" r="${rad * glow}" fill="url(#${id}g)"/><circle cx="${cx}" cy="${cy}" r="${rad}" fill="${color}"/>`;
}

const lerpColor = (a, b, t) => {
  const pa = a.match(/\w\w/g).map((x) => parseInt(x, 16)), pb = b.match(/\w\w/g).map((x) => parseInt(x, 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
};

// the scene alone (no text), w × h
function scene(kind, palName, seed, w, h) {
  const P = PAL[palName] || PAL.dusk;
  const r = rng(seed);
  const u = w / 800;   // drawing unit: sizes are designed for an 800-wide picture
  const id = `s${seed}${kind}`;
  const defs = [], body = [];
  defs.push(`<linearGradient id="${id}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.sky[0]}"/><stop offset=".55" stop-color="${P.sky[1]}"/><stop offset="1" stop-color="${P.sky[2]}"/></linearGradient>`);
  body.push(`<rect width="${w}" height="${h}" fill="url(#${id}sky)"/>`);
  const horizon = h * (.55 + r() * .12);
  const sunX = w * (.25 + r() * .5);

  const ridges = (count, top, spread, rough) => {
    for (let i = 0; i < count; i++) {
      const c = P.layers[Math.min(P.layers.length - 1, i + (4 - count))];
      const y = top + i * spread;
      defs.push(`<linearGradient id="${id}l${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lerpColor(c, P.sky[2], .18)}"/><stop offset="1" stop-color="${c}"/></linearGradient>`);
      body.push(`<path d="${ridge(r, w, h, y, rough * (1 - i * .12))}" fill="url(#${id}l${i})"/>`);
      if (i < count - 1) body.push(`<rect y="${y - 10 * u}" width="${w}" height="${spread * 1.6}" fill="${P.sky[2]}" opacity=".07"/>`);
    }
  };

  if (P.night) body.push(stars(r, w, h, Math.round(140 * (w * h) / (800 * 1200)) + 60, horizon));

  switch (kind) {
    case 'range': case 'fjord': case 'aurora': {
      if (kind === 'aurora') {
        defs.push(`<filter id="${id}blur"><feGaussianBlur stdDeviation="${14 * u}"/></filter>`);
        const cols = ['#4dffb0', '#3fd2ff', '#b67bff'];
        for (let i = 0; i < 3; i++) {
          defs.push(`<linearGradient id="${id}au${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${cols[i]}" stop-opacity="0"/><stop offset=".7" stop-color="${cols[i]}" stop-opacity=".55"/><stop offset="1" stop-color="${cols[i]}" stop-opacity="0"/></linearGradient>`);
          const y0 = h * (.12 + i * .08);
          let d = `M${-w * .1} ${y0}`;
          for (let x = 0; x <= w * 1.1; x += w / 8) d += ` Q${x + w / 16} ${y0 + (r() - .5) * h * .18} ${x + w / 8} ${y0 + (r() - .5) * h * .1}`;
          body.push(`<path d="${d} L${w * 1.1} ${y0 + h * .3} L${-w * .1} ${y0 + h * .3} Z" fill="url(#${id}au${i})" filter="url(#${id}blur)" opacity=".9"/>`);
        }
      } else body.push(sunDisc(id + 'sun', sunX, horizon - h * (.06 + r() * .12), 46 * u, P.sun));
      if (kind === 'range') ridges(4, horizon - h * .1, h * .09, h * .22);
      else {
        // mountains either side of a still fjord, mirrored in the water
        const water = horizon + h * .06;
        const gap = .4 + r() * .2;   // where the fjord opens, as a fraction of the width
        const valley = (depth, width) => (t) => depth * Math.exp(-((t - gap) ** 2) / (2 * width * width));
        const back = ridge(r, w, water, water - h * .3, h * .2, 7, valley(h * .2, .1));
        const front = ridge(r, w, water, water - h * .2, h * .16, 7, valley(h * .26, .16));
        const c1 = P.layers[1], c2 = P.layers[2];
        body.push(`<path d="${back}" fill="${c1}"/><path d="${front}" fill="${c2}"/>`);
        defs.push(`<linearGradient id="${id}wat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.sky[2]}" stop-opacity=".55"/><stop offset="1" stop-color="${P.layers[3]}"/></linearGradient>`);
        body.push(`<g opacity=".38" transform="translate(0 ${water * 2}) scale(1 -1)"><path d="${back}" fill="${c1}"/><path d="${front}" fill="${c2}"/></g>`);
        body.push(`<rect y="${water}" width="${w}" height="${h - water}" fill="url(#${id}wat)" opacity=".85"/>`);
        for (let i = 0; i < 26; i++) body.push(`<rect x="${(r() * w).toFixed(0)}" y="${(water + 4 * u + r() * (h - water)).toFixed(0)}" width="${(20 + r() * 80) * u}" height="${1.2 * u}" fill="#fff" opacity="${(.05 + r() * .12).toFixed(2)}"/>`);
        body.push(`<path d="${ridge(r, w, h, h - h * .05, h * .04)}" fill="${P.layers[3]}"/>`);
      }
      break;
    }
    case 'sea': case 'lighthouse': {
      const sy = horizon - h * (.02 + r() * .1);
      body.push(sunDisc(id + 'sun', sunX, sy, 52 * u, P.sun));
      defs.push(`<linearGradient id="${id}sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.layers[1]}"/><stop offset="1" stop-color="${P.layers[3]}"/></linearGradient>`);
      body.push(`<rect y="${horizon}" width="${w}" height="${h - horizon}" fill="url(#${id}sea)"/>`);
      for (let i = 0; i < 46; i++) {
        const t = r(), y = horizon + 3 * u + t * t * (h - horizon), spread = (30 + t * 260) * u;
        body.push(`<rect x="${(sunX - spread / 2 + (r() - .5) * spread * .8).toFixed(0)}" y="${y.toFixed(0)}" width="${(spread * (.2 + r() * .5)).toFixed(0)}" height="${(1.5 + t * 3) * u}" rx="${u}" fill="${P.sun}" opacity="${(.5 - t * .35).toFixed(2)}"/>`);
      }
      if (kind === 'lighthouse') {
        const lx = w * (sunX > w / 2 ? .22 : .74), base = horizon + h * .08, lh = h * .3;
        body.push(`<path d="${wave(r, w, h, base + h * .02, h * .02)}" fill="${P.layers[3]}"/>`);
        const bw = 26 * u;
        defs.push(`<linearGradient id="${id}beam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${P.sun}" stop-opacity=".55"/><stop offset="1" stop-color="${P.sun}" stop-opacity="0"/></linearGradient>`);
        const dir = sunX > w / 2 ? 1 : -1;
        if (dir < 0) defs.push(`<linearGradient id="${id}beamL" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="${P.sun}" stop-opacity=".55"/><stop offset="1" stop-color="${P.sun}" stop-opacity="0"/></linearGradient>`);
        body.push(`<path d="M${lx} ${base - lh - 13 * u} L${lx + dir * w * .8} ${base - lh - h * .12} L${lx + dir * w * .8} ${base - lh + h * .06} Z" fill="url(#${id}${dir < 0 ? 'beamL' : 'beam'})"/>`);
        body.push(`<path d="M${lx - bw} ${base} L${lx - bw * .6} ${base - lh} L${lx + bw * .6} ${base - lh} L${lx + bw} ${base} Z" fill="${P.layers[3]}"/>`);
        body.push(`<rect x="${lx - bw * .8}" y="${base - lh - 26 * u}" width="${bw * 1.6}" height="${26 * u}" fill="${P.sun}"/><path d="M${lx - bw} ${base - lh - 26 * u} L${lx} ${base - lh - 48 * u} L${lx + bw} ${base - lh - 26 * u} Z" fill="${P.layers[3]}"/>`);
        body.push(`<rect x="${lx - bw * .66}" y="${base - lh * .62}" width="${bw * 1.32}" height="${10 * u}" fill="${P.layers[1]}" opacity=".6"/>`);
      } else {
        body.push(`<path d="${wave(r, w, h, h - h * .07, h * .015)}" fill="${P.layers[3]}" opacity=".9"/>`);
      }
      break;
    }
    case 'orbit': {
      const px = w * (.35 + r() * .3), py = h * (.42 + r() * .12), pr = Math.min(w, h) * (.24 + r() * .08);
      defs.push(`<radialGradient id="${id}pl" cx=".32" cy=".3" r=".9"><stop offset="0" stop-color="${P.sun}"/><stop offset=".45" stop-color="${P.layers[0]}"/><stop offset="1" stop-color="${P.layers[3]}"/></radialGradient>`);
      defs.push(`<radialGradient id="${id}atm"><stop offset=".86" stop-color="${P.sky[2]}" stop-opacity="0"/><stop offset=".93" stop-color="${P.sky[2]}" stop-opacity=".55"/><stop offset="1" stop-color="${P.sky[2]}" stop-opacity="0"/></radialGradient>`);
      const tilt = -18 + r() * 12;
      const ring = (half) => `<path d="M${px - pr * 1.9} ${py} A${pr * 1.9} ${pr * .42} 0 0 ${half} ${px + pr * 1.9} ${py}" fill="none" stroke="${P.sun}" stroke-opacity=".55" stroke-width="${7 * u}" transform="rotate(${tilt} ${px} ${py})"/>
        <path d="M${px - pr * 1.6} ${py} A${pr * 1.6} ${pr * .34} 0 0 ${half} ${px + pr * 1.6} ${py}" fill="none" stroke="${P.sky[2]}" stroke-opacity=".5" stroke-width="${3 * u}" transform="rotate(${tilt} ${px} ${py})"/>`;
      body.push(ring(0));
      body.push(`<circle cx="${px}" cy="${py}" r="${pr * 1.12}" fill="url(#${id}atm)"/><circle cx="${px}" cy="${py}" r="${pr}" fill="url(#${id}pl)"/>`);
      for (let i = 0; i < 5; i++) body.push(`<ellipse cx="${px}" cy="${py - pr * .5 + i * pr * .25}" rx="${pr * (.95 - Math.abs(i - 2) * .12)}" ry="${pr * .03}" fill="${P.sun}" opacity=".08" transform="rotate(${tilt / 2} ${px} ${py})"/>`);
      body.push(ring(1));
      const mx = px + pr * (r() < .5 ? -1.9 : 1.7), my = py - pr * (1 + r() * .4);
      body.push(`<circle cx="${mx}" cy="${my}" r="${pr * .12}" fill="${P.layers[0]}"/><circle cx="${mx + pr * .03}" cy="${my - pr * .03}" r="${pr * .1}" fill="${P.sun}" opacity=".35"/>`);
      break;
    }
    case 'dunes': case 'hills': case 'road': {
      const sy = horizon - h * (.1 + r() * .12);
      body.push(sunDisc(id + 'sun', sunX, sy, 70 * u, P.sun, 2.6));
      if (P.twin) body.push(sunDisc(id + 'sun2', sunX + 120 * u * (sunX > w / 2 ? -1 : 1), sy + 50 * u, 26 * u, P.sun, 3));
      for (let i = 0; i < 4; i++) {
        const c = P.layers[i];
        defs.push(`<linearGradient id="${id}d${i}" x1="0" y1="0" x2="1" y2=".4"><stop offset="0" stop-color="${lerpColor(c, P.sun, .25)}"/><stop offset=".6" stop-color="${c}"/><stop offset="1" stop-color="${lerpColor(c, '#000000', .25)}"/></linearGradient>`);
        body.push(`<path d="${wave(r, w, h, horizon - h * .04 + i * h * .085, h * (.05 - i * .006))}" fill="url(#${id}d${i})"/>`);
      }
      if (kind === 'road') {
        // a road winding from the bottom of the picture up to the horizon, with a few riders on it
        const pts = [];
        for (let k = 0; k <= 24; k++) { const t = k / 24; pts.push([w * (.5 + Math.sin(t * 5 + 1) * .22 * (1 - t * .7)), h * 1.02 - t * (h * 1.02 - horizon - h * .02)]); }
        const half = (t) => w * (.16 * (1 - t) + .006);
        const left = pts.map(([x, y], k) => `${(x - half(k / 24)).toFixed(1)} ${y.toFixed(1)}`), right = pts.map(([x, y], k) => `${(x + half(k / 24)).toFixed(1)} ${y.toFixed(1)}`).reverse();
        body.push(`<path d="M${left.join(' L')} L${right.join(' L')} Z" fill="#3a3d45"/>`);
        body.push(`<path d="M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')}" fill="none" stroke="#f4f1e8" stroke-width="${3 * u}" stroke-dasharray="${18 * u} ${16 * u}" opacity=".8"/>`);
        [[.2, '#ffd23f'], [.24, '#e63946'], [.27, '#1d9bf0'], [.31, '#2a9d8f'], [.36, '#f4a261'], [.5, '#ffd23f']].forEach(([t, c]) => {
          const k = Math.round(t * 24), [x, y] = pts[k], s = (1 - t) * 9 * u + 2 * u;
          body.push(`<ellipse cx="${x + (r() - .5) * half(t) * .8}" cy="${y}" rx="${s * .55}" ry="${s * 1.1}" fill="${c}"/><circle cx="${x}" cy="${y - s * 1.2}" r="${s * .4}" fill="#222"/>`);
        });
      }
      if (kind === 'hills') for (let i = 0; i < 30; i++) {
        const x = r() * w, y = horizon + h * (.12 + r() * .25), s = (3 + r() * 5) * u;
        body.push(`<circle cx="${x}" cy="${y}" r="${s}" fill="${['#ffd166', '#f78fb3', '#ffffff'][i % 3]}" opacity=".85"/>`);
      }
      break;
    }
    case 'forest': {
      body.push(sunDisc(id + 'moon', sunX, h * (.18 + r() * .12), 40 * u, P.sun, 3.5));
      for (let layer = 0; layer < 4; layer++) {
        const c = P.layers[layer], base = horizon - h * .05 + layer * h * .1, size = (40 + layer * 26) * u;
        let d = '';
        for (let x = -size; x < w + size; x += size * (.45 + r() * .3)) {
          const th = size * (2.2 + r() * 1.6), tw = size * (.55 + r() * .2), y = base + (r() - .5) * h * .03;
          d += `M${x} ${y - th} L${x - tw} ${y} L${x + tw} ${y} Z `;
        }
        body.push(`<path d="${d}" fill="${c}"/><rect y="${base - 1}" width="${w}" height="${h - base}" fill="${c}"/>`);
        if (layer < 3) body.push(`<rect y="${base - h * .05}" width="${w}" height="${h * .1}" fill="${P.sky[2]}" opacity=".08"/>`);
      }
      for (let i = 0; i < 18; i++) body.push(`<circle cx="${r() * w}" cy="${horizon + r() * h * .3}" r="${(1.2 + r() * 1.8) * u}" fill="#fff6c8" opacity="${(.4 + r() * .5).toFixed(2)}"/>`);
      break;
    }
    case 'city': {
      body.push(sunDisc(id + 'sun', sunX, horizon - h * .12, 80 * u, P.sun, 2.4));
      for (let i = 0; i < 9; i++) body.push(`<rect x="0" y="${horizon - h * .12 + i * 12 * u}" width="${w}" height="${(3 + i * .6) * u}" fill="${P.sky[1]}" opacity=".9"/>`);
      for (let layer = 0; layer < 3; layer++) {
        const c = P.layers[layer + 1], base = horizon + layer * h * .06;
        let x = -10 * u, d = '', win = '';
        while (x < w) {
          const bw = (24 + r() * 46) * u * (1 + layer * .25), bh = h * (.08 + r() * (.26 - layer * .05));
          d += `M${x} ${base} L${x} ${base - bh} L${x + bw} ${base - bh} L${x + bw} ${base} Z `;
          if (layer === 2) for (let wy = base - bh + 8 * u; wy < base - 6 * u; wy += 11 * u) for (let wx = x + 5 * u; wx < x + bw - 6 * u; wx += 9 * u) if (r() < .32) win += `<rect x="${wx}" y="${wy}" width="${4 * u}" height="${5 * u}" fill="${r() < .5 ? '#ffd27a' : P.sun}" opacity="${(.5 + r() * .5).toFixed(2)}"/>`;
          x += bw + r() * 4 * u;
        }
        body.push(`<path d="${d}" fill="${c}"/><rect y="${base - 1}" width="${w}" height="${h - base}" fill="${c}"/>${win}`);
      }
      break;
    }
    case 'lanterns': {
      ridges(3, horizon, h * .08, h * .12);
      for (let i = 0; i < 34; i++) {
        const x = r() * w, y = r() * horizon * 1.05, s = (5 + r() * 12) * u * (y / horizon + .4);
        defs.push(`<radialGradient id="${id}lg${i}"><stop offset="0" stop-color="#ffd38a" stop-opacity=".9"/><stop offset="1" stop-color="#ff9a4a" stop-opacity="0"/></radialGradient>`);
        body.push(`<circle cx="${x}" cy="${y}" r="${s * 3}" fill="url(#${id}lg${i})" opacity=".55"/><rect x="${x - s / 2}" y="${y - s * .7}" width="${s}" height="${s * 1.4}" rx="${s * .35}" fill="#ffcf85"/>`);
      }
      break;
    }
    case 'macro': {
      defs.push(`<filter id="${id}bk"><feGaussianBlur stdDeviation="${10 * u}"/></filter>`);
      for (let i = 0; i < 22; i++) body.push(`<circle cx="${r() * w}" cy="${r() * h * .7}" r="${(14 + r() * 40) * u}" fill="${P.sun}" opacity="${(.08 + r() * .2).toFixed(2)}" filter="url(#${id}bk)"/>`);
      for (let i = 0; i < 40; i++) {
        const x = r() * w, top = h * (.35 + r() * .35), bend = (r() - .5) * 60 * u, c = P.layers[1 + (i % 3)];
        body.push(`<path d="M${x} ${h} Q${x + bend} ${(h + top) / 2} ${x + bend * 1.6} ${top}" stroke="${c}" stroke-width="${(2 + r() * 3) * u}" fill="none"/>`);
        if (r() < .28) body.push(`<circle cx="${x + bend * 1.6}" cy="${top}" r="${(5 + r() * 7) * u}" fill="${['#ffd166', '#ff8fab', '#ffffff', '#c3a6ff'][i % 4]}"/>`);
      }
      const dx = w * (.3 + r() * .4), dy = h * (.42 + r() * .1);
      body.push(`<g transform="translate(${dx} ${dy}) rotate(${-20 + r() * 40}) scale(${u})"><ellipse cx="-22" cy="-10" rx="26" ry="14" fill="${P.sun}" opacity=".7" transform="rotate(-25)"/><ellipse cx="22" cy="-10" rx="26" ry="14" fill="${P.sun}" opacity=".7" transform="rotate(25)"/><ellipse cx="0" cy="0" rx="5" ry="22" fill="${P.layers[3]}"/></g>`);
      body.push(`<rect y="${h * .8}" width="${w}" height="${h * .2}" fill="${P.layers[3]}" opacity=".6"/>`);
      break;
    }
    case 'ice': {
      const water = h * .3;
      defs.push(`<linearGradient id="${id}deep" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.layers[0]}"/><stop offset="1" stop-color="#03111c"/></linearGradient>`);
      body.push(`<rect y="${water}" width="${w}" height="${h - water}" fill="url(#${id}deep)"/>`);
      for (let i = 0; i < 7; i++) {
        const x = r() * w, s = (20 + r() * 50) * u;
        body.push(`<path d="M${x - s} ${water} L${x + s} ${water} L${x + s * 3 + (r() - .5) * 200 * u} ${h} L${x - s * 2} ${h} Z" fill="#fff" opacity="${(.03 + r() * .06).toFixed(2)}"/>`);
      }
      const bx = w * (.35 + r() * .3), bw = w * .2;
      body.push(`<path d="M${bx - bw * .6} ${water} L${bx - bw * .3} ${water - h * .1} L${bx - bw * .05} ${water - h * .07} L${bx + bw * .2} ${water - h * .14} L${bx + bw * .6} ${water} Z" fill="#f4fbff"/>`);
      body.push(`<path d="M${bx - bw * .6} ${water} L${bx + bw * .6} ${water} L${bx + bw * 1.1} ${water + h * .2} L${bx + bw * .7} ${water + h * .45} L${bx - bw * .2} ${water + h * .52} L${bx - bw * .9} ${water + h * .3} Z" fill="${P.layers[0]}" opacity=".75"/>`);
      body.push(`<rect y="${water - 1.5 * u}" width="${w}" height="${3 * u}" fill="#fff" opacity=".5"/>`);
      for (let i = 0; i < 40; i++) body.push(`<circle cx="${r() * w}" cy="${water + r() * (h - water)}" r="${(1 + r() * 2.5) * u}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="${u}"/>`);
      break;
    }
    case 'pitch': {
      // a football ground under floodlights: stand with crowd, then the pitch in perspective
      const y0 = h * .42;
      defs.push(`<linearGradient id="${id}stand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0f18"/><stop offset="1" stop-color="#1c2230"/></linearGradient>`);
      body.push(`<rect width="${w}" height="${y0}" fill="url(#${id}stand)"/>`);
      for (let i = 0; i < 4; i++) body.push(sunDisc(`${id}fl${i}`, w * (.12 + i * .25), h * .05, 7 * u, '#fffbe8', 9));
      const crowd = ['#e63946', '#f1faee', '#457b9d', '#ffd166', '#2a2f3a', '#3a4150', '#c9cdd6'];
      for (let i = 0; i < 2600; i++) { const y = h * .17 + r() * (y0 - h * .19); body.push(`<rect x="${(r() * w).toFixed(0)}" y="${y.toFixed(0)}" width="${2.4 * u}" height="${2.4 * u}" fill="${crowd[Math.floor(r() * crowd.length)]}" opacity="${(.35 + (y / y0) * .5).toFixed(2)}"/>`); }
      body.push(`<rect y="${y0 - h * .03}" width="${w}" height="${h * .03}" fill="#10151f"/>`);
      for (let i = 0; i < 6; i++) body.push(`<rect x="${(i / 6) * w + 6 * u}" y="${y0 - h * .026}" width="${w / 6 - 12 * u}" height="${h * .018}" rx="${2 * u}" fill="${['#ff7a59', '#6ea1ff', '#ffd166'][i % 3]}" opacity=".85"/>`);
      const stripes = 9;
      let y = y0;
      for (let i = 0; i < stripes; i++) { const hh = (h - y0) * (.05 + i * .022); body.push(`<rect y="${y}" width="${w}" height="${hh + 1}" fill="${i % 2 ? '#2f8a3e' : '#287a36'}"/>`); y += hh; }
      body.push(`<rect y="${y}" width="${w}" height="${h - y}" fill="#2f8a3e"/>`);
      const line = `stroke="#f2f6ef" stroke-opacity=".85" fill="none" stroke-width="${2.2 * u}"`;
      body.push(`<path d="M${w * .02} ${y0 + h * .012} L${w * .98} ${y0 + h * .012}" ${line}/><path d="M${w * .5} ${y0 + h * .012} L${w * .5} ${h}" ${line}/>`);
      body.push(`<ellipse cx="${w * .5}" cy="${y0 + (h - y0) * .42}" rx="${w * .17}" ry="${(h - y0) * .2}" ${line}/>`);
      const players = [[.31, .2, 'a'], [.42, .55, 'b'], [.55, .32, 'a'], [.62, .7, 'b'], [.7, .25, 'b'], [.22, .6, 'a'], [.8, .5, 'a'], [.47, .15, 'b'], [.37, .82, 'a']];
      players.forEach(([px, py, team]) => {
        const yy = y0 + (h - y0) * py, s = (5 + py * 12) * u, x = w * px;
        body.push(`<ellipse cx="${x + s * .4}" cy="${yy + s * .2}" rx="${s * .9}" ry="${s * .25}" fill="#000" opacity=".25"/><rect x="${x - s * .45}" y="${yy - s * 2.2}" width="${s * .9}" height="${s * 1.3}" rx="${s * .3}" fill="${team === 'a' ? '#e63946' : '#f1faee'}"/><rect x="${x - s * .4}" y="${yy - s * .95}" width="${s * .8}" height="${s * .95}" fill="${team === 'a' ? '#f1faee' : '#1d3557'}"/><circle cx="${x}" cy="${yy - s * 2.6}" r="${s * .38}" fill="#c68b59"/>`);
      });
      body.push(`<circle cx="${w * .5}" cy="${y0 + (h - y0) * .5}" r="${4 * u}" fill="#fff"/>`);
      break;
    }
    case 'studio': {
      // a news studio: blue backdrop with a world map of dots, a desk and screen glow
      defs.push(`<radialGradient id="${id}st" cx=".5" cy=".35" r=".8"><stop offset="0" stop-color="#1d4f9a"/><stop offset="1" stop-color="#061433"/></radialGradient>`);
      body.push(`<rect width="${w}" height="${h}" fill="url(#${id}st)"/>`);
      for (let gx = 0; gx < 70; gx++) for (let gy = 0; gy < 26; gy++) {
        const x = (gx + .5) / 70, yy = (gy + .5) / 26;
        const land = Math.sin(x * 9.1 + 1.3) * Math.cos(yy * 6.3 - .4) + Math.sin(x * 23 + yy * 5) * .35 > .25;
        if (land) body.push(`<circle cx="${(w * .08 + x * w * .84).toFixed(1)}" cy="${(h * .08 + yy * h * .5).toFixed(1)}" r="${2.2 * u}" fill="#7fb4ff" opacity=".45"/>`);
      }
      for (let i = 0; i < 7; i++) body.push(`<rect x="${w * (i / 7)}" y="0" width="${w / 14}" height="${h}" fill="#fff" opacity=".025"/>`);
      defs.push(`<linearGradient id="${id}desk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9eef7"/><stop offset=".08" stop-color="#9fb0c9"/><stop offset="1" stop-color="#2a3550"/></linearGradient>`);
      body.push(`<path d="M${w * .16} ${h * .72} L${w * .84} ${h * .72} L${w * .95} ${h} L${w * .05} ${h} Z" fill="url(#${id}desk)"/>`);
      body.push(`<rect x="${w * .16}" y="${h * .715}" width="${w * .68}" height="${h * .012}" fill="#ff5a63"/>`);
      // anchor: a simple silhouette behind the desk
      const ax = w * .5, ay = h * .72;
      body.push(`<path d="M${ax - w * .12} ${ay} Q${ax - w * .11} ${ay - h * .2} ${ax} ${ay - h * .21} Q${ax + w * .11} ${ay - h * .2} ${ax + w * .12} ${ay} Z" fill="#1b2335"/>`);
      body.push(`<path d="M${ax - w * .03} ${ay - h * .2} L${ax} ${ay - h * .1} L${ax + w * .03} ${ay - h * .2} Z" fill="#e9eef7"/><rect x="${ax - w * .006}" y="${ay - h * .19}" width="${w * .012}" height="${h * .08}" fill="#c0303a"/>`);
      body.push(`<rect x="${ax - w * .022}" y="${ay - h * .245}" width="${w * .044}" height="${h * .05}" rx="${w * .01}" fill="#c68b59"/><ellipse cx="${ax}" cy="${ay - h * .3}" rx="${w * .045}" ry="${h * .085}" fill="#c68b59"/><path d="M${ax - w * .05} ${ay - h * .31} Q${ax} ${ay - h * .42} ${ax + w * .05} ${ay - h * .31} Q${ax + w * .045} ${ay - h * .36} ${ax} ${ay - h * .37} Q${ax - w * .045} ${ay - h * .36} ${ax - w * .05} ${ay - h * .31} Z" fill="#2b1d16"/>`);
      break;
    }
    default: ridges(4, horizon - h * .1, h * .09, h * .2);
  }

  // film grain and a soft vignette over everything
  defs.push(`<filter id="${id}grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="${seed}"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 0"/></filter>`);
  defs.push(`<radialGradient id="${id}vig" cx=".5" cy=".45" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>`);
  body.push(`<rect width="${w}" height="${h}" filter="url(#${id}grain)" opacity=".07"/><rect width="${w}" height="${h}" fill="url(#${id}vig)"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${defs.join('')}</defs>${body.join('')}</svg>`;
}

const STYLES = ['caps', 'serif', 'block', 'thin'];
const escX = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A whole poster page (HTML) at w × h: the scene plus title, tagline and a credits block.
function posterHtml(item, people, w = 500, h = 750, kindLabel = 'A FILM BY') {
  const [kind, pal, seed] = item.art;
  const style = STYLES[seed % STYLES.length];
  const t = escX(item.name);
  const titleCss = {
    caps: `font: 800 ${w * .095}px/0.98 'DM Sans'; letter-spacing: .06em; text-transform: uppercase; text-align: center; bottom: 17%; left: 6%; right: 6%;`,
    serif: `font: italic 400 ${w * .12}px/0.95 'Liberation Serif', serif; text-align: center; top: 9%; left: 6%; right: 6%;`,
    block: `font: 900 ${w * .118}px/0.9 'Inter Display', 'Inter'; letter-spacing: -.02em; text-transform: uppercase; text-align: left; bottom: 16%; left: 7%; right: 7%;`,
    thin: `font: 200 ${w * .1}px/1 'Inter Display', 'Inter'; letter-spacing: .14em; text-transform: uppercase; text-align: center; top: 12%; left: 5%; right: 5%;`,
  }[style];
  const tagTop = style === 'serif' || style === 'thin';
  const credits = `${kindLabel} ${people[0].toUpperCase()} &nbsp; STARRING ${people.slice(1, 4).join('  ').toUpperCase()} &nbsp; MUSIC BY ${people[4].toUpperCase()} &nbsp; EDITED BY ${people[5].toUpperCase()} &nbsp; PRODUCED BY ${people[6].toUpperCase()}`;
  return `<!doctype html><html><head><style>
    @font-face { font-family: 'DM Sans'; font-weight: 400 800; src: url(fonts/dm-sans-latin.woff2) format('woff2'); }
    html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: #000; }
    .p { position: relative; width: ${w}px; height: ${h}px; color: #fff; }
    .p > svg { position: absolute; inset: 0; }
    .shade { position: absolute; inset: 0; background: linear-gradient(${tagTop ? '180deg' : '0deg'}, rgba(0,0,0,.55), rgba(0,0,0,0) 45%); }
    .t { position: absolute; ${titleCss} text-shadow: 0 2px 18px rgba(0,0,0,.35); }
    .tag { position: absolute; left: 8%; right: 8%; text-align: center; font: 500 ${w * .031}px/1.3 'DM Sans'; letter-spacing: .22em; text-transform: uppercase; opacity: .85; ${tagTop ? 'bottom: 15%;' : 'top: 7%;'} }
    .cr { position: absolute; left: 8%; right: 8%; bottom: 4.2%; text-align: center; font: 500 ${w * .0165}px/1.5 'DM Sans'; letter-spacing: .08em; opacity: .62; }
    .yr { position: absolute; left: 0; right: 0; bottom: 10.5%; text-align: center; font: 700 ${w * .026}px 'DM Sans'; letter-spacing: .4em; opacity: .8; }
  </style></head><body><div class="p">${scene(kind, pal, seed, w, h)}<div class="shade"></div>
    <div class="tag">${escX(item.tag || item.genre)}</div><div class="t">${t}</div>
    <div class="yr">${item.year}</div><div class="cr">${credits}</div></div></body></html>`;
}

const SHAPES = {
  round: (c) => `<rect x="16" y="16" width="224" height="224" rx="56" fill="${c}"/>`,
  square: (c) => `<rect x="20" y="20" width="216" height="216" rx="14" fill="${c}"/>`,
  circle: (c) => `<circle cx="128" cy="128" r="112" fill="${c}"/>`,
  pill: (c) => `<rect x="4" y="66" width="248" height="124" rx="62" fill="${c}"/>`,
  slant: (c) => `<path d="M60 36 H236 L196 220 H20 Z" fill="${c}"/>`,
  hex: (c) => `<path d="M128 12 L228 70 V186 L128 244 L28 186 V70 Z" fill="${c}"/>`,
  diamond: (c) => `<rect x="44" y="44" width="168" height="168" rx="22" fill="${c}" transform="rotate(45 128 128)"/>`,
};
function logoHtml([label, shape, color, ink]) {
  const len = [...label].length;
  const size = shape === 'pill' ? (len > 3 ? 64 : 78) : len >= 3 ? 74 : len === 2 ? (shape === 'slant' ? 92 : 104) : 132;
  return `<!doctype html><html><head><style>
    @font-face { font-family: 'DM Sans'; font-weight: 400 800; src: url(fonts/dm-sans-latin.woff2) format('woff2'); }
    html, body { margin: 0; background: transparent; } svg { display: block; }
  </style></head><body><svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
    ${SHAPES[shape](color)}${SHAPES[shape]('url(#g)')}
    <text x="128" y="${shape === 'slant' ? 130 : 128}" text-anchor="middle" dominant-baseline="central" font-family="DM Sans" font-weight="800" font-size="${size}" letter-spacing="${len > 2 ? -2 : -4}" fill="${ink}">${escX(label)}</text>
  </svg></body></html>`;
}

// What a broadcast puts over the picture (1280 × 720, transparent): the channel's logo in the corner, plus a news
// lower third, a scoreboard, race info or the song that's playing.
function overlayHtml(logoFile, o = {}) {
  const css = `@font-face { font-family: 'DM Sans'; font-weight: 400 800; src: url(fonts/dm-sans-latin.woff2) format('woff2'); }
    html, body { margin: 0; width: 1280px; height: 720px; background: transparent; font-family: 'DM Sans'; color: #fff; overflow: hidden; }
    .bug { position: absolute; top: 34px; right: 40px; width: 64px; height: 64px; opacity: .88; filter: drop-shadow(0 2px 6px rgba(0,0,0,.4)); }
    .lt { position: absolute; left: 70px; right: 70px; bottom: 92px; }
    .lt .k { display: inline-flex; gap: 10px; align-items: center; background: #d6303a; padding: 7px 14px; font-weight: 800; font-size: 19px; letter-spacing: .08em; }
    .lt .h { background: rgba(255,255,255,.95); color: #0d1424; padding: 14px 20px; font-weight: 700; font-size: 31px; }
    .tick { position: absolute; left: 0; right: 0; bottom: 34px; height: 40px; background: rgba(8,14,30,.88); display: flex; align-items: center; font-size: 19px; white-space: nowrap; }
    .tick b { background: #ffd23f; color: #111; height: 100%; display: grid; place-items: center; padding: 0 16px; margin-right: 18px; letter-spacing: .06em; }
    .clock { position: absolute; top: 40px; left: 44px; font-weight: 700; font-size: 22px; background: rgba(8,14,30,.7); padding: 6px 12px; border-radius: 4px; }
    .score { position: absolute; top: 36px; left: 44px; display: flex; font-weight: 800; font-size: 24px; box-shadow: 0 4px 18px rgba(0,0,0,.35); }
    .score span { padding: 8px 14px; background: rgba(10,16,30,.92); }
    .score .t { background: #fff; color: #0d1424; } .score .c { background: #1d4ed8; } .score .m { background: rgba(10,16,30,.75); font-weight: 600; }
    .race { position: absolute; top: 36px; left: 44px; background: rgba(10,16,30,.85); border-left: 6px solid #ffd23f; padding: 10px 18px; }
    .race b { display: block; font-size: 24px; } .race small { font-size: 17px; opacity: .8; letter-spacing: .05em; }
    .np { position: absolute; left: 60px; bottom: 60px; background: rgba(10,10,20,.72); border-radius: 10px; padding: 14px 20px; display: flex; gap: 14px; align-items: center; }
    .np i { width: 12px; height: 34px; background: linear-gradient(#22d3ee, #a855f7); border-radius: 3px; display: block; }
    .np small { display: block; font-size: 15px; opacity: .75; letter-spacing: .08em; text-transform: uppercase; } .np b { font-size: 25px; }`;
  let extra = '';
  if (o.news) extra = `<div class="clock">${o.clock || '20:31'}</div><div class="lt"><div class="k">● LIVE &nbsp;${escX(o.label || 'BREAKING')}</div><div class="h">${escX(o.news)}</div></div>
    <div class="tick"><b>LATEST</b>${escX(o.ticker || '')}</div>`;
  else if (o.score) extra = `<div class="score"><span class="t">${escX(o.score[0])}</span><span>${escX(o.score[1])}</span><span class="c">${escX(o.score[2])}</span><span class="m">${escX(o.score[3])}</span></div>`;
  else if (o.race) extra = `<div class="race"><b>${escX(o.race[0])}</b><small>${escX(o.race[1])}</small></div>`;
  else if (o.song) extra = `<div class="np"><i></i><div><small>Now playing</small><b>${escX(o.song)}</b></div></div>`;
  return `<!doctype html><html><head><style>${css}</style></head><body><img class="bug" src="img/${logoFile}">${extra}</body></html>`;
}

const sceneHtml = (kind, pal, seed, w, h) => `<!doctype html><html><head><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden}</style></head><body>${scene(kind, pal, seed, w, h)}</body></html>`;

module.exports = { scene, sceneHtml, posterHtml, logoHtml, overlayHtml, PAL };
