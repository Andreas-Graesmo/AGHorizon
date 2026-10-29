'use strict';
/* AG Horizon – add / edit / delete playlists. */

const dlg = $('#addDlg');
const form = $('#plForm');
const F = (n) => form.elements.namedItem(n); // form.name would be the <form>'s own name attribute
let editingId = null;
let pendingFile = null;

function openPlaylistDialog(p) {
  resetForm();
  if (p) fillForm(p);
  if (!dlg.open) dlg.showModal();
  setTimeout(() => (p ? F('name') : F('name')).focus(), 30);
}
const closePlaylistDialog = () => { if (dlg.open) dlg.close(); };
$('#mClose').addEventListener('click', closePlaylistDialog);
$('#btnCancelEdit').addEventListener('click', closePlaylistDialog);
dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) closePlaylistDialog(); });

function setType(type) {
  F('type').value = type;
  $$('#typeTiles button').forEach((b) => b.classList.toggle('on', b.dataset.type === type));
  $$('[data-for]', form).forEach((d) => { d.hidden = d.dataset.for !== type; });
}
$('#typeTiles').addEventListener('click', (e) => { const b = e.target.closest('button[data-type]'); if (b) setType(b.dataset.type); });

F('server').addEventListener('change', () => {
  const x = parseXtreamLink(F('server').value);
  if (x) { F('server').value = x.server; F('username').value = x.username; F('password').value = x.password; }
});

F('file').addEventListener('change', async () => {
  const f = F('file').files[0];
  pendingFile = null;
  if (!f) return;
  pendingFile = { name: f.name, text: await f.text() };
  if (!F('name').value) F('name').value = f.name.replace(/\.[^.]+$/, '');
  $('#fileHint').textContent = `${f.name} – ${(f.size / 1024).toFixed(0)} KB ready`;
});

function setFormMsg(text, kind = '') { const m = $('#formMsg'); m.textContent = text; m.className = 'form-msg ' + kind; }

function resetForm() {
  editingId = null; pendingFile = null;
  form.reset();
  setType('xtream');
  $('#formTitle').textContent = 'Add playlist';
  $('#btnSave').textContent = 'Add playlist';
  $('#fileHint').textContent = '';
  form.querySelector('details').open = false;
  setFormMsg('');
}

function fillForm(p) {
  editingId = p.id;
  for (const k of ['name', 'server', 'username', 'password', 'format', 'url', 'epgUrl', 'ua']) if (F(k) && p[k] != null) F(k).value = p[k];
  setType(p.type);
  if (p.type === 'file') $('#fileHint').textContent = `Current file: ${p.fileName || 'stored locally'} – choose another to replace it.`;
  if (p.ua) form.querySelector('details').open = true;
  $('#formTitle').textContent = `Edit “${p.name}”`;
  $('#btnSave').textContent = 'Save changes';
}

function readForm() {
  const f = Object.fromEntries(new FormData(form).entries());
  const p = { id: editingId || uidOf(), name: (f.name || '').trim(), type: f.type, epgUrl: (f.epgUrl || '').trim(), ua: (f.ua || '').trim() };
  if (p.type === 'xtream') {
    Object.assign(p, { server: normServer(f.server), username: (f.username || '').trim(), password: (f.password || '').trim(), format: f.format || 'm3u8' });
    if (!p.server || !p.username || !p.password) throw new Error('Server, username and password are all required');
  } else if (p.type === 'm3u') {
    p.url = (f.url || '').trim();
    if (!/^https?:\/\//i.test(p.url)) throw new Error('Enter a full http(s) playlist URL');
  } else {
    const old = editingId && playlistById(editingId);
    if (!pendingFile && !(old && old.type === 'file')) throw new Error('Choose an M3U file');
    p.fileName = pendingFile ? pendingFile.name : old.fileName;
  }
  if (!p.name) throw new Error('Give the playlist a name');
  return p;
}

$('#btnTest').addEventListener('click', async () => {
  let p;
  try { p = readForm(); } catch (e) { return setFormMsg(e.message, 'err'); }
  setFormMsg('Testing…');
  try {
    if (p.type === 'xtream') {
      const j = await apiJson(xt.api(p, ''), p);
      const u = j.user_info;
      if (!u || String(u.auth) === '0') throw new Error('The server rejected the username or password');
      const exp = u.exp_date && Number(u.exp_date) ? new Date(Number(u.exp_date) * 1000).toLocaleDateString() : 'no expiry';
      setFormMsg(`Connected ✓\nStatus: ${u.status || 'unknown'} · expires: ${exp} · connections: ${u.active_cons ?? '?'}/${u.max_connections ?? '?'}`, 'ok');
    } else {
      const text = p.type === 'file' ? (pendingFile && pendingFile.text) : await apiText(p.url, p);
      if (!text) throw new Error(p.type === 'file' ? 'Choose a file first' : 'Empty response');
      const r = parseM3U(text, p);
      const total = r.channels.length + r.movies.length + r.series.length;
      if (!total) throw new Error('No channels found – is this an M3U playlist?');
      setFormMsg(`Playlist OK ✓ – ${r.channels.length.toLocaleString()} channels, ${r.movies.length.toLocaleString()} movies, ${r.series.length.toLocaleString()} series${r.epgUrl ? ' · guide link found' : ''}`, 'ok');
    }
  } catch (e) { setFormMsg(e.message, 'err'); }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  let p;
  try { p = readForm(); } catch (err) { return setFormMsg(err.message, 'err'); }
  if (p.type === 'file' && pendingFile) await idb.put('file:' + p.id, pendingFile.text);
  const idx = state.playlists.findIndex((x) => x.id === p.id);
  p.added = idx >= 0 ? state.playlists[idx].added || Date.now() : Date.now();
  if (idx >= 0) p.updated = state.playlists[idx].updated;
  if (idx >= 0) state.playlists[idx] = p; else state.playlists.push(p);
  dropCaches(p.id);
  savePlaylists();
  closePlaylistDialog();
  uiPlaylistsChanged();
  if (ws.pid === p.id) { ws.items = []; }
  openWorkspace(p.id, ws.pid === p.id ? ws.mode : 'live', { force: true });
  toast(idx >= 0 ? 'Playlist saved' : 'Playlist added');
});

function deletePlaylist(id, silent) {
  const p = playlistById(id);
  if (!p || !(silent || confirm(`Delete “${p.name}”? Your favorites from it stay in the list, but can't be opened any more.`))) return;
  state.playlists = state.playlists.filter((x) => x.id !== id);
  dropCaches(id);
  if (p.type === 'file') idb.del('file:' + id).catch(() => {});
  if (state.current && state.current.pid === id) stopPlayback();
  savePlaylists();
  if (ws.pid === id) { ws.pid = null; ws.items = []; }
  uiPlaylistsChanged();
  if (!silent) toast('Playlist deleted');
}

function refreshPlaylist(id) {
  const p = playlistById(id);
  if (!p) return;
  dropCaches(id);
  toast(`Reloading “${p.name}”…`);
  if (ui.route === 'ws' && ws.pid === id) { loadWs({ force: true }); return; }
  loadPlaylist(p, true)
    .then((r) => { toast(`“${p.name}” updated – ${r.channels.length.toLocaleString()} channels`); if (ui.route === 'dashboard') renderDashboard(); })
    .catch((e) => toast(`“${p.name}” did not respond: ${e.message}`, 'err'));
}
