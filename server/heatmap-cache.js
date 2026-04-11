const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { ROOT_DIR, DB_PATH } = require("./config");
const { getMetaValue, setMetaValue } = require("./db");

const execFileAsync = promisify(execFile);

const HEATMAP_SOURCE = "adsbx_heatmap";
const HEATMAP_STATUS_META_KEY = "adsbx_heatmap_status";
const HEATMAP_REFRESH_MS = 30 * 60 * 1000;
const HEATMAP_RELEASE_LAG_MS = 2 * 60 * 1000;
const HEATMAP_SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "update_latest_heatmap.py");

function createDefaultStatus() {
  return {
    provider: HEATMAP_SOURCE,
    providerLabel: "ADS-B Exchange heatmap",
    cadenceMinutes: 30,
    refreshing: false,
    nextRefreshAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    latestSampledAt: null,
    latestSlotKey: null,
    latestUrl: null,
    cachePath: null,
    usedCache: null,
    matchedCount: null,
    airborneCount: null,
    rolling24hCount: null,
    concurrentCount: null,
  };
}

function loadSavedStatus() {
  const savedValue = getMetaValue(HEATMAP_STATUS_META_KEY);
  if (!savedValue) {
    return createDefaultStatus();
  }

  try {
    return {
      ...createDefaultStatus(),
      ...JSON.parse(savedValue),
    };
  } catch {
    return createDefaultStatus();
  }
}

function persistStatus(status) {
  setMetaValue(HEATMAP_STATUS_META_KEY, JSON.stringify(status));
}

function nextRefreshAtIso(nowMs = Date.now()) {
  const nextBoundaryMs = Math.floor(nowMs / HEATMAP_REFRESH_MS) * HEATMAP_REFRESH_MS + HEATMAP_REFRESH_MS;
  return new Date(nextBoundaryMs + HEATMAP_RELEASE_LAG_MS).toISOString();
}

function delayUntilNextRefresh(nowMs = Date.now()) {
  return Math.max(1_000, Date.parse(nextRefreshAtIso(nowMs)) - nowMs);
}

function extractErrorMessage(error) {
  const stderr = String(error?.stderr || "").trim();
  if (stderr) {
    return stderr.split("\n").pop();
  }

  const stdout = String(error?.stdout || "").trim();
  if (stdout) {
    return stdout.split("\n").pop();
  }

  return error?.message || "Heatmap refresh failed.";
}

function createHeatmapCacheRefresher({ onRefreshComplete = null } = {}) {
  let status = loadSavedStatus();
  let timer = null;
  let inFlight = null;

  persistStatus(status);

  function updateStatus(patch) {
    status = {
      ...status,
      ...patch,
    };
    persistStatus(status);
    return getStatus();
  }

  function getStatus() {
    return { ...status };
  }

  function notifyRefreshComplete(success) {
    if (typeof onRefreshComplete !== "function") {
      return;
    }

    setTimeout(() => {
      try {
        onRefreshComplete({
          success,
          status: getStatus(),
        });
      } catch (error) {
        console.error("Heatmap refresh callback failed:", error);
      }
    }, 0);
  }

  function scheduleNextRefresh() {
    if (timer) {
      clearTimeout(timer);
    }

    const delayMs = delayUntilNextRefresh();
    updateStatus({
      nextRefreshAt: new Date(Date.now() + delayMs).toISOString(),
    });

    timer = setTimeout(() => {
      void refreshNow();
    }, delayMs);
  }

  async function refreshNow({ force = false } = {}) {
    if (inFlight) {
      return inFlight;
    }

    const startedAt = new Date().toISOString();
    updateStatus({
      refreshing: true,
      lastAttemptAt: startedAt,
      lastError: null,
    });

    inFlight = (async () => {
      try {
        const args = [HEATMAP_SCRIPT_PATH, "--db", DB_PATH];
        if (force) {
          args.push("--force");
        }

        const { stdout } = await execFileAsync("python3", args, {
          cwd: ROOT_DIR,
          maxBuffer: 1024 * 1024,
        });
        const payload = JSON.parse(String(stdout || "{}").trim() || "{}");

        updateStatus({
          refreshing: false,
          lastSuccessAt: new Date().toISOString(),
          lastError: null,
          latestSampledAt: payload.latestSampledAt ?? status.latestSampledAt,
          latestSlotKey: payload.latestSlotKey ?? status.latestSlotKey,
          latestUrl: payload.latestUrl ?? status.latestUrl,
          cachePath: payload.cachePath ?? status.cachePath,
          usedCache: payload.usedCache ?? status.usedCache,
          matchedCount: payload.matchedCount ?? status.matchedCount,
          airborneCount: payload.airborneCount ?? status.airborneCount,
          rolling24hCount: payload.rolling24hCount ?? status.rolling24hCount,
          concurrentCount: payload.concurrentCount ?? status.concurrentCount,
        });
        notifyRefreshComplete(true);
      } catch (error) {
        updateStatus({
          refreshing: false,
          lastError: extractErrorMessage(error),
        });
        notifyRefreshComplete(false);
      } finally {
        inFlight = null;
        scheduleNextRefresh();
      }

      return getStatus();
    })();

    return inFlight;
  }

  function start() {
    scheduleNextRefresh();
    void refreshNow();
  }

  return {
    getStatus,
    refreshNow,
    start,
    source: HEATMAP_SOURCE,
  };
}

module.exports = {
  HEATMAP_SOURCE,
  createHeatmapCacheRefresher,
};
