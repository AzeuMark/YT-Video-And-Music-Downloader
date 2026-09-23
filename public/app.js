const $ = (id) => document.getElementById(id);
const state = { info: null, videoId: null, tab: "video", optionId: null, poll: null, jobId: null, saveUrl: null, saveName: "", fetching: false, busy: false, lastFetched: "", debounce: null };
const MUSIC_DESC = { 320: "Best sound", 256: "Great sound", 192: "Good sound", 128: "Smaller file" };

const YT_ID_RE = /(?:youtube\.com\/(?:watch\?[^#\s]*v=|shorts\/|embed\/|live\/)|music\.youtube\.com\/watch\?[^#\s]*v=|youtu\.be\/)([\w-]{11})(?=[&#?/\s]|$)/i;
const MAX_URL_LEN = 100;

function ytId(s) {
  s = String(s || "").trim();
  if (!s || s.length > MAX_URL_LEN) return null;
  const m = s.match(YT_ID_RE);
  return m ? m[1] : null;
}

function urlHint(s) {
  s = String(s || "").trim();
  if (!s) return "";
  if (s.length > MAX_URL_LEN) return "That URL is too long to be a YouTube link — check for typos.";
  if (s.includes("://") && !ytId(s)) return "That doesn't look like a YouTube video / Shorts link.";
  return "";
}

function show(el, on) { el.hidden = !on; }
function err(box, msg) {
  if (!msg) { box.hidden = true; box.textContent = ""; return; }
  box.hidden = false; box.textContent = msg;
}
function fetchStatus(msg) { $("fetchStatus").textContent = msg || ""; }

/* ---------- segmented MM:SS time inputs — digits only, typos impossible ---------- */
const SEG_ORDER = ["m", "s"];
function segInputs(group) {
  return SEG_ORDER.map((p) => document.querySelector(`.seg[data-group="${group}"][data-part="${p}"]`));
}
function segSeconds(group) {
  const vals = segInputs(group).map((el) => el.value);
  if (!/^\d{1,4}$/.test(vals[0]) || !/^\d{1,2}$/.test(vals[1])) return null;
  const m = Number(vals[0]), s = Number(vals[1]);
  if (s > 59) return null;
  return m * 60 + s;
}
function setSegSeconds(group, total) {
  total = Math.max(0, Math.floor(Number(total) || 0));
  const [me, se] = segInputs(group);
  me.value = String(Math.floor(total / 60));
  se.value = String(total % 60).padStart(2, "0");
}
function segLabel(group) {
  const [m, s] = segInputs(group).map((el) => el.value);
  return `${Number(m) || 0}:${String(s).padStart(2, "0")}`;
}
function focusSeg(group, part) {
  const el = document.querySelector(`.seg[data-group="${group}"][data-part="${part}"]`);
  if (el && !el.disabled) { el.focus(); el.select(); }
}
function parsePastedTime(text) {
  // Accepts "4:30", "1:02:03", "90" from clipboard.
  const t = String(text || "").trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  return parts.map(Number).reduce((acc, n) => acc * 60 + n, 0);
}
function wireSeg(el) {
  const group = el.dataset.group, part = el.dataset.part;
  const order = SEG_ORDER;
  const maxLen = part === "m" ? 3 : 2;
  el.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // allow copy/paste/select-all
    const i = order.indexOf(part);
    if (/^[0-9]$/.test(e.key)) return; // digits only — letters never enter
    if (e.key === "Backspace" && el.value === "" && i > 0) { e.preventDefault(); focusSeg(group, order[i - 1]); return; }
    if (e.key === "ArrowLeft" && i > 0) { e.preventDefault(); focusSeg(group, order[i - 1]); return; }
    if (e.key === "ArrowRight" && i < order.length - 1) { e.preventDefault(); focusSeg(group, order[i + 1]); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const d = e.key === "ArrowUp" ? 1 : -1;
      const max = part === "m" ? 5999 : 59;
      el.value = String(Math.min(max, Math.max(0, (Number(el.value) || 0) + d)));
      refreshDownloadState();
      return;
    }
    if (["Tab", "Enter", "Delete", "Home", "End"].includes(e.key)) return;
    e.preventDefault(); // blocks letters, symbols, spaces — everything non-numeric
  });
  el.addEventListener("input", () => {
    el.value = el.value.replace(/\D/g, "").slice(0, maxLen);
    if (part === "s" && el.value !== "" && Number(el.value) > 59) el.value = "59";
    refreshDownloadState();
  });
  el.addEventListener("paste", (e) => {
    e.preventDefault();
    const secs = parsePastedTime((e.clipboardData || window.clipboardData || {}).getData
      ? (e.clipboardData || window.clipboardData).getData("text") : "");
    if (secs === null || secs < 0) return;
    setSegSeconds(group, secs);
    refreshDownloadState();
  });
  el.addEventListener("focus", () => el.select());
  el.addEventListener("blur", () => {
    if (el.value === "") el.value = "00";
    else el.value = el.value.padStart(2, "0");
    refreshDownloadState();
  });
}

/* ---------- timestamps: strict live validation, red + tooltip ---------- */
function validateTrim() {
  const startBox = document.querySelector('.segs [data-group="start"]').closest(".segs");
  const endBox = document.querySelector('.segs [data-group="end"]').closest(".segs");
  const box = $("trimErr");
  const clearMarks = () => {
    [startBox, endBox].forEach((el) => { el.classList.remove("invalid"); el.removeAttribute("title"); });
  };
  if (!state.info) { clearMarks(); err(box, null); return { ok: false, msg: "" }; }
  const d = state.info.durationSec || 0;
  const dl = state.info.durationLabel || "";
  const bad = (which, msg) => {
    clearMarks();
    const el = which === "start" ? startBox : endBox;
    el.classList.add("invalid");
    el.setAttribute("title", msg);
    err(box, msg);
    return { ok: false, msg };
  };
  const s = segSeconds("start"), e = segSeconds("end");
  if (s === null) return bad("start", "Start has a bad value — seconds go 00–59.");
  if (e === null) return bad("end", "End has a bad value — seconds go 00–59.");
  if (!(e > s)) return bad("end", "End must be after Start.");
  if (e - s < 1) return bad("end", "Pick at least 1 second.");
  if (d && e > d + 1) return bad("end", `That's longer than the video (${dl}). Lower the End.`);
  clearMarks();
  err(box, null);
  return { ok: true, msg: "" };
}

function refreshDownloadState() {
  const t = validateTrim();
  $("dlBtn").disabled = state.busy || !t.ok || !state.optionId;
  return t;
}

/* ---------- busy lock: downloading disables everything that could break it ---------- */
function setBusy(b) {
  state.busy = b;
  ["url", "fetchBtn", "tabVideo", "tabMusic", "dlBtn"].forEach((id) => { $(id).disabled = b; });
  document.querySelectorAll(".seg, #videoList input, #audioList input").forEach((r) => { r.disabled = b; });
  if (!b) refreshDownloadState();
}

/* ---------- recent links: last 10, local to this browser ---------- */
const RECENT_KEY = "yt-dl-recent-v1";
function migrateRecents() {
  // One-time: adopt entries saved under the old per-profile keys.
  try {
    if (!localStorage.getItem(RECENT_KEY)) {
      const adopted = localStorage.getItem("yt-dl-recent-me");
      if (adopted) {
        localStorage.setItem(RECENT_KEY, adopted);
        localStorage.removeItem("yt-dl-recent-me");
      }
    }
  } catch { /* ignore */ }
}
function getRecents() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function pushRecent(url, title) {
  const list = getRecents().filter((r) => r.url !== url);
  list.unshift({ url, title: title || url, at: Date.now() });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10))); } catch { /* ignore */ }
  renderRecents();
}
function timeAgo(at) {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  try { return new Date(at).toLocaleDateString(); } catch { return ""; }
}
function renderRecents() {
  const box = $("recent");
  const list = getRecents();
  if (!list.length) { box.innerHTML = '<div class="empty">Nothing here yet — links you load will appear.</div>'; return; }
  box.innerHTML = "";
  list.forEach((r) => {
    const row = document.createElement("div");
    row.className = "ritem";
    const main = document.createElement("button");
    main.className = "rmain"; main.type = "button"; main.title = r.url;
    const t = document.createElement("span"); t.className = "rtitle"; t.textContent = r.title;
    const short = r.url.length > 44 ? r.url.slice(0, 44) + "…" : r.url;
    const m = document.createElement("span"); m.className = "rmeta"; m.textContent = `${short} · ${timeAgo(r.at)}`;
    main.append(t, m);
    const get = document.createElement("button");
    get.className = "btn small primary rget"; get.type = "button"; get.textContent = "Get";
    get.title = "Load this link instantly";
    const load = () => {
      if (state.busy) return;
      closeRecents();
      $("url").value = r.url;
      fetchInfo();
    };
    main.addEventListener("click", load);
    get.addEventListener("click", load);
    row.append(main, get);
    box.append(row);
  });
}
function closeRecents() { $("recentDD").hidden = true; }

