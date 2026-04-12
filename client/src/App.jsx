import { startTransition, useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import {
  Area,
  AreaChart,
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { geoEqualEarth, geoGraticule10, geoPath } from 'd3-geo'
import { feature } from 'topojson-client'
import worldAtlas from 'world-atlas/countries-110m.json'
import './App.css'

const DASHBOARD_URL = import.meta.env.VITE_DASHBOARD_URL || '/api/dashboard'
const DASHBOARD_CACHE_BUSTER_MINUTES = 5
const DASHBOARD_POLL_INTERVAL_MS = 5 * 60_000
const worldGeographies = feature(worldAtlas, worldAtlas.objects.countries).features
const worldProjection = geoEqualEarth().fitExtent(
  [
    [20, 16],
    [780, 394],
  ],
  { type: 'FeatureCollection', features: worldGeographies },
)
const worldPath = geoPath(worldProjection)
const worldGraticule = geoPath(worldProjection)(geoGraticule10())

const DIAL_START = -140
const DIAL_END = 140
const DIAL_SIGMA_RANGE = 2
const NARROW_HISTORY_BREAKPOINT = 820
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const alertCopy = {
  normal: {
    label: 'All Quiet',
    detail: 'No visible sprint for the runway. The bunker class appears calm, for now.',
  },
  elevated: {
    label: 'Engines Spooling',
    detail: 'More aircraft are up than the model expects. Maybe noise. Maybe everyone found their go-bag.',
  },
  alarm: {
    label: 'Bunker Run',
    detail: 'The private-jet scramble is materially above precedent. If someone got the memo early, this is the zone.',
  },
}

function polarToCartesian(cx, cy, radius, angle) {
  const radians = ((angle - 90) * Math.PI) / 180
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  }
}

function describeArc(cx, cy, radius, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, radius, endAngle)
  const end = polarToCartesian(cx, cy, radius, startAngle)
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1'
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`
}

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

function formatRoundedTime(value) {
  const roundedDate = roundDateToNearestHalfHour(value)
  if (!roundedDate) {
    return 'n/a'
  }

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(roundedDate)
}

function formatCompactDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${value}T00:00:00Z`))
}

function formatLongDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`))
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

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return '0%'
  }

  return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) {
    return '0%'
  }

  const percentage = value * 100
  const digits = Math.abs(percentage) >= 10 ? 0 : 1
  return `${percentage >= 0 ? '+' : ''}${percentage.toFixed(digits)}%`
}

function formatWeekdayName(value) {
  if (!value) {
    return 'weekday'
  }

  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(value))
}

function formatRecentWeekdayWindowLabel(weekdayName, sampleCount = 4) {
  if (!weekdayName || weekdayName === 'weekday') {
    return `Last ${sampleCount} Matching Weekdays`
  }

  return `Last ${sampleCount} ${weekdayName}s`
}

function getUtcWeekday(value) {
  return new Date(`${value}T00:00:00Z`).getUTCDay()
}

function normalizeModelLabel(value) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized || 'Unknown model'
}

function clampZoomRange(range, length) {
  if (!length) {
    return { startIndex: 0, endIndex: 0 }
  }

  const maxIndex = length - 1
  const startIndex = Math.max(0, Math.min(Number(range?.startIndex ?? 0), maxIndex))
  const endIndex = Math.max(startIndex, Math.min(Number(range?.endIndex ?? maxIndex), maxIndex))
  return { startIndex, endIndex }
}

function buildTrailingRange(length, windowSize) {
  if (!length) {
    return { startIndex: 0, endIndex: 0 }
  }

  const clampedWindow = Math.max(1, Math.min(windowSize, length))
  return {
    startIndex: Math.max(0, length - clampedWindow),
    endIndex: length - 1,
  }
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

function clampSigmaShift(value) {
  return Math.max(-DIAL_SIGMA_RANGE, Math.min(DIAL_SIGMA_RANGE, Number(value || 0)))
}

function sigmaToNeedleAngle(value) {
  return (clampSigmaShift(value) / DIAL_SIGMA_RANGE) * DIAL_END
}

function getShiftEmphasis(sigmaShift) {
  if (sigmaShift <= -0.25) {
    return 'cool'
  }

  if (sigmaShift >= 0.25) {
    return 'hot'
  }

  return 'warm'
}

function buildWeekdayPredictionSeries(data) {
  const weekdayTotals = Array.from({ length: 7 }, () => ({ total: 0, count: 0 }))

  for (const row of data) {
    const weekday = getUtcWeekday(row.day)
    weekdayTotals[weekday].total += Number(row.uniqueAirborneCount || 0)
    weekdayTotals[weekday].count += 1
  }

  return data.map((row) => {
    const weekday = getUtcWeekday(row.day)
    const weekdayStats = weekdayTotals[weekday]
    const predictedCount = weekdayStats.count
      ? weekdayStats.total / weekdayStats.count
      : Number(row.uniqueAirborneCount || 0)

    return {
      ...row,
      weekday,
      weekdayLabel: WEEKDAY_LABELS[weekday],
      predictedCount,
      divergence: Number(row.uniqueAirborneCount || 0) - predictedCount,
    }
  })
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

function MetricBlock({ label, value, note, emphasis = 'warm' }) {
  return (
    <div className={`metric-block metric-block-${emphasis}`}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      <span className="metric-note">{note}</span>
    </div>
  )
}

function SignalDial({ eyebrow, title, signal, lede, stats }) {
  const gradientId = useId().replace(/:/g, '')
  const sigmaShift = signal?.sigmaShift ?? signal?.zScore ?? 0
  const needleAngle = sigmaToNeedleAngle(sigmaShift)
  const label = alertCopy[signal?.alertLevel || 'normal']

  return (
    <section className="panel dial-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <span className={`signal-pill signal-${signal?.alertLevel || 'normal'}`}>
          {label.label}
        </span>
      </div>

      <div className="dial-wrap">
        <svg viewBox="0 0 360 240" className="dial-svg" role="img" aria-label="Alarm gauge">
          <defs>
            <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="180" y1="180" x2="180" y2="74">
              <stop offset="0%" stopColor="#b8ff66" />
              <stop offset="45%" stopColor="#ffc24c" />
              <stop offset="100%" stopColor="#ff5a33" />
            </linearGradient>
          </defs>

          <path d={describeArc(180, 180, 112, DIAL_START, DIAL_END)} className="dial-track" />
          <path d={describeArc(180, 180, 112, DIAL_START, 5)} className="dial-segment dial-segment-cool" />
          <path d={describeArc(180, 180, 112, 5, 70)} className="dial-segment dial-segment-warm" />
          <path d={describeArc(180, 180, 112, 70, DIAL_END)} className="dial-segment dial-segment-hot" />
          <path d={describeArc(180, 180, 96, DIAL_START, DIAL_END)} className="dial-inner-track" />

          {Array.from({ length: 9 }).map((_, index) => {
            const angle = DIAL_START + (index / 8) * (DIAL_END - DIAL_START)
            const start = polarToCartesian(180, 180, 86, angle)
            const end = polarToCartesian(180, 180, 100, angle)
            return (
              <line
                key={angle}
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                className="dial-tick"
              />
            )
          })}

          <g
            className="dial-needle"
            transform={`rotate(${needleAngle} 180 180)`}
          >
            <line
              x1="180"
              y1="180"
              x2="180"
              y2="74"
              stroke={`url(#${gradientId})`}
              strokeWidth="5"
              strokeLinecap="round"
            />
            <circle
              cx="180"
              cy="180"
              r="10"
              fill="#fff6e7"
              stroke="rgba(255, 184, 77, 0.25)"
              strokeWidth="6"
            />
          </g>
          <circle cx="180" cy="180" r="132" className="dial-frame" />
        </svg>
      </div>

      <p className="panel-lede">{lede || label.detail}</p>
      <div className="metric-grid">
        {stats.map((stat) => (
          <MetricBlock
            key={stat.label}
            label={stat.label}
            value={stat.value}
            note={stat.note}
            emphasis={stat.emphasis || 'warm'}
          />
        ))}
      </div>
    </section>
  )
}

