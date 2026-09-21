# MJR Music Player

![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

A beautiful Spotify-style music player for Windows — playlists, favorites,
song photos, live visualizer, and shuffle/repeat. Built with Electron.

## Download

Get `MJR Music Player Setup 1.0.0.exe` from the
[**Releases**](https://github.com/imrealMJR/MJR-Music-Player/releases) page,
install it, and open **MJR Music Player** from your Desktop or Start Menu.
No tech skills needed.

## Features

- Play MP3 / WAV / FLAC / OGG / M4A, add files or whole folders (drag & drop works)
- Playlists with song picker, rename, delete, shuffle play
- Favorites with one-tap hearts
- Embedded song photos, auto-shrunk so they always show and persist
- Edit song details + custom photo per song
- Live visualizer, spinning vinyl, blur background
- Shuffle / repeat (all / one), seek bar, volume, media keys


## Run from source (developers)

Requirements: [Node.js](https://nodejs.org/) 18+ (includes npm).

```bash
npm install
npm start
Build your own installer:
npm run dist
Project files
- index.html — layout · renderer.js — player logic · main.js — file picking/metadata
- preload.js — safe bridge · styles.css — full theme · assets/ — icons
License
MIT — see LICENSE (LICENSE).

**Notes on the plan:**
- The 3 badge images need internet to render — they will once the file is on GitHub.
- Replace `MJR-Music-Player` in the Releases link if your repo ends up named differently.
- The Screenshots section is a placeholder on purpose: take 2 screenshots of the running app, drag them into GitHub's file editor, and it embeds them for you.
- Your current `README.md` in the project stays untouched until you say to update it — say the word and I'll sync this version into the project + Desktop zip.
