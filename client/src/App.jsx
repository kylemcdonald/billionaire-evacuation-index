import { startTransition, useDeferredValue, useEffect, useEffectEvent, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { geoEqualEarth, geoGraticule10, geoMercator, geoPath } from 'd3-geo'
import { feature } from 'topojson-client'
import worldAtlas from 'world-atlas/countries-110m.json'
import './App.css'

const DASHBOARD_URL = import.meta.env.VITE_DASHBOARD_URL || '/api/dashboard'
const DASHBOARD_CACHE_BUSTER_MINUTES = 5
const DASHBOARD_POLL_INTERVAL_MS = 5 * 60_000
const MAP_WIDTH = 800
const MAP_HEIGHT = 410
const ARCHIVE_DAY_MS = 24 * 60 * 60 * 1000
const worldGeographies = feature(worldAtlas, worldAtlas.objects.countries).features

const NARROW_HISTORY_BREAKPOINT = 820
const CHART_TICK_COLOR = '#000000'
const CHART_GRID_COLOR = '#d4d4d4'
const CHART_PRIMARY_COLOR = '#0000ee'
const CHART_SECONDARY_COLOR = '#808080'
const CHART_TOOLTIP_STYLE = {
  background: '#ffffff',
  border: '1px solid #999999',
  borderRadius: '0',
  color: '#000000',
}
const WORLD_FEATURE_COLLECTION = { type: 'FeatureCollection', features: worldGeographies }
const BACKGROUND_URL = '/backgrounds/soft-cartoon-tile-15.png'

function formatCount(value) {
  return new Intl.NumberFormat().format(Math.round(value || 0))
}

function formatDelta(value) {
  if (!Number.isFinite(value)) {
    return '0'
  }

  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded}`
}

function formatSigned(value) {
  if (!Number.isFinite(value)) {
    return '0.0σ'
  }

  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}σ`
}

function roundDateToNearestHalfHour(value) {
  const date = new Date(value)
  const timestamp = date.getTime()
  if (!Number.isFinite(timestamp)) {
    return null
  }

  return new Date(Math.round(timestamp / (30 * 60 * 1000)) * 30 * 60 * 1000)
}

function formatTimestamp(value) {
  if (!value) {
    return 'No timestamp'
  }

  const roundedDate = roundDateToNearestHalfHour(value)
  if (!roundedDate) {
    return 'No timestamp'
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(roundedDate)
}

function formatArchiveRangeDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

function formatArchiveTick(value, windowDays) {
  const date = new Date(value)
  if (windowDays <= 2) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)
  }

  if (windowDays <= 30) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    }).format(date)
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function formatAltitude(value) {
  if (!Number.isFinite(value)) {
    return 'n/a'
  }

  return `${Math.round(value / 100) * 100} ft`
}

function formatSpeed(value) {
  if (!Number.isFinite(value)) {
    return 'n/a'
  }

  return `${Math.round(value)} kt`
}

function formatCoordinate(value, positiveHemisphere, negativeHemisphere) {
  if (!Number.isFinite(value)) {
    return 'n/a'
  }

  const hemisphere = value >= 0 ? positiveHemisphere : negativeHemisphere
  return `${Math.abs(value).toFixed(2)}° ${hemisphere}`
}

function formatCoordinates(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return 'n/a'
  }

  return `${formatCoordinate(lat, 'N', 'S')}, ${formatCoordinate(lon, 'E', 'W')}`
}

function normalizeModelLabel(value) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized || 'Unknown model'
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function findFirstIndexAtOrAfter(values, target) {
  let low = 0
  let high = values.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (values[mid] < target) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  return clamp(low, 0, Math.max(0, values.length - 1))
}

function findLastIndexAtOrBefore(values, target) {
  let low = 0
  let high = values.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (values[mid] <= target) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  return clamp(low - 1, 0, Math.max(0, values.length - 1))
}

