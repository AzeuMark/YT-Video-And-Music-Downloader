const path = require("path");

// Accepted YouTube video URL templates (watch, shorts, embed, live, share links).
const YT_ID_RE =
  /(?:youtube\.com\/(?:watch\?[^#\s]*v=|shorts\/|embed\/|live\/)|music\.youtube\.com\/watch\?[^#\s]*v=|youtu\.be\/)([\w-]{11})(?=[&#?/\s]|$)/i;

// Anything longer is a mistype/paste-garbage, never a real share link.
const MAX_URL_LEN = 100;

/** Extract the 11-char video ID, or null if the URL is not an accepted template. */
function extractVideoId(url) {
  if (typeof url !== "string") return null;
  const m = url.trim().match(YT_ID_RE);
  return m ? m[1] : null;
}

function isYouTubeUrl(url) {
  if (typeof url !== "string") return false;
  const s = url.trim();
  if (s.length === 0 || s.length > MAX_URL_LEN) return false;
  return extractVideoId(s) !== null;
}

function urlProblem(url) {
  if (typeof url !== "string" || url.trim().length === 0) return "empty";
  if (url.trim().length > MAX_URL_LEN) return "too-long";
  if (!extractVideoId(url)) return "not-youtube";
  return null;
}

/** Strip extra params (list, si, …) down to the canonical watch URL. */
function normalizeYouTubeUrl(url) {
  const id = extractVideoId(url);
  return id ? `https://www.youtube.com/watch?v=${id}` : String(url || "").trim();
}

/** Parse "s", "m:ss", "h:mm:ss" -> seconds (float). Returns null on invalid. */
function parseTime(str) {
  if (str === undefined || str === null) return null;
  const s = String(str).trim();
  if (s === "") return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return null;
  }
  const nums = parts.map(Number);
  let seconds = 0;
  for (const n of nums) seconds = seconds * 60 + n;
  return seconds;
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function sanitizeFilename(name, maxLen = 80) {
  const base = String(name || "video")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
    .replace(/[. ]+$/g, "");
  return base || "video";
}

function safeOutputName(name) {
  return path.basename(String(name || ""));
}

module.exports = { isYouTubeUrl, extractVideoId, urlProblem, normalizeYouTubeUrl, MAX_URL_LEN, parseTime, formatTime, sanitizeFilename, safeOutputName };
