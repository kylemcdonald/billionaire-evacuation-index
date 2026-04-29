const {
  getMetaValue,
  getConcurrentCount,
  getLiveAircraft,
  getAllRollingMetrics,
  getTrackedAircraftCount,
  getTrackingSummary,
  areAllTrackedAircraftDemo,
} = require("./db");
const { getDemoDashboard } = require("./demo-data");

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;
const MATCH_WINDOW_MS = 20 * 60 * 1000;
const HEATMAP_SOURCE = "adsbx_heatmap";
const HEATMAP_STATUS_META_KEY = "adsbx_heatmap_status";
const META_SLOT_KEY = "adsbx_heatmap_slot_key";
const META_SAMPLED_AT = "adsbx_heatmap_sampled_at";
const META_URL = "adsbx_heatmap_url";
const META_CACHE_PATH = "adsbx_heatmap_cache_path";

const CONCURRENT_LOOKBACK_DAYS = 28;
const CONCURRENT_SLOT_HALF_LIFE_DAYS = 2;
const CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS = 3;
const CONCURRENT_SLOT_NEIGHBOR_WEIGHT = 1;
const CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT = 1;
const CONCURRENT_WEEKDAY_SHRINKAGE = 2;
const CONCURRENT_MIN_HISTORY_SAMPLES = 7 * 48;
const CONCURRENT_MIN_STD_DEV = 8;
const MIN_ALARM_SIGMA_THRESHOLD = 4;
const DEFAULT_ALARM_SIGMA_THRESHOLD = 7;
const ARCHIVE_DECIMAL_PLACES = 2;

function mean(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) {
    return null;
  }

  return finiteValues.reduce((total, value) => total + value, 0) / finiteValues.length;
}

function weightedMean(components) {
  const activeComponents = components.filter(
    (component) => component.weight > 0 && Number.isFinite(component.value),
  );
  if (!activeComponents.length) {
    return null;
  }

  const totalWeight = activeComponents.reduce((total, component) => total + component.weight, 0);
  return activeComponents.reduce((total, component) => total + component.weight * component.value, 0) / totalWeight;
}

function computeAlertLevel(sigmaShift, alarmSigmaThreshold) {
  const elevatedSigmaThreshold = Math.max(1.5, alarmSigmaThreshold / 2);
  if (sigmaShift >= alarmSigmaThreshold) {
    return "alarm";
  }

  if (sigmaShift >= elevatedSigmaThreshold) {
    return "elevated";
  }

  return "normal";
}

function computeGaugeValue(sigmaShift, alarmSigmaThreshold) {
  if (!alarmSigmaThreshold) {
    return 0;
  }

  const clampedShift = Math.max(0, Math.min(alarmSigmaThreshold, sigmaShift));
  return Math.max(0, Math.min(1, clampedShift / alarmSigmaThreshold));
}

function computeEmergencyLevel(sigmaShift, alarmSigmaThreshold) {
  const normalizedSigma = Math.max(0, Number(sigmaShift || 0));
  if (!alarmSigmaThreshold) {
    return 1;
  }

  if (normalizedSigma >= alarmSigmaThreshold) {
    return 5;
  }

  return Math.min(4, Math.max(1, Math.floor((normalizedSigma / alarmSigmaThreshold) * 4) + 1));
}

function computeBaselineSignal(currentValue, baselineMean, baselineStdDev, alarmSigmaThreshold) {
  if (!baselineStdDev) {
    return {
      sigmaShift: 0,
      gaugeValue: 0,
      alertLevel: "normal",
      emergencyLevel: 1,
    };
  }

  const sigmaShift = (currentValue - baselineMean) / baselineStdDev;
  return {
    sigmaShift,
    gaugeValue: computeGaugeValue(sigmaShift, alarmSigmaThreshold),
    alertLevel: computeAlertLevel(sigmaShift, alarmSigmaThreshold),
    emergencyLevel: computeEmergencyLevel(sigmaShift, alarmSigmaThreshold),
  };
}

