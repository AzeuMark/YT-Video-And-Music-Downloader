const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// Persistent auto-deletion schedule for downloaded files.
// retention.json maps file name -> ISO timestamp when it should be deleted.
// A 60s sweeper (cheap: one stat pass, no I/O when empty) enforces it, and an
// immediate sweep on server boot catches up on anything missed during downtime.

let DATA_FILE = path.join(__dirname, "..", "retention.json");
let OUTPUT_DIR = path.join(__dirname, "..", "outputs");
let timer = null;

function configure({ dataFile, outputsDir } = {}) {
  if (dataFile) DATA_FILE = dataFile;
  if (outputsDir) OUTPUT_DIR = outputsDir;
}

async function load() {
  try {
    const raw = await fsp.readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function save(map) {
  try {
    await fsp.writeFile(DATA_FILE, JSON.stringify(map, null, 1));
  } catch {
    // Retention is best-effort; a failed write just means retry next time.
  }
}

/** Schedule `name` for deletion `delayMs` from now (resets any prior timer). */
async function schedule(name, delayMs) {
  if (!name) return null;
  const map = await load();
  const at = new Date(Date.now() + delayMs).toISOString();
  map[path.basename(name)] = at;
  await save(map);
  return at;
}

async function unschedule(name) {
  const map = await load();
  if (map[path.basename(name)]) {
    delete map[path.basename(name)];
    await save(map);
  }
}

function getDeleteAt(name) {
  return load().then((map) => map[path.basename(name)] || null);
}

/** Delete every scheduled file whose time has come. Returns deleted names. */
async function sweepNow() {
  const map = await load();
  const now = Date.now();
  const deleted = [];
  let changed = false;
  for (const [name, at] of Object.entries(map)) {
    if (new Date(at).getTime() > now) continue;
    const full = path.join(OUTPUT_DIR, path.basename(name));
    try {
      await fsp.unlink(full);
      deleted.push(name);
    } catch {
      // Already gone manually — just drop the entry.
    }
    delete map[name];
    changed = true;
  }
  if (changed) await save(map);
  return deleted;
}

function startSweeper(intervalMs = 60000) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    sweepNow().catch(() => {});
  }, intervalMs);
  return timer;
}

module.exports = { configure, schedule, unschedule, getDeleteAt, sweepNow, startSweeper };
