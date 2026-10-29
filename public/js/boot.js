'use strict';
/* AG Horizon – start-up. Everything else is defined in the other files; this wires it together and opens the first page. */

applyTheme();
updateSwitcher();
syncNavState();
updatePlayerChrome();

// Keep the "on now" lines, progress bars and the red "now" marker fresh.
setInterval(() => {
  if (document.hidden || ui.route !== 'ws' || ws.mode !== 'live') return;
  if (ws.lv === 'channels') { renderLiveList(); renderLiveInfo(); } else { renderGuide(); placeNowLine(); }
}, 30000);

/* Drop an .m3u / .m3u8 file anywhere on the window to add it as a playlist. */
let dragDepth = 0;
const isFileDrag = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (isFileDrag(e)) { dragDepth++; document.body.classList.add('dropping'); } });
window.addEventListener('dragleave', (e) => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const files = [...e.dataTransfer.files].filter((f) => /\.(m3u8?|txt)$/i.test(f.name));
  if (!files.length) { toast('Drop an .m3u or .m3u8 playlist file.', 'err'); return; }
  let last = null;
  for (const f of files) {
    const text = await f.text();
    if (!/#EXTM3U|#EXTINF/.test(text.slice(0, 4000))) { toast(`“${f.name}” does not look like an M3U playlist.`, 'err'); continue; }
    const p = { id: uidOf(), name: f.name.replace(/\.[^.]+$/, ''), type: 'file', fileName: f.name, epgUrl: '', ua: '', added: Date.now() };
    await idb.put('file:' + p.id, text);
    state.playlists.push(p);
    last = p;
  }
  if (!last) return;
  savePlaylists();
  uiPlaylistsChanged();
  toast(files.length > 1 ? 'Playlists added' : 'Playlist added');
  openWorkspace(last.id, 'live');
});

go('dashboard', {}, { push: false });

/* Reload every playlist when the app starts (last used one first), so lists, guide and status are fresh. */
async function startupReload() {
  const lastSaved = LS.get('tuner.lastPid', '');
  const last = playlistById(lastSaved) ? lastSaved : (state.playlists[0] && state.playlists[0].id);
  const order = [...state.playlists].sort((x, y) => (y.id === last) - (x.id === last));
  for (const p of order) {
    if (!playlistById(p.id)) continue;
    try {
      await loadPlaylist(p, true);
    } catch { continue; }   // status is already marked "not responding"
    if (p.id === last) {
      if (!state.epgState[p.id]) loadEpg(p);
      for (const m of ['movie', 'series']) loadItems(p, m).then(() => { if (ui.route === 'dashboard') renderDashboard(); }).catch(() => {});
    }
    if (ui.route === 'dashboard') renderDashboard();
  }
}
startupReload();
initUpdates();