function roundNumber(value, decimalPlaces) {
  if (!Number.isFinite(value) || Number.isInteger(value)) {
    return value;
  }

  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

function encodeRuns(values) {
  const runs = [];
  for (const value of values) {
    const previous = runs[runs.length - 1];
    if (previous && previous[0] === value) {
      previous[1] += 1;
    } else {
      runs.push([value, 1]);
    }
  }

  return runs;
}

function buildTimestampDeltaRuns(records) {
  const deltas = [];
  for (let index = 1; index < records.length; index += 1) {
    const previousTimestamp = Date.parse(records[index - 1].sampledAt);
    const currentTimestamp = Date.parse(records[index].sampledAt);

    if (!Number.isFinite(previousTimestamp) || !Number.isFinite(currentTimestamp)) {
      return null;
    }

    deltas.push(currentTimestamp - previousTimestamp);
  }

  return encodeRuns(deltas);
}

function compactArchiveSeries(records) {
  if (!records.length) {
    return {
      v: 1,
      t0: null,
      tr: [],
      c: [],
      p: [],
      s: [],
    };
  }

  const timestampDeltaRuns = buildTimestampDeltaRuns(records);
  if (!timestampDeltaRuns) {
    return records.map((record) => ({
      sampledAt: record.sampledAt,
      concurrentCount: record.concurrentCount,
      predictedConcurrentCount: roundNumber(
        record.expectedConcurrentCount ?? record.predictedConcurrentCount,
        ARCHIVE_DECIMAL_PLACES,
      ),
      predictedConcurrentStdDev: roundNumber(
        record.expectedConcurrentStdDev ?? record.predictedConcurrentStdDev,
        ARCHIVE_DECIMAL_PLACES,
      ),
    }));
  }

  return {
    v: 1,
    t0: records[0].sampledAt,
    tr: timestampDeltaRuns,
    c: records.map((record) => record.concurrentCount),
    p: records.map((record) =>
      roundNumber(record.expectedConcurrentCount ?? record.predictedConcurrentCount, ARCHIVE_DECIMAL_PLACES),
    ),
    s: records.map((record) =>
      roundNumber(record.expectedConcurrentStdDev ?? record.predictedConcurrentStdDev, ARCHIVE_DECIMAL_PLACES),
    ),
  };
}

function roundIsoToNearestHalfHour(referenceIso) {
  const timestamp = Date.parse(referenceIso);
  if (!Number.isFinite(timestamp)) {
    return referenceIso;
  }

  return new Date(Math.round(timestamp / HALF_HOUR_MS) * HALF_HOUR_MS).toISOString();
}

function normalizeSlot(slot) {
  return (slot + 48) % 48;
}

function getSlotFromIso(referenceIso) {
  const date = new Date(referenceIso);
  return date.getUTCHours() * 2 + (date.getUTCMinutes() >= 30 ? 1 : 0);
}

function getWeekdayFromIso(referenceIso) {
  return new Date(referenceIso).getUTCDay();
}

function getNeighborSlots(slot) {
  return [normalizeSlot(slot - 1), normalizeSlot(slot), normalizeSlot(slot + 1)];
}

function trimHistoryQueue(queue, cutoffTimestampMs) {
  while (queue.length && queue[0].timestampMs < cutoffTimestampMs) {
    queue.shift();
  }
}

function computeDecayedMean(entries, referenceTimestampMs, halfLifeDays, valueKey) {
  if (!entries.length) {
    return null;
  }

  const lambda = Math.log(2) / Math.max(0.01, halfLifeDays);
  let totalWeight = 0;
  let weightedSum = 0;

  for (const entry of entries) {
    const value = Number(entry[valueKey]);
    if (!Number.isFinite(value)) {
      continue;
    }

    const ageDays = Math.max(0, (referenceTimestampMs - entry.timestampMs) / DAY_MS);
    const weight = Math.exp(-lambda * ageDays);
    totalWeight += weight;
    weightedSum += weight * value;
  }

  return totalWeight ? weightedSum / totalWeight : null;
}

function computeDecayedRootMeanSquare(entries, referenceTimestampMs, halfLifeDays, valueKey) {
  if (!entries.length) {
    return null;
  }

  const lambda = Math.log(2) / Math.max(0.01, halfLifeDays);
  let totalWeight = 0;
  let weightedSquareSum = 0;

  for (const entry of entries) {
    const value = Number(entry[valueKey]);
    if (!Number.isFinite(value)) {
      continue;
    }

    const ageDays = Math.max(0, (referenceTimestampMs - entry.timestampMs) / DAY_MS);
    const weight = Math.exp(-lambda * ageDays);
    totalWeight += weight;
    weightedSquareSum += weight * value * value;
  }

  return totalWeight ? Math.sqrt(weightedSquareSum / totalWeight) : null;
}

function buildNeighborhoodValue(entriesBySlot, referenceTimestampMs, halfLifeDays, neighborWeight, valueKey) {
  const [previousEntries, currentEntries, nextEntries] = entriesBySlot;
  const value = weightedMean([
    {
      weight: neighborWeight,
      value: computeDecayedMean(previousEntries, referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: 1,
      value: computeDecayedMean(currentEntries, referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: neighborWeight,
      value: computeDecayedMean(nextEntries, referenceTimestampMs, halfLifeDays, valueKey),
    },
  ]);

  const exactSampleCount = currentEntries.length;
  const effectiveSampleCount =
    currentEntries.length + neighborWeight * (previousEntries.length + nextEntries.length);

  return {
    value,
    exactSampleCount,
    effectiveSampleCount,
  };
}

function buildNeighborhoodScale(entriesBySlot, referenceTimestampMs, halfLifeDays, neighborWeight, valueKey) {
  return weightedMean([
    {
      weight: neighborWeight,
      value: computeDecayedRootMeanSquare(entriesBySlot[0], referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: 1,
      value: computeDecayedRootMeanSquare(entriesBySlot[1], referenceTimestampMs, halfLifeDays, valueKey),
    },
    {
      weight: neighborWeight,
      value: computeDecayedRootMeanSquare(entriesBySlot[2], referenceTimestampMs, halfLifeDays, valueKey),
    },
  ]);
}

function trimRelevantHistories(state, weekday, slot, cutoffTimestampMs) {
  for (const neighborSlot of getNeighborSlots(slot)) {
    trimHistoryQueue(state.slotHistory[neighborSlot], cutoffTimestampMs);
    trimHistoryQueue(state.slotResidualHistory[neighborSlot], cutoffTimestampMs);
    trimHistoryQueue(state.weekdaySlotHistory[weekday][neighborSlot], cutoffTimestampMs);
    trimHistoryQueue(state.weekdaySlotResidualHistory[weekday][neighborSlot], cutoffTimestampMs);
  }
}

function buildConcurrentPredictionFromState(referenceIso, concurrentCount, state) {
  const canonicalReferenceIso = roundIsoToNearestHalfHour(referenceIso);
  const referenceTimestampMs = Date.parse(canonicalReferenceIso);
  if (!Number.isFinite(referenceTimestampMs)) {
    return {
      canonicalReferenceIso,
      modelReady: false,
      expectedConcurrentCount: Number(concurrentCount || 0),
      expectedConcurrentStdDev: CONCURRENT_MIN_STD_DEV,
      timeOfDayExpected: null,
      timeOfWeekExpected: null,
      timeOfDaySampleCount: 0,
      timeOfWeekSampleCount: 0,
      timeOfWeekBlendWeight: 0,
      sigmaShift: 0,
      divergence: 0,
    };
  }

  const slot = getSlotFromIso(canonicalReferenceIso);
  const weekday = getWeekdayFromIso(canonicalReferenceIso);
  const cutoffTimestampMs = referenceTimestampMs - CONCURRENT_LOOKBACK_DAYS * DAY_MS;
  trimRelevantHistories(state, weekday, slot, cutoffTimestampMs);

  const neighborSlots = getNeighborSlots(slot);
  const slotCountHistories = neighborSlots.map((neighborSlot) => state.slotHistory[neighborSlot]);
  const weekdaySlotCountHistories = neighborSlots.map(
    (neighborSlot) => state.weekdaySlotHistory[weekday][neighborSlot],
  );
  const slotResidualHistories = neighborSlots.map((neighborSlot) => state.slotResidualHistory[neighborSlot]);
  const weekdaySlotResidualHistories = neighborSlots.map(
    (neighborSlot) => state.weekdaySlotResidualHistory[weekday][neighborSlot],
  );

  const timeOfDayComponent = buildNeighborhoodValue(
    slotCountHistories,
    referenceTimestampMs,
    CONCURRENT_SLOT_HALF_LIFE_DAYS,
    CONCURRENT_SLOT_NEIGHBOR_WEIGHT,
    "count",
  );
  const timeOfWeekComponent = buildNeighborhoodValue(
    weekdaySlotCountHistories,
    referenceTimestampMs,
    CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS,
    CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT,
    "count",
  );

  const timeOfDayResidualScale =
    buildNeighborhoodScale(
      slotResidualHistories,
      referenceTimestampMs,
      CONCURRENT_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_SLOT_NEIGHBOR_WEIGHT,
      "residual",
    ) ??
    buildNeighborhoodScale(
      slotCountHistories,
      referenceTimestampMs,
      CONCURRENT_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_SLOT_NEIGHBOR_WEIGHT,
      "count",
    );
  const timeOfWeekResidualScale =
    buildNeighborhoodScale(
      weekdaySlotResidualHistories,
      referenceTimestampMs,
      CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT,
      "residual",
    ) ??
    buildNeighborhoodScale(
      weekdaySlotCountHistories,
      referenceTimestampMs,
      CONCURRENT_WEEKDAY_SLOT_HALF_LIFE_DAYS,
      CONCURRENT_WEEKDAY_SLOT_NEIGHBOR_WEIGHT,
      "count",
    );

  const timeOfWeekBlendWeight = Math.max(
    0,
    Math.min(
      1,
      timeOfWeekComponent.effectiveSampleCount /
        (timeOfWeekComponent.effectiveSampleCount + CONCURRENT_WEEKDAY_SHRINKAGE),
    ),
  );
  const expectedConcurrentCount =
    weightedMean([
      { weight: 1 - timeOfWeekBlendWeight, value: timeOfDayComponent.value },
      { weight: timeOfWeekBlendWeight, value: timeOfWeekComponent.value },
    ]) ?? Number(concurrentCount || 0);
  const expectedConcurrentStdDev = Math.max(
    CONCURRENT_MIN_STD_DEV,
    weightedMean([
      { weight: 1 - timeOfWeekBlendWeight, value: timeOfDayResidualScale },
      { weight: timeOfWeekBlendWeight, value: timeOfWeekResidualScale },
    ]) ?? CONCURRENT_MIN_STD_DEV,
  );
  const modelReady =
    state.historySampleCount >= CONCURRENT_MIN_HISTORY_SAMPLES &&
    (Number.isFinite(timeOfDayComponent.value) || Number.isFinite(timeOfWeekComponent.value));
  const divergence = modelReady ? Number(concurrentCount || 0) - expectedConcurrentCount : 0;
  const sigmaShift = modelReady ? divergence / expectedConcurrentStdDev : 0;

  return {
    canonicalReferenceIso,
    modelReady,
    slot,
    weekday,
    timeOfDayExpected: timeOfDayComponent.value,
    timeOfWeekExpected: timeOfWeekComponent.value,
    timeOfDayResidualScale,
    timeOfWeekResidualScale,
    timeOfDaySampleCount: timeOfDayComponent.exactSampleCount,
    timeOfWeekSampleCount: timeOfWeekComponent.exactSampleCount,
    timeOfWeekBlendWeight,
    expectedConcurrentCount: modelReady ? expectedConcurrentCount : Number(concurrentCount || 0),
    expectedConcurrentStdDev: modelReady ? expectedConcurrentStdDev : CONCURRENT_MIN_STD_DEV,
    sigmaShift,
    divergence,
  };
}

function calibrateConcurrentAlarmThreshold(records) {
  if (!records.length) {
    return DEFAULT_ALARM_SIGMA_THRESHOLD;
  }

  const latestTimestamp = Date.parse(records[records.length - 1].sampledAt);
  const lowerBound = latestTimestamp - 365 * DAY_MS;
  const dailyPeaks = new Map();

  for (const record of records) {
    const sampledAtMs = Date.parse(record.sampledAt);
    if (!Number.isFinite(sampledAtMs) || sampledAtMs < lowerBound || !record.modelReady) {
      continue;
    }

    const day = record.sampledAt.slice(0, 10);
    dailyPeaks.set(day, Math.max(dailyPeaks.get(day) ?? -Infinity, record.sigmaShift));
  }

  const sortedPeaks = Array.from(dailyPeaks.values()).sort((left, right) => right - left);
  if (!sortedPeaks.length) {
    return DEFAULT_ALARM_SIGMA_THRESHOLD;
  }

  if (sortedPeaks.length === 1) {
    return Math.max(MIN_ALARM_SIGMA_THRESHOLD, Math.ceil(sortedPeaks[0] * 10) / 10);
  }

  const secondHighestPeak = sortedPeaks[1];
  return Math.max(MIN_ALARM_SIGMA_THRESHOLD, Math.ceil((secondHighestPeak + 0.05) * 10) / 10);
}

function buildConcurrentPredictionContext(rows) {
  const normalizedRows = rows.map((row) => ({
    sampledAt: row.sampledAt,
    concurrentCount: Number(row.concurrentCount || 0),
  }));
  const state = {
    slotHistory: Array.from({ length: 48 }, () => []),
    weekdaySlotHistory: Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => [])),
    slotResidualHistory: Array.from({ length: 48 }, () => []),
    weekdaySlotResidualHistory: Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => [])),
    historySampleCount: 0,
    alarmSigmaThreshold: DEFAULT_ALARM_SIGMA_THRESHOLD,
  };
  const provisionalRecords = [];

  for (const row of normalizedRows) {
    const prediction = buildConcurrentPredictionFromState(row.sampledAt, row.concurrentCount, state);
    provisionalRecords.push({
      sampledAt: row.sampledAt,
      concurrentCount: row.concurrentCount,
      ...prediction,
    });

    const timestampMs = Date.parse(row.sampledAt);
    const historyEntry = {
      timestampMs,
      count: row.concurrentCount,
    };
    state.slotHistory[prediction.slot].push(historyEntry);
    state.weekdaySlotHistory[prediction.weekday][prediction.slot].push(historyEntry);

    if (prediction.modelReady) {
      const residualEntry = {
        timestampMs,
        residual: prediction.divergence,
      };
      state.slotResidualHistory[prediction.slot].push(residualEntry);
      state.weekdaySlotResidualHistory[prediction.weekday][prediction.slot].push(residualEntry);
    }

    state.historySampleCount += 1;
  }

  const alarmSigmaThreshold = calibrateConcurrentAlarmThreshold(provisionalRecords);
  state.alarmSigmaThreshold = alarmSigmaThreshold;
  const elevatedSigmaThreshold = Math.max(1.5, alarmSigmaThreshold / 2);
  const records = provisionalRecords.map((record) => ({
    ...record,
    ...computeBaselineSignal(
      Number(record.concurrentCount || 0),
      Number(record.expectedConcurrentCount || 0),
      Number(record.expectedConcurrentStdDev || CONCURRENT_MIN_STD_DEV),
      alarmSigmaThreshold,
    ),
  }));
  const bySampledAt = new Map(records.map((record) => [record.sampledAt, record]));

  return {
    records,
    bySampledAt,
    alarmSigmaThreshold,
    elevatedSigmaThreshold,
    state,
  };
}

