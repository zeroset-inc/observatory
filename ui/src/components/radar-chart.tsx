import { useMemo } from "react"
import { motion } from "framer-motion"

interface ProviderData {
  provider: string
  data: Record<string, { accuracy: number; correct: number; total: number }>
}

interface RadarChartProps {
  data?: Record<string, { accuracy: number; correct: number; total: number }>
  multiData?: ProviderData[]
  size?: number
  rings?: number[]
}

const PROVIDER_COLORS: Record<string, string> = {
  nebula: "#5b5fd6",
  supermemory: "#60a5fa",
}

const FALLBACK_COLORS = [
  "#3dd6a0", // mint
  "#e07050", // terracotta
  "#f5c842", // saffron
  "#60a5fa", // azure
  "#c084fc", // lavender
]

function getProviderColor(provider: string, index: number): string {
  return PROVIDER_COLORS[provider.toLowerCase()] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]
}

function getPointOnCircle(
  cx: number,
  cy: number,
  radius: number,
  index: number,
  total: number
) {
  const angle = (2 * Math.PI * index) / total - Math.PI / 2
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
    angle,
  }
}

function getLabelAnchor(angle: number) {
  const normalized = ((angle + Math.PI / 2) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
  const isTop = normalized < Math.PI / 4 || normalized > (7 * Math.PI) / 4
  const isBottom = normalized > (3 * Math.PI) / 4 && normalized < (5 * Math.PI) / 4
  const isLeft = normalized > Math.PI

  return {
    textAnchor: (isTop || isBottom ? "middle" : isLeft ? "end" : "start") as
      "middle" | "end" | "start",
    dy: isTop ? "-0.7em" : isBottom ? "1.2em" : "0.35em",
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function RadarChart({
  data,
  multiData,
  size = 300,
  rings = [25, 50, 75, 100],
}: RadarChartProps) {
  // Determine if we're in multi-provider mode
  const isMulti = !!multiData && multiData.length > 0

  // For single mode, derive entries from data
  const singleEntries = useMemo(() => {
    if (!data) return []
    return Object.entries(data)
  }, [data])

  // For multi mode, derive union of all question types
  const multiTypes = useMemo(() => {
    if (!multiData) return []
    const types = new Set<string>()
    multiData.forEach((p) => Object.keys(p.data).forEach((t) => types.add(t)))
    return Array.from(types).sort()
  }, [multiData])

  const typeLabels = isMulti ? multiTypes : singleEntries.map(([type]) => type)
  const n = typeLabels.length

  // Fallback for < 3 types
  if (n < 3) {
    if (isMulti) {
      if (multiTypes.length === 0) return null
      return (
        <div className="card">
          <h3 className="text-sm font-medium text-text-primary mb-4">
            Accuracy by Question Type
          </h3>
          <div className="text-sm text-text-muted text-center py-4">
            Need at least 3 question types for radar chart
          </div>
        </div>
      )
    }
    if (!data || n === 0) return null
    return (
      <div className="card">
        <h3 className="text-sm font-medium text-text-primary mb-4">
          Accuracy by Question Type
        </h3>
        <div className="grid grid-cols-2 gap-3">
          {singleEntries.map(([type, stats]) => (
            <div
              key={type}
              className="p-3 rounded-lg bg-bg-elevated/50 border border-border"
            >
              <div className="text-xs text-text-muted mb-1">
                {type.replace(/[-_]/g, " ")}
              </div>
              <div className="text-lg font-semibold text-text-primary">
                {(stats.accuracy * 100).toFixed(1)}%
              </div>
              <div className="text-xs text-text-secondary">
                {stats.correct}/{stats.total}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const cx = size / 2
  const cy = size / 2
  const labelMargin = 44
  const maxRadius = size / 2 - labelMargin

  // Build guide polygons
  const guidePolygons = rings.map((pct) => {
    const r = maxRadius * (pct / 100)
    const points = Array.from({ length: n }, (_, i) => {
      const p = getPointOnCircle(cx, cy, r, i, n)
      return `${p.x},${p.y}`
    }).join(" ")
    return { pct, points }
  })

  // Build axis lines
  const axisLines = Array.from({ length: n }, (_, i) => {
    const p = getPointOnCircle(cx, cy, maxRadius, i, n)
    return { x1: cx, y1: cy, x2: p.x, y2: p.y }
  })

  // Build vertex labels
  const labels = typeLabels.map((label, i) => {
    const p = getPointOnCircle(cx, cy, maxRadius + 18, i, n)
    const anchor = getLabelAnchor(p.angle)
    const displayLabel = label.replace(/[-_]/g, " ")
    return { ...p, displayLabel, fullLabel: label, ...anchor }
  })

  // Ring labels (along top axis only)
  const ringLabels = rings.filter((pct) => pct > 0).map((pct) => {
    const r = maxRadius * (pct / 100)
    return { pct, x: cx + 4, y: cy - r + 3 }
  })

  // Build polygon data for each provider (or single)
  const polygons = useMemo(() => {
    if (isMulti && multiData) {
      return multiData.map((provider, providerIdx) => {
        const color = getProviderColor(provider.provider, providerIdx)
        const points = typeLabels.map((type, i) => {
          const accuracy = provider.data[type]?.accuracy ?? 0
          const r = maxRadius * accuracy
          const p = getPointOnCircle(cx, cy, r, i, n)
          return { ...p, accuracy }
        })
        const polygonPoints = points.map((p) => `${p.x},${p.y}`).join(" ")
        return { provider: provider.provider, color, points, polygonPoints }
      })
    }
    // Single provider
    const points = singleEntries.map(([, stats], i) => {
      const r = maxRadius * stats.accuracy
      const p = getPointOnCircle(cx, cy, r, i, n)
      return { ...p, accuracy: stats.accuracy }
    })
    const polygonPoints = points.map((p) => `${p.x},${p.y}`).join(" ")
    return [{ provider: "", color: "#5040ff", points, polygonPoints }]
  }, [isMulti, multiData, singleEntries, typeLabels, maxRadius, cx, cy, n])

  return (
    <div className="card">
      <h3 className="text-sm font-medium text-text-primary mb-3">
        Accuracy by Question Type
      </h3>

      {/* Provider legend (multi mode only) */}
      {isMulti && (
        <div className="flex items-center gap-4 mb-3 px-2">
          {polygons.map((poly) => (
            <div key={poly.provider} className="flex items-center gap-1.5 text-xs">
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: poly.color }}
              />
              <span className="text-text-secondary capitalize">{poly.provider}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-center px-6">
        <svg
          viewBox={`0 0 ${size} ${size}`}
          className="w-full max-w-[320px] overflow-visible"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Guide polygons */}
          {guidePolygons.map((guide) => (
            <polygon
              key={guide.pct}
              points={guide.points}
              fill="none"
              stroke="rgba(255, 255, 255, 0.06)"
              strokeWidth="1"
            />
          ))}

          {/* Axis lines */}
          {axisLines.map((line, i) => (
            <line
              key={i}
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke="rgba(255, 255, 255, 0.06)"
              strokeWidth="1"
            />
          ))}

          {/* Ring labels */}
          {ringLabels.map((rl) => (
            <text
              key={rl.pct}
              x={rl.x}
              y={rl.y}
              fontSize="9"
              fill="#55556a"
              textAnchor="start"
            >
              {rl.pct}%
            </text>
          ))}

          {/* Data polygons - animated */}
          {polygons.map((poly, polyIdx) => (
            <motion.g
              key={poly.provider || polyIdx}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{
                duration: 0.6,
                delay: polyIdx * 0.15,
                ease: [0.16, 1, 0.3, 1],
              }}
              style={{ transformOrigin: `${cx}px ${cy}px` }}
            >
              <polygon
                points={poly.polygonPoints}
                fill={hexToRgba(poly.color, 0.12)}
                stroke={poly.color}
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </motion.g>
          ))}

          {/* Vertex dots - staggered */}
          {polygons.map((poly, polyIdx) =>
            poly.points.map((point, i) => (
              <motion.circle
                key={`${poly.provider || polyIdx}-${i}`}
                cx={point.x}
                cy={point.y}
                r={isMulti ? 3 : 4}
                fill={poly.color}
                stroke={hexToRgba(poly.color, 0.5)}
                strokeWidth="1.5"
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{
                  delay: 0.3 + polyIdx * 0.15 + i * 0.03,
                  duration: 0.3,
                  ease: [0.16, 1, 0.3, 1],
                }}
                style={{ transformOrigin: `${point.x}px ${point.y}px` }}
              />
            ))
          )}

          {/* Vertex labels */}
          {labels.map((label, i) => (
            <text
              key={i}
              x={label.x}
              y={label.y}
              fontSize="10"
              fill="#8888a0"
              textAnchor={label.textAnchor}
              dy={label.dy}
              className="select-none"
            >
              <title>{label.fullLabel}</title>
              {label.displayLabel}
            </text>
          ))}
        </svg>
      </div>

      {/* Legend row - single mode only */}
      {!isMulti && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-4 px-2">
          {singleEntries.map(([type, stats]) => (
            <div key={type} className="flex items-center justify-between text-xs">
              <span className="text-text-secondary truncate mr-2">
                {type.replace(/[-_]/g, " ")}
              </span>
              <span className="flex-shrink-0">
                <span className="text-text-primary font-medium">
                  {(stats.accuracy * 100).toFixed(0)}%
                </span>
                <span className="text-text-muted ml-1.5">
                  {stats.correct}/{stats.total}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
