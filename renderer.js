const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const audio = $('#audio');
const api = window.electronAPI || null;

const icon = (n, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

const state = {
  library: [],
  queue: [],
  currentId: null,
  isPlaying: false,
  shuffle: false,
  repeat: 'off', // off | all | one
  filter: 'all',
  search: '',
  openPlaylist: null, // id of playlist shown in detail view
  playlists: [],
  favorites: new Set(),
  view: 'home',
  lastView: 'home'
};

// ---------- persistence ----------
// Covers (base64 data URLs) can be huge and blow past localStorage quota,
// which used to wipe out playlists/favorites. So we persist the library
// WITHOUT covers, and keep covers in memory + a separate best-effort cache.
const coverCache = new Map(); // id -> dataURL
function save() {
  try {
    const libNoCover = state.library.map(t => {
      const { cover, ...rest } = t;
      return rest;
    });
    localStorage.setItem('mjr.library', JSON.stringify(libNoCover));
    localStorage.setItem('mjr.playlists', JSON.stringify(state.playlists));
    localStorage.setItem('mjr.favs', JSON.stringify([...state.favorites]));
    localStorage.setItem('mjr.queue', JSON.stringify(state.queue));
    try { localStorage.setItem('mjr.settings', JSON.stringify({ volume: $('#volume')?.value || 85, shuffle: state.shuffle, repeat: state.repeat })); } catch {}
  } catch (e) {
    console.warn('save failed (quota?)', e);
    // Last-resort: try to at least keep playlists + favs
    try {
      localStorage.setItem('mjr.playlists', JSON.stringify(state.playlists));
      localStorage.setItem('mjr.favs', JSON.stringify([...state.favorites]));
    } catch {}
  }
}
function load() {
  try {
    state.library = JSON.parse(localStorage.getItem('mjr.library') || '[]');
    state.playlists = JSON.parse(localStorage.getItem('mjr.playlists') || '[]');
    state.favorites = new Set(JSON.parse(localStorage.getItem('mjr.favs') || '[]'));
    try { state.queue = JSON.parse(localStorage.getItem('mjr.queue') || '[]'); } catch { state.queue = []; }
    try {
      const s = JSON.parse(localStorage.getItem('mjr.settings') || '{}');
      if (s.volume) setTimeout(() => { const v = $('#volume'); if (v) v.value = s.volume; if (audio) audio.volume = s.volume / 100; }, 0);
      if (typeof s.shuffle === 'boolean') state.shuffle = s.shuffle;
      if (s.repeat) state.repeat = s.repeat;
    } catch {}
    // restore covers from best-effort cache
    try {
      const cc = JSON.parse(localStorage.getItem('mjr.covers') || '{}');
      for (const t of state.library) {
        if (cc[t.id]) { t.cover = cc[t.id]; coverCache.set(t.id, cc[t.id]); }
      }
    } catch {}
  } catch {}
}
function persistCovers() {
  // best-effort, tiny + capped: only keep covers under ~150KB, max ~40 songs
  try {
    const out = {};
    let n = 0;
    for (const t of state.library) {
      const c = t.cover || coverCache.get(t.id);
      if (!c || typeof c !== 'string') continue;
      if (c.length > 200000) continue; // skip giant art for storage
      out[t.id] = c;
      if (++n >= 40) break;
    }
    localStorage.setItem('mjr.covers', JSON.stringify(out));
  } catch {}
}

// ---------- helpers ----------
const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtLong = (s) => {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} hr ${m} min` : m ? `${m} min` : `${s} sec`;
};
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2400);
}
function trackById(id) { return state.library.find(t => t.id === id); }
function playlistById(id) { return state.playlists.find(p => p.id === id); }
function playlistTracks(pl) {
  const map = new Map(state.library.map(t => [t.id, t]));
  return (pl?.trackIds || []).map(id => map.get(id)).filter(Boolean);
}
function playlistCover(pl) {
  for (const t of playlistTracks(pl)) {
    const c = coverSrc(t);
    if (c) return c;
  }
  return null;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function coverHTML(t, cls = 't-cover') {
  const initial = esc((t.title || 'M').charAt(0).toUpperCase());
  const src = t.cover || coverCache.get(t.id);
  if (src) return `<div class="${cls} has-photo" aria-hidden="true"><img src="${src}" alt="" loading="lazy" onerror="this.parentElement.classList.remove('has-photo');this.remove()"/></div>`;
  return `<div class="${cls}" aria-hidden="true">${initial}</div>`;
}
function coverSrc(t) { return t?.cover || coverCache.get(t?.id) || null; }

// ---------- audio + visualizer ----------
let actx = null, analyser = null, srcNode = null, dataArr = null, gainNode = null;
function ensureAudioGraph() {
  try {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return true; }
    actx = new (window.AudioContext || window.webkitAudioContext)();
    srcNode = actx.createMediaElementSource(audio);
    analyser = actx.createAnalyser();
    analyser.fftSize = 128;
    gainNode = actx.createGain();
    srcNode.connect(gainNode); gainNode.connect(analyser); analyser.connect(actx.destination);
    dataArr = new Uint8Array(analyser.frequencyBinCount);
    return true;
  } catch (e) { console.warn('visualizer unavailable', e); return false; }
}

const vCanvas = $('#visual'), bgCanvas = $('#bg-visual');
const vCtx = vCanvas.getContext('2d'), bgCtx = bgCanvas.getContext('2d');
function sizeCanvas() {
  for (const c of [vCanvas, bgCanvas]) {
    const r = c.getBoundingClientRect();
    const w = Math.max(2, Math.floor(r.width)), h = Math.max(2, Math.floor(r.height));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }
}
window.addEventListener('resize', sizeCanvas);

let fakeT = 0;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function drawVisual() {
  requestAnimationFrame(drawVisual);
  const W = vCanvas.width, H = vCanvas.height;
  if (!W) return;
  vCtx.clearRect(0, 0, W, H);
  let vals = null, live = false;
  if (analyser && state.isPlaying && $('#toggle-visual').checked) {
    try {
      analyser.getByteFrequencyData(dataArr);
      if (dataArr.reduce((a, b) => a + b, 0) > 50) { vals = dataArr; live = true; }
    } catch {}
  }
  const N = 64, barW = W / N;
  if (!reducedMotion()) fakeT += 0.06;
  for (let i = 0; i < N; i++) {
    let v;
    if (live) v = vals[Math.floor(i / N * vals.length)] / 255;
    else {
      const amp = state.isPlaying ? 0.55 : 0.14;
      v = amp * (0.5 + 0.5 * Math.sin(fakeT + i * 0.35) * Math.sin(fakeT * 0.7 + i * 0.12));
      if (!state.isPlaying) v *= 0.5;
    }
    const h = Math.max(3, v * H * 0.92);
    const x = i * barW + barW * 0.2;
    const g = vCtx.createLinearGradient(0, H - h, 0, H);
    g.addColorStop(0, '#5b8cff'); g.addColorStop(0.55, '#8b5cf6'); g.addColorStop(1, '#22d3ee');
    vCtx.fillStyle = g;
    vCtx.shadowColor = 'rgba(139,92,246,.7)'; vCtx.shadowBlur = 12;
    vCtx.beginPath();
    if (vCtx.roundRect) vCtx.roundRect(x, H - h, barW * 0.6, h, 4); else vCtx.rect(x, H - h, barW * 0.6, h);
    vCtx.fill();
  }
  vCtx.shadowBlur = 0;
  const bw2 = bgCanvas.width, bh2 = bgCanvas.height;
  if (bw2) {
    bgCtx.clearRect(0, 0, bw2, bh2);
    bgCtx.fillStyle = 'rgba(139,92,246,.5)';
    for (let i = 0; i < 48; i++) {
      const v = live ? vals[Math.floor(i / 48 * vals.length)] / 255 : 0.06 + 0.05 * Math.sin(fakeT + i);
      bgCtx.fillRect(i * (bw2 / 48), bh2 - v * bh2, 3, v * bh2);
    }
  }
}

// ---------- menus (context menu + add-to-playlist) ----------
function closeMenus() {
  $('#ctx-menu').hidden = true;
  $('#pl-popup').hidden = true;
}
function placeMenu(el, x, y) {
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - r.width - 12) + 'px';
  el.style.top = Math.min(y, window.innerHeight - r.height - 12) + 'px';
  const first = el.querySelector('.menu-item');
  if (first) first.focus({ preventScroll: true });
}
function menuItemHTML(it, i) {
  if (it.sep) return `<div class="menu-sep" role="separator"></div>`;
  if (it.head) return `<div class="menu-head">${esc(it.head)}</div>`;
  return `<button class="menu-item ${it.danger ? 'danger' : ''} ${it.checked ? 'in-list' : ''}" role="menuitem" data-mi="${i}">${icon(it.icon || 'check')}<span>${esc(it.label)}</span><span class="check">${icon('check', 'ic ic-sm')}</span></button>`;
}
function openCtxMenu(x, y, items) {
  closeMenus();
  const el = $('#ctx-menu');
  el.innerHTML = items.map(menuItemHTML).join('');
  el.querySelectorAll('[data-mi]').forEach(b => b.addEventListener('click', () => {
    const it = items[+b.dataset.mi];
    closeMenus();
    it.action?.();
  }));
  placeMenu(el, x, y);
}
function openPlaylistPopup(trackId, x, y) {
  closeMenus();
  const el = $('#pl-popup');
  const rows = state.playlists.map((p, i) => ({
    icon: 'music', label: `${p.name} • ${p.trackIds.length}`, checked: p.trackIds.includes(trackId),
    action: () => toggleInPlaylist(p.id, trackId)
  }));
  const items = [
    { head: 'Add to playlist' },
    ...rows,
    ...(rows.length ? [{ sep: true }] : []),
    { icon: 'plus', label: 'New playlist…', action: () => openPlaylistModal(trackId) }
  ];
  if (!rows.length) items.splice(1, 0, { head: '' });
  el.innerHTML = items.map(menuItemHTML).join('');
  el.querySelectorAll('.menu-item').forEach(b => {
    const idx = +b.dataset.mi;
    b.addEventListener('click', () => { closeMenus(); items[idx].action?.(); });
  });
  placeMenu(el, x, y);
}
function trackCtxItems(id, ctx = 'library') {
  const t = trackById(id);
  const fav = state.favorites.has(id);
  const items = [
    { icon: 'play', label: 'Play', action: () => playFromList(id, ctx) },
    { icon: 'listplus', label: 'Add to playlist…', action: (e) => openPlaylistPopup(id, lastMouse.x, lastMouse.y) },
    { icon: 'heart', label: fav ? 'Remove from Favorites' : 'Add to Favorites', action: () => toggleFav(id) },
    { icon: 'edit', label: 'Edit details…', action: () => openEditTrackModal(id) },
  ];
  if (ctx === 'playlist' && state.openPlaylist) {
    items.push({ icon: 'x', label: 'Remove from this playlist', danger: true, action: () => removeFromPlaylist(state.openPlaylist, id) });
  }
  items.push({ sep: true });
  items.push({ icon: 'trash', label: 'Remove from library', danger: true, action: () => removeFromLibrary(id) });
  return items;
}
const lastMouse = { x: 200, y: 200 };
window.addEventListener('mousemove', (e) => { lastMouse.x = e.clientX; lastMouse.y = e.clientY; }, { passive: true });

// ---------- render: track rows ----------
function trackRowHTML(t, i, opts = {}) {
  const fav = state.favorites.has(t.id);
  const ctx = opts.ctx || 'library';
  const thirdBtn = ctx === 'playlist'
    ? `<button class="icon-mini" data-act="rmpl" aria-label="Remove from this playlist" title="Remove from playlist">${icon('x')}</button>`
    : `<button class="icon-mini" data-act="more" aria-label="More actions" aria-haspopup="menu" title="More actions">${icon('dots')}</button>`;
  return `
    <div class="track ${t.id === state.currentId ? 'playing' : ''}" role="listitem" tabindex="0" data-id="${t.id}" data-ctx="${ctx}" style="animation-delay:${Math.min(i * 25, 500)}ms">
      <div class="idx">${i + 1}</div>
      <div class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      ${coverHTML(t)}
      <div class="t-meta"><div class="t-title">${esc(t.title)}</div><div class="t-artist">${esc(t.artist)}</div></div>
      <div class="t-album">${esc(t.album)}</div>
      <div class="t-dur">${icon('clock', 'ic ic-sm')}${t.duration ? fmt(t.duration) : '--:--'}</div>
      <div class="t-actions">
        <button class="icon-mini ${fav ? 'loved' : ''}" data-act="fav" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${fav}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}">${icon('heart')}</button>
        ${thirdBtn}
        <button class="icon-mini" data-act="edit" aria-label="Edit details" title="Edit details">${icon('edit')}</button>
      </div>
    </div>`;
}
function bindRowEvents(container, ctx) {
  if (!container) return;
  container.querySelectorAll('.track').forEach(el => {
    const id = el.dataset.id;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'fav') toggleFav(id);
        else if (act === 'more') { const r = btn.getBoundingClientRect(); openCtxMenu(r.left - 190, r.bottom + 6, trackCtxItems(id, ctx)); }
        else if (act === 'edit') openEditTrackModal(id);
        else if (act === 'rmpl' && state.openPlaylist) removeFromPlaylist(state.openPlaylist, id);
        return;
      }
      playFromList(id, ctx);
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('[data-act]')) return;
      openEditTrackModal(id);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') playFromList(id, ctx);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY, trackCtxItems(id, ctx));
    });
  });
}

// ---------- render: views ----------
function filteredLibrary() {
  let list = [...state.library];
  if (state.filter === 'favorites') list = list.filter(t => state.favorites.has(t.id));
  if (state.filter === 'recent') list = list.slice(-30).reverse();
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter(t => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
  }
  return list;
}
function renderTracks() {
  const list = filteredLibrary();
  $('#empty').style.display = state.library.length ? 'none' : 'block';
  const label = state.filter === 'favorites' ? 'favorite' : 'song';
  $('#count-label').textContent = list.length ? `${list.length} ${label}${list.length > 1 ? 's' : ''}` : '';
  const totalSec = state.library.reduce((a, t) => a + (t.duration || 0), 0);
  $('#stats').textContent = state.library.length
    ? `${state.library.length} songs • ${fmtLong(totalSec)}`
    : 'No music yet';
  const box = $('#track-list');
  box.innerHTML = list.map((t, i) => trackRowHTML(t, i, { ctx: 'library' })).join('');
  bindRowEvents(box, 'library');
}

function renderFavorites() {
  const box = $('#fav-list');
  const favs = state.library.filter(t => state.favorites.has(t.id));
  const has = favs.length > 0;
  $('#btn-fav-play').style.display = has ? '' : 'none';
  $('#btn-fav-shuffle').style.display = has ? '' : 'none';
  if (!has) {
    box.innerHTML = `<div class="empty"><div class="empty-art" aria-hidden="true">${icon('heart', 'ic-xl')}</div><h2>No favorites yet</h2><p>Tap the heart on any song and it will live here, ready to play.</p></div>`;
    return;
  }
  box.innerHTML = favs.map((t, i) => trackRowHTML(t, i, { ctx: 'favorites' })).join('');
  bindRowEvents(box, 'favorites');
}

function renderPlaylists() {
  const list = $('#playlist-list');
  list.innerHTML = state.playlists.map(p => {
    const cov = playlistCover(p);
    return `
    <div class="pl-item ${p.id === state.openPlaylist ? 'active' : ''}" role="listitem" tabindex="0" data-id="${p.id}">
      <div class="pl-cover" aria-hidden="true">${cov ? `<img src="${cov}" alt="" loading="lazy"/>` : esc((p.name || 'P').charAt(0).toUpperCase())}</div>
      <div class="pl-info"><div class="pl-name">${esc(p.name)}</div><small>${p.trackIds.length} song${p.trackIds.length === 1 ? '' : 's'}</small></div>
      <button class="pl-play" data-act="play" aria-label="Play ${esc(p.name)}">${icon('play', 'ic')}</button>
    </div>`;
  }).join('') || `<div class="pl-empty">No playlists yet.<br>Click <strong>+ New</strong> to create one, then right-click any song → Add to playlist.</div>`;

  list.querySelectorAll('.pl-item').forEach(el => {
    const id = el.dataset.id;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="play"]')) { playPlaylist(id, false); return; }
      openPlaylist(id);
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openPlaylist(id); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = playlistById(id);
      openCtxMenu(e.clientX, e.clientY, [
        { icon: 'music', label: 'Open', action: () => openPlaylist(id) },
        { icon: 'play', label: 'Play', action: () => playPlaylist(id, false) },
        { icon: 'shuffle', label: 'Shuffle play', action: () => playPlaylist(id, true) },
        { sep: true },
        { icon: 'edit', label: 'Rename', action: () => openRenameModal(id) },
        { icon: 'trash', label: 'Delete playlist', danger: true, action: () => deletePlaylist(id) },
      ]);
    });
  });

  const grid = $('#playlists-grid');
  grid.innerHTML = state.playlists.map(p => {
    const tracks = playlistTracks(p);
    const cov = playlistCover(p);
    const secs = tracks.reduce((a, t) => a + (t.duration || 0), 0);
    return `
    <div class="pl-card" tabindex="0" role="button" aria-label="Open playlist ${esc(p.name)}, ${tracks.length} songs" data-id="${p.id}">
      <div class="pl-big" aria-hidden="true">${cov ? `<img src="${cov}" alt="" loading="lazy"/>` : icon('disc', 'ic-xl')}</div>
      <button class="pl-card-play" data-act="play" aria-label="Play ${esc(p.name)}">${icon('play', 'ic')}</button>
      <button class="pl-card-del" data-act="del" aria-label="Delete playlist ${esc(p.name)}" title="Delete playlist">${icon('trash', 'ic ic-sm')}</button>
      <h3>${esc(p.name)}</h3><p>${tracks.length} song${tracks.length === 1 ? '' : 's'}${secs ? ` • ${fmtLong(secs)}` : ''}</p>
    </div>`;
  }).join('') || `<div class="empty"><div class="empty-art" aria-hidden="true">${icon('disc', 'ic-xl')}</div><h2>No playlists</h2><p>Create one and fill it from any song's menu.</p></div>`;
  grid.querySelectorAll('.pl-card').forEach(el => {
    const id = el.dataset.id;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="play"]')) { playPlaylist(id, false); return; }
      if (e.target.closest('[data-act="del"]')) { e.stopPropagation(); deletePlaylist(id); return; }
      openPlaylist(id);
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openPlaylist(id); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY, [
        { icon: 'music', label: 'Open', action: () => openPlaylist(id) },
        { icon: 'play', label: 'Play', action: () => playPlaylist(id, false) },
        { icon: 'shuffle', label: 'Shuffle play', action: () => playPlaylist(id, true) },
        { sep: true },
        { icon: 'edit', label: 'Rename', action: () => openRenameModal(id) },
        { icon: 'trash', label: 'Delete playlist', danger: true, action: () => deletePlaylist(id) },
      ]);
    });
  });
  updateNavCounts();
}

