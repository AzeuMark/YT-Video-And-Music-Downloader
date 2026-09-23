const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const retention = require("./retention");

// Finished files auto-delete 5 minutes after completion / last user download.
const AUTO_DELETE_MS = 5 * 60 * 1000;

function findYtDlp() {
  const exe = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  try {
    const pkgDir = path.dirname(require.resolve("yt-dlp-exec/package.json"));
    const bundled = path.join(pkgDir, "bin", exe);
    if (fs.existsSync(bundled)) return bundled;
  } catch { /* ignore */ }
  return "yt-dlp"; // fall back to PATH
}

function findFfmpeg() {
  try {
    const bin = require("ffmpeg-static");
    if (bin && fs.existsSync(bin)) return bin;
  } catch { /* ignore */ }
  return "ffmpeg"; // fall back to PATH
}

const YTDLP_BIN = findYtDlp();
const FFMPEG_BIN = findFfmpeg();

const jobs = new Map();
let OUTPUT_DIR = path.join(__dirname, "..", "outputs");
let TEMP_DIR = path.join(__dirname, "..", "temp");

function configure(dirs) {
  if (dirs.outputsDir) OUTPUT_DIR = dirs.outputsDir;
  if (dirs.tempDir) TEMP_DIR = dirs.tempDir;
}

function toolInfo() {
  return {
    ytdlp: YTDLP_BIN,
    ffmpeg: FFMPEG_BIN,
  };
}

const STAGE_LABELS = {
  queued: "Getting ready",
  downloading: "Downloading",
  merging: "Putting video + sound together",
  converting: "Making your MP3",
  trimming: "Cutting your clip",
  finalizing: "Saving your file",
  done: "Done",
  error: "Something went wrong",
};

/** Ordered pipeline for a job — the frontend stepper renders exactly this. */
function pipeline(job) {
  const stages = ["queued", "downloading"];
  if (job.kind === "audio") stages.push("converting");
  else if (!job.opt || job.opt.needsMerge) stages.push("merging");
  if (job.mode === "clip") stages.push("trimming");
  stages.push("finalizing", "done");
  return stages.map((key) => ({ key, label: STAGE_LABELS[key] }));
}

function stageIndex(job) {
  if (job.stage === "error") return -1;
  const keys = pipeline(job).map((s) => s.key);
  const i = keys.indexOf(job.stage);
  return i === -1 ? 0 : i;
}

function newJobId() {
  return crypto.randomBytes(8).toString("hex");
}

function getJob(id) {
  return jobs.get(id) || null;
}

