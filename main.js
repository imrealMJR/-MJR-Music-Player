const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let mm = null;
try { mm = require('music-metadata'); } catch (e) { console.warn('music-metadata not available', e); }

let win = null;
const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'opus', 'wma'];

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#070b18',
    title: 'MJR Music Player',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Acrylic on Windows 11 (Electron 30+) — safe fallback
  try {
    if (process.platform === 'win32') win.setBackgroundMaterial('acrylic');
  } catch {}

  win.loadFile(path.join(__dirname, 'index.html'));
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.mjr.musicplayer');
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- window controls ----
ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.on('win:close', () => win?.close());

// ---- external links (GitHub button; allow-listed to https) ----
ipcMain.on('shell:openExternal', (_e, url) => {
  try {
    if (typeof url === 'string' && /^https:\/\/github\.com\/imrealMJR(\/.*)?$/.test(url)) shell.openExternal(url);
  } catch {}
});

// ---- metadata parsing ----
// Embedded photos are often 500KB–2MB: they slow the UI and break saving.
// Shrink every photo to a small JPEG (max 512px) at parse time so song
// pictures always show and survive restarts.
function coverFromPicture(pic) {
  if (!pic || !pic.data) return null;
  try {
    const buf = Buffer.from(pic.data);
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) throw new Error('empty image');
    const size = img.getSize();
    const steps = [
      { max: 512, q: 80 },
      { max: 320, q: 75 },
      { max: 256, q: 70 }
    ];
    for (const s of steps) {
      const scale = Math.min(1, s.max / Math.max(size.width || s.max, size.height || s.max));
      const w = Math.max(1, Math.round((size.width || s.max) * scale));
      const h = Math.max(1, Math.round((size.height || s.max) * scale));
      const work = (scale < 1) ? img.resize({ width: w, height: h, quality: 'good' }) : img;
      const jpg = work.toJPEG(s.q);
      if (jpg && jpg.length) {
        const url = `data:image/jpeg;base64,${jpg.toString('base64')}`;
        if (url.length <= 200000 || s === steps[steps.length - 1]) return url;
      }
    }
  } catch {}
  try {
    const mime = pic.format || 'image/jpeg';
    return `data:${mime};base64,${Buffer.from(pic.data).toString('base64')}`;
  } catch { return null; }
}
async function parseOne(filePath) {
  const stat = (() => { try { return fs.statSync(filePath); } catch { return null; } })();
  if (!stat || !stat.isFile()) return null;
  const fileName = path.basename(filePath);
  let title = fileName.replace(/\.[^.]+$/, '');
  let artist = 'Unknown Artist';
  let album = 'Unknown Album';
  let duration = 0;
  let cover = null;

  if (mm) {
    try {
      const meta = await mm.parseFile(filePath, { duration: true, skipCovers: false });
      const common = meta.common || {};
      const format = meta.format || {};
      if (common.title) title = common.title;
      if (common.artist) artist = common.artist;
      if (common.album) album = common.album;
      if (format.duration) duration = Math.round(format.duration);
      const pic = common.picture && common.picture[0];
      cover = coverFromPicture(pic);
    } catch (e) {
      // fallback to filename parsing: "Artist - Title"
      const m = title.match(/^(.+?)\s*-\s*(.+)$/);
      if (m) { artist = m[1].trim(); title = m[2].trim(); }
    }
  }
  let fileUrl = filePath;
  try { fileUrl = pathToFileURL(filePath).href; } catch {}

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    path: filePath,
    fileUrl,
    fileName,
    title,
    artist,
    album,
    duration,
    cover
  };
}

function walkDir(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(full, out);
    else if (e.isFile()) {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (AUDIO_EXTS.includes(ext)) out.push(full);
    }
  }
  return out;
}

ipcMain.handle('dialog:openFiles', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Add music to MJR Music Player',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXTS }]
  });
  if (res.canceled) return [];
  const tracks = [];
  for (const f of res.filePaths) {
    const t = await parseOne(f);
    if (t) tracks.push(t);
  }
  return tracks;
});

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Add music folder',
    properties: ['openDirectory']
  });
  if (res.canceled) return [];
  const files = walkDir(res.filePaths[0]).slice(0, 2000);
  const tracks = [];
  for (const f of files) {
    const t = await parseOne(f);
    if (t) tracks.push(t);
  }
  return tracks;
});

ipcMain.handle('files:parsePaths', async (_e, paths) => {
  const tracks = [];
  for (const p of (paths || []).slice(0, 2000)) {
    try {
      const s = fs.statSync(p);
      if (s.isDirectory()) {
        for (const f of walkDir(p).slice(0, 2000)) {
          const t = await parseOne(f);
          if (t) tracks.push(t);
        }
      } else {
        const ext = path.extname(p).slice(1).toLowerCase();
        if (!AUDIO_EXTS.includes(ext)) continue;
        const t = await parseOne(p);
        if (t) tracks.push(t);
      }
    } catch {}
  }
  return tracks;
});

// Re-read just the embedded photo for one file already in the library
// (used on boot to heal songs whose big photo was lost before downscaling).
ipcMain.handle('files:coverForPath', async (_e, filePath) => {
  try {
    if (!mm || !filePath) return null;
    if (!fs.existsSync(filePath)) return null;
    const meta = await mm.parseFile(filePath, { duration: false, skipCovers: false });
    return coverFromPicture(meta.common && meta.common.picture && meta.common.picture[0]);
  } catch { return null; }
});
