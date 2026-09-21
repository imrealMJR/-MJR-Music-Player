# MJR Music Player

A beautiful animated music player for Windows (Electron). Spotify-style UI with
playlist management, favorites, song photos, visualizer, and a GitHub link to
[@imrealMJR](https://github.com/imrealMJR).

## Run it (easy way)

No Node.js needed. Upload `MJR Music Player Setup 1.0.0.exe` (from `dist/`
after building, or from this repo's Releases page) to any PC, install it,
and open **MJR Music Player** from the Desktop shortcut.

## Run from source (developers)

Requirements: [Node.js](https://nodejs.org/) 18 or newer (includes npm).

```bash
npm install
npm start
```

## Build your own installer

```bash
npm run dist
```

This creates in `dist/`:

- `MJR Music Player Setup 1.0.0.exe` — installer (share this file)
- `MJR Music Player 1.0.0.exe` — portable, no install needed

## Add music

Open the app, click **Add Music** (or drag & drop MP3 / WAV / FLAC / OGG / M4A
files anywhere into the window).

## Project files

- `index.html` — app layout
- `renderer.js` — player logic (library, playlists, favorites, covers)
- `main.js` — Electron main process (file picking, metadata, covers)
- `preload.js` — safe bridge between the two
- `styles.css` — full theme (deep navy + blue/violet/cyan, matched to the icon)
- `assets/` — app icons
