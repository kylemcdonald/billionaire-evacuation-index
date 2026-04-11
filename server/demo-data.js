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
  const rollingSeries = createSeries(48, 11, 2.5, 0.02);
  const dailySeries = createSeries(365, 9, 3.5, 0.01);
  const currentRolling24hCount = 17;
  const currentConcurrentCount = 6;
  const baselineMean = 11.2;
  const baselineStdDev = 2.4;
  const expectedConcurrentCount = 5.2;
  const expectedConcurrentStdDev = 0.9;
  const zScore = (currentConcurrentCount - expectedConcurrentCount) / expectedConcurrentStdDev;
  const yearAgoCount = 12;
  const yearAgoDelta = currentRolling24hCount - yearAgoCount;
  const weekdayRollingMean = 11.2;
  const timeOfDayConcurrentMean = 5.1;
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
      rolling24hCount: currentRolling24hCount,
      concurrentCount: 6,
    },
    current: {
      asOf: new Date().toISOString(),
      rolling24hCount: currentRolling24hCount,
      concurrentCount: currentConcurrentCount,
      baselineMean: expectedConcurrentCount,
      baselineStdDev: expectedConcurrentStdDev,
      zScore,
      gaugeValue: Math.max(0, Math.min(1, 0.5 + 0.25 * zScore)),
      alertLevel: zScore >= 2 ? "alarm" : zScore >= 1 ? "elevated" : "normal",
    },
    signals: {
      composite: {
        asOf: new Date().toISOString(),
        actualConcurrentCount: currentConcurrentCount,
        expectedConcurrentCount,
        expectedConcurrentStdDev,
        blendedRollingBaseline: currentRolling24hCount,
        sigmaShift: zScore,
        gaugeValue: Math.max(0, Math.min(1, 0.5 + 0.25 * zScore)),
        alertLevel: zScore >= 2 ? "alarm" : zScore >= 1 ? "elevated" : "normal",
      },
      weekday: {
        asOf: new Date().toISOString(),
        currentRolling24hCount,
        baselineMean: weekdayRollingMean,
        baselineStdDev: baselineStdDev,
        sampleCount: 4,
        sigmaShift: (currentRolling24hCount - weekdayRollingMean) / baselineStdDev,
        gaugeValue: Math.max(0, Math.min(1, 0.5 + 0.25 * ((currentRolling24hCount - weekdayRollingMean) / baselineStdDev))),
        alertLevel:
          (currentRolling24hCount - weekdayRollingMean) / baselineStdDev >= 2
            ? "alarm"
            : (currentRolling24hCount - weekdayRollingMean) / baselineStdDev >= 1
              ? "elevated"
              : "normal",
      },
      yearAgo: {
        asOf: new Date().toISOString(),
        currentRolling24hCount,
        referenceCount: yearAgoCount,
        referenceSampledAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        referenceTargetAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        differenceSeconds: 0,
        deltaCount: yearAgoDelta,
        percentChange: yearAgoDelta / yearAgoCount,
        sigmaShift: yearAgoDelta / baselineStdDev,
        gaugeValue: Math.max(0, Math.min(1, 0.5 + yearAgoDelta / baselineStdDev / 4)),
        alertLevel: yearAgoDelta / baselineStdDev >= 2 ? "alarm" : yearAgoDelta / baselineStdDev >= 1 ? "elevated" : "normal",
      },
      timeOfDay: {
        asOf: new Date().toISOString(),
        actualConcurrentCount: currentConcurrentCount,
        concurrentMean: timeOfDayConcurrentMean,
        concurrentStdDev: 0.8,
        rollingMean: currentRolling24hCount,
        ratioMean: timeOfDayConcurrentMean / currentRolling24hCount,
        ratioStdDev: 0.03,
        sampleCount: 7,
        sigmaShift: (currentConcurrentCount - timeOfDayConcurrentMean) / 0.8,
        gaugeValue: Math.max(0, Math.min(1, 0.5 + 0.25 * ((currentConcurrentCount - timeOfDayConcurrentMean) / 0.8))),
        alertLevel:
          (currentConcurrentCount - timeOfDayConcurrentMean) / 0.8 >= 2
            ? "alarm"
            : (currentConcurrentCount - timeOfDayConcurrentMean) / 0.8 >= 1
              ? "elevated"
              : "normal",
      },
    },
    liveAircraft: [
      {
        hex: "d3m001",
        registration: "N-DEMO1",
        label: "Cohort 01",
        observedAt: new Date().toISOString(),
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
        observedAt: new Date().toISOString(),
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
        observedAt: new Date().toISOString(),
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
        observedAt: new Date().toISOString(),
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
        observedAt: new Date().toISOString(),
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
        observedAt: new Date().toISOString(),
        lat: -33.8688,
        lon: 151.2093,
        altitudeFt: 35400,
        groundSpeedKt: 433,
        track: 294,
        isAirborne: true,
      },
    ],
    trends: {
      daily: dailySeries.map((value, index) => {
        const day = new Date(Date.now() - (364 - index) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        return {
          day,
          uniqueAirborneCount: value,
          peakConcurrentCount: Math.max(2, Math.round(value * 0.55)),
          peakRolling24hCount: Math.max(value, Math.round(value + 1.5)),
          sampleCount: 48,
        };
      }),
      rolling: rollingSeries.map((value, index) => {
        const sampledAt = new Date(Date.now() - (47 - index) * 30 * 60 * 1000).toISOString();
        const concurrentCount = Math.max(1, Math.round(value * 0.45));
        return {
          sampledAt,
          rolling24hCount: value,
          concurrentCount,
          predictedConcurrentCount: Math.max(1, Math.round(concurrentCount * 0.92 + ((index % 6) - 2) * 0.6)),
        };
      }),
    },
  };
}

module.exports = {
  getDemoDashboard,
};
