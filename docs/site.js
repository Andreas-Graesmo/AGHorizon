'use strict';
/* AG Horizon website: the right download for this computer, straight from the latest GitHub release; accent colours
   to try; sections that fade in. Everything here is optional – without it the links go to the releases page. */
const REPO = 'Andreas-Graesmo/AGHorizon';
document.documentElement.classList.add('js');

/* ── which computer is this? ── */
function detectOs() {
  const p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|android/.test(ua)) return '';          // phones and tablets: no download to offer
  if (p.includes('win') || ua.includes('windows')) return 'win';
  if (p.includes('mac') || ua.includes('mac os')) return 'mac';
  if (p.includes('linux') || ua.includes('linux')) return 'linux';
  return '';
}
const OS_NAME = { win: 'Windows', mac: 'macOS', linux: 'Linux' };
const ASSET = { win: /setup.*\.exe$/i, mac: /arm64\.dmg$/i, linux: /\.appimage$/i };
const os = detectOs();

if (os) {
  document.getElementById('dlMainLabel').textContent = `Download for ${OS_NAME[os]}`;
  const card = document.querySelector(`.platform[data-os="${os}"]`);
  if (card) card.classList.add('mine');
}

/* ── the latest release: version number and direct file links ── */
fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
  .then((rel) => {
    const version = String(rel.tag_name || '').replace(/^v/, '');
    const assets = rel.assets || [];
    for (const [key, re] of Object.entries(ASSET)) {
      const a = assets.find((x) => re.test(x.name));
      if (!a) continue;
      const card = document.querySelector(`.platform[data-os="${key}"]`);
      if (card) { card.href = a.browser_download_url; card.querySelector('.file').textContent = a.name; }
      if (key === os) document.getElementById('dlMain').href = a.browser_download_url;
    }
    if (version) {
      const date = rel.published_at ? new Date(rel.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
      document.getElementById('dlVersion').textContent = `Version ${version}${date ? ' · ' + date : ''}`;
      document.getElementById('dlMeta').textContent = `Version ${version} · Free download · Updates itself`;
    }
  })
  .catch(() => { /* offline or rate-limited: the links still go to the releases page */ });

/* ── accent colours, like the app's Settings › Appearance ── */
const swatches = [...document.querySelectorAll('.swatches button')];
function setAccent(btn, save) {
  const root = document.documentElement.style;
  root.setProperty('--accent', btn.style.getPropertyValue('--c'));
  root.setProperty('--sun', btn.style.getPropertyValue('--c'));
  root.setProperty('--accent-ink', btn.dataset.ink);
  swatches.forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
  if (save) try { localStorage.setItem('agh.accent', btn.getAttribute('aria-label')); } catch { /* storage blocked */ }
}
swatches.forEach((b) => b.addEventListener('click', () => setAccent(b, true)));
try {
  const saved = localStorage.getItem('agh.accent');
  const b = saved && swatches.find((x) => x.getAttribute('aria-label') === saved);
  if (b) setAccent(b, false);
} catch { /* storage blocked */ }

/* ── fade sections in as they scroll into view ── */
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const els = document.querySelectorAll('.feature .copy, .feature .shot, .pair .shot, .card, .byo-in, .platform');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  els.forEach((el) => { el.classList.add('reveal'); io.observe(el); });
}

/* ── click a screenshot to see it large; ← → to step through them, Esc or a click to close ── */
const shots = [...document.querySelectorAll('.shot img, .card-light img')];
if (shots.length && typeof HTMLDialogElement === 'function') {
  const box = document.createElement('dialog');
  box.className = 'lightbox';
  box.innerHTML = `<figure><img alt=""><figcaption></figcaption></figure>
    <button class="lb-btn lb-close" aria-label="Close">✕</button>
    <button class="lb-btn lb-prev" aria-label="Previous picture">‹</button>
    <button class="lb-btn lb-next" aria-label="Next picture">›</button>`;
  document.body.appendChild(box);
  const big = box.querySelector('img'), cap = box.querySelector('figcaption');
  let at = 0, opener = null;
  const show = (i) => {
    at = (i + shots.length) % shots.length;
    big.src = shots[at].currentSrc || shots[at].src;
    big.alt = shots[at].alt;
    cap.textContent = shots[at].alt;
  };
  shots.forEach((img, i) => {
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', `Show larger: ${img.alt}`);
    const open = () => { opener = img; show(i); box.showModal(); document.documentElement.classList.add('lb-open'); };
    img.addEventListener('click', open);
    img.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  box.addEventListener('close', () => { document.documentElement.classList.remove('lb-open'); if (opener) opener.focus(); });
  box.addEventListener('click', (e) => {
    if (e.target.closest('.lb-prev')) show(at - 1);
    else if (e.target.closest('.lb-next')) show(at + 1);
    else box.close();   // the picture, the backdrop or ✕
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); show(at + 1); }
  });
}