function downsampleArchiveSeries(series, maxPoints = 960) {
  if (series.length <= maxPoints) {
    return series
  }

  const bucketCount = Math.max(1, Math.floor(maxPoints / 4))
  const bucketSize = Math.ceil(series.length / bucketCount)
  const selectedIndexes = new Set([0, series.length - 1])

  for (let bucketStart = 0; bucketStart < series.length; bucketStart += bucketSize) {
    const bucketEnd = Math.min(series.length, bucketStart + bucketSize)
    let maxConcurrentIndex = bucketStart
    let maxPositiveDivergenceIndex = bucketStart
    let maxNegativeDivergenceIndex = bucketStart

    for (let index = bucketStart + 1; index < bucketEnd; index += 1) {
      if ((series[index].concurrentCount ?? 0) > (series[maxConcurrentIndex].concurrentCount ?? 0)) {
        maxConcurrentIndex = index
      }
      if ((series[index].divergence ?? 0) > (series[maxPositiveDivergenceIndex].divergence ?? 0)) {
        maxPositiveDivergenceIndex = index
      }
      if ((series[index].divergence ?? 0) < (series[maxNegativeDivergenceIndex].divergence ?? 0)) {
        maxNegativeDivergenceIndex = index
      }
    }

    selectedIndexes.add(bucketStart)
    selectedIndexes.add(bucketEnd - 1)
    selectedIndexes.add(maxConcurrentIndex)
    selectedIndexes.add(maxPositiveDivergenceIndex)
    selectedIndexes.add(maxNegativeDivergenceIndex)
  }

  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => series[index])
}

function useIsNarrowLayout(breakpoint = NARROW_HISTORY_BREAKPOINT) {
  const [isNarrowLayout, setIsNarrowLayout] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }

    return window.innerWidth <= breakpoint
  })

  useEffect(() => {
    function updateLayoutMode() {
      setIsNarrowLayout(window.innerWidth <= breakpoint)
    }

    updateLayoutMode()
    window.addEventListener('resize', updateLayoutMode)
    return () => {
      window.removeEventListener('resize', updateLayoutMode)
    }
  }, [breakpoint])

  return isNarrowLayout
}

function buildLiveModelSummary(aircraft) {
  const grouped = new Map()

  for (const plane of aircraft) {
    const modelLabel = normalizeModelLabel(plane.label || plane.registration || plane.hex?.toUpperCase())
    const existing = grouped.get(modelLabel) || { modelLabel, count: 0 }
    existing.count += 1
    grouped.set(modelLabel, existing)
  }

  return Array.from(grouped.values())
    .sort((left, right) => right.count - left.count || left.modelLabel.localeCompare(right.modelLabel))
    .map((entry, index, entries) => {
      const total = aircraft.length || 1
      return {
        ...entry,
        rank: index + 1,
        share: entry.count / total,
        totalModels: entries.length,
      }
    })
}

function buildDashboardRequestUrl() {
  const url = new URL(DASHBOARD_URL, window.location.href)
  const bucketMs = DASHBOARD_CACHE_BUSTER_MINUTES * 60 * 1000
  url.searchParams.set('v', String(Math.floor(Date.now() / bucketMs)))
  return url.toString()
}

function createWorldProjection() {
  return geoEqualEarth().fitExtent(
    [
      [20, 16],
      [780, 394],
    ],
    WORLD_FEATURE_COLLECTION,
  )
}

function createUnitedStatesProjection() {
  return geoMercator()
    .center([-98.5, 38.5])
    .scale(700)
    .translate([MAP_WIDTH / 2, MAP_HEIGHT / 2 + 12])
}

function EmergencySummary({ title, signal, latestSweep, actualCount, expectedCount, trackedCount }) {
  const sigmaShift = signal?.sigmaShift ?? signal?.zScore ?? 0
  const emergencyLevel = Number(signal?.emergencyLevel || 1)

  return (
    <section className="panel dial-panel">
      <div className="panel-header">
        <div><h2>{title}</h2></div>
      </div>
      <p className="emergency-line">
        <strong>Emergency level: {emergencyLevel}/5.</strong>
      </p>
      <p className="panel-lede">Current deviation: {formatSigned(sigmaShift)}</p>
      <div className="summary-text-block">
        <p><strong>Last updated:</strong> {latestSweep}</p>
        <p><strong>Aircraft currently airborne:</strong> {formatCount(actualCount)}</p>
        <p><strong>Expected airborne aircraft:</strong> {formatCount(expectedCount)}</p>
        <p><strong>Tracked aircraft:</strong> {formatCount(trackedCount)}</p>
      </div>
    </section>
  )
}