function renderPlaylistDetail() {
  const p = playlistById(state.openPlaylist);
  if (!p) return;
  const tracks = playlistTracks(p);
  const cov = playlistCover(p);
  const secs = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  $('#pl-hero-cover').innerHTML = cov
    ? `<img src="${cov}" alt="" />`
    : esc((p.name || 'P').charAt(0).toUpperCase());
  $('#pl-detail-name').textContent = p.name;
  $('#pl-detail-meta').textContent = `${tracks.length} song${tracks.length === 1 ? '' : 's'}${secs ? ` • ${fmtLong(secs)}` : ''}`;
  const box = $('#playlist-detail-list');
  box.innerHTML = tracks.length
    ? tracks.map((t, i) => trackRowHTML(t, i, { ctx: 'playlist' })).join('')
    : `<div class="empty"><div class="empty-art" aria-hidden="true">${icon('music', 'ic-xl')}</div><h2>Empty playlist</h2><p>Right-click any song → “Add to playlist” → “${esc(p.name)}”.</p></div>`;
  bindRowEvents(box, 'playlist');
}

// ---------- playback queue (internal only — no Queue UI) ----------
// state.queue is the invisible play order used by next/prev/shuffle/repeat.
// It is rebuilt automatically whenever you press Play; there is nothing to manage.

