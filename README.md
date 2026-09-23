# FetchTube — YouTube Video & Music Downloader

A local Node.js web app that downloads YouTube videos and music with quality
choice, clip trimming, and automatic cleanup. Paste a link, pick **Video** or
**Music**, optionally narrow the time range to save just a clip, and the file
lands in `outputs/` plus straight to your device.

Ported from `test.py` (which shelled out to `yt-dlp` + `ffmpeg`) into a full
server + download page. All orchestration code is JavaScript; the `yt-dlp` and
`ffmpeg` binaries arrive automatically via npm — no Python, no `winget`, no
manual installs.

## Features

- **Link Bar** — paste a YouTube / Shorts / `youtu.be` / embed / music link and
  it loads by itself (paste detection + debounced typing). Strict validation:
  11-char video IDs only, non-YouTube links rejected, >100-char URLs rejected
  as mistyped, extra params (`list`, `si`, …) normalized away.
- **Mini player card** — click-to-play embed, title, channel + subscriber count,
  views / likes / comments / upload-date chips, full-length line, and a
  collapsible description.
- **Video tab** — qualities listed as `1080p`⁶⁰-style (fps superscript) with an
  `MP4` badge, 60fps variants sorted first. Every option is merged with best
  audio, so results are never muted.
- **Music tab** — fixed MP3 ladder: **320 / 256 / 192 / 128 kbps**, labeled
  `Best sound` → `Smaller file`. Best source in, MP3 out at your chosen rate.
- **Automatic trim** — `MM:SS` numeric-only boxes (letters can't even be typed),
  prefilled `00:00` → full length. Leave the full range for the whole video;
  narrow it and only those seconds download (section-only fetch, KBs not GBs).
  Live validation (End-after-Start, ≥1s, within length) with red + tooltip.
- **Live progress modal** — ordered stepper
  (`Getting ready → Downloading → Putting video + sound together / Making your MP3
  → Cutting your clip → Saving your file → Done`) with **real percentages**:
  downloads report native yt-dlp % and every merge/convert/trim reports true
  ffmpeg progress. `Cancel` kills the job and wipes temps instantly;
  `Save file` stays grayed until the file is ready (auto-save also fires).
- **Recent links** — `Recent ▾` dropdown beside Get Video: last 10 links with
  title + URL + age, each with its own `Get` button (localStorage, per browser).
- **Auto-delete (5 min)** — finished files delete 5 minutes after your last
  download; every retrieval restarts the timer. Schedule persists in
  `retention.json` so restarts remember; a 60s sweeper enforces it plus a
  catch-up sweep on boot. `temp/` intermediates are cleaned per job and any
  stale files are wiped on startup (reclaimed 5.5 GB in testing).
- **Busy lock** — while a download runs, link field, tabs, qualities, timer,
  and buttons lock so nothing can corrupt the job.
- **Plain-language UI** — no jargon (`Get Video`, `Ready`/`Offline`, friendly
  stage names), fixed-width layout (no resize jump on load), dark gradient
  FetchTube theme (Space Grotesk + Inter).

## How it works

```
Browser → POST /api/info {url}  → video meta + curated quality lists
Browser → POST /api/download {url, kind, optionId, start, end}
          → server auto-decides full vs clip from the range
          → yt-dlp fetches streams (measured %) → own ffmpeg
            merges/converts/trims (measured %) → outputs/
Browser → GET /api/progress/:id (stepper + %) · GET /api/file/:id (save)
          GET /api/outputs (file list + delete countdowns)
          DELETE /api/job/:id (cancel + instant cleanup)
```

Clip mode uses `--download-sections *start-end --force-keyframes-at-cuts`
(section-only fetch), with automatic fallback to full-download + exact local
trim if YouTube 403s a section fetch.

## Tools needed

| Tool | Purpose | Install |
|---|---|---|
| Node.js 20+ | runtime | https://nodejs.org |
| npm | dependency install | ships with Node |
| `express` | web server + API | `npm install` |
| `yt-dlp-exec` | bundled `yt-dlp` binary + metadata | `npm install` |
| `ffmpeg-static` | bundled `ffmpeg` binary (merge/trim/convert) | `npm install` |
| A browser + internet | UI + YouTube access | — |

No Python, no system `ffmpeg`/`yt-dlp`, no build step.

## Run

```powershell
cd Downloader
npm install
npm start
# open http://localhost:3000
```

1. Paste a YouTube link (it loads by itself) — or pick one from `Recent ▾`.
2. Optional: narrow Start/End to save just a clip.
3. Open the **Video** or **Music** tab, pick a quality.
4. Press **Download** — watch the modal, then **Save file**.
5. Files also sit in `outputs/` (auto-deleted 5 min after your last download;
  use Refresh to see the countdowns).

## Project layout

```
server.js            Express app + API routes
lib/validate.js      URL templates/length/ID checks, time parse, filename sanitize
lib/youtube.js       yt-dlp metadata → curated video/music options (+5-min cache)
lib/downloader.js    phased fetch + ffmpeg assemble, progress, cancel, retention hook
lib/retention.js     retention.json schedule + 60s sweeper + boot catch-up
public/              FetchTube UI (index.html, app.js, style.css)
outputs/             finished files (auto-cleaned)
temp/                intermediates (cleaned per job + wiped on boot)
plan.md              full implementation plan / changelog
test.py              original Python script this was ported from
```

## Notes & limits

- MP3 rates are transcode targets: YouTube sources top out ~160kbps, so 320k
  means a bigger file from the same source (like every YouTube-to-MP3 site).
- Videos over 2h are blocked to avoid huge files.
- Files created before auto-delete existed have no timer and are kept.
- Everything runs locally; links leave the machine only to YouTube.