function ArchiveChart({ data }) {
  return <ArchiveChartPanel key={`archive-${data.length}`} data={data} defaultWindowDays={3} />
}

function ArchiveChartPanel({ data, defaultWindowDays }) {
  const hasData = data.length > 0
  const sampledAtTimestamps = useMemo(() => data.map((sample) => Date.parse(sample.sampledAt || 0)), [data])
  const latestTimestamp = sampledAtTimestamps[sampledAtTimestamps.length - 1] || 0
  const earliestTimestamp = sampledAtTimestamps[0] || 0
  const maxDaysAvailable = Math.max(1, Math.ceil((latestTimestamp - earliestTimestamp) / ARCHIVE_DAY_MS))
  const [rangeDaysAgo, setRangeDaysAgo] = useState(() => ({
    startDaysAgo: clamp(defaultWindowDays, 1, maxDaysAvailable),
    endDaysAgo: 0,
  }))
  const clampedRangeDaysAgo = {
    startDaysAgo: clamp(rangeDaysAgo.startDaysAgo, 1, maxDaysAvailable),
    endDaysAgo: clamp(rangeDaysAgo.endDaysAgo, 0, Math.max(0, clamp(rangeDaysAgo.startDaysAgo, 1, maxDaysAvailable) - 1)),
  }

  function setArchiveRange(startDaysAgo, endDaysAgo = 0) {
    const nextStart = clamp(startDaysAgo, 1, maxDaysAvailable)
    const nextEnd = clamp(endDaysAgo, 0, Math.max(0, nextStart - 1))
    setRangeDaysAgo({
      startDaysAgo: nextStart,
      endDaysAgo: nextEnd,
    })
  }

  const deferredStartDaysAgo = useDeferredValue(clampedRangeDaysAgo.startDaysAgo)
  const deferredEndDaysAgo = useDeferredValue(clampedRangeDaysAgo.endDaysAgo)
  const visibleWindowDays = Math.max(1, clampedRangeDaysAgo.startDaysAgo - clampedRangeDaysAgo.endDaysAgo)
  const pastHandlePercent = ((maxDaysAvailable - clampedRangeDaysAgo.startDaysAgo) / maxDaysAvailable) * 100
  const nowHandlePercent = ((maxDaysAvailable - clampedRangeDaysAgo.endDaysAgo) / maxDaysAvailable) * 100

  const { visibleData, visibleStart, visibleEnd } = useMemo(() => {
    const lowerBound = latestTimestamp - deferredStartDaysAgo * ARCHIVE_DAY_MS
    const upperBound = latestTimestamp - deferredEndDaysAgo * ARCHIVE_DAY_MS
    const startIndex = findFirstIndexAtOrAfter(sampledAtTimestamps, lowerBound)
    const endIndex = findLastIndexAtOrBefore(sampledAtTimestamps, upperBound)
    const slicedData = startIndex <= endIndex ? data.slice(startIndex, endIndex + 1) : []
    const downsampledData = downsampleArchiveSeries(slicedData)

    return {
      visibleData: downsampledData,
      visibleStart: slicedData[0]?.sampledAt,
      visibleEnd: slicedData[slicedData.length - 1]?.sampledAt,
    }
  }, [data, deferredEndDaysAgo, deferredStartDaysAgo, latestTimestamp, sampledAtTimestamps])

  if (!hasData) {
    return (
      <section className="panel chart-panel">
        <div className="panel-header">
          <div><h2>Escape Traffic Archive</h2></div>
        </div>
        <div className="empty-state">No historical half-hour data is available yet.</div>
      </section>
    )
  }

  return (
    <section className="panel chart-panel history-panel">
      <div className="panel-header">
        <div><h2>Escape Traffic Archive</h2></div>
      </div>
      <div className="chart-toolbar">
        <div className="chart-range-copy">
          <strong>
            {formatArchiveRangeDate(visibleStart)} to {formatArchiveRangeDate(visibleEnd)}
          </strong>
        </div>
      </div>
      <div className="chart-toolbar chart-toolbar-archive">
        <div className="chart-range-slider">
          <div className="chart-range-slider-copy">
            <span>Past</span>
            <span>Now</span>
          </div>
          <div className="chart-range-slider-stack">
            <div className="chart-range-track" />
            <div
              className="chart-range-track-active"
              style={{
                left: `${pastHandlePercent}%`,
                right: `${100 - nowHandlePercent}%`,
              }}
            />
            <input
              className="chart-range-input chart-range-input-past"
              type="range"
              min="1"
              max={maxDaysAvailable}
              step="1"
              value={maxDaysAvailable - clampedRangeDaysAgo.startDaysAgo}
              onChange={(event) =>
                setArchiveRange(
                  maxDaysAvailable - Number(event.target.value),
                  clampedRangeDaysAgo.endDaysAgo,
                )
              }
              aria-label="Past archive boundary"
            />
            <input
              className="chart-range-input chart-range-input-now"
              type="range"
              min="0"
              max={maxDaysAvailable}
              step="1"
              value={maxDaysAvailable - clampedRangeDaysAgo.endDaysAgo}
              onChange={(event) =>
                setArchiveRange(
                  clampedRangeDaysAgo.startDaysAgo,
                  maxDaysAvailable - Number(event.target.value),
                )
              }
              aria-label="Current archive boundary"
            />
          </div>
        </div>
        <fieldset className="chart-radio-group">
          <legend className="sr-only">Historical archive window</legend>
          <label className="chart-radio-option">
            <input
              type="radio"
              name="archive-window"
              checked={clampedRangeDaysAgo.startDaysAgo === 3 && clampedRangeDaysAgo.endDaysAgo === 0}
              onChange={() => setArchiveRange(3, 0)}
            />
            <span>3 days</span>
          </label>
          <label className="chart-radio-option">
            <input
              type="radio"
              name="archive-window"
              checked={clampedRangeDaysAgo.startDaysAgo === 30 && clampedRangeDaysAgo.endDaysAgo === 0}
              onChange={() => setArchiveRange(30, 0)}
            />
            <span>30D</span>
          </label>
          <label className="chart-radio-option">
            <input
              type="radio"
              name="archive-window"
              checked={clampedRangeDaysAgo.startDaysAgo === 90 && clampedRangeDaysAgo.endDaysAgo === 0}
              onChange={() => setArchiveRange(90, 0)}
            />
            <span>90D</span>
          </label>
          <label className="chart-radio-option">
            <input
              type="radio"
              name="archive-window"
              checked={clampedRangeDaysAgo.startDaysAgo === maxDaysAvailable && clampedRangeDaysAgo.endDaysAgo === 0}
              onChange={() => setArchiveRange(maxDaysAvailable, 0)}
            />
            <span>Full Year</span>
          </label>
        </fieldset>
      </div>
      <div className="chart-frame">
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={visibleData} margin={{ top: 14, right: 18, left: -14, bottom: 0 }}>
            <CartesianGrid stroke={CHART_GRID_COLOR} strokeDasharray="2 2" vertical={false} />
            <XAxis
              dataKey="sampledAt"
              tickFormatter={(value) => formatArchiveTick(value, visibleWindowDays)}
              tick={{ fill: CHART_TICK_COLOR, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tick={{ fill: CHART_TICK_COLOR, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={34}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ zIndex: 6 }}
              labelFormatter={(value) => formatTimestamp(value)}
              formatter={(value, name) => [formatCount(value), name]}
            />
            <Line
              type="linear"
              dataKey="concurrentCount"
              stroke={CHART_PRIMARY_COLOR}
              strokeWidth={2.5}
              dot={false}
              name="Observed concurrent"
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="predictedConcurrentCount"
              stroke={CHART_SECONDARY_COLOR}
              strokeWidth={2}
              strokeDasharray="7 6"
              dot={false}
              name="Predicted concurrent"
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-subsection">
        <div className="chart-subsection-header">
          <strong>Difference from Predicted Concurrent Activity</strong>
          <span>Positive values indicate more aircraft airborne than predicted for that half-hour slot.</span>
        </div>
        <div className="chart-frame chart-frame-secondary">
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={visibleData} margin={{ top: 8, right: 18, left: -6, bottom: 0 }}>
              <defs>
                <linearGradient id="archiveDivergenceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_PRIMARY_COLOR} stopOpacity="0.18" />
                  <stop offset="100%" stopColor={CHART_PRIMARY_COLOR} stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={CHART_GRID_COLOR} strokeDasharray="2 2" vertical={false} />
              <XAxis
                dataKey="sampledAt"
                tickFormatter={(value) => formatArchiveTick(value, visibleWindowDays)}
                tick={{ fill: CHART_TICK_COLOR, fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                tick={{ fill: CHART_TICK_COLOR, fontSize: 12 }}
                tickFormatter={formatDelta}
                axisLine={false}
                tickLine={false}
                width={42}
              />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                allowEscapeViewBox={{ x: false, y: true }}
                wrapperStyle={{ zIndex: 6 }}
                labelFormatter={(value) => formatTimestamp(value)}
                formatter={(value) => [formatDelta(value), 'Difference']}
              />
              <ReferenceLine y={0} stroke="#999999" strokeDasharray="5 5" />
              <Area
                type="linear"
                dataKey="divergence"
                stroke={CHART_PRIMARY_COLOR}
                strokeWidth={2}
                fill="url(#archiveDivergenceFill)"
                name="Difference"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  )
}

function GlobalMap({ aircraft }) {
  const isNarrowLayout = useIsNarrowLayout()
  const [activePlaneHex, setActivePlaneHex] = useState(null)
  const activePlane = aircraft.find((plane) => plane.hex === activePlaneHex) ?? null
  const projection = isNarrowLayout ? createUnitedStatesProjection() : createWorldProjection()
  const path = geoPath(projection)
  const graticulePath = path(geoGraticule10())
  const markerCoreRadius = isNarrowLayout ? 8.5 : 6.5
  const markerHaloRadius = isNarrowLayout ? 15 : 12
  const markerHitRadius = isNarrowLayout ? 24 : 16

  function toggleActivePlane(planeHex) {
    setActivePlaneHex((currentHex) => (currentHex === planeHex ? null : planeHex))
  }

  return (
    <section className="panel map-panel">
      <div className="panel-header">
        <div><h2>Aircraft Positions</h2></div>
      </div>

      <div className="map-frame">
        <div className={`map-hover-card${activePlane ? ' map-hover-card-active' : ''}`}>
          {activePlane ? (
            <>
              <div className="map-hover-header">
                <strong>{activePlane.label || activePlane.registration || activePlane.hex?.toUpperCase()}</strong>
                <span>{activePlane.registration || activePlane.hex?.toUpperCase() || 'Unknown aircraft'}</span>
              </div>
              <dl className="map-hover-grid">
                <div>
                  <dt>Last seen</dt>
                  <dd>{formatTimestamp(activePlane.observed_at)}</dd>
                </div>
                <div>
                  <dt>Altitude</dt>
                  <dd>{formatAltitude(activePlane.altitudeFt)}</dd>
                </div>
                <div>
                  <dt>Speed</dt>
                  <dd>{formatSpeed(activePlane.groundSpeedKt)}</dd>
                </div>
                <div className="map-hover-coordinates">
                  <dt>Coordinates</dt>
                  <dd>{formatCoordinates(activePlane.lat, activePlane.lon)}</dd>
                </div>
              </dl>
            </>
          ) : (
            <div className="map-hover-empty">
              <strong>{isNarrowLayout ? 'Tap a craft' : 'Hover a craft'}</strong>
              <span>
                {isNarrowLayout
                  ? 'Tap any marker to inspect the latest half-hour snapshot for that aircraft.'
                  : 'Mouse over any marker to inspect the latest half-hour snapshot for that aircraft.'}
              </span>
            </div>
          )}
        </div>
        <svg
          viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
          className={`map-svg${isNarrowLayout ? ' map-svg-narrow' : ''}`}
          role="img"
          aria-label="Current aircraft positions"
          onPointerUp={
            isNarrowLayout
              ? (event) => {
                  if (event.target !== event.currentTarget) {
                    return
                  }
                  setActivePlaneHex(null)
                }
              : undefined
          }
        >
          <rect x="8" y="8" width="784" height="394" rx={isNarrowLayout ? 16 : 198} className="map-sphere" />
          <path d={graticulePath} className="map-graticule" />
          {worldGeographies.map((geo) => (
            <path key={geo.id || geo.properties?.name} d={path(geo)} className="map-geography" />
          ))}
          {aircraft.map((plane) => {
            const point = projection([plane.lon, plane.lat])
            if (!point) {
              return null
            }

            return (
              <g
                key={plane.hex}
                className={`map-marker${plane.hex === activePlaneHex ? ' map-marker-active' : ''}${isNarrowLayout ? ' map-marker-touch' : ''}`}
                transform={`translate(${point[0]} ${point[1]})`}
                onMouseEnter={isNarrowLayout ? undefined : () => setActivePlaneHex(plane.hex)}
                onMouseLeave={isNarrowLayout ? undefined : () => setActivePlaneHex((currentHex) => (currentHex === plane.hex ? null : currentHex))}
                onFocus={() => setActivePlaneHex(plane.hex)}
                onBlur={() => setActivePlaneHex((currentHex) => (currentHex === plane.hex ? null : currentHex))}
                onClick={(event) => {
                  if (isNarrowLayout) {
                    return
                  }

                  event.stopPropagation()
                  toggleActivePlane(plane.hex)
                }}
                onPointerDown={(event) => {
                  if (!isNarrowLayout) {
                    return
                  }

                  event.preventDefault()
                  event.stopPropagation()
                  toggleActivePlane(plane.hex)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    toggleActivePlane(plane.hex)
                  }
                }}
                tabIndex={0}
                role="button"
                aria-pressed={plane.hex === activePlaneHex}
                aria-label={`${plane.label || plane.registration || plane.hex?.toUpperCase()} at ${formatAltitude(plane.altitudeFt)}, ${formatSpeed(plane.groundSpeedKt)}`}
              >
                <circle r={markerHitRadius} className="map-marker-hit" />
                <circle r={markerCoreRadius} className="map-marker-core" />
                <circle r={markerHaloRadius} className="map-marker-halo" />
                <title>{`${plane.label} · ${formatAltitude(plane.altitudeFt)} · ${formatSpeed(plane.groundSpeedKt)}`}</title>
              </g>
            )
          })}
        </svg>
      </div>
    </section>
  )
}

function ModelSummaryList({ aircraft }) {
  const modelSummary = buildLiveModelSummary(aircraft)

  return (
    <section className="panel list-panel">
      <div className="panel-header">
        <div><h2>Aircraft By Model</h2></div>
        <span className="map-badge">{formatCount(modelSummary.length)} types</span>
      </div>
      {modelSummary.length ? (
        <ul className="flight-list model-list">
          {modelSummary.map((entry) => (
            <li key={entry.modelLabel}>
              <div>
                <strong>{entry.modelLabel}</strong>
              </div>
              <strong className="model-count">{formatCount(entry.count)}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">
          No tracked aircraft are currently airborne in the latest cached heatmap.
        </div>
      )}
    </section>
  )
}

function App() {
  const [dashboard, setDashboard] = useState(null)
  const [error, setError] = useState(null)

  const applyDashboard = useEffectEvent((nextDashboard) => {
    startTransition(() => {
      setDashboard(nextDashboard)
      setError(null)
    })
  })

  async function requestDashboard() {
    const response = await fetch(buildDashboardRequestUrl(), {
      cache: 'no-store',
    })
    if (!response.ok) {
      throw new Error(`Dashboard request failed with ${response.status}`)
    }

    return response.json()
  }

  useEffect(() => {
    let active = true

    async function loadDashboard() {
      try {
        const nextDashboard = await requestDashboard()
        if (active) {
          applyDashboard(nextDashboard)
        }
      } catch (nextError) {
        if (active) {
          setError(nextError.message)
        }
      }
    }

    loadDashboard()
    const intervalId = window.setInterval(loadDashboard, DASHBOARD_POLL_INTERVAL_MS)

    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [])

  let content = null

  if (error && !dashboard) {
    content = (
      <main className="app-shell">
        <section className="panel error-panel">
          <h1>Data Unavailable</h1>
          <p>{error}</p>
        </section>
      </main>
    )
  } else if (!dashboard) {
    content = (
      <main className="app-shell">
        <section className="panel loading-panel">
          <h1>Loading</h1>
        </section>
      </main>
    )
  } else {
    const archiveData = dashboard.trends?.archive ?? []
    const liveAircraft = dashboard.liveAircraft ?? []
    const liveStatus = dashboard.liveStatus ?? null
    const compositeSignal = dashboard.signals?.composite ?? {
      asOf: dashboard.current?.asOf,
      actualConcurrentCount: dashboard.current?.concurrentCount,
      expectedConcurrentCount: dashboard.current?.baselineMean,
      expectedConcurrentStdDev: dashboard.current?.baselineStdDev,
      sigmaShift: dashboard.current?.zScore,
      alertLevel: dashboard.current?.alertLevel,
    }

    content = (
      <main className="app-shell">
        {dashboard.warning ? (
          <section className="status-banner">
            <strong>{dashboard.mode === 'demo' ? 'Demo mode.' : 'Configuration required.'}</strong>
            <span>{dashboard.warning}</span>
          </section>
        ) : null}

        {!dashboard.warning && !liveStatus?.latestSampledAt ? (
          <section className="status-banner">
            <strong>No recent sweep.</strong>
            <span>The backend polls the newest heatmap every 30 minutes and serves the latest cached sample.</span>
          </section>
        ) : null}

        {liveStatus?.lastError ? (
          <section className="status-banner">
            <strong>Refresh error.</strong>
            <span>
              {liveStatus.lastError}
              {liveStatus.nextRefreshAt ? ` Next sweep: ${formatTimestamp(liveStatus.nextRefreshAt)}.` : ''}
            </span>
          </section>
        ) : null}

        <section className="focus-grid">
          <section className="panel hero-copy-panel">
            <h1>Apocalypse Early Warning System</h1>
            <p className="hero-copy">
              Private jet activity monitor
            </p>
            <p className="hero-caption">
              This dashboard tracks a cohort of private aircraft and compares current airborne activity against recent
              historical baselines.
            </p>
          </section>
          <div className="dial-stack">
            <EmergencySummary
              title="Current Assessment"
              signal={compositeSignal}
              latestSweep={formatTimestamp(dashboard.current?.asOf)}
              actualCount={compositeSignal.actualConcurrentCount}
              expectedCount={compositeSignal.expectedConcurrentCount}
              trackedCount={dashboard.cohort?.trackedCount ?? dashboard.watchlist?.trackedCount}
            />
          </div>
        </section>

        <section className="focus-map-grid">
          <GlobalMap aircraft={liveAircraft} />
        </section>

        <section className="details-stack">
          <ArchiveChart data={archiveData} />
          <ModelSummaryList aircraft={liveAircraft} />
        </section>
      </main>
    )
  }

  return (
    <>
      <div className="background-wallpaper" style={{ backgroundImage: `url("${BACKGROUND_URL}")` }} aria-hidden="true" />
      {content}
    </>
  )
}

export default App
