const {
  initDb,
  getDb,
  getRecentWeekdayBaselineStats,
  getRecentTimeOfDayBaseline,
  getRollingMetricNear,
} = require("../server/db");

const DAY_MS = 24 * 60 * 60 * 1000;

function average(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) {
    return null;
  }

  return finiteValues.reduce((total, value) => total + value, 0) / finiteValues.length;
}

function predictConcurrent(referenceIso) {
  const recentWeekdayBaseline = getRecentWeekdayBaselineStats(referenceIso, 4);
  const recentTimeOfDayBaseline = getRecentTimeOfDayBaseline(referenceIso, 7);
  const yearAgoTargetAt = new Date(new Date(referenceIso).getTime() - 365 * DAY_MS).toISOString();
  const yearAgoReference = getRollingMetricNear(yearAgoTargetAt);
  const yearAgoRollingCount = yearAgoReference?.rolling24hCount ?? null;
  const blendedRollingBaseline =
    average([recentWeekdayBaseline.mean || null, yearAgoRollingCount]) ??
    recentTimeOfDayBaseline.rollingMean ??
    null;
  const ratioMean = recentTimeOfDayBaseline.ratioMean || 0;

  return blendedRollingBaseline && ratioMean
    ? blendedRollingBaseline * ratioMean
    : recentTimeOfDayBaseline.concurrentMean || null;
}

function computeMedian(sortedValues) {
  if (!sortedValues.length) {
    return null;
  }

  const midpoint = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 0
    ? (sortedValues[midpoint - 1] + sortedValues[midpoint]) / 2
    : sortedValues[midpoint];
}

initDb();
const db = getDb();
const rows = db
  .prepare(`
    SELECT sampled_at AS sampledAt, concurrent_count AS concurrentCount
    FROM rolling_metrics
    WHERE sampled_at >= datetime((SELECT max(sampled_at) FROM rolling_metrics), ?)
    ORDER BY sampled_at ASC
  `)
  .all("-7 days");

const evaluations = rows
  .map((row) => {
    const predicted = Number(predictConcurrent(row.sampledAt));
    if (!Number.isFinite(predicted)) {
      return null;
    }

    const actual = Number(row.concurrentCount || 0);
    const error = actual - predicted;
    const absoluteError = Math.abs(error);
    const absolutePercentageError = actual > 0 ? absoluteError / actual : null;

    return {
      sampledAt: row.sampledAt,
      actual,
      predicted,
      error,
      absoluteError,
      absolutePercentageError,
    };
  })
  .filter(Boolean);

const count = evaluations.length;
const absoluteErrors = evaluations.map((row) => row.absoluteError).sort((left, right) => left - right);
const mapeRows = evaluations.filter((row) => row.absolutePercentageError != null);
const worstCase = evaluations.reduce(
  (worst, row) => (row.absoluteError > worst.absoluteError ? row : worst),
  evaluations[0],
);

const summary = {
  count,
  windowStart: evaluations[0]?.sampledAt ?? null,
  windowEnd: evaluations[count - 1]?.sampledAt ?? null,
  mae: evaluations.reduce((total, row) => total + row.absoluteError, 0) / count,
  rmse: Math.sqrt(evaluations.reduce((total, row) => total + row.error * row.error, 0) / count),
  bias: evaluations.reduce((total, row) => total + row.error, 0) / count,
  medianAbsoluteError: computeMedian(absoluteErrors),
  mape:
    mapeRows.reduce((total, row) => total + row.absolutePercentageError, 0) /
    Math.max(1, mapeRows.length),
  actualMean: evaluations.reduce((total, row) => total + row.actual, 0) / count,
  predictedMean: evaluations.reduce((total, row) => total + row.predicted, 0) / count,
  worstCase,
};

console.log(JSON.stringify(summary, null, 2));