function getNearestConcurrentRecord(context, referenceIso) {
  const exactMatch = context.bySampledAt.get(referenceIso);
  if (exactMatch) {
    return exactMatch;
  }

  const referenceTimestamp = Date.parse(referenceIso);
  if (!Number.isFinite(referenceTimestamp)) {
    return null;
  }

  let nearestRecord = null;
  let nearestDifferenceMs = Number.POSITIVE_INFINITY;
  for (const record of context.records) {
    const differenceMs = Math.abs(Date.parse(record.sampledAt) - referenceTimestamp);
    if (differenceMs < nearestDifferenceMs) {
      nearestDifferenceMs = differenceMs;
      nearestRecord = record;
    }
  }

  return nearestDifferenceMs <= MATCH_WINDOW_MS ? nearestRecord : null;
}

function computeConcurrentPredictionModel(referenceIso, concurrentCount, concurrentContext = null) {
  const context = concurrentContext || buildConcurrentPredictionContext(getAllRollingMetrics());
  const referenceRecord = getNearestConcurrentRecord(context, referenceIso);

  if (referenceRecord) {
    const resolvedConcurrentCount = Number(concurrentCount ?? referenceRecord.concurrentCount ?? 0);
    const compositeSignal = computeBaselineSignal(
      resolvedConcurrentCount,
      Number(referenceRecord.expectedConcurrentCount || 0),
      Number(referenceRecord.expectedConcurrentStdDev || CONCURRENT_MIN_STD_DEV),
      context.alarmSigmaThreshold,
    );

    return {
      ...referenceRecord,
      concurrentCount: resolvedConcurrentCount,
      divergence: resolvedConcurrentCount - Number(referenceRecord.expectedConcurrentCount || 0),
      sigmaShift: compositeSignal.sigmaShift,
      gaugeValue: compositeSignal.gaugeValue,
      alertLevel: compositeSignal.alertLevel,
      emergencyLevel: compositeSignal.emergencyLevel,
      alarmSigmaThreshold: context.alarmSigmaThreshold,
      elevatedSigmaThreshold: context.elevatedSigmaThreshold,
      compositeSignal,
    };
  }

  const prediction = buildConcurrentPredictionFromState(referenceIso, concurrentCount, context.state);
  const compositeSignal = computeBaselineSignal(
    Number(concurrentCount || 0),
    Number(prediction.expectedConcurrentCount || 0),
    Number(prediction.expectedConcurrentStdDev || CONCURRENT_MIN_STD_DEV),
    context.alarmSigmaThreshold,
  );

  return {
    ...prediction,
    alarmSigmaThreshold: context.alarmSigmaThreshold,
    elevatedSigmaThreshold: context.elevatedSigmaThreshold,
    compositeSignal,
  };
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
    concurrentCount: null,
    ...savedStatus,
    latestSampledAt: getMetaValue(META_SAMPLED_AT),
    latestSlotKey: getMetaValue(META_SLOT_KEY),
    latestUrl: getMetaValue(META_URL),
    cachePath: getMetaValue(META_CACHE_PATH),
    ...overrides,
  };
}

