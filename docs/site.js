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