async function health() {
  const pill = $("health");
  try {
    const r = await fetch("/api/health");
    const j = await r.json();
    pill.textContent = j.ok ? "Ready" : "Not ready";
    pill.className = "pill " + (j.ok ? "ok" : "bad");
  } catch {
    pill.textContent = "Offline";
    pill.className = "pill bad";
  }
}

/* ---------- tabs: video / music are mutually exclusive by construction ---------- */
function setTab(tab) {
  if (state.busy) return;
  state.tab = tab;
  $("tabVideo").classList.toggle("active", tab === "video");
  $("tabMusic").classList.toggle("active", tab === "music");
  show($("paneVideo"), tab === "video");
  show($("paneMusic"), tab === "music");
  // Move the selection to the visible list so both can never be selected at once.
  const list = tab === "video" ? $("videoList") : $("audioList");
  const other = tab === "video" ? $("audioList") : $("videoList");
  other.querySelectorAll("input").forEach((r) => { r.checked = false; });
  let checked = list.querySelector("input:checked");
  if (!checked) {
    checked = list.querySelector("input");
    if (checked) checked.checked = true;
  }
  state.optionId = checked ? checked.value : null;
  refreshDownloadState();
}

function optRow(name, opt, extra, qHtml) {
  const label = document.createElement("label");
  label.className = "opt";
  const radio = document.createElement("input");
  radio.type = "radio"; radio.name = name; radio.value = opt.id;
  radio.addEventListener("change", () => {
    if (state.busy) return;
    // Selecting here clears the other tab's list — only one choice exists at a time.
    const other = name === "vq" ? $("audioList") : $("videoList");
    other.querySelectorAll("input").forEach((r) => { r.checked = false; });
    setTab(name === "vq" ? "video" : "music");
    state.optionId = opt.id;
    refreshDownloadState();
  });
  const q = document.createElement("span");
  q.className = "q";
  if (qHtml) q.innerHTML = qHtml;
  else q.textContent = opt.label;
  label.append(radio, q);
  for (const html of extra) {
    const s = document.createElement("span");
    if (html.cls) s.className = html.cls;
    s.textContent = html.text;
    label.append(s);
  }
  return label;
}

