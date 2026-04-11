const {
  getMetaValue,
  getBaselineStats,
  getRecentWeekdayBaselineStats,
  getRecentTimeOfDayBaseline,
  getRollingMetricNear,
  getCurrentRollingCount,
  getConcurrentCount,
  getLiveAircraft,
  getRecentDailyMetrics,
  getRecentRollingMetrics,
  getTrackedAircraftCount,
  getTrackingSummary,
  areAllTrackedAircraftDemo,
} = require("./db");
const { getDemoDashboard } = require("./demo-data");

const DAY_MS = 24 * 60 * 60 * 1000;
const HEATMAP_SOURCE = "adsbx_heatmap";
const HEATMAP_STATUS_META_KEY = "adsbx_heatmap_status";
const META_SLOT_KEY = "adsbx_heatmap_slot_key";
const META_SAMPLED_AT = "adsbx_heatmap_sampled_at";
const META_URL = "adsbx_heatmap_url";
const META_CACHE_PATH = "adsbx_heatmap_cache_path";

function computeAlertLevel(sigmaShift) {
  if (sigmaShift >= 2) {
    return "alarm";
  }

  if (sigmaShift >= 1) {
    return "elevated";
  }

  return "normal";
}

function computeGaugeValue(sigmaShift) {
  const clampedShift = Math.max(-2, Math.min(2, sigmaShift));
  return Math.max(0, Math.min(1, 0.5 + clampedShift / 4));
}

function computeBaselineSignal(currentValue, baselineMean, baselineStdDev) {
  if (!baselineStdDev) {
    return {
      sigmaShift: 0,
      gaugeValue: 0.5,
      alertLevel: "normal",
    };
  }

  const sigmaShift = (currentValue - baselineMean) / baselineStdDev;
  return {
    sigmaShift,
    gaugeValue: computeGaugeValue(sigmaShift),
    alertLevel: computeAlertLevel(sigmaShift),
  };
}

function computeReferenceSignal(currentValue, referenceValue, normalizationStdDev) {
  if (!Number.isFinite(referenceValue)) {
    return {
      deltaCount: null,
      percentChange: null,
      sigmaShift: 0,
      gaugeValue: 0.5,
      alertLevel: "normal",
    };
  }

  const deltaCount = currentValue - referenceValue;
  const percentChange = referenceValue ? deltaCount / referenceValue : null;
  const sigmaShift = normalizationStdDev ? deltaCount / normalizationStdDev : 0;

  return {
    deltaCount,
    percentChange,
    sigmaShift,
    gaugeValue: computeGaugeValue(sigmaShift),
    alertLevel: computeAlertLevel(sigmaShift),
  };
}

function average(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) {
    return null;
  }

  return finiteValues.reduce((total, value) => total + value, 0) / finiteValues.length;
}

function parseSavedHeatmapStatus() {
  const savedValue = getMetaValue(HEATMAP_STATUS_META_KEY);
  if (!savedValue) {
    return null;
  }

  try {
    return JSON.parse(savedValue);
  } catch {
    return null;
  }
}

function buildStoredHeatmapStatus(overrides = {}) {
  const savedStatus = parseSavedHeatmapStatus() || {};
  return {
    provider: HEATMAP_SOURCE,
    providerLabel: "ADS-B Exchange heatmap",
    cadenceMinutes: 30,
    refreshing: false,
    nextRefreshAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    latestSampledAt: getMetaValue(META_SAMPLED_AT),
    latestSlotKey: getMetaValue(META_SLOT_KEY),
    latestUrl: getMetaValue(META_URL),
    cachePath: getMetaValue(META_CACHE_PATH),
    usedCache: null,
    matchedCount: null,
    airborneCount: null,
    rolling24hCount: null,
    concurrentCount: null,
    ...savedStatus,
    ...overrides,
  };
}