function updateNavCounts() {
  const f = $('#nav-fav-count');
  if (f) { f.hidden = !state.favorites.size; if (state.favorites.size) f.textContent = state.favorites.size; }
  const pl = $('#nav-pl-count');
  if (pl) { pl.hidden = !state.playlists.length; if (state.playlists.length) pl.textContent = state.playlists.length; }
}

function renderAll() {
  renderTracks(); renderFavorites(); renderPlaylists(); renderPlaylistDetail(); updatePlayerUI();
}

// ---------- playlist ops ----------
function openPlaylist(id) {
  if (state.view !== 'playlist') state.lastView = state.view;
  state.openPlaylist = id;
  setView('playlist');
  renderPlaylists(); renderPlaylistDetail();
}
function playPlaylist(id, shuffle) {
  const tracks = playlistTracks(playlistById(id));
  if (!tracks.length) { toast('This playlist is empty — add some songs first'); return; }
  state.shuffle = !!shuffle;
  setQueueFromLibrary(tracks.map(t => t.id));
  playTrack(shuffle ? tracks[Math.floor(Math.random() * tracks.length)].id : tracks[0].id);
  updatePlayerUI();
}
function toggleInPlaylist(plId, trackId) {
  const p = playlistById(plId); if (!p) return;
  const i = p.trackIds.indexOf(trackId);
  if (i >= 0) { p.trackIds.splice(i, 1); toast(`Removed from “${p.name}”`); }
  else { p.trackIds.push(trackId); toast(`Added to “${p.name}”`); }
  save(); renderAll();
}
async function deletePlaylist(id) {
  const p = playlistById(id); if (!p) return;
  const ok = await showModal({
    title: `Delete “${p.name}”?`,
    message: `This removes the playlist (${p.trackIds.length} songs). Your music files stay in the library.`,
    okText: 'Delete', danger: true, showInput: false
  });
  if (!ok) return;
  state.playlists = state.playlists.filter(x => x.id !== id);
  if (state.openPlaylist === id) { state.openPlaylist = null; setView(state.lastView || 'home'); }
  save(); renderAll();
  toast('Playlist deleted');
}
function removeFromPlaylist(plId, trackId) {
  const p = playlistById(plId); if (!p) return;
  p.trackIds = p.trackIds.filter(x => x !== trackId);
  save(); renderAll();
  toast('Removed from playlist');
}
function removeFromLibrary(id) {
  const t = trackById(id);
  showModal({
    title: `Remove “${t?.title || 'song'}”?`,
    message: 'Removes it from your library and playlists. The file on disk is kept.',
    okText: 'Remove', danger: true, showInput: false
  }).then(ok => {
    if (!ok) return;
    if (state.currentId === id) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.currentId = null; state.isPlaying = false; }
    state.library = state.library.filter(x => x.id !== id);
    state.queue = state.queue.filter(x => x !== id);
    state.playlists.forEach(p => p.trackIds = p.trackIds.filter(x => x !== id));
    state.favorites.delete(id);
    coverCache.delete(id);
    save(); persistCovers(); renderAll();
    toast('Removed from library');
  });
}