function compact(n) {
  if (n === null || n === undefined) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function resetScreen(thumbUrl, label) {
  $("screen").querySelectorAll("iframe").forEach((f) => f.remove());
  $("thumb").src = thumbUrl || "";
  $("thumb").hidden = false;
  $("playBtn").hidden = false;
  $("durBadge").hidden = false;
  $("durBadge").textContent = label || "";
}

function renderInfo(info) {
  state.info = info;
  state.videoId = info.videoId || null;
  state.optionId = null;
  $("dlBtn").disabled = true;
  show($("preview"), true);
  err($("dlErr"), null); $("done").hidden = true;

  // --- left: mini player card ---
  resetScreen(info.thumbnail, info.durationLabel);
  $("ptitle").textContent = info.title || "Unknown";
  const channel = info.channel || info.author || "Unknown channel";
  $("cname").textContent = channel;
  $("avatar").textContent = (channel.trim()[0] || "?").toUpperCase();
  $("csubs").textContent = info.channelSubs != null ? `${compact(info.channelSubs)} subscribers` : "";
  const stats = $("stats");
  stats.innerHTML = "";
  const chips = [];
  if (info.views != null) chips.push(`${compact(info.views)} views`);
  if (info.likes != null) chips.push(`${compact(info.likes)} likes`);
  if (info.comments != null) chips.push(`${compact(info.comments)} comments`);
  if (info.uploadDate) chips.push(info.uploadDate);
  for (const c of chips) {
    const s = document.createElement("span");
    s.className = "stat";
    s.textContent = c;
    stats.append(s);
  }
  $("desc").textContent = info.description || "No description available.";
  $("descWrap").open = false;

  $("rangeHint").textContent = info.durationSec ? info.durationLabel : "";
  // Automatic trim defaults: full range. Narrowing it trims.
  setSegSeconds("start", 0);
  setSegSeconds("end", info.durationSec || 0);
  const vl = $("videoList"); vl.innerHTML = "";
  if (!info.videoOptions.length) vl.innerHTML = '<div class="empty">No video streams.</div>';
  for (const o of info.videoOptions) {
    // FPS as superscript over the quality, container as the only badge.
    // No "+ audio" tag: sound is expected, nobody wants a muted video.
    const qHtml = o.fps ? `${o.label}<sup>${Math.round(o.fps)}</sup>` : null;
    vl.append(optRow("vq", o, [
      { cls: "tag", text: (o.container || "mp4").toUpperCase() },
    ], qHtml));
  }
  const al = $("audioList"); al.innerHTML = "";
  if (!info.audioOptions.length) al.innerHTML = '<div class="empty">No audio streams.</div>';
  for (const o of info.audioOptions) {
    al.append(optRow("aq", o, [
      { cls: "tag", text: "MP3" },
      { cls: "dim", text: MUSIC_DESC[o.bitrate] || "" },
    ]));
  }
  setTab("video");
  refreshDownloadState();
}

/* ---------- fetch (button, Enter, or paste) ---------- */
async function fetchInfo() {
  const url = $("url").value.trim();
  err($("fetchErr"), null);
  if (!url) return;
  if (url.length > MAX_URL_LEN) return err($("fetchErr"), "That URL is too long to be a YouTube link — check for typos or extra text.");
  if (!ytId(url)) return err($("fetchErr"), "Please paste a valid YouTube watch, Shorts, or youtu.be URL.");
  if (state.fetching || state.busy) return;
  state.fetching = true;
  $("fetchBtn").disabled = true; $("fetchBtn").textContent = "Getting…";
  fetchStatus("Getting the video info…");
  try {
    const r = await fetch("/api/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Fetch failed.");
    state.lastFetched = url;
    renderInfo(j);
    pushRecent(url, j.title);
    fetchStatus(`Found it! Choose Video or Music, then tap Download.`);
  } catch (e) {
    show($("preview"), false);
    err($("fetchErr"), e.message);
    fetchStatus("");
  } finally {
    state.fetching = false;
    $("fetchBtn").disabled = false; $("fetchBtn").textContent = "Get Video";
  }
}

function maybeAutoFetch() {
  const url = $("url").value.trim();
  if (!ytId(url)) return;
  if (url === state.lastFetched || state.fetching || state.busy) return;
  fetchInfo();
}

/* ---------- stepper ---------- */
function renderSteps(stages, stageIndex, stage) {
  const box = $("steps");
  box.innerHTML = "";
  stages.forEach((s, i) => {
    const d = document.createElement("div");
    d.className = "step" + (stage === "error" ? " err" : i < stageIndex ? " done" : i === stageIndex ? " active" : "");
    d.textContent = (i < stageIndex && stage !== "error" ? "✓ " : "") + s.label;
    box.append(d);
    if (i < stages.length - 1) {
      const sep = document.createElement("div");
      sep.className = "step-sep";
      sep.textContent = "›";
      box.append(sep);
    }
  });
}

/* ---------- download modal ---------- */
function openModal(fileLabel) {
  $("mTitle").textContent = "Getting your file…";
  $("mFile").textContent = fileLabel || "";
  $("steps").innerHTML = "";
  $("barFill").style.width = "0%";
  const pt = $("progTxt");
  pt.textContent = "Starting…";
  pt.title = "";
  $("mSave").disabled = true;
  state.saveUrl = null;
  state.saveName = "";
  show($("modal"), true);
}
function closeModal() { show($("modal"), false); }
function triggerSave() {
  if (!state.saveUrl) return;
  const a = document.createElement("a");
  a.href = state.saveUrl; a.download = state.saveName || "";
  document.body.append(a); a.click(); a.remove();
}
async function cancelDownload() {
  const id = state.jobId;
  clearInterval(state.poll);
  state.jobId = null;
  if (id) {
    try { await fetch(`/api/job/${id}`, { method: "DELETE" }); } catch { /* ignore */ }
  }
  closeModal();
  setBusy(false);
  err($("dlErr"), "Cancelled — cleaned up, nothing was saved.");
  loadOutputs();
}

/* ---------- download ---------- */
async function download() {
  err($("dlErr"), null); $("done").hidden = true;
  if (state.busy) return;
  if (!state.info || !state.optionId) return err($("dlErr"), "Get a video first, then pick a quality.");
  const t = refreshDownloadState();
  if (!t.ok) return; // trim tooltip already shows the problem
  setBusy(true);
  const fname = state.tab === "music" ? "Music" : "Video";
  openModal(`${fname} · ${(state.info && state.info.title) || ""}`.slice(0, 90));
  try {
    const r = await fetch("/api/download", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: $("url").value.trim(),
        kind: state.tab === "music" ? "audio" : "video",
        optionId: state.optionId,
        start: segLabel("start"),
        end: segLabel("end"),
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Couldn't start — try again.");
    state.jobId = j.jobId;
    poll(j.jobId);
  } catch (e) {
    state.jobId = null;
    closeModal();
    err($("dlErr"), e.message);
    setBusy(false);
  }
}

function poll(jobId) {
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    try {
      const r = await fetch(`/api/progress/${jobId}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Progress error.");
      if (j.stages) renderSteps(j.stages, j.stageIndex, j.stage);
      $("barFill").style.width = `${j.percent || 0}%`;
      const label = (j.stages && j.stageIndex >= 0 && j.stages[j.stageIndex])
        ? j.stages[j.stageIndex].label : j.stage;
      const detail = `${label}… ${j.percent || 0}%` + (j.mode === "clip" ? " · clip" : "");
      const pt = $("progTxt");
      pt.textContent = detail;
      pt.title = j.message || "";
      if (j.stage === "done") {
        clearInterval(state.poll);
        state.jobId = null;
        setBusy(false);
        $("mTitle").textContent = "Done — your file is ready!";
        $("mSave").disabled = false;
        state.saveUrl = j.downloadUrl;
        state.saveName = j.fileName || "";
        const d = $("done");
        d.hidden = false;
        d.innerHTML = `Saved. <a href="${j.downloadUrl}" download>Save to this device</a>`;
        triggerSave();
        loadOutputs();
      } else if (j.stage === "error") {
        clearInterval(state.poll);
        state.jobId = null;
        closeModal();
        setBusy(false);
        err($("dlErr"), j.message);
      }
    } catch (e) {
      clearInterval(state.poll);
      state.jobId = null;
      closeModal();
      setBusy(false);
      err($("dlErr"), e.message);
    }
  }, 800);
}

async function loadOutputs() {
  const box = $("outputs");
  try {
    const r = await fetch("/api/outputs");
    const j = await r.json();
    if (!j.files.length) { box.innerHTML = "No files yet."; return; }
    box.innerHTML = "";
    for (const f of j.files) {
      const row = document.createElement("div");
      row.className = "filerow";
      const a = document.createElement("a");
      a.href = `/outputs/${encodeURIComponent(f.name)}`; a.textContent = f.name; a.download = f.name;
      if (f.deleteAt) {
        const ms = new Date(f.deleteAt).getTime() - Date.now();
        const c = document.createElement("span");
        c.className = "countdown";
        c.title = "Files auto-delete 5 minutes after your last download, to save space.";
        c.textContent = ms > 0
          ? `auto-deletes in ${Math.floor(ms / 60000)}m ${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}s`
          : "deleting soon";
        row.append(a, c);
      } else {
        row.append(a);
      }
      const s = document.createElement("span");
      s.className = "size"; s.textContent = `${(f.size / 1048576).toFixed(1)} MB`;
      row.append(s);
      box.append(row);
    }
  } catch { box.textContent = "Could not load outputs/."; }
}

$("fetchBtn").addEventListener("click", fetchInfo);
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") fetchInfo(); });
// Paste a link → fetch immediately; typing a full link → fetch after a short pause.
$("url").addEventListener("paste", () => setTimeout(maybeAutoFetch, 60));
$("url").addEventListener("input", () => {
  // Live hint while typing: only speaks up for pasted-looking or overlong input.
  const hint = urlHint($("url").value);
  fetchStatus(hint);
  clearTimeout(state.debounce);
  state.debounce = setTimeout(maybeAutoFetch, 700);
});
$("tabVideo").addEventListener("click", () => setTab("video"));
$("tabMusic").addEventListener("click", () => setTab("music"));
$("recentBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const dd = $("recentDD");
  show(dd, dd.hidden);
  if (!dd.hidden) renderRecents();
});
document.addEventListener("click", (e) => {
  if (!$("recentDD").hidden && !e.target.closest(".ddwrap")) closeRecents();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeRecents();
});
$("mCancel").addEventListener("click", cancelDownload);
$("mSave").addEventListener("click", triggerSave);
document.querySelectorAll(".seg").forEach(wireSeg);
$("playBtn").addEventListener("click", () => {
  if (state.busy || !state.videoId || $("screen").querySelector("iframe")) return;
  $("thumb").hidden = true;
  $("playBtn").hidden = true;
  $("durBadge").hidden = true;
  const f = document.createElement("iframe");
  f.src = `https://www.youtube.com/embed/${state.videoId}?autoplay=1&rel=0`;
  f.title = "Video preview";
  f.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
  f.allowFullscreen = true;
  $("screen").prepend(f);
});
$("dlBtn").addEventListener("click", download);
$("refreshBtn").addEventListener("click", loadOutputs);
$("cancelBtn").addEventListener("click", () => location.reload());
$("recentClear").addEventListener("click", () => {
  try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ }
  renderRecents();
});

health();
loadOutputs();
migrateRecents();
renderRecents();