function cancelledError() {
  const e = new Error("Cancelled");
  e.cancelled = true;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function unlinkQuiet(p) {
  try { await fsp.unlink(p); return true; } catch { return false; }
}

/** Unlink with retries — a just-killed process can briefly hold its files. */
async function unlinkRetry(p, tries = 4, delayMs = 500) {
  for (let i = 0; i < tries; i++) {
    if (await unlinkQuiet(p)) return true;
    await sleep(delayMs);
  }
  return false;
}

function runCmd(bin, args, onLine, job) {
  return new Promise((resolve, reject) => {
    if (job && job.cancelled) return reject(cancelledError());
    const child = spawn(bin, args, { windowsHide: true });
    if (job) job.children.push(child);
    let stderr = "";
    let buf = "";
    const onData = (chunk) => {
      const s = chunk.toString();
      stderr += s;
      buf += s;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        if (onLine) onLine(line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      if (job) job.children = job.children.filter((c) => c !== child);
      reject(new Error(`Could not start ${path.basename(bin)}: ${err.message}`));
    });
    child.on("close", (code) => {
      if (job) job.children = job.children.filter((c) => c !== child);
      if (job && job.cancelled) return reject(cancelledError());
      if (code === 0) return resolve();
      const tail = stderr.trim().split("\n").slice(-4).join(" ").slice(0, 400);
      reject(new Error(`${path.basename(bin)} failed (exit ${code}): ${tail || "see server log"}`));
    });
  });
}

/**
 * yt-dlp single-stream fetch with measured progress over [base, base+span].
 * No merge/extract here — those run in our own ffmpeg step so their
 * progress is measurable too. `section` ("*s-e") fetches only a clip part.
 */
async function fetchStream(job, formatSel, outPath, base, span, section, exact) {
  const args = [
    "--no-playlist", "--no-warnings", "--newline", "--progress", "--no-part",
    "--socket-timeout", "30", "--retries", "5", "--fragment-retries", "5",
  ];
  if (section) {
    args.push("--download-sections", section);
    if (exact) args.push("--force-keyframes-at-cuts");
  }
  args.push("-f", formatSel, "-o", outPath, job.url);
  await runCmd(YTDLP_BIN, args, (line) => {
    const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (m) {
      const p = base + (Number(m[1]) / 100) * span;
      job.percent = Math.max(job.percent, Math.min(base + span, Math.round(p)));
      job.message = line.trim().slice(0, 160);
    } else if (/\[ffmpeg\]/i.test(line) && job.mode === "clip") {
      job.stage = "trimming";
      job.message = "Cutting your clip…";
    }
  }, job);
  if (!fs.existsSync(outPath)) throw new Error("Download finished but the part file is missing.");
}

/**
 * Our own ffmpeg step with real progress over [base, base+span],
 * parsed from `-progress pipe:1` (out_time_us vs totalSec).
 */
async function runFfmpeg(job, ffArgs, outPath, totalSec, base, span) {
  job.percent = Math.max(job.percent, base);
  const args = [...ffArgs, "-progress", "pipe:1", "-nostats", "-y", outPath];
  await runCmd(FFMPEG_BIN, args, (line) => {
    const m = line.match(/^out_time_us=(\d+)/);
    if (m) {
      const done = Number(m[1]) / 1e6;
      const p = base + Math.min(1, done / Math.max(totalSec, 0.1)) * span;
      job.percent = Math.max(job.percent, Math.min(base + span, Math.round(p)));
    } else if (line.trim() === "progress=end") {
      job.percent = Math.max(job.percent, base + span);
    }
  }, job);
  if (!fs.existsSync(outPath)) throw new Error("Converter finished but the output is missing.");
}

function mergeArgs(job, vPath, aPath, seekExact) {
  if (seekExact) {
    // Exact cut while merging (403 fallback): re-encode for frame accuracy.
    return ["-ss", String(job.start), "-i", vPath, "-ss", String(job.start), "-i", aPath,
      "-t", String(job.end - job.start), "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest"];
  }
  return ["-i", vPath, "-i", aPath, "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest"];
}

function audioArgs(job, aPath, seekExact) {
  const rate = (job.opt && job.opt.bitrate) || 192;
  if (seekExact) {
    return ["-ss", String(job.start), "-i", aPath, "-t", String(job.end - job.start),
      "-vn", "-c:a", "libmp3lame", "-b:a", `${rate}k`];
  }
  return ["-i", aPath, "-vn", "-c:a", "libmp3lame", "-b:a", `${rate}k`];
}

function cutArgs(job, inPath) {
  // Exact cut of a single progressive file (403 fallback).
  return ["-ss", String(job.start), "-i", inPath, "-t", String(job.end - job.start),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
}

async function runDownloadJob(job) {
  const tempV = path.join(TEMP_DIR, `${job.id}.v`);
  const tempA = path.join(TEMP_DIR, `${job.id}.a`);
  job.tempFiles = [tempV, tempA];
  const clipLen = Math.max(job.end - job.start, 1);
  const fullLen = job.durationSec || clipLen;
  const section = job.mode === "clip" ? `*${job.start}-${job.end}` : null;
  const checkpoint = () => { if (job.cancelled) throw cancelledError(); };
  try {
    await fsp.mkdir(TEMP_DIR, { recursive: true });
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });

    job.stage = "downloading";
    job.message = job.mode === "clip" ? "Downloading just your clip part…" : "Downloading…";

    if (job.kind === "audio") {
      if (job.mode === "clip") {
        try {
          await fetchStream(job, "bestaudio/best", tempA, 0, 55, section, false);
          await checkpoint();
          job.stage = "converting"; job.message = "Making your MP3…";
          await runFfmpeg(job, audioArgs(job, tempA, false), job.outputPath, clipLen, 55, 45);
        } catch (err) {
          if (err.cancelled || !/403|Forbidden/i.test(err.message)) throw err;
          job.message = "That shortcut failed — getting the whole file instead…";
          job.percent = 0;
          await fetchStream(job, "bestaudio/best", tempA, 0, 55, null, false);
          await checkpoint();
          job.stage = "converting"; job.message = "Making your MP3…";
          await runFfmpeg(job, audioArgs(job, tempA, true), job.outputPath, clipLen, 55, 45);
        }
      } else {
        await fetchStream(job, "bestaudio/best", tempA, 0, 60, null, false);
        await checkpoint();
        job.stage = "converting"; job.message = "Making your MP3…";
        await runFfmpeg(job, audioArgs(job, tempA, false), job.outputPath, fullLen, 60, 40);
      }
    } else if (!job.opt.needsMerge) {
      // Progressive single stream.
      if (job.mode === "clip") {
        try {
          await fetchStream(job, `${job.opt.formatId}/best`, job.outputPath, 0, 90, section, true);
        } catch (err) {
          if (err.cancelled || !/403|Forbidden/i.test(err.message)) throw err;
          job.message = "That shortcut failed — getting the whole file instead…";
          job.percent = 0;
          await fetchStream(job, `${job.opt.formatId}/best`, tempV, 0, 55, null, false);
          checkpoint();
          job.stage = "trimming"; job.message = "Cutting your clip…";
          await runFfmpeg(job, cutArgs(job, tempV), job.outputPath, clipLen, 55, 45);
        }
      } else {
        await fetchStream(job, `${job.opt.formatId}/best`, job.outputPath, 0, 95, null, false);
      }
    } else if (job.mode === "clip") {
      try {
        await fetchStream(job, job.opt.formatId, tempV, 0, 40, section, true);
        await checkpoint();
        await fetchStream(job, "bestaudio/best", tempA, 40, 15, section, false);
        await checkpoint();
        job.stage = "merging"; job.message = "Putting video + sound together…";
        await runFfmpeg(job, mergeArgs(job, tempV, tempA, false), job.outputPath, clipLen, 55, 45);
      } catch (err) {
        if (err.cancelled || !/403|Forbidden/i.test(err.message)) throw err;
        job.message = "That shortcut failed — getting the whole file instead…";
        job.percent = 0;
        await fetchStream(job, job.opt.formatId, tempV, 0, 40, null, false);
        await checkpoint();
        await fetchStream(job, "bestaudio/best", tempA, 40, 15, null, false);
        await checkpoint();
        job.stage = "merging"; job.message = "Putting video + sound together…";
        await runFfmpeg(job, mergeArgs(job, tempV, tempA, true), job.outputPath, clipLen, 55, 45);
      }
    } else {
      await fetchStream(job, job.opt.formatId, tempV, 0, 45, null, false);
      await checkpoint();
      await fetchStream(job, "bestaudio/best", tempA, 45, 15, null, false);
      await checkpoint();
      job.stage = "merging"; job.message = "Putting video + sound together…";
      await runFfmpeg(job, mergeArgs(job, tempV, tempA, false), job.outputPath, fullLen, 60, 40);
    }
    await checkpoint();

    if (!fs.existsSync(job.outputPath)) throw new Error("Finished but the output file is missing.");

    job.stage = "finalizing";
    job.percent = 99;
    job.message = "Saving your file…";
    await fsp.access(job.outputPath);

    job.stage = "done";
    job.percent = 100;
    job.message = "Done — file auto-deletes 5 min after your last download";
    job.downloadUrl = `/api/file/${job.id}`;
    retention.schedule(job.fileName, AUTO_DELETE_MS).catch(() => {});
  } catch (err) {
    if (err && err.cancelled) return; // cancelJob already cleaned up
    job.stage = "error";
    job.message = err.message || "Download failed";
  } finally {
    for (const p of (job.tempFiles || [])) {
      try { await fsp.unlink(p); } catch { /* ignore */ }
    }
  }
}