function getTrailingConcurrentRecords(records, days = 365) {
  if (!records.length) {
    return [];
  }

  const latestTimestamp = Date.parse(records[records.length - 1].sampledAt);
  const lowerBound = latestTimestamp - days * DAY_MS;
  return records.filter((record) => Date.parse(record.sampledAt) >= lowerBound);
}

function buildDashboardPayload({ liveStatus: liveStatusOverride = null } = {}) {
  const tracking = getTrackingSummary();
  const liveStatus = buildStoredHeatmapStatus(liveStatusOverride || {});
  const referenceIso = liveStatus.latestSampledAt || new Date().toISOString();
  const concurrentCount = getConcurrentCount(HEATMAP_SOURCE);
  const rollingHistory = getAllRollingMetrics();
  const concurrentContext = buildConcurrentPredictionContext(rollingHistory);
  const currentModel = computeConcurrentPredictionModel(referenceIso, concurrentCount, concurrentContext);
  const archiveSeries = compactArchiveSeries(getTrailingConcurrentRecords(concurrentContext.records));

  return {
    mode: tracking.configured ? "configured" : "empty",
    warning: tracking.configured ? null : tracking.reason,
    cohort: tracking,
    watchlist: tracking,
    liveStatus: {
      ...liveStatus,
      concurrentCount,
    },
    current: {
      asOf: referenceIso,
      concurrentCount,
      baselineMean: currentModel.expectedConcurrentCount,
      baselineStdDev: currentModel.expectedConcurrentStdDev,
      zScore: currentModel.compositeSignal.sigmaShift,
      gaugeValue: currentModel.compositeSignal.gaugeValue,
      alertLevel: currentModel.compositeSignal.alertLevel,
      emergencyLevel: currentModel.compositeSignal.emergencyLevel,
      alarmSigmaThreshold: currentModel.alarmSigmaThreshold,
      elevatedSigmaThreshold: currentModel.elevatedSigmaThreshold,
    },
    signals: {
      composite: {
        asOf: referenceIso,
        actualConcurrentCount: concurrentCount,
        expectedConcurrentCount: currentModel.expectedConcurrentCount,
        expectedConcurrentStdDev: currentModel.expectedConcurrentStdDev,
        timeOfDayExpected: currentModel.timeOfDayExpected,
        timeOfWeekExpected: currentModel.timeOfWeekExpected,
        timeOfDaySampleCount: currentModel.timeOfDaySampleCount,
        timeOfWeekSampleCount: currentModel.timeOfWeekSampleCount,
        timeOfWeekBlendWeight: currentModel.timeOfWeekBlendWeight,
        sigmaShift: currentModel.compositeSignal.sigmaShift,
        gaugeValue: currentModel.compositeSignal.gaugeValue,
        alertLevel: currentModel.compositeSignal.alertLevel,
        emergencyLevel: currentModel.compositeSignal.emergencyLevel,
        alarmSigmaThreshold: currentModel.alarmSigmaThreshold,
        elevatedSigmaThreshold: currentModel.elevatedSigmaThreshold,
      },
    },
    liveAircraft: getLiveAircraft(HEATMAP_SOURCE),
    trends: {
      archive: archiveSeries,
    },
  };
}

function buildDashboardSnapshot({ liveStatus = null, snapshotGeneratedAt = new Date().toISOString() } = {}) {
  const trackedCount = getTrackedAircraftCount();
  const hasAnyHistoricalData = getAllRollingMetrics().length > 0;
  const onlyDemoData = areAllTrackedAircraftDemo();

  if ((!trackedCount && !hasAnyHistoricalData) || onlyDemoData) {
    const demoDashboard = getDemoDashboard();
    return {
      ...demoDashboard,
      trends: {
        ...demoDashboard.trends,
        archive: compactArchiveSeries(demoDashboard.trends?.archive ?? []),
      },
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
  buildConcurrentPredictionContext,
  computeConcurrentPredictionModel,
  HEATMAP_SOURCE,
};