// ---------- modal (playlist + picker / confirm / edit-track) ----------
// Playlist dialog shows ONLY: playlist name + song picker (tick what to add).
// Song details (Title/Artist/Album/photo) live ONLY in the Edit-song dialog.
let modalResolve = null;
let modalMode = 'input'; // 'input' | 'confirm' | 'track' | 'playlist'
let editingTrackId = null;
let editingCoverData = null; // staged dataURL or '__REMOVE__'
let pickSelected = new Set();
let pickExclude = [];
function showModal({ title, message = '', showInput = true, inputValue = '', okText = 'Save', danger = false, trackFields = false, songPicker = false, hideNameInput = false }) {
  modalMode = trackFields ? 'track' : (songPicker ? 'playlist' : (showInput ? 'input' : 'confirm'));
  $('#modal-title').textContent = title;
  const msg = $('#modal-message');
  msg.hidden = !message; msg.textContent = message;
  const inp = $('#playlist-name');
  const showName = (((showInput && !trackFields) || songPicker) && !hideNameInput);
  inp.style.display = showName ? '' : 'none';
  inp.value = inputValue;
  inp.placeholder = 'Playlist name...';
  const tf = $('#modal-track-fields');
  if (tf) tf.hidden = !trackFields;
  const sp = $('#modal-song-picker');
  if (sp) sp.hidden = !songPicker;
  const saveBtn = $('#modal-save');
  saveBtn.textContent = okText;
  saveBtn.className = danger ? 'btn danger' : 'btn primary';
  $('#modal').classList.remove('hidden');
  setTimeout(() => {
    if (trackFields) $('#track-title')?.focus();
    else if (songPicker) (hideNameInput ? $('#song-pick-search') : inp)?.focus();
    else (showInput ? inp : saveBtn).focus();
  }, 60);
  return new Promise(res => { modalResolve = res; });
}
function closeModal(val) {
  $('#modal').classList.add('hidden');
  const pn = $('#playlist-name');
  if (pn) pn.value = '';
  const ps = $('#song-pick-search');
  if (ps) ps.value = '';
  editingTrackId = null;
  editingCoverData = null;
  pickSelected = new Set();
  pickExclude = [];
  if (modalResolve) { modalResolve(val); modalResolve = null; }
}
function collectModalResult() {
  if (modalMode === 'confirm') return true;
  if (modalMode === 'track') {
    return {
      title: $('#track-title').value.trim(),
      artist: $('#track-artist').value.trim(),
      album: $('#track-album').value.trim(),
      coverAction: editingCoverData // null = keep, '__REMOVE__' = remove, dataURL = set
    };
  }
  if (modalMode === 'playlist') {
    return { name: $('#playlist-name').value.trim(), trackIds: getSelectedPickIds() };
  }
  return $('#playlist-name').value.trim();
}
// ----- song picker (checkbox list inside playlist dialog) -----
function renderSongPickList(excludeIds = []) {
  const box = $('#song-pick-list');
  if (!box) return;
  const q = ($('#song-pick-search')?.value || '').trim().toLowerCase();
  const excluded = new Set(excludeIds);
  const songs = state.library.filter(t => {
    if (excluded.has(t.id)) return false;
    if (q && `${t.title} ${t.artist} ${t.album}`.toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  const cnt = $('#song-pick-count');
  if (cnt) cnt.textContent = songs.length
    ? `${pickSelected.size} selected • ${songs.length} shown`
    : (state.library.length ? 'No songs match — clear the search' : 'No songs in library yet — add music first');
  if (!songs.length) {
    box.innerHTML = `<div class="pick-empty">No songs to show.</div>`;
    return;
  }
  box.innerHTML = songs.map(t => {
    const on = pickSelected.has(t.id);
    const src = coverSrc(t);
    const art = src ? `<span class="pick-cover"><img src="${src}" alt="" loading="lazy"/></span>`
      : `<span class="pick-cover pick-letter">${esc((t.title || 'M').charAt(0).toUpperCase())}</span>`;
    return `<button class="pick-row ${on ? 'on' : ''}" role="option" aria-selected="${on}" data-id="${t.id}">
      <span class="pick-check" aria-hidden="true">${icon('check', 'ic ic-sm')}</span>
      ${art}
      <span class="pick-meta"><span class="pick-title">${esc(t.title)}</span><span class="pick-artist">${esc(t.artist)}</span></span>
    </button>`;
  }).join('');
  box.querySelectorAll('.pick-row').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id;
    if (pickSelected.has(id)) pickSelected.delete(id); else pickSelected.add(id);
    b.classList.toggle('on', pickSelected.has(id));
    b.setAttribute('aria-selected', pickSelected.has(id));
    const c = $('#song-pick-count');
    if (c) c.textContent = `${pickSelected.size} selected`;
  }));
}
function getSelectedPickIds() { return [...pickSelected]; }
function openPlaylistModal(pendingTrackId = null) {
  // New playlist = name + tick the songs. No Title/Artist/Album here.
  pickSelected = new Set();
  pickExclude = [];
  if (pendingTrackId) pickSelected.add(pendingTrackId);
  const s = $('#song-pick-search');
  if (s) s.value = '';
  renderSongPickList();
  showModal({ title: 'New playlist', okText: 'Create playlist', songPicker: true }).then(res => {
    if (!res) return;
    const pl = { id: `pl-${Date.now()}`, name: res.name || 'My Playlist', trackIds: res.trackIds || [], created: Date.now() };
    state.playlists.push(pl);
    save(); renderAll(); openPlaylist(pl.id);
    toast(pl.trackIds.length ? `Playlist “${pl.name}” created with ${pl.trackIds.length} song${pl.trackIds.length === 1 ? '' : 's'}` : `Playlist “${pl.name}” created`);
  });
}
function openAddSongsModal(plId) {
  const p = playlistById(plId); if (!p) return;
  pickSelected = new Set();
  pickExclude = [...p.trackIds];
  const s = $('#song-pick-search');
  if (s) s.value = '';
  renderSongPickList(p.trackIds);
  showModal({ title: `Add songs to “${p.name}”`, okText: 'Add selected', songPicker: true, hideNameInput: true }).then(res => {
    if (!res) return;
    const fresh = (res.trackIds || []).filter(id => !p.trackIds.includes(id));
    if (!fresh.length) { toast('No new songs selected'); return; }
    p.trackIds.push(...fresh);
    save(); renderAll();
    toast(`Added ${fresh.length} song${fresh.length === 1 ? '' : 's'} to “${p.name}”`);
  });
}
function openRenameModal(id) {
  const p = playlistById(id); if (!p) return;
  showModal({ title: 'Rename playlist', inputValue: p.name, okText: 'Rename' }).then(name => {
    if (name === null) return;
    p.name = (name || '').trim() || p.name;
    save(); renderAll();
    toast('Playlist renamed');
  });
}
function refreshEditCoverPreview() {
  const box = $('#edit-cover-preview');
  if (!box) return;
  const t = trackById(editingTrackId);
  let src = null;
  if (editingCoverData && editingCoverData !== '__REMOVE__') src = editingCoverData;
  else if (editingCoverData !== '__REMOVE__') src = coverSrc(t);
  if (src) {
    box.innerHTML = `<img src="${src}" alt="" />`;
    box.classList.add('has-photo');
  } else {
    box.textContent = ((t?.title || 'M').charAt(0) || 'M').toUpperCase();
    box.classList.remove('has-photo');
  }
}
function openEditTrackModal(id) {
  const t = trackById(id); if (!t) return;
  editingTrackId = id;
  editingCoverData = null;
  $('#track-title').value = t.title || '';
  $('#track-artist').value = t.artist || '';
  $('#track-album').value = t.album || '';
  refreshEditCoverPreview();
  showModal({ title: 'Edit song details', message: '', showInput: false, okText: 'Save changes', trackFields: true }).then(res => {
    if (!res) { editingTrackId = null; editingCoverData = null; return; }
    const track = trackById(id); if (!track) return;
    if (res.title) track.title = res.title;
    if (res.artist) track.artist = res.artist;
    if (res.album) track.album = res.album;
    if (res.coverAction === '__REMOVE__') { track.cover = null; coverCache.delete(id); }
    else if (typeof res.coverAction === 'string' && res.coverAction.startsWith('data:')) {
      track.cover = res.coverAction;
      coverCache.set(id, res.coverAction);
    }
    save(); persistCovers(); renderAll();
    toast('Song details updated');
    editingTrackId = null; editingCoverData = null;
  });
}