function RollingChart({ data, summaryCopy, summaryMetrics }) {
  return (
    <section className="panel chart-panel rolling-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Scramble Rhythm</p>
          <h2>Recent Airborne Panic</h2>
        </div>
      </div>
      <div className="chart-frame">
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={data} margin={{ top: 12, right: 18, left: -14, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="4 8" vertical={false} />
            <XAxis
              dataKey="sampledAt"
              tickFormatter={formatRoundedTime}
              tick={{ fill: 'rgba(240, 223, 197, 0.56)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tick={{ fill: 'rgba(240, 223, 197, 0.56)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={34}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                background: 'rgba(9, 18, 26, 0.96)',
                border: '1px solid rgba(117, 209, 240, 0.18)',
                borderRadius: '14px',
                color: '#f6efde',
              }}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ zIndex: 6 }}
              labelFormatter={(value) => formatTimestamp(value)}
              formatter={(value, name) => [formatCount(value), name]}
            />
            <Line
              type="linear"
              dataKey="concurrentCount"
              stroke="#ff7a4a"
              strokeWidth={3}
              dot={false}
              name="Jets up now"
            />
            <Line
              type="linear"
              dataKey="predictedConcurrentCount"
              stroke="#d6ff6a"
              strokeWidth={2}
              strokeDasharray="7 6"
              dot={false}
              name="Model says"
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-subsection chart-summary-section">
        <div className="chart-subsection-header">
          <strong>How The Model Calibrates</strong>
          <span>{summaryCopy}</span>
        </div>
        <div className="summary-stack chart-summary-stack">
          {summaryMetrics.map((metric) => (
            <MetricBlock
              key={metric.label}
              label={metric.label}
              value={metric.value}
              note={metric.note}
              emphasis={metric.emphasis || 'warm'}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

function DailyChart({ data }) {
  const isNarrowLayout = useIsNarrowLayout()

  return <DailyChartPanel key={`${isNarrowLayout ? 'narrow' : 'wide'}-${data.length}`} data={data} isNarrowLayout={isNarrowLayout} />
}

function DailyChartPanel({ data, isNarrowLayout }) {
  const [zoomRange, setZoomRange] = useState(null)
  const [activeBrushEdge, setActiveBrushEdge] = useState(null)
  const overviewRef = useRef(null)

  if (!data.length) {
    return (
      <section className="panel chart-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Precedent Archive</p>
            <h2>Daily Airborne Counts</h2>
          </div>
        </div>
        <div className="empty-state">No historical daily data is available yet.</div>
      </section>
    )
  }

  const visibleRange = clampZoomRange(zoomRange ?? buildTrailingRange(data.length, isNarrowLayout ? 30 : 365), data.length)
  const visibleData = data.slice(visibleRange.startIndex, visibleRange.endIndex + 1)
  const visibleStart = visibleData[0]?.day
  const visibleEnd = visibleData[visibleData.length - 1]?.day
  const chartTitle =
    visibleData.length <= 45 ? 'One Month Of Escape Traffic' : visibleData.length >= 300 ? 'One Year Of Escape Traffic' : 'Escape Traffic Archive'
  const brushStartRatio = data.length > 1 ? visibleRange.startIndex / (data.length - 1) : 0
  const brushEndRatio = data.length > 1 ? visibleRange.endIndex / (data.length - 1) : 1
  const brushStartLabel = formatCompactDate(data[visibleRange.startIndex]?.day)
  const brushEndLabel = formatCompactDate(data[visibleRange.endIndex]?.day)

  function applyPreset(days) {
    setZoomRange(buildTrailingRange(data.length, days))
  }

  function updateActiveBrushEdge(event) {
    const overviewNode = overviewRef.current
    if (!overviewNode || !data.length) {
      return
    }

    const rect = overviewNode.getBoundingClientRect()
    const contentLeft = 6
    const contentRight = 28
    const contentWidth = Math.max(rect.width - contentLeft - contentRight, 1)
    const pointerX = event.clientX - rect.left
    const startX = contentLeft + brushStartRatio * contentWidth
    const endX = contentLeft + brushEndRatio * contentWidth
    const snapDistance = 18

    if (Math.abs(pointerX - startX) <= snapDistance) {
      setActiveBrushEdge('start')
      return
    }

    if (Math.abs(pointerX - endX) <= snapDistance) {
      setActiveBrushEdge('end')
      return
    }

    setActiveBrushEdge(null)
  }

  return (
    <section className="panel chart-panel history-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Precedent Archive</p>
          <h2>{chartTitle}</h2>
        </div>
      </div>
      <div className="chart-toolbar">
        <div className="chart-range-copy">
          <strong>
            {formatLongDate(visibleStart)} to {formatLongDate(visibleEnd)}
          </strong>
          <span>{formatCount(visibleData.length)} daily samples in view</span>
          <span>Weekday baseline built from the last 365 UTC days of airborne counts.</span>
        </div>
        <div className="chart-preset-group" role="group" aria-label="Historical zoom presets">
          <button type="button" className="chart-preset" onClick={() => applyPreset(30)}>
            30D
          </button>
          <button type="button" className="chart-preset" onClick={() => applyPreset(90)}>
            90D
          </button>
          <button type="button" className="chart-preset" onClick={() => applyPreset(365)}>
            Full Year
          </button>
        </div>
      </div>
      <div className="chart-frame">
        <ResponsiveContainer width="100%" height={320}>
          <AreaChart data={visibleData} margin={{ top: 14, right: 28, left: 6, bottom: 0 }}>
            <defs>
              <linearGradient id="dailyFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ff6d40" stopOpacity="0.82" />
                <stop offset="100%" stopColor="#ff6d40" stopOpacity="0" />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="4 8" vertical={false} />
            <XAxis
              dataKey="day"
              tickFormatter={formatCompactDate}
              tick={{ fill: 'rgba(240, 223, 197, 0.56)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tick={{ fill: 'rgba(240, 223, 197, 0.56)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={34}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                background: 'rgba(9, 18, 26, 0.96)',
                border: '1px solid rgba(255, 190, 92, 0.18)',
                borderRadius: '14px',
                color: '#f6efde',
              }}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ zIndex: 6 }}
              labelFormatter={(value) => formatLongDate(value)}
              formatter={(value, name) => [
                formatCount(value),
                name === 'Weekday prediction' ? 'Weekday prediction' : 'Unique airborne',
              ]}
            />
            <Area
              type="monotone"
              dataKey="uniqueAirborneCount"
              stroke="#ff6d40"
              strokeWidth={3}
              fill="url(#dailyFill)"
              name="Unique airborne"
            />
            <Area
              type="monotone"
              dataKey="predictedCount"
              stroke="#d6ff6a"
              strokeWidth={2}
              strokeDasharray="7 6"
              fillOpacity={0}
              name="Weekday prediction"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-subsection">
        <div className="chart-subsection-header">
          <strong>Excess Over Weekday Expectation</strong>
          <span>Positive values mean more private jets were airborne than the weekday model expected.</span>
        </div>
        <div className="chart-frame chart-frame-secondary">
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={visibleData} margin={{ top: 8, right: 28, left: 6, bottom: 0 }}>
              <defs>
                <linearGradient id="divergenceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#d6ff6a" stopOpacity="0.45" />
                  <stop offset="100%" stopColor="#d6ff6a" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="4 8" vertical={false} />
              <XAxis
                dataKey="day"
                tickFormatter={formatCompactDate}
                tick={{ fill: 'rgba(240, 223, 197, 0.56)', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                tick={{ fill: 'rgba(240, 223, 197, 0.56)', fontSize: 12 }}
                tickFormatter={formatDelta}
                axisLine={false}
                tickLine={false}
                width={42}
              />
              <Tooltip
                contentStyle={{
                  background: 'rgba(9, 18, 26, 0.96)',
                  border: '1px solid rgba(117, 209, 240, 0.18)',
                  borderRadius: '14px',
                  color: '#f6efde',
                }}
                allowEscapeViewBox={{ x: true, y: true }}
                wrapperStyle={{ zIndex: 6 }}
                labelFormatter={(value) => formatLongDate(value)}
                formatter={(value) => [formatDelta(value), 'Divergence']}
              />
              <ReferenceLine y={0} stroke="rgba(255, 245, 227, 0.28)" strokeDasharray="5 5" />
              <Area
                type="monotone"
                dataKey="divergence"
                stroke="#d6ff6a"
                strokeWidth={2}
                fill="url(#divergenceFill)"
                name="Divergence"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div
        ref={overviewRef}
        className="chart-overview"
        onMouseMove={updateActiveBrushEdge}
        onMouseLeave={() => setActiveBrushEdge(null)}
      >
        <div className="brush-range-labels" aria-hidden="true">
          {activeBrushEdge === 'start' ? (
            <span className="brush-range-label brush-range-label-start" style={{ left: `calc(${brushStartRatio * 100}% + 12px)` }}>
              {brushStartLabel}
            </span>
          ) : null}
          {activeBrushEdge === 'end' ? (
            <span className="brush-range-label brush-range-label-end" style={{ left: `calc(${brushEndRatio * 100}% - 12px)` }}>
              {brushEndLabel}
            </span>
          ) : null}
        </div>
        <ResponsiveContainer width="100%" height={88}>
          <AreaChart data={data} margin={{ top: 0, right: 28, left: 6, bottom: 0 }}>
            <defs>
              <linearGradient id="dailyOverviewFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffb84d" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#ffb84d" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="uniqueAirborneCount"
              stroke="#ffb84d"
              strokeWidth={1.5}
              fill="url(#dailyOverviewFill)"
              isAnimationActive={false}
            />
            <XAxis dataKey="day" hide />
            <YAxis hide />
            <Brush
              dataKey="day"
              height={32}
              startIndex={visibleRange.startIndex}
              endIndex={visibleRange.endIndex}
              onChange={(nextRange) => {
                if (!Number.isInteger(nextRange?.startIndex) || !Number.isInteger(nextRange?.endIndex)) {
                  return
                }
                setZoomRange(clampZoomRange(nextRange, data.length))
              }}
              travellerWidth={14}
              stroke="#ffb84d"
              fill="rgba(16, 29, 40, 0.95)"
              tickFormatter={formatCompactDate}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}

function GlobalMap({ aircraft }) {
  return (
    <section className="panel map-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Escape Grid</p>
          <h2>Where The Lifeboats Are</h2>
        </div>
        <span className="map-badge">{aircraft.length} aloft</span>
      </div>

      <div className="map-frame">
        <svg viewBox="0 0 800 410" className="map-svg" role="img" aria-label="Current aircraft positions">
          <rect x="8" y="8" width="784" height="394" rx="198" className="map-sphere" />
          <path d={worldGraticule} className="map-graticule" />
          {worldGeographies.map((geo) => (
            <path key={geo.id || geo.properties?.name} d={worldPath(geo)} className="map-geography" />
          ))}
          {aircraft.map((plane) => {
            const point = worldProjection([plane.lon, plane.lat])
            if (!point) {
              return null
            }

            return (
              <g key={plane.hex} className="map-marker" transform={`translate(${point[0]} ${point[1]})`}>
                <circle r="6.5" className="map-marker-core" />
                <circle r="12" className="map-marker-halo" />
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
        <div>
          <p className="eyebrow">Exit Fleet Mix</p>
          <h2>Who Has Wheels Up</h2>
        </div>
        <span className="map-badge">{formatCount(modelSummary.length)} types</span>
      </div>
      {modelSummary.length ? (
        <ul className="flight-list model-list">
          {modelSummary.map((entry) => (
            <li key={entry.modelLabel}>
              <div>
                <strong>{entry.modelLabel}</strong>
                <span>
                  {formatCount(entry.count)} in the air now • {formatPercent(entry.share)} of visible escape traffic
                </span>
              </div>
              <strong className="model-count">{formatCount(entry.count)}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">
          No tracked aircraft are airborne in the latest cached heatmap. For the moment, the runway is quiet.
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

  if (error && !dashboard) {
    return (
      <main className="app-shell">
        <section className="panel error-panel">
          <p className="eyebrow">Signal Loss</p>
          <h1>The Siren Went Quiet</h1>
          <p>{error}</p>
        </section>
      </main>
    )
  }

  if (!dashboard) {
    return (
      <main className="app-shell">
        <section className="panel loading-panel">
          <p className="eyebrow">Civil Defense Boot</p>
          <h1>Tuning The Doom Receiver…</h1>
        </section>
      </main>
    )
  }

  const dailyData = dashboard.trends?.daily ?? []
  const modeledDailyData = buildWeekdayPredictionSeries(dailyData)
  const rollingData = dashboard.trends?.rolling ?? []
  const liveAircraft = dashboard.liveAircraft ?? []
  const liveStatus = dashboard.liveStatus ?? null
  const alert = alertCopy[dashboard.current?.alertLevel || 'normal']
  const compositeSignal = dashboard.signals?.composite ?? {
    asOf: dashboard.current?.asOf,
    actualConcurrentCount: dashboard.current?.concurrentCount,
    expectedConcurrentCount: dashboard.current?.baselineMean,
    expectedConcurrentStdDev: dashboard.current?.baselineStdDev,
    sigmaShift: dashboard.current?.zScore,
    alertLevel: dashboard.current?.alertLevel,
  }
  const weekdaySignal = dashboard.signals?.weekday ?? {
    asOf: dashboard.current?.asOf,
    currentRolling24hCount: dashboard.current?.rolling24hCount,
    baselineMean: dashboard.current?.baselineMean,
    baselineStdDev: dashboard.current?.baselineStdDev,
  }
  const yearAgoSignal = dashboard.signals?.yearAgo ?? null
  const timeOfDaySignal = dashboard.signals?.timeOfDay ?? null
  const weekdayName = formatWeekdayName(weekdaySignal.asOf)
  const weekdayWindowLabel = formatRecentWeekdayWindowLabel(weekdayName, weekdaySignal.sampleCount || 4)
  const concurrentDelta =
    Number(compositeSignal.actualConcurrentCount || 0) - Number(compositeSignal.expectedConcurrentCount || 0)
  const weekdayDelta =
    Number(weekdaySignal.currentRolling24hCount || 0) - Number(weekdaySignal.baselineMean || 0)
  const yearAgoDelta = yearAgoSignal?.deltaCount
  const sameTimeDelta =
    Number(compositeSignal.actualConcurrentCount || 0) - Number(timeOfDaySignal?.concurrentMean || 0)
  const compositeEmphasis = getShiftEmphasis(compositeSignal.sigmaShift ?? 0)
  const rollingSummaryCopy =
    "The dial does not move just because mornings are busy or Wednesdays run hot. It blends the same date last year, recent matching weekdays, and the last week's intraday rhythm to estimate how many aircraft should be airborne before anyone starts acting unusually prepared."
  const rollingSummaryMetrics = [
    {
      label: 'Panic spread',
      value: formatDelta(concurrentDelta),
      note: 'Difference between the actual airborne count and the modelled calm',
      emphasis: compositeEmphasis,
    },
    {
      label: 'Weekday excuse',
      value: formatDelta(weekdayDelta),
      note: `Difference versus the ${weekdayWindowLabel.toLowerCase()} rolling mean`,
      emphasis: getShiftEmphasis(weekdaySignal.sigmaShift),
    },
    {
      label: 'Holiday excuse',
      value: yearAgoDelta != null ? formatDelta(yearAgoDelta) : 'n/a',
      note:
        yearAgoSignal?.percentChange != null
          ? `${formatSignedPercent(yearAgoSignal.percentChange)} versus the nearest sample one year ago`
          : 'Year-ago sample unavailable',
      emphasis: getShiftEmphasis(yearAgoSignal?.sigmaShift ?? 0),
    },
    {
      label: 'Clock excuse',
      value: formatDelta(sameTimeDelta),
      note:
        timeOfDaySignal?.sampleCount
          ? `${formatCount(timeOfDaySignal.sampleCount)} prior same-time samples in the last week`
          : 'No recent same-time samples available',
      emphasis: getShiftEmphasis(timeOfDaySignal?.sigmaShift ?? 0),
    },
  ]

  return (
    <main className="app-shell">
      {dashboard.warning ? (
        <section className="status-banner">
          <strong>{dashboard.mode === 'demo' ? 'Demo mode.' : 'Configuration required.'}</strong>
          <span>{dashboard.warning}</span>
        </section>
      ) : null}

      {!dashboard.warning && !liveStatus?.latestSampledAt ? (
        <section className="status-banner">
          <strong>Awaiting first sweep.</strong>
          <span>The backend polls the newest heatmap every 30 minutes and serves the last one instantly.</span>
        </section>
      ) : null}

      {liveStatus?.lastError ? (
        <section className="status-banner">
          <strong>Fallout monitor stalled.</strong>
          <span>
            {liveStatus.lastError}
            {liveStatus.nextRefreshAt ? ` Next sweep: ${formatTimestamp(liveStatus.nextRefreshAt)}.` : ''}
          </span>
        </section>
      ) : null}

      <section className="top-grid">
        <section className="panel hero-copy-panel">
          <p className="eyebrow">Continuity Monitor</p>
          <h1>Billionaire Evacuation Index</h1>
          <p className="hero-copy">
            An early-warning instrument built on one impolite theory: if catastrophe is coming, the people with
            private terminals, long-range jets, and somewhere else to be may hear it first.
          </p>
          <p className="hero-caption">
            Three excuses are baked in before the dial moves: same season last year, same weekday over the last month,
            and the last week's usual time-of-day rhythm. What remains is the scramble.
          </p>
        </section>
        <div className="dial-stack">
          <SignalDial
            eyebrow="Evacuation Thermometer"
            title="Private Jet Scramble Index"
            signal={compositeSignal}
            lede={alert.detail}
            stats={[
              {
                label: 'Jets up now',
                value: formatCount(compositeSignal.actualConcurrentCount),
                note: 'Tracked aircraft currently airborne in the latest half-hour snapshot',
              },
              {
                label: 'Model says',
                value: formatCount(compositeSignal.expectedConcurrentCount),
                note: 'Expected airborne count after the alibis and seasonal excuses are applied',
              },
              {
                label: 'Tracked escape craft',
                value: formatCount(dashboard.cohort?.trackedCount ?? dashboard.watchlist?.trackedCount),
                note: 'FAA-derived business-jet cohort currently monitored by the system',
              },
              {
                label: 'Latest sweep',
                value: formatTimestamp(dashboard.current?.asOf),
                note: 'Most recent published half-hour heatmap sample',
              },
              {
                label: 'Panic offset',
                value: formatSigned(compositeSignal.sigmaShift),
                note: 'Distance between the actual scramble and the modelled calm',
                emphasis: compositeEmphasis,
              },
              {
                label: 'Historical alibi',
                value: formatCount(compositeSignal.blendedRollingBaseline),
                note: 'Average of the year-ago rolling count and the recent matching-weekday rolling mean',
              },
            ]}
          />
        </div>
      </section>

      <section className="secondary-grid">
        <GlobalMap aircraft={liveAircraft} />
        <ModelSummaryList aircraft={liveAircraft} />
      </section>

      <RollingChart data={rollingData} summaryCopy={rollingSummaryCopy} summaryMetrics={rollingSummaryMetrics} />

      <DailyChart data={modeledDailyData} />
    </main>
  )
}

export default App
