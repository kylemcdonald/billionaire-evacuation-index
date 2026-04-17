function createSeries(length, startValue, noise, trend = 0) {
  const values = [];
  let current = startValue;

  for (let index = 0; index < length; index += 1) {
    current += trend + (Math.sin(index / 3) * noise) / 2 + ((index % 5) - 2) * (noise / 8);
    values.push(Math.max(1, Math.round(current)));
  }

  return values;
}

function getDemoDashboard() {
  const archiveSeries = createSeries(365 * 48, 8, 1.6, 0.001);
  const currentConcurrentCount = 6;
  const expectedConcurrentCount = 5.2;
  const expectedConcurrentStdDev = 0.9;
  const zScore = (currentConcurrentCount - expectedConcurrentCount) / expectedConcurrentStdDev;
  const alarmSigmaThreshold = 7.0;
  const elevatedSigmaThreshold = 3.5;
  const emergencyLevel = zScore >= alarmSigmaThreshold ? 5 : Math.min(4, Math.max(1, Math.floor((Math.max(0, zScore) / alarmSigmaThreshold) * 4) + 1));
  const cohort = {
    configured: false,
    trackedCount: 0,
    reason: "Run `npm run import:faa` to switch from demo mode to real tracking.",
  };

  return {
    mode: "demo",
    warning: "No cohort has been imported yet. This dashboard is showing synthetic review data.",
    cohort,
    watchlist: cohort,
    liveStatus: {
      provider: "adsbx_heatmap",
      providerLabel: "ADS-B Exchange heatmap",
      cadenceMinutes: 30,
      refreshing: false,
      nextRefreshAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      latestSampledAt: new Date().toISOString(),
      latestSlotKey: "demo",
      latestUrl: null,
      cachePath: null,
      usedCache: true,
      matchedCount: 6,
      airborneCount: 6,
      concurrentCount: 6,
    },
    current: {
      asOf: new Date().toISOString(),
      concurrentCount: currentConcurrentCount,
      baselineMean: expectedConcurrentCount,
      baselineStdDev: expectedConcurrentStdDev,
      zScore,
      gaugeValue: Math.max(0, Math.min(1, 0.5 + 0.25 * zScore)),
      alertLevel: zScore >= 2 ? "alarm" : zScore >= 1 ? "elevated" : "normal",
      emergencyLevel,
      alarmSigmaThreshold,
      elevatedSigmaThreshold,
    },
    signals: {
      composite: {
        asOf: new Date().toISOString(),
        actualConcurrentCount: currentConcurrentCount,
        expectedConcurrentCount,
        expectedConcurrentStdDev,
        timeOfDayExpected: 5.0,
        timeOfWeekExpected: 5.4,
        timeOfDaySampleCount: 28,
        timeOfWeekSampleCount: 4,
        timeOfWeekBlendWeight: 0.67,
        sigmaShift: zScore,
        gaugeValue: Math.max(0, Math.min(1, 0.5 + 0.25 * zScore)),
        alertLevel: zScore >= 2 ? "alarm" : zScore >= 1 ? "elevated" : "normal",
        emergencyLevel,
        alarmSigmaThreshold,
        elevatedSigmaThreshold,
      },
    },
    liveAircraft: [
      {
        hex: "d3m001",
        registration: "N-DEMO1",
        label: "Cohort 01",
        observed_at: new Date().toISOString(),
        lat: 40.7128,
        lon: -74.006,
        altitudeFt: 39000,
        groundSpeedKt: 441,
        track: 84,
        isAirborne: true,
      },
      {
        hex: "d3m002",
        registration: "N-DEMO2",
        label: "Cohort 02",
        observed_at: new Date().toISOString(),
        lat: 51.5072,
        lon: -0.1276,
        altitudeFt: 41000,
        groundSpeedKt: 458,
        track: 118,
        isAirborne: true,
      },
      {
        hex: "d3m003",
        registration: "N-DEMO3",
        label: "Cohort 03",
        observed_at: new Date().toISOString(),
        lat: 25.2048,
        lon: 55.2708,
        altitudeFt: 38200,
        groundSpeedKt: 429,
        track: 303,
        isAirborne: true,
      },
      {
        hex: "d3m004",
        registration: "N-DEMO4",
        label: "Cohort 04",
        observed_at: new Date().toISOString(),
        lat: -23.5505,
        lon: -46.6333,
        altitudeFt: 36700,
        groundSpeedKt: 417,
        track: 47,
        isAirborne: true,
      },
      {
        hex: "d3m005",
        registration: "N-DEMO5",
        label: "Cohort 05",
        observed_at: new Date().toISOString(),
        lat: 35.6764,
        lon: 139.65,
        altitudeFt: 40100,
        groundSpeedKt: 447,
        track: 211,
        isAirborne: true,
      },
      {
        hex: "d3m006",
        registration: "N-DEMO6",
        label: "Cohort 06",
        observed_at: new Date().toISOString(),
        lat: -33.8688,
        lon: 151.2093,
        altitudeFt: 35400,
        groundSpeedKt: 433,
        track: 294,
        isAirborne: true,
      },
    ],
    trends: {
      archive: archiveSeries.map((value, index) => {
        const sampledAt = new Date(Date.now() - (archiveSeries.length - 1 - index) * 30 * 60 * 1000).toISOString();
        const concurrentCount = Math.max(1, Math.round(value * (0.65 + Math.sin(index / 24) * 0.08)));
        const predictedConcurrentCount = Math.max(
          1,
          Math.round(concurrentCount * 0.94 + Math.sin(index / 33) * 2),
        );
        return {
          sampledAt,
          concurrentCount,
          predictedConcurrentCount,
          divergence: concurrentCount - predictedConcurrentCount,
        };
      }),
    },
  };
}

module.exports = {
  getDemoDashboard,
};