function computeConcurrentPredictionModel(referenceIso, currentRolling24hCount, concurrentCount, globalBaseline) {
  const recentWeekdayBaseline = getRecentWeekdayBaselineStats(referenceIso, 4);
  const recentTimeOfDayBaseline = getRecentTimeOfDayBaseline(referenceIso, 7);
  const yearAgoTargetAt = new Date(new Date(referenceIso).getTime() - 365 * DAY_MS).toISOString();
  const yearAgoReference = getRollingMetricNear(yearAgoTargetAt);
  const yearAgoRollingCount = yearAgoReference?.rolling24hCount ?? null;
  const blendedRollingBaseline =
    average([recentWeekdayBaseline.mean || null, yearAgoRollingCount]) ??
    recentTimeOfDayBaseline.rollingMean ??
    currentRolling24hCount;
  const ratioMean = recentTimeOfDayBaseline.ratioMean || 0;
  const ratioStandardDeviation = recentTimeOfDayBaseline.ratioStandardDeviation || 0;
  const expectedConcurrentCount =
    blendedRollingBaseline && ratioMean
      ? blendedRollingBaseline * ratioMean
      : recentTimeOfDayBaseline.concurrentMean || concurrentCount;
  const expectedConcurrentStdDev =
    blendedRollingBaseline && ratioStandardDeviation
      ? Math.max(1, blendedRollingBaseline * ratioStandardDeviation)
      : Math.max(
          1,
          recentTimeOfDayBaseline.concurrentStandardDeviation ||
            recentWeekdayBaseline.standardDeviation * Math.max(ratioMean, 0.01) ||
            globalBaseline.standardDeviation * Math.max(ratioMean, 0.01) ||
            expectedConcurrentCount * 0.1,
        );
  const compositeSignal = computeBaselineSignal(
    concurrentCount,
    expectedConcurrentCount,
    expectedConcurrentStdDev,
  );
  const weekdaySignal = computeBaselineSignal(
    currentRolling24hCount,
    recentWeekdayBaseline.mean,
    recentWeekdayBaseline.standardDeviation,
  );
  const timeOfDaySignal = computeBaselineSignal(
    concurrentCount,
    recentTimeOfDayBaseline.concurrentMean,
    recentTimeOfDayBaseline.concurrentStandardDeviation,
  );
  const normalizationStdDev = recentWeekdayBaseline.standardDeviation || globalBaseline.standardDeviation;
  const yearAgoSignal = computeReferenceSignal(
    currentRolling24hCount,
    yearAgoRollingCount,
    normalizationStdDev,
  );

  return {
    yearAgoTargetAt,
    yearAgoReference,
    yearAgoRollingCount,
    recentWeekdayBaseline,
    recentTimeOfDayBaseline,
    blendedRollingBaseline,
    ratioMean,
    ratioStandardDeviation,
    expectedConcurrentCount,
    expectedConcurrentStdDev,
    compositeSignal,
    weekdaySignal,
    timeOfDaySignal,
    yearAgoSignal,
  };
}

