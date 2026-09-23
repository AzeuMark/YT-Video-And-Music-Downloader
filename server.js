const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const { isYouTubeUrl, urlProblem, normalizeYouTubeUrl, parseTime, formatTime, sanitizeFilename, safeOutputName } = require("./lib/validate");
const { fetchInfo, resolveOption } = require("./lib/youtube");
const downloader = require("./lib/downloader");
const retention = require("./lib/retention");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const OUTPUT_DIR = path.join(ROOT, "outputs");
const TEMP_DIR = path.join(ROOT, "temp");
downloader.configure({ outputsDir: OUTPUT_DIR, tempDir: TEMP_DIR });
retention.configure({ dataFile: path.join(ROOT, "retention.json"), outputsDir: OUTPUT_DIR });

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(ROOT, "public")));

app.get("/api/health", async (req, res) => {
  const tools = downloader.toolInfo();
  res.json({
    ok: true,
    engine: "yt-dlp (bundled via npm, JS-driven)",
    ffmpeg: tools.ffmpeg,
    outputsDir: "outputs/",
  });
});

function badUrlMessage(url) {
  const problem = urlProblem(url);
  if (problem === "too-long") {
    return "That URL is too long to be a YouTube link — check for typos or extra text.";
  }
  return "Please paste a valid YouTube watch, shorts, or youtu.be URL.";
}

app.post("/api/info", async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isYouTubeUrl(String(url))) {
    return res.status(400).json({ error: badUrlMessage(String(url || "")) });
  }
  const cleanUrl = normalizeYouTubeUrl(String(url));
  try {
    const info = await fetchInfo(cleanUrl);
    if (!info.videoOptions.length && !info.audioOptions.length) {
      return res.status(502).json({ error: "No downloadable formats found for this video." });
    }
    res.json({ url: cleanUrl, ...info });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Failed to fetch video info." });
  }
});

app.post("/api/download", async (req, res) => {
  const { url, kind, optionId, start, end } = req.body || {};
  if (!url || !isYouTubeUrl(String(url))) {
    return res.status(400).json({ error: badUrlMessage(String(url || "")) });
  }
  const cleanUrl = normalizeYouTubeUrl(String(url));
  if (kind !== "video" && kind !== "audio") {
    return res.status(400).json({ error: "Pick a video or music quality first." });
  }
  if (!optionId) {
    return res.status(400).json({ error: "No quality selected." });
  }
  // Automatic trim: empty fields default to the full range (0:00 → video length).
  // A range covering (almost) the whole video downloads in full; anything
  // narrower is fetched as a section-only clip. No mode flag needed.
  let startSec = parseTime(start);
  let endSec = parseTime(end);
  if (startSec === null) startSec = 0;
  if (endSec === null) endSec = 0; // resolved against duration below

  try {
    const { opt, data } = await resolveOption(cleanUrl, kind, optionId);
    const durationSec = Math.round(Number(data.duration || 0));
    if (endSec === 0) endSec = durationSec;

    if (!durationSec && endSec <= 0) {
      return res.status(400).json({ error: "Could not determine video length — enter an End time." });
    }
    if (!(startSec >= 0)) {
      return res.status(400).json({ error: "Start must be 0:00 or later (e.g. 4:30)." });
    }
    if (!(endSec > startSec)) {
      return res.status(400).json({ error: "End must be after Start." });
    }
    if (durationSec && endSec > durationSec + 1) {
      return res.status(400).json({ error: `End (${formatTime(endSec)}) is beyond video length (${formatTime(durationSec)}).` });
    }
    if (endSec - startSec < 1) {
      return res.status(400).json({ error: "Range must be at least 1 second long." });
    }
    if (durationSec && durationSec > 2 * 3600) {
      return res.status(400).json({ error: "Videos over 2h are blocked to avoid huge files." });
    }
    const cleanMode = startSec <= 0 && (!durationSec || endSec >= durationSec - 1) ? "full" : "clip";

    const title = sanitizeFilename(data.title || "video");
    const tag = String(opt.label).replace(/\s+/g, "");
    const clipTag = cleanMode === "clip"
      ? `_clip_${formatTime(startSec).replace(/:/g, "m")}-${formatTime(endSec).replace(/:/g, "m")}`
      : "";
    const ext = kind === "audio" ? "mp3" : "mp4";
    const fileName = `${title}_${tag}${clipTag}.${ext}`.slice(0, 120);

    const job = downloader.createJob({
      url: cleanUrl, kind, opt, mode: cleanMode,
      start: startSec, end: endSec, fileName, durationSec,
    });
    res.status(202).json({ jobId: job.id });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not start download." });
  }
});

