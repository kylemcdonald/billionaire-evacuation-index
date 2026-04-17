const { initDb, getAllRollingMetrics } = require("../server/db");
const { buildConcurrentPredictionContext } = require("../server/dashboard");

function summarizeErrors(rows, actualKey, predictedKey) {
  const evaluations = rows
    .map((row) => {
      const actual = Number(row[actualKey] || 0);
      const predicted = Number(row[predictedKey] || 0);
      if (!Number.isFinite(actual) || !Number.isFinite(predicted)) {
        return null;
      }

      const error = actual - predicted;
      return {
        actual,
        predicted,
        error,
        absoluteError: Math.abs(error),
      };
    })
    .filter(Boolean);

  if (!evaluations.length) {
    return {
      count: 0,
      mae: null,
      rmse: null,
      bias: null,
    };
  }

  return {
    count: evaluations.length,
    mae: evaluations.reduce((total, row) => total + row.absoluteError, 0) / evaluations.length,
    rmse: Math.sqrt(evaluations.reduce((total, row) => total + row.error * row.error, 0) / evaluations.length),
    bias: evaluations.reduce((total, row) => total + row.error, 0) / evaluations.length,
  };
}

function buildConcurrentSummary() {
  const context = buildConcurrentPredictionContext(getAllRollingMetrics());
  const latestTimestamp = Date.parse(context.records[context.records.length - 1]?.sampledAt || 0);
  const lowerBound = latestTimestamp - 365 * 24 * 60 * 60 * 1000;
  const recentRecords = context.records.filter(
    (record) => Date.parse(record.sampledAt) >= lowerBound && record.modelReady,
  );
  const dailyPeaks = new Map();

  for (const record of recentRecords) {
    const day = record.sampledAt.slice(0, 10);
    dailyPeaks.set(day, Math.max(dailyPeaks.get(day) ?? -Infinity, record.sigmaShift));
  }

  const sortedDailyPeaks = Array.from(dailyPeaks.entries()).sort((left, right) => right[1] - left[1]);

  return {
    ...summarizeErrors(recentRecords, "concurrentCount", "expectedConcurrentCount"),
    sampleCount: recentRecords.length,
    windowStart: recentRecords[0]?.sampledAt ?? null,
    windowEnd: recentRecords[recentRecords.length - 1]?.sampledAt ?? null,
    alarmSigmaThreshold: context.alarmSigmaThreshold,
    redDaysAtThreshold: Array.from(dailyPeaks.values()).filter(
      (value) => value >= context.alarmSigmaThreshold,
    ).length,
    topDailyPeaks: sortedDailyPeaks.slice(0, 10),
  };
}

initDb();

console.log(
  JSON.stringify(
    {
      concurrent: buildConcurrentSummary(),
    },
    null,
    2,
  ),
);