function buildDashboardPayload({ liveStatus: liveStatusOverride = null } = {}) {
  const tracking = getTrackingSummary();
  const liveStatus = buildStoredHeatmapStatus(liveStatusOverride || {});
  const referenceIso = liveStatus.latestSampledAt || new Date().toISOString();
  const globalBaseline = getBaselineStats();
  const currentRolling24hCount = getCurrentRollingCount(referenceIso, { liveSource: HEATMAP_SOURCE });
  const concurrentCount = getConcurrentCount(HEATMAP_SOURCE);
  const currentModel = computeConcurrentPredictionModel(
    referenceIso,
    currentRolling24hCount,
    concurrentCount,
    globalBaseline,
  );
  const rollingSeries = getRecentRollingMetrics().map((sample) => {
    const sampleModel = computeConcurrentPredictionModel(
      sample.sampledAt,
      sample.rolling24hCount,
      sample.concurrentCount,
      globalBaseline,
    );

    return {
      ...sample,
      predictedConcurrentCount: sampleModel.expectedConcurrentCount,
    };
  });

  return {
    mode: tracking.configured ? "configured" : "empty",
    warning: tracking.configured ? null : tracking.reason,
    cohort: tracking,
    watchlist: tracking,
    liveStatus: {
      ...liveStatus,
      rolling24hCount: currentRolling24hCount,
      concurrentCount,
    },
    current: {
      asOf: referenceIso,
      rolling24hCount: currentRolling24hCount,
      concurrentCount,
      baselineMean: currentModel.expectedConcurrentCount,
      baselineStdDev: currentModel.expectedConcurrentStdDev,
      globalBaselineMean: globalBaseline.mean,
      globalBaselineStdDev: globalBaseline.standardDeviation,
      zScore: currentModel.compositeSignal.sigmaShift,
      gaugeValue: currentModel.compositeSignal.gaugeValue,
      alertLevel: currentModel.compositeSignal.alertLevel,
    },
    signals: {
      composite: {
        asOf: referenceIso,
        actualConcurrentCount: concurrentCount,
        expectedConcurrentCount: currentModel.expectedConcurrentCount,
        expectedConcurrentStdDev: currentModel.expectedConcurrentStdDev,
        blendedRollingBaseline: currentModel.blendedRollingBaseline,
        sigmaShift: currentModel.compositeSignal.sigmaShift,
        gaugeValue: currentModel.compositeSignal.gaugeValue,
        alertLevel: currentModel.compositeSignal.alertLevel,
      },
      weekday: {
        asOf: referenceIso,
        currentRolling24hCount,
        baselineMean: currentModel.recentWeekdayBaseline.mean,
        baselineStdDev: currentModel.recentWeekdayBaseline.standardDeviation,
        sampleCount: currentModel.recentWeekdayBaseline.sampleCount,
        samples: currentModel.recentWeekdayBaseline.samples,
        sigmaShift: currentModel.weekdaySignal.sigmaShift,
        gaugeValue: currentModel.weekdaySignal.gaugeValue,
        alertLevel: currentModel.weekdaySignal.alertLevel,
      },
      yearAgo: {
        asOf: referenceIso,
        currentRolling24hCount,
        referenceCount: currentModel.yearAgoRollingCount,
        referenceSampledAt: currentModel.yearAgoReference?.sampledAt ?? null,
        referenceTargetAt: currentModel.yearAgoTargetAt,
        differenceSeconds: currentModel.yearAgoReference?.differenceSeconds ?? null,
        deltaCount: currentModel.yearAgoSignal.deltaCount,
        percentChange: currentModel.yearAgoSignal.percentChange,
        sigmaShift: currentModel.yearAgoSignal.sigmaShift,
        gaugeValue: currentModel.yearAgoSignal.gaugeValue,
        alertLevel: currentModel.yearAgoSignal.alertLevel,
      },
      timeOfDay: {
        asOf: referenceIso,
        actualConcurrentCount: concurrentCount,
        concurrentMean: currentModel.recentTimeOfDayBaseline.concurrentMean,
        concurrentStdDev: currentModel.recentTimeOfDayBaseline.concurrentStandardDeviation,
        rollingMean: currentModel.recentTimeOfDayBaseline.rollingMean,
        ratioMean: currentModel.ratioMean,
        ratioStdDev: currentModel.ratioStandardDeviation,
        sampleCount: currentModel.recentTimeOfDayBaseline.sampleCount,
        samples: currentModel.recentTimeOfDayBaseline.samples,
        sigmaShift: currentModel.timeOfDaySignal.sigmaShift,
        gaugeValue: currentModel.timeOfDaySignal.gaugeValue,
        alertLevel: currentModel.timeOfDaySignal.alertLevel,
      },
    },
    liveAircraft: getLiveAircraft(HEATMAP_SOURCE),
    trends: {
      daily: getRecentDailyMetrics(),
      rolling: rollingSeries,
    },
  };
}

function buildDashboardSnapshot({ liveStatus = null, snapshotGeneratedAt = new Date().toISOString() } = {}) {
  const trackedCount = getTrackedAircraftCount();
  const hasAnyHistoricalData = getBaselineStats().sampleCount > 0;
  const onlyDemoData = areAllTrackedAircraftDemo();

  if ((!trackedCount && !hasAnyHistoricalData) || onlyDemoData) {
    return {
      ...getDemoDashboard(),
      snapshotGeneratedAt,
    };
  }

  return {
    ...buildDashboardPayload({ liveStatus }),
    snapshotGeneratedAt,
  };
}

module.exports = {
  buildDashboardPayload,
  buildDashboardSnapshot,
  buildStoredHeatmapStatus,
  HEATMAP_SOURCE,
};