// ---------- playback (play order is automatic — no Queue screen) ----------
function setQueueFromLibrary(ids) { state.queue = [...ids]; save(); updateNavCounts(); }
function queueForCtx(id, ctx) {
  if (ctx === 'playlist' && state.openPlaylist) return playlistTracks(playlistById(state.openPlaylist)).map(t => t.id);
  if (ctx === 'favorites') {
    const favs = state.library.filter(t => state.favorites.has(t.id)).map(t => t.id);
    if (favs.length) return favs;
  }
  const list = filteredLibrary().map(t => t.id);
  return list.length ? list : state.library.map(t => t.id);
}
function playFromList(id, ctx = 'library') {
  setQueueFromLibrary(queueForCtx(id, ctx));
  playTrack(id);
}
function playTrack(id) {
  const t = trackById(id);
  if (!t) return;
  state.currentId = id;
  ensureAudioGraph();
  audio.src = t.fileUrl || t.path;
  const vol = $('#volume');
  audio.volume = vol ? (vol.value / 100) : 0.85;
  audio.play().catch(() => toast('Could not play file — it may have moved. Re-add it.'));
}
function togglePlay() {
  if (!state.currentId) {
    const first = filteredLibrary()[0] || state.library[0];
    if (!first) { toast('Add some music first'); return; }
    setQueueFromLibrary(state.library.map(t => t.id));
    playTrack(first.id); return;
  }
  ensureAudioGraph();
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
function next(auto = false) {
  if (!state.queue.length) return;
  const i = state.queue.indexOf(state.currentId);
  if (state.repeat === 'one' && auto) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  if (state.shuffle) {
    let n; do { n = Math.floor(Math.random() * state.queue.length); } while (state.queue.length > 1 && state.queue[n] === state.currentId);
    playTrack(state.queue[n]); return;
  }
  let n = i + 1;
  if (n >= state.queue.length) {
    if (state.repeat === 'all' || !auto) n = 0;
    else { state.isPlaying = false; updatePlayerUI(); return; }
  }
  playTrack(state.queue[n]);
}
function prev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (!state.queue.length) return;
  const i = state.queue.indexOf(state.currentId);
  let n = i - 1; if (n < 0) n = state.queue.length - 1;
  playTrack(state.queue[n]);
}