app.get("/api/progress/:id", (req, res) => {
  const job = downloader.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown job." });
  res.json({
    id: job.id,
    stage: job.stage,
    stages: downloader.pipeline(job),
    stageIndex: downloader.stageIndex(job),
    percent: job.percent,
    message: job.message,
    mode: job.mode,
    fileName: job.fileName || null,
    downloadUrl: job.downloadUrl || null,
  });
});

app.get("/api/file/:id", (req, res) => {
  const job = downloader.getJob(req.params.id);
  if (!job || !job.fileName) return res.status(404).send("File not ready yet.");
  const full = path.join(OUTPUT_DIR, path.basename(job.fileName));
  if (!fs.existsSync(full)) return res.status(404).send("File missing from outputs/.");
  res.download(full, job.fileName, (err) => {
    // Timer restarts on every user download: 5 min after last retrieval.
    if (!err) retention.schedule(job.fileName, downloader.AUTO_DELETE_MS).catch(() => {});
  });
});

app.delete("/api/job/:id", async (req, res) => {
  try {
    const ok = await downloader.cancelJob(req.params.id);
    if (!ok) return res.status(404).json({ error: "Unknown job." });
    res.json({ cancelled: true });
  } catch (err) {
    res.status(500).json({ error: "Could not cancel job." });
  }
});

app.get("/outputs/:name", (req, res) => {
  const name = safeOutputName(req.params.name);
  if (!name) return res.status(400).send("Bad filename.");
  const full = path.join(OUTPUT_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).send("Not found.");
  res.download(full, name, (err) => {
    if (!err) retention.schedule(name, downloader.AUTO_DELETE_MS).catch(() => {});
  });
});

app.get("/api/outputs", async (req, res) => {
  try {
    const files = await downloader.listOutputs();
    for (const f of files) {
      f.deleteAt = await retention.getDeleteAt(f.name);
    }
    res.json({ files, autoDeleteMin: downloader.AUTO_DELETE_MS / 60000 });
  } catch (err) {
    res.status(500).json({ error: "Could not list outputs/." });
  }
});

async function main() {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  await fsp.mkdir(TEMP_DIR, { recursive: true });
  const keep = path.join(OUTPUT_DIR, ".gitkeep");
  if (!fs.existsSync(keep)) await fsp.writeFile(keep, "");
  // Temp files are pure intermediates — no job is running at boot, so any
  // leftovers (crashed/interrupted runs) are safe to wipe to reclaim space.
  try {
    const stale = await fsp.readdir(TEMP_DIR);
    let wiped = 0;
    for (const n of stale) {
      try { await fsp.unlink(path.join(TEMP_DIR, n)); wiped++; } catch { /* ignore */ }
    }
    if (wiped) console.log(`Temp: wiped ${wiped} stale file(s) from previous runs.`);
  } catch { /* ignore */ }
  // Catch up on deletions missed while the server was down, then sweep every 60s.
  const caughtUp = await retention.sweepNow().catch(() => []);
  if (caughtUp.length) console.log(`Retention: deleted ${caughtUp.length} expired file(s) from previous session.`);
  retention.startSweeper(60000);
  app.listen(PORT, () => {
    console.log(`Downloader running: http://localhost:${PORT}`);
    console.log(`Saving to: ${OUTPUT_DIR}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
