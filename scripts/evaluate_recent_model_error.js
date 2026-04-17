const {
  initDb,
  getDb,
  getAllRollingMetrics,
} = require("../server/db");
const {
  buildConcurrentPredictionContext,
  computeConcurrentPredictionModel,
} = require("../server/dashboard");

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
const concurrentContext = buildConcurrentPredictionContext(getAllRollingMetrics());
const rows = db
  .prepare(`
    SELECT sampled_at AS sampledAt, rolling_24h_count AS rolling24hCount, concurrent_count AS concurrentCount
    FROM rolling_metrics
    WHERE sampled_at >= datetime((SELECT max(sampled_at) FROM rolling_metrics), ?)
    ORDER BY sampled_at ASC
  `)
  .all("-7 days");

const evaluations = rows
  .map((row) => {
    const predicted = Number(
      computeConcurrentPredictionModel(
        row.sampledAt,
        Number(row.concurrentCount || 0),
        concurrentContext,
      )
        .expectedConcurrentCount,
    );
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