audio.addEventListener('play', () => { state.isPlaying = true; updatePlayerUI(); });
audio.addEventListener('pause', () => { state.isPlaying = false; updatePlayerUI(); });
audio.addEventListener('ended', () => next(true));
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  $('#progress-fill').style.width = pct + '%';
  $('#progress-knob').style.left = pct + '%';
  $('#progress').setAttribute('aria-valuenow', Math.round(pct));
  $('#t-cur').textContent = fmt(audio.currentTime);
  $('#t-end').textContent = fmt(audio.duration);
  const t = trackById(state.currentId);
  if (t && !t.duration && audio.duration) { t.duration = Math.round(audio.duration); save(); }
});
audio.addEventListener('loadedmetadata', () => {
  $('#t-end').textContent = fmt(audio.duration);
  const t = trackById(state.currentId);
  if (t && audio.duration && !t.duration) { t.duration = Math.round(audio.duration); save(); renderTracks(); }
});

function updatePlayerUI() {
  const t = trackById(state.currentId);
  $('#play-use').setAttribute('href', state.isPlaying ? '#i-pause' : '#i-play');
  $('#btn-play').setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
  $('#vinyl').classList.toggle('paused', !state.isPlaying);
  $('#p-cover').classList.toggle('playing-anim', !!state.isPlaying);
  if (t) {
    $('#p-title').textContent = t.title;
    $('#p-artist').textContent = `${t.artist} • ${t.album}`;
    $('#hero-title').textContent = t.title;
    $('#hero-artist').textContent = `${t.artist} — ${t.album}`;
    $('#pill-text').textContent = `${t.title} — ${t.artist}`;
    const img = $('#p-cover-img');
    const vimg = $('#vinyl-cover');
    const cov = coverSrc(t);
    if (cov) {
      img.src = cov;
      $('#p-cover').classList.add('has-img');
      vimg.src = cov;
      vimg.style.display = '';
    }
    else { $('#p-cover').classList.remove('has-img'); img.removeAttribute('src'); vimg.removeAttribute('src'); vimg.style.display = 'none'; }
    const blurOn = $('#toggle-blur')?.checked;
    if (blurOn && cov) {
      const bb = $('#bg-blur');
      try { bb.style.backgroundImage = `url("${cov.slice(0, 200000)}")`; } catch { bb.style.backgroundImage = ''; }
      bb.classList.add('on');
    }
    else $('#bg-blur').classList.remove('on');
    const fav = state.favorites.has(t.id);
    const fb = $('#btn-fav');
    fb.classList.toggle('loved', fav);
    fb.setAttribute('aria-pressed', fav);
    fb.setAttribute('aria-label', fav ? 'Remove from favorites' : 'Add to favorites');
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album }); } catch {}
    }
  } else {
    $('#p-title').textContent = 'Not playing';
    $('#p-artist').textContent = '—';
    $('#pill-text').textContent = 'Ready to play';
  }
  const sh = $('#btn-shuffle');
  sh.classList.toggle('on', state.shuffle);
  sh.setAttribute('aria-pressed', state.shuffle);
  const rep = $('#btn-repeat');
  rep.classList.toggle('on', state.repeat !== 'off');
  rep.setAttribute('aria-pressed', state.repeat !== 'off');
  rep.setAttribute('aria-label', `Repeat mode: ${state.repeat}`);
  $('#repeat-use').setAttribute('href', state.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
  $$('#track-list .track, #fav-list .track, #playlist-detail-list .track').forEach(el => {
    el.classList.toggle('playing', el.dataset.id === state.currentId);
  });
}

