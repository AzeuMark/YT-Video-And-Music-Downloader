const path = require("path");
const ytdlp = require("yt-dlp-exec");
const { formatTime } = require("./validate");

// Short-lived cache so POST /api/download can reuse the formats from
// POST /api/info without a second slow metadata fetch.
const cache = new Map(); // url -> { at, data }
const CACHE_TTL_MS = 5 * 60 * 1000;

const MP3_LADDER = [320, 256, 192, 128];

function isDownloadable(f) {
  if (!f || f.format_note === "storyboard") return false;
  if (f.protocol === "mhtml") return false;
  return Boolean(f.url || f.fragments || f.format_id);
}

function pickBestAudio(formats) {
  const audios = formats.filter(
    (f) => isDownloadable(f) && f.vcodec === "none" && f.acodec && f.acodec !== "none"
  );
  audios.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
  return audios[0] || null;
}

function buildOptions(data) {
  const formats = (data.formats || []).filter(isDownloadable);
  const bestAudio = pickBestAudio(formats);

  // Group video streams by height + fps so 60fps variants are offered separately
  // and sorted first. Within a group prefer mp4/avc for compatibility, then bitrate.
  const compat = (f) =>
    (f.ext === "mp4" ? 2 : 0) + (String(f.vcodec || "").startsWith("avc1") ? 1 : 0);
  const byQuality = new Map();
  for (const f of formats) {
    if (f.vcodec === "none" || !f.height) continue;
    const fpsBucket = f.fps ? Math.round(f.fps) : 0;
    const key = `${f.height}x${fpsBucket}`;
    const cur = byQuality.get(key);
    const score = compat(f) * 1e12 + (f.tbr || f.abr || 0);
    if (!cur || score > cur.score) {
      byQuality.set(key, { format: f, score, height: f.height, fps: fpsBucket });
    }
  }

  const videoOptions = [...byQuality.values()]
    .sort((a, b) => b.height - a.height || b.fps - a.fps)
    .slice(0, 10)
    .map(({ format: f, height, fps }) => {
      const hi = fps >= 48 ? fps : null;
      return {
        id: `v${height}${hi ? `-${hi}` : ""}-${f.format_id}`,
        label: `${height}p${hi || ""}`,
        height,
        fps: f.fps || null,
        formatId: String(f.format_id),
        container: f.ext || null,
        codecs: [f.vcodec, bestAudio ? bestAudio.acodec : null].filter(Boolean).join(" + ") || null,
        // yt-dlp merges bestaudio at download time, so output is never muted.
        hasAudioAfterMerge: Boolean(bestAudio) || (f.acodec && f.acodec !== "none"),
        needsMerge: !f.acodec || f.acodec === "none",
      };
    });

  // Fixed MP3 output ladder for the Music tab. YouTube sources top out around
  // ~160kbps, so these are transcode targets (best source -> MP3 at chosen
  // rate), not native source rates — but they are the numbers users choose between.
  const hasAnyAudio = Boolean(bestAudio);
  const audioOptions = hasAnyAudio
    ? MP3_LADDER.map((kbps) => ({
        id: `a${kbps}`,
        label: `${kbps} kbps`,
        formatId: null, // resolved to bestaudio at download time
        bitrate: kbps,
        container: "mp3",
        codec: "mp3",
      }))
    : [];

  return { videoOptions, audioOptions, formats };
}

async function dumpJson(url) {
  return ytdlp(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noPlaylist: true,
    socketTimeout: 30,
    retries: 3,
  });
}

function toInfo(url, data) {
  const thumbs = data.thumbnails || [];
  const thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : data.thumbnail || null;
  const durationSec = Math.round(Number(data.duration || 0));
  const { videoOptions, audioOptions } = buildOptions(data);
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  return {
    videoId: data.id || null,
    title: data.title || "Unknown title",
    author: (data.uploader || data.channel || null),
    channel: data.channel || data.uploader || null,
    channelSubs: num(data.channel_follower_count),
    views: num(data.view_count),
    likes: num(data.like_count),
    comments: num(data.comment_count),
    description: typeof data.description === "string" ? data.description.slice(0, 4000) : null,
    uploadDate: typeof data.upload_date === "string" && /^\d{8}$/.test(data.upload_date)
      ? `${data.upload_date.slice(0, 4)}-${data.upload_date.slice(4, 6)}-${data.upload_date.slice(6, 8)}`
      : null,
    thumbnail,
    durationSec,
    durationLabel: durationSec ? formatTime(durationSec) : "live/unknown",
    isLive: Boolean(data.is_live),
    videoOptions,
    audioOptions,
  };
}

async function fetchInfo(url, { useCache = true } = {}) {
  const now = Date.now();
  const hit = cache.get(url);
  if (useCache && hit && now - hit.at < CACHE_TTL_MS) {
    return { ...toInfo(url, hit.data), _cached: true };
  }
  let data;
  try {
    data = await dumpJson(url);
  } catch (e) {
    const detail = (e && (e.stderr || e.message)) || "yt-dlp failed";
    const err = new Error(`Could not fetch video info: ${String(detail).split("\n").slice(-3).join(" ").slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  cache.set(url, { at: now, data });
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  return toInfo(url, data);
}

/** Resolve a client-picked optionId against cached/live formats. */
async function resolveOption(url, kind, optionId) {
  const now = Date.now();
  let hit = cache.get(url);
  if (!hit || now - hit.at >= CACHE_TTL_MS) {
    const data = await dumpJson(url);
    hit = { at: now, data };
    cache.set(url, hit);
  }
  const { videoOptions, audioOptions, formats } = buildOptions(hit.data);
  const list = kind === "audio" ? audioOptions : videoOptions;
  const opt = list.find((o) => o.id === optionId);
  if (!opt) {
    const err = new Error("Selected quality is no longer available. Please Fetch again.");
    err.status = 400;
    throw err;
  }
  return { opt, data: hit.data, formats };
}

module.exports = { fetchInfo, buildOptions, resolveOption };