function createJob({ url, kind, opt, mode, start, end, fileName, durationSec }) {
  const id = newJobId();
  const outputPath = path.join(OUTPUT_DIR, fileName);
  const job = {
    id, url, kind, opt, mode,
    start, end, fileName, outputPath,
    durationSec: durationSec || 0,
    stage: "queued", percent: 0, message: "Queued…",
    createdAt: new Date().toISOString(), downloadUrl: null,
    children: [], tempFiles: [], cancelled: false,
  };
  jobs.set(id, job);
  if (jobs.size > 50) jobs.delete([...jobs.keys()][0]);
  setImmediate(() => runDownloadJob(job));
  return job;
}

/**
 * Cancel a running job: kill its processes and instantly remove every
 * temp/part file plus any partial output, so storage never ramps up.
 */
async function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  for (const child of [...job.children]) {
    try { child.kill(); } catch { /* ignore */ }
  }
  // Give killed processes a moment to release their file locks, then remove
  // every temp/part file plus any partial output.
  await sleep(1000);
  const paths = [...(job.tempFiles || []), job.outputPath];
  for (const p of paths) {
    await unlinkRetry(p);
  }
  try {
    const names = await fsp.readdir(TEMP_DIR);
    for (const n of names) {
      if (n.startsWith(job.id)) {
        await unlinkRetry(path.join(TEMP_DIR, n));
      }
    }
  } catch { /* ignore */ }
  try { await retention.unschedule(job.fileName); } catch { /* ignore */ }
  jobs.delete(id);
  return true;
}

async function listOutputs() {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const names = await fsp.readdir(OUTPUT_DIR);
  const files = [];
  for (const name of names) {
    if (name === ".gitkeep") continue;
    const full = path.join(OUTPUT_DIR, name);
    try {
      const st = await fsp.stat(full);
      if (st.isFile()) files.push({ name, size: st.size, mtime: st.mtime.toISOString() });
    } catch { /* ignore */ }
  }
  files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return files;
}

module.exports = { configure, toolInfo, createJob, getJob, cancelJob, listOutputs, pipeline, stageIndex, STAGE_LABELS, AUTO_DELETE_MS };