// ---------- library ops ----------
async function addTracks(tracks) {
  if (!tracks?.length) return;
  const existing = new Set(state.library.map(t => t.path));
  const fresh = tracks.filter(t => !existing.has(t.path));
  const dupes = tracks.length - fresh.length;
  for (const t of fresh) {
    if (t.cover) coverCache.set(t.id, t.cover);
  }
  state.library.push(...fresh);
  if (!state.queue.length) state.queue = state.library.map(t => t.id);
  save(); renderAll();
  shrinkBigCovers(fresh.map(t => t.id)); // downscale huge art so photos always show + persist
  toast(fresh.length
    ? `Added ${fresh.length} song${fresh.length === 1 ? '' : 's'}${dupes ? ` (${dupes} already in library)` : ''}`
    : 'Those songs are already in your library');
  if (!state.currentId && fresh[0]) playTrack(fresh[0].id);
}
// Big embedded photos (500KB+) break saving and slow the UI.
// Shrink them to max 512px JPEG so every song photo shows and survives restarts.
function shrinkBigCovers(ids) {
  const jobs = (ids || state.library.map(t => t.id))
    .map(id => trackById(id))
    .filter(t => t && typeof t.cover === 'string' && t.cover.length > 200000);
  if (!jobs.length) { persistCovers(); return; }
  let done = 0;
  const finish = () => { if (++done >= jobs.length) { save(); persistCovers(); renderAll(); } };
  for (const t of jobs) {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const max = 512;
          const scale = Math.min(1, max / Math.max(img.width || max, img.height || max));
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round((img.width || max) * scale));
          cv.height = Math.max(1, Math.round((img.height || max) * scale));
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          t.cover = cv.toDataURL('image/jpeg', 0.82);
          coverCache.set(t.id, t.cover);
        } catch {}
        finish();
      };
      img.onerror = () => finish();
      img.src = t.cover;
    } catch { finish(); }
  }
}

function toggleFav(id) {
  const on = !state.favorites.has(id);
  if (on) state.favorites.add(id); else state.favorites.delete(id);
  save(); renderAll();
  toast(on ? 'Added to Favorites' : 'Removed from Favorites');
}

// ---------- view ----------
function setView(v) {
  if (!v) v = 'home';
  state.view = v;
  $$('.nav-item').forEach(b => {
    const on = b.dataset.view === v || (v === 'playlist' && b.dataset.view === 'playlists');
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $$('.view').forEach(x => x.classList.remove('active'));
  const target = $(`#view-${v}`);
  if (target) target.classList.add('active');
  else $('#view-home')?.classList.add('active');
}

// ---------- events ----------
function bind() {
  $('#btn-min')?.addEventListener('click', () => api?.minimize());
  $('#btn-max')?.addEventListener('click', () => api?.maximize());
  $('#btn-close')?.addEventListener('click', () => api?.close());
  $('#github-link')?.addEventListener('click', () => {
    const url = 'https://github.com/imrealMJR';
    if (api?.openExternal) api.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  });

  $$('.nav-item').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.view === 'playlists' && state.openPlaylist && state.view !== 'playlist') { setView('playlist'); return; }
    setView(b.dataset.view);
  }));
  $$('.chip').forEach(c => c.addEventListener('click', () => {
    $$('.chip').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
    c.classList.add('active'); c.setAttribute('aria-selected', 'true');
    state.filter = c.dataset.filter; renderTracks();
  }));

  const search = $('#search'), clearBtn = $('#search-clear');
  search?.addEventListener('input', () => {
    state.search = search.value.trim();
    if (clearBtn) clearBtn.hidden = !search.value;
    renderTracks();
  });
  clearBtn?.addEventListener('click', () => { search.value = ''; state.search = ''; clearBtn.hidden = true; renderTracks(); search.focus(); });

  const pickFiles = async () => {
    if (!api) { toast('File picker needs the desktop app'); return; }
    try { addTracks(await api.openFiles()); } catch { toast('Could not open files'); }
  };
  const pickFolder = async () => {
    if (!api) { toast('Folder picker needs the desktop app'); return; }
    toast('Scanning folder…');
    try { addTracks(await api.openFolder()); } catch { toast('Could not open folder'); }
  };
  ['#btn-add-files', '#btn-hero-add', '#btn-empty-files'].forEach(s => $(s)?.addEventListener('click', pickFiles));
  ['#btn-add-folder', '#btn-empty-folder'].forEach(s => $(s)?.addEventListener('click', pickFolder));

  $('#btn-hero-play')?.addEventListener('click', togglePlay);
  $('#btn-hero-shuffle')?.addEventListener('click', () => {
    if (!state.library.length) { toast('Add some music first'); return; }
    state.shuffle = true;
    setQueueFromLibrary(state.library.map(t => t.id));
    playTrack(state.library[Math.floor(Math.random() * state.library.length)].id);
    updatePlayerUI();
  });

  $('#btn-play')?.addEventListener('click', togglePlay);
  $('#btn-next')?.addEventListener('click', () => next(false));
  $('#btn-prev')?.addEventListener('click', prev);
  $('#btn-shuffle')?.addEventListener('click', () => { state.shuffle = !state.shuffle; save(); updatePlayerUI(); toast(state.shuffle ? 'Shuffle on' : 'Shuffle off'); });
  $('#btn-repeat')?.addEventListener('click', () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    save(); updatePlayerUI();
    toast(`Repeat: ${state.repeat}`);
  });
  $('#btn-fav')?.addEventListener('click', () => { if (state.currentId) toggleFav(state.currentId); else toast('Nothing playing'); });

  // favorites head actions
  $('#btn-fav-play')?.addEventListener('click', () => {
    const favs = state.library.filter(t => state.favorites.has(t.id));
    if (!favs.length) { toast('No favorites yet'); return; }
    state.shuffle = false;
    setQueueFromLibrary(favs.map(t => t.id));
    playTrack(favs[0].id); updatePlayerUI();
  });
  $('#btn-fav-shuffle')?.addEventListener('click', () => {
    const favs = state.library.filter(t => state.favorites.has(t.id));
    if (!favs.length) { toast('No favorites yet'); return; }
    state.shuffle = true;
    setQueueFromLibrary(favs.map(t => t.id));
    playTrack(favs[Math.floor(Math.random() * favs.length)].id); updatePlayerUI();
  });

  $('#volume')?.addEventListener('input', (e) => { audio.volume = e.target.value / 100; save(); });
  try { audio.volume = ($('#volume')?.value || 85) / 100; } catch {}

  const prog = $('#progress');
  const seek = (clientX) => {
    const r = prog.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    if (audio.duration) audio.currentTime = p * audio.duration;
  };
  let dragging = false;
  prog?.addEventListener('pointerdown', (e) => { dragging = true; try { prog.setPointerCapture(e.pointerId); } catch {} seek(e.clientX); });
  prog?.addEventListener('pointermove', (e) => { if (dragging) seek(e.clientX); });
  prog?.addEventListener('pointerup', () => dragging = false);
  prog?.addEventListener('keydown', (e) => {
    if (!audio.duration) return;
    if (e.key === 'ArrowRight') { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - 5); e.preventDefault(); }
  });

  $('#btn-clear')?.addEventListener('click', async () => {
    if (!state.library.length) return;
    const ok = await showModal({ title: 'Clear entire library?', message: `${state.library.length} songs and ${state.playlists.length} playlists will be removed. Files on disk are kept.`, okText: 'Clear all', danger: true, showInput: false });
    if (!ok) return;
    state.library = []; state.queue = []; state.playlists = []; state.favorites = new Set();
    state.currentId = null; state.openPlaylist = null;
    coverCache.clear();
    try { localStorage.removeItem('mjr.covers'); } catch {}
    audio.pause(); audio.removeAttribute('src'); audio.load();
    save(); renderAll();
    toast('Library cleared');
  });
  // playlists — name + song picker, delete, rename
  $('#btn-new-playlist')?.addEventListener('click', () => openPlaylistModal());
  $('#btn-grid-new')?.addEventListener('click', () => openPlaylistModal());
  $('#pl-back')?.addEventListener('click', () => setView(state.lastView && state.lastView !== 'playlist' ? state.lastView : 'playlists'));
  $('#pl-detail-play')?.addEventListener('click', () => state.openPlaylist && playPlaylist(state.openPlaylist, false));
  $('#pl-detail-shuffle')?.addEventListener('click', () => state.openPlaylist && playPlaylist(state.openPlaylist, true));
  $('#pl-detail-add')?.addEventListener('click', () => state.openPlaylist && openAddSongsModal(state.openPlaylist));
  $('#pl-detail-rename')?.addEventListener('click', () => state.openPlaylist && openRenameModal(state.openPlaylist));
  $('#pl-detail-delete')?.addEventListener('click', () => state.openPlaylist && deletePlaylist(state.openPlaylist));

  // modal
  $('#modal-cancel')?.addEventListener('click', () => closeModal(null));
  $('#modal')?.addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(null); });
  $('#modal-save')?.addEventListener('click', () => closeModal(collectModalResult()));
  $('#playlist-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') closeModal(collectModalResult());
  });
  $('#song-pick-search')?.addEventListener('input', () => renderSongPickList(pickExclude));
  for (const sel of ['#track-title', '#track-artist', '#track-album']) {
    $(sel)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') closeModal(collectModalResult());
    });
  }
  // cover picker inside edit modal
  $('#btn-cover-change')?.addEventListener('click', () => $('#cover-file')?.click());
  $('#btn-cover-remove')?.addEventListener('click', () => { editingCoverData = '__REMOVE__'; refreshEditCoverPreview(); });
  $('#cover-file')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Pick an image file'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          // downscale to max 512px so localStorage never blows up + UI stays fast
          const max = 512;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          editingCoverData = cv.toDataURL('image/jpeg', 0.82);
        } catch { editingCoverData = String(reader.result); }
        refreshEditCoverPreview();
      };
      img.onerror = () => { editingCoverData = String(reader.result); refreshEditCoverPreview(); };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(f);
    e.target.value = '';
  });

  // menus: click-away + escape
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('[data-act="more"]')) closeMenus();
  });
  window.addEventListener('blur', closeMenus);

  // drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop-overlay').classList.add('show'); });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.remove('show'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); dragDepth = 0; $('#drop-overlay').classList.remove('show');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    const paths = files.map(f => f.path).filter(Boolean);
    if (api && paths.length) {
      toast('Adding music…');
      try { addTracks(await api.parsePaths(paths)); }
      catch { toast('Could not add files'); }
    } else toast('Run the desktop app to add dropped files');
  });

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#pl-popup').hidden || !$('#ctx-menu').hidden) closeMenus();
      else if (!$('#modal').classList.contains('hidden')) closeModal(null);
      return;
    }
    if (e.target.matches('input, textarea')) return;
    if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); togglePlay(); }
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', togglePlay);
      navigator.mediaSession.setActionHandler('pause', togglePlay);
      navigator.mediaSession.setActionHandler('previoustrack', prev);
      navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
    } catch {}
  }
}

// Re-read embedded photos for library songs that have none.
// (Heals songs whose huge photo was lost before downscaling existed.
// Songs with genuinely no embedded photo keep their letter art —
// set one via pencil icon > Edit details > Change photo.)
async function refreshMissingCovers() {
  try {
    if (!api?.coverForPath) return;
    const missing = state.library.filter(t => !coverSrc(t) && t.path);
    if (!missing.length) return;
    let updated = 0;
    for (const t of missing.slice(0, 200)) {
      try {
        const c = await api.coverForPath(t.path);
        if (c && typeof c === 'string') { t.cover = c; coverCache.set(t.id, c); updated++; }
      } catch {}
    }
    if (updated) {
      shrinkBigCovers();
      save(); persistCovers(); renderAll();
      toast(`Found photos for ${updated} song${updated === 1 ? '' : 's'}`);
    }
  } catch {}
}

// ---------- boot ----------
load();
if (!state.queue.length && state.library.length) state.queue = state.library.map(t => t.id);
bind();
renderAll();
sizeCanvas();
drawVisual();
setTimeout(sizeCanvas, 300);
setTimeout(refreshMissingCovers, 800);
