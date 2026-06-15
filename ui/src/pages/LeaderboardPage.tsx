import { useState, useEffect, useMemo, useId } from "react"
import { Link, useNavigate } from "react-router-dom"
import { getLeaderboard, removeFromLeaderboard, type LeaderboardEntry } from "@/lib/api"
import { cn } from "@/lib/utils"
import { MultiSelect } from "@/components/multi-select"
import { SingleSelect } from "@/components/single-select"
import { DataTable, type Column } from "@/components/data-table"
import { DropdownMenu } from "@/components/dropdown-menu"
import { EmptyState } from "@/components/empty-state"
import { Search, ChevronDown, ChevronRight } from "lucide-react"

// Provider colors for charts — muted/desaturated palette
const PROVIDER_COLORS: Record<string, string> = {
  supermemory: "#4d85c8",
  nebula: "#5b5fd6",
}
const DEFAULT_COLORS = ["#32ab80", "#b35a40", "#c4a035", "#4d85c8", "#9a6acc"]

function buildColorMap(providers: string[]): Map<string, string> {
  const map = new Map<string, string>()
  let idx = 0
  for (const p of providers) {
    if (PROVIDER_COLORS[p.toLowerCase()]) {
      map.set(p, PROVIDER_COLORS[p.toLowerCase()])
    } else {
      map.set(p, DEFAULT_COLORS[idx % DEFAULT_COLORS.length])
      idx++
    }
  }
  return map
}


// --- Animated Vertical Bar Chart ---

interface BarGroup {
  label: string
  bars: { key: string; value: number; color: string }[]
}

interface VerticalBarChartProps {
  title: string
  groups: BarGroup[]
  yMax: number
  ySteps: number[]
  formatValue: (v: number) => string
  formatYLabel?: (v: number) => string
  height?: number
  barWidth?: number
  legend?: { label: string; color: string; opacity?: number }[]
  lowerIsBetter?: boolean
}

function VerticalBarChart({
  title,
  groups,
  yMax,
  ySteps,
  formatValue,
  formatYLabel,
  height: chartHeight = 280,
  barWidth: bw = 28,
  legend,
  lowerIsBetter = false,
}: VerticalBarChartProps) {
  const animId = useId()

  const barGap = Math.max(Math.round(bw * 0.2), 2)
  const groupGap = Math.max(Math.round(bw * 2.5), 40)
  const yAxisWidth = 48
  const xAxisHeight = 32
  const topPadding = 28
  const rightPad = 16

  const maxBarsInGroup = Math.max(...groups.map((g) => g.bars.length), 1)
  const groupWidth = maxBarsInGroup * (bw + barGap) - barGap
  const totalWidth = yAxisWidth + groups.length * (groupWidth + groupGap) + rightPad

  const yScale = (value: number) => chartHeight - (value / yMax) * chartHeight

  return (
    <div className="card p-5 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[11px] font-medium text-text-muted uppercase tracking-widest">
          {title}
        </h3>
        {legend && (
          <div className="flex items-center gap-3">
            {legend.map((item) => (
              <div key={item.label} className="flex items-center gap-1.5">
                <div
                  className="w-2.5 h-2.5 rounded-sm"
                  style={{ backgroundColor: item.color, opacity: item.opacity ?? 1 }}
                />
                <span className="text-[10px] text-text-muted">{item.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 w-full overflow-x-auto">
        <svg
          width="100%"
          height={chartHeight + xAxisHeight + topPadding}
          viewBox={`0 0 ${totalWidth} ${chartHeight + xAxisHeight + topPadding}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <style>{`
            @keyframes ${CSS.escape(animId)}-grow {
              from { transform: scaleY(0); }
              to { transform: scaleY(1); }
            }
            @keyframes ${CSS.escape(animId)}-fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
          `}</style>

          {/* Y-axis */}
          {ySteps.map((value) => (
            <g key={value}>
              <text
                x={yAxisWidth - 8}
                y={yScale(value) + topPadding + 3.5}
                textAnchor="end"
                className="fill-text-muted"
                style={{ fontSize: 10, fontFamily: "'IBM Plex Mono', monospace" }}
              >
                {(formatYLabel ?? formatValue)(value)}
              </text>
              <line
                x1={yAxisWidth}
                y1={yScale(value) + topPadding}
                x2={totalWidth - rightPad}
                y2={yScale(value) + topPadding}
                stroke="rgba(255, 255, 255, 0.04)"
                strokeWidth={1}
              />
            </g>
          ))}

          {/* Bar groups */}
          {groups.map((group, gi) => {
            const groupX = yAxisWidth + gi * (groupWidth + groupGap) + groupGap / 2
            const nonZeroBars = group.bars.filter((b) => b.value > 0)
            const bestValue = lowerIsBetter
              ? (nonZeroBars.length > 0 ? Math.min(...nonZeroBars.map((b) => b.value)) : 0)
              : Math.max(...group.bars.map((b) => b.value), 0)
            const firstBestIdx = group.bars.findIndex((b) => b.value === bestValue && b.value > 0)

            return (
              <g key={group.label}>
                {group.bars.map((bar, bi) => {
                  const barX = groupX + bi * (bw + barGap)
                  const barH = Math.max((bar.value / yMax) * chartHeight, 0)
                  const barY = yScale(bar.value) + topPadding
                  const isBest = bi === firstBestIdx && bestValue > 0
                  const delay = gi * 50 + bi * 25

                  const r = Math.min(4, bw / 2, barH / 2)
                  const path =
                    barH > 0
                      ? `M ${barX} ${barY + barH} L ${barX} ${barY + r} Q ${barX} ${barY} ${barX + r} ${barY} L ${barX + bw - r} ${barY} Q ${barX + bw} ${barY} ${barX + bw} ${barY + r} L ${barX + bw} ${barY + barH} Z`
                      : ""

                  return (
                    <g key={bar.key}>
                      {barH > 0 && (
                        <path
                          d={path}
                          fill={bar.color}
                          opacity={isBest ? 1 : 0.75}
                          style={{
                            transformOrigin: `${barX + bw / 2}px ${chartHeight + topPadding}px`,
                            animation: `${CSS.escape(animId)}-grow 700ms cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms both`,
                          }}
                        />
                      )}
                      {bar.value > 0 && (
                        <text
                          x={barX + bw / 2}
                          y={barY - 6}
                          textAnchor="middle"
                          className={isBest ? "fill-text-primary" : "fill-text-secondary"}
                          style={{
                            fontSize: 9,
                            fontFamily: "'IBM Plex Mono', monospace",
                            animation: `${CSS.escape(animId)}-fadeIn 500ms ease ${delay + 500}ms both`,
                          }}
                        >
                          {formatValue(bar.value)}
                        </text>
                      )}
                    </g>
                  )
                })}

                <text
                  x={groupX + groupWidth / 2}
                  y={chartHeight + topPadding + 18}
                  textAnchor="middle"
                  className="fill-text-muted capitalize"
                  style={{ fontSize: 10 }}
                >
                  {group.label}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// --- Benchmark Charts Section ---

function BenchmarkCharts({
  entries,
  selectedBenchmark,
  onBenchmarkChange,
}: {
  entries: LeaderboardEntry[]
  selectedBenchmark: string
  onBenchmarkChange: (b: string) => void
}) {
  const availableBenchmarks = useMemo(() => {
    const set = new Set<string>()
    entries.forEach((e) => { if (e.isLatest) set.add(e.benchmark) })
    return Array.from(set).sort()
  }, [entries])

  const [selectedChartProviders, setSelectedChartProviders] = useState<string[]>([])

  useEffect(() => {
    if (availableBenchmarks.length > 0 && !availableBenchmarks.includes(selectedBenchmark)) {
      onBenchmarkChange(availableBenchmarks[0])
    }
  }, [availableBenchmarks])

  const benchmarkEntries = useMemo(
    () => entries.filter((e) => e.isLatest && e.benchmark === selectedBenchmark),
    [entries, selectedBenchmark]
  )

  // All providers for this benchmark (for the filter options)
  const allProviders = useMemo(
    () => benchmarkEntries
      .slice()
      .sort((a, b) => b.accuracy - a.accuracy)
      .map((e) => e.provider),
    [benchmarkEntries]
  )

  // Reset provider selection when benchmark changes (show all by default)
  useEffect(() => {
    setSelectedChartProviders([])
  }, [selectedBenchmark])

  // Filtered provider list — if none selected, show all
  const providerList = useMemo(
    () => selectedChartProviders.length > 0
      ? allProviders.filter((p) => selectedChartProviders.includes(p))
      : allProviders,
    [allProviders, selectedChartProviders]
  )

  const colorMap = useMemo(() => buildColorMap(allProviders), [allProviders])

  const benchmarkOptions = useMemo(
    () => availableBenchmarks.map((b) => ({ value: b, label: b })),
    [availableBenchmarks]
  )

  const providerOptions = useMemo(
    () => allProviders.map((p) => ({ value: p, label: p })),
    [allProviders]
  )

  if (availableBenchmarks.length === 0) return null

  // --- Build chart data for all 3 panels ---

  // Accuracy: overall + per-question-type
  const accuracyGroups: BarGroup[] = (() => {
    const groups: BarGroup[] = [{
      label: "overall",
      bars: providerList.map((p) => ({
        key: p,
        value: (benchmarkEntries.find((e) => e.provider === p)?.accuracy ?? 0) * 100,
        color: colorMap.get(p) || DEFAULT_COLORS[0],
      })),
    }]
    const allTypes = new Set<string>()
    benchmarkEntries.forEach((e) => Object.keys(e.byQuestionType).forEach((t) => allTypes.add(t)))
    Array.from(allTypes).sort().forEach((type) => {
      groups.push({
        label: type.replace(/[-_]/g, " "),
        bars: providerList.map((p) => {
          const stats = benchmarkEntries.find((e) => e.provider === p)?.byQuestionType[type]
          return { key: p, value: stats ? stats.accuracy * 100 : 0, color: colorMap.get(p) || DEFAULT_COLORS[0] }
        }),
      })
    })
    return groups
  })()

  // Memory precision: relevant_tokens / total_retrieved_tokens per provider
  const precisionGroups: BarGroup[] = providerList.map((p) => {
    const entry = benchmarkEntries.find((e) => e.provider === p)
    const precision = entry?.retrieval?.memoryPrecision ?? 0
    return {
      label: p,
      bars: [
        { key: "precision", value: precision * 100, color: colorMap.get(p) || DEFAULT_COLORS[0] },
      ],
    }
  })

  // Retrieved Context Size: total chars per provider
  const contextSizeGroups: BarGroup[] = providerList.map((p) => {
    const entry = benchmarkEntries.find((e) => e.provider === p)
    const totalChars = entry?.retrieval?.totalChars ?? 0
    return {
      label: p,
      bars: [
        { key: "contextSize", value: totalChars, color: colorMap.get(p) || DEFAULT_COLORS[0] },
      ],
    }
  })
  const contextSizeAllVals = contextSizeGroups.flatMap((g) => g.bars.map((b) => b.value))
  const contextSizeMaxVal = Math.max(...contextSizeAllVals, 1)
  const contextSizeYMax = Math.ceil(contextSizeMaxVal / 1000) * 1000 || 1000
  const contextSizeStep = contextSizeYMax / 5
  const contextSizeYSteps = Array.from({ length: 6 }, (_, i) => Math.round(i * contextSizeStep))

  // Latency: by phase
  const phases = ["ingest", "indexing", "search", "evaluate"] as const
  const latencyGroups: BarGroup[] = phases.map((phase) => ({
    label: phase,
    bars: providerList.map((p) => {
      const stats = benchmarkEntries.find((e) => e.provider === p)?.latencyStats?.[phase]
      return { key: p, value: stats?.mean ?? 0, color: colorMap.get(p) || DEFAULT_COLORS[0] }
    }),
  }))
  const latencyAllVals = latencyGroups.flatMap((g) => g.bars.map((b) => b.value))
  const latencyMaxVal = Math.max(...latencyAllVals, 1)
  const latencyYMax = Math.ceil(latencyMaxVal / 200) * 200
  const latencyStep = latencyYMax / 5
  const latencyYSteps = Array.from({ length: 6 }, (_, i) => Math.round(i * latencyStep))

  const noData = benchmarkEntries.length === 0

  return (
    <div className="mb-8" key={selectedBenchmark}>
      {/* Header: benchmark dropdown + provider filter + legend */}
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-48">
            <SingleSelect
              label="Benchmark"
              options={benchmarkOptions}
              selected={selectedBenchmark}
              onChange={onBenchmarkChange}
              placeholder="Select benchmark"
            />
          </div>
          <div className="w-52">
            <MultiSelect
              label="Providers"
              options={providerOptions}
              selected={selectedChartProviders}
              onChange={setSelectedChartProviders}
              placeholder="All providers"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          {providerList.map((p) => (
            <div key={p} className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: colorMap.get(p) }} />
              <span className="text-xs text-text-muted capitalize">{p}</span>
            </div>
          ))}
        </div>
      </div>

      {noData ? (
        <p className="text-text-muted text-sm py-8 text-center">No data for this benchmark.</p>
      ) : (
        <div className="space-y-4">
          {/* Hero chart — Accuracy gets full width and extra height */}
          <VerticalBarChart
            title="Accuracy"
            groups={accuracyGroups}
            yMax={100}
            ySteps={[0, 20, 40, 60, 80, 100]}
            formatValue={(v) => `${v.toFixed(1)}%`}
            formatYLabel={(v) => `${v}`}
            height={320}
            barWidth={32}
          />
          {/* Secondary charts */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <VerticalBarChart
              title="Memory Precision"
              groups={precisionGroups}
              yMax={100}
              ySteps={[0, 20, 40, 60, 80, 100]}
              formatValue={(v) => `${v.toFixed(0)}%`}
              formatYLabel={(v) => `${v}`}
              height={260}
              barWidth={24}
            />
            <VerticalBarChart
              title="Retrieved Context Size"
              groups={contextSizeGroups}
              yMax={contextSizeYMax}
              ySteps={contextSizeYSteps}
              formatValue={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`}
              formatYLabel={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`}
              height={260}
              barWidth={24}
              lowerIsBetter
            />
            <VerticalBarChart
              title="Latency (mean)"
              groups={latencyGroups}
              yMax={latencyYMax}
              ySteps={latencyYSteps}
              formatValue={(v) => `${Math.round(v)}ms`}
              height={260}
              barWidth={24}
              lowerIsBetter
            />
          </div>
        </div>
      )}
    </div>
  )
}

// --- Leaderboard Table ---

interface GroupedEntry {
  key: string
  latest: LeaderboardEntry
  history: LeaderboardEntry[]
}

export default function LeaderboardPage() {
  const navigate = useNavigate()
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Expanded groups (show history)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // Benchmark selection (shared between charts and table)
  const [selectedBenchmark, setSelectedBenchmark] = useState("")

  // Filters
  const [search, setSearch] = useState("")
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])

  useEffect(() => {
    loadLeaderboard()
  }, [])

  async function loadLeaderboard() {
    try {
      setLoading(true)

      const data = await getLeaderboard()
      setEntries(data.entries)

      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load leaderboard")
    } finally {
      setLoading(false)
    }
  }

  async function handleRemove(id: number) {
    if (!confirm("Remove this entry from the leaderboard?")) return

    try {
      await removeFromLeaderboard(id)
      setEntries((prev) => {
        const remaining = prev.filter((e) => e.id !== id)
        // Recompute isLatest on cloned objects (entries ordered by added_at DESC)
        const seen = new Set<string>()
        return remaining.map((entry) => {
          const key = `${entry.provider}::${entry.benchmark}`
          const isLatest = !seen.has(key)
          seen.add(key)
          return isLatest !== entry.isLatest ? { ...entry, isLatest } : entry
        })
      })
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to remove entry")
    }
  }

  // Get unique providers for filter options (scoped to selected benchmark)
  const providers = useMemo(() => {
    const counts: Record<string, number> = {}
    entries
      .filter((e) => e.benchmark === selectedBenchmark)
      .forEach((e) => {
        counts[e.provider] = (counts[e.provider] || 0) + 1
      })
    return Object.entries(counts).map(([value, count]) => ({
      value,
      label: value,
      count,
    }))
  }, [entries, selectedBenchmark])

  // Filter entries — always scoped to selected benchmark
  const filteredEntries = useMemo(() => {
    return entries.filter((e) => {
      if (e.benchmark !== selectedBenchmark) return false
      if (search) {
        const searchLower = search.toLowerCase()
        const matchesSearch =
          e.version.toLowerCase().includes(searchLower) ||
          e.runId.toLowerCase().includes(searchLower) ||
          e.provider.toLowerCase().includes(searchLower)
        if (!matchesSearch) return false
      }
      if (selectedProviders.length > 0 && !selectedProviders.includes(e.provider)) return false
      return true
    })
  }, [entries, search, selectedProviders, selectedBenchmark])

  // Group filtered entries by provider+benchmark, latest first
  const grouped = useMemo((): GroupedEntry[] => {
    const map = new Map<string, LeaderboardEntry[]>()
    for (const entry of filteredEntries) {
      const key = `${entry.provider}::${entry.benchmark}`
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(entry)
    }
    // Sort groups by best accuracy (latest entry's accuracy)
    const groups: GroupedEntry[] = []
    for (const [key, groupEntries] of map) {
      // Entries already sorted by added_at DESC from backend
      const [latest, ...history] = groupEntries
      groups.push({ key, latest, history })
    }
    groups.sort((a, b) => b.latest.accuracy - a.latest.accuracy)
    return groups
  }, [filteredEntries])

  // Build flat display list from groups (latest + expanded history)
  const displayEntries = useMemo(() => {
    const rows: Array<{ entry: LeaderboardEntry; isHistory: boolean; groupKey: string; hasHistory: boolean }> = []
    for (const group of grouped) {
      rows.push({ entry: group.latest, isHistory: false, groupKey: group.key, hasHistory: group.history.length > 0 })
      if (expandedGroups.has(group.key)) {
        for (const historyEntry of group.history) {
          rows.push({ entry: historyEntry, isHistory: true, groupKey: group.key, hasHistory: false })
        }
      }
    }
    return rows
  }, [grouped, expandedGroups])

  // Get question types and registry for the selected benchmark
  const { visibleQuestionTypes, typeRegistry } = useMemo((): {
    visibleQuestionTypes: string[]
    typeRegistry: LeaderboardEntry["questionTypeRegistry"]
  } => {
    const types = new Set<string>()
    let registry: LeaderboardEntry["questionTypeRegistry"] = null

    filteredEntries.forEach((e) => {
      Object.keys(e.byQuestionType).forEach((t) => types.add(t))
      if (!registry && e.questionTypeRegistry) {
        registry = e.questionTypeRegistry
      }
    })

    return {
      visibleQuestionTypes: Array.from(types).sort(),
      typeRegistry: registry,
    }
  }, [filteredEntries])

  const hasActiveFilters = search !== "" || selectedProviders.length > 0

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Render a column header that doubles as a filter trigger
  const renderFilterTrigger =
    (name: string) =>
    ({ selected, open }: { selected: string[]; open: boolean }) => (
      <span
        className={cn(
          "flex items-center gap-1.5 transition-colors",
          selected.length > 0 ? "text-accent" : "text-text-secondary hover:text-text-primary"
        )}
      >
        <span className="text-xs font-medium uppercase tracking-wider">{name}</span>
        <ChevronDown
          className={cn(
            "w-3 h-3 flex-shrink-0 transition-transform",
            open && "rotate-180"
          )}
        />
        {selected.length > 0 && (
          <span className="text-[10px] bg-accent/15 text-accent rounded-full min-w-[18px] h-[18px] flex items-center justify-center">
            {selected.length}
          </span>
        )}
      </span>
    )

  type DisplayRow = (typeof displayEntries)[number]

  // Pre-compute ranks so render functions don't use mutable counters
  const rankByEntryId = useMemo(() => {
    const map = new Map<number, number>()
    let rank = 0
    for (const row of displayEntries) {
      if (!row.isHistory) {
        rank++
        map.set(row.entry.id, rank)
      }
    }
    return map
  }, [displayEntries])

  // Build columns
  const columns: Column<DisplayRow>[] = useMemo(() => {
    const cols: Column<DisplayRow>[] = [
      {
        key: "expand",
        header: "",
        width: "28px",
        render: (row) => {
          if (row.isHistory) return null
          if (!row.hasHistory) return null
          const isExpanded = expandedGroups.has(row.groupKey)
          return (
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleGroup(row.groupKey)
              }}
              className="p-0.5 text-text-muted hover:text-text-primary transition-colors cursor-pointer"
            >
              <ChevronRight
                className={cn(
                  "w-3.5 h-3.5 transition-transform",
                  isExpanded && "rotate-90"
                )}
              />
            </button>
          )
        },
      },
      {
        key: "rank",
        header: "Rank",
        width: "50px",
        render: (row) => {
          if (row.isHistory) return null
          return <span className="text-text-muted">{rankByEntryId.get(row.entry.id)}</span>
        },
      },
      {
        key: "provider",
        header: "Provider",
        filterElement: (
          <MultiSelect
            label="Provider"
            options={providers}
            selected={selectedProviders}
            onChange={setSelectedProviders}
            renderTrigger={renderFilterTrigger("Provider")}
          />
        ),
        render: (row) => (
          <Link
            to={`/providers/${row.entry.provider}`}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "capitalize hover:underline",
              row.isHistory ? "text-text-muted" : "text-text-primary"
            )}
          >
            {row.entry.provider}
          </Link>
        ),
      },
      {
        key: "version",
        header: "Run",
        filterElement: (
          <div className="relative flex items-center h-full w-full">
            <Search className="absolute left-0 w-3.5 h-3.5 text-text-muted" />
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-full pl-5 text-sm bg-transparent text-text-primary placeholder-text-muted border-0 focus:outline-none cursor-text"
            />
          </div>
        ),
        render: (row) => (
          <Link
            to={`/leaderboard/${row.entry.id}`}
            className={cn(
              "hover:underline cursor-pointer text-sm",
              row.isHistory ? "text-text-muted" : "text-accent"
            )}
          >
            {row.entry.version || row.entry.runId}
          </Link>
        ),
      },
      {
        key: "date",
        header: "Date",
        render: (row) => {
          const date = new Date(row.entry.addedAt)
          return (
            <span className={cn("text-xs", row.isHistory ? "text-text-muted" : "text-text-secondary")}>
              {date.getFullYear()}-{String(date.getMonth() + 1).padStart(2, "0")}-{String(date.getDate()).padStart(2, "0")}
            </span>
          )
        },
      },
    ]

    // Add question type columns only when single benchmark is selected
    visibleQuestionTypes.forEach((type) => {
      const alias = typeRegistry?.[type]?.alias || type.replace(/[-_]/g, " ")
      cols.push({
        key: type,
        header: alias,
        align: "center",
        render: (row) => {
          const stats = row.entry.byQuestionType[type]
          if (!stats) {
            return <span className="text-text-muted">—</span>
          }
          return (
            <span className={row.isHistory ? "text-text-muted" : ""}>
              {(stats.accuracy * 100).toFixed(0)}%
            </span>
          )
        },
      })
    })

    // Accuracy column (always last)
    cols.push({
      key: "accuracy",
      header: "Accuracy",
      align: "right",
      render: (row) => (
        <span className={cn("font-medium", row.isHistory ? "text-text-muted" : "text-accent")}>
          {(row.entry.accuracy * 100).toFixed(1)}%
        </span>
      ),
    })

    // Actions column
    cols.push({
      key: "actions",
      header: "",
      width: "40px",
      align: "right",
      render: (row) => (
        <DropdownMenu
          items={[
            {
              label: "view details",
              href: `/leaderboard/${row.entry.id}`,
            },
            { divider: true },
            {
              label: "remove from leaderboard",
              onClick: () => handleRemove(row.entry.id),
              danger: true,
            },
          ]}
        />
      ),
    })

    return cols
  }, [visibleQuestionTypes, typeRegistry, search, providers, selectedProviders, expandedGroups, rankByEntryId])

  const clearFilters = () => {
    setSearch("")
    setSelectedProviders([])
  }

  if (error) {
    return (
      <div className="stagger-fade-in">
        <div className="mb-6">
          <h1 className="text-2xl font-display font-medium text-text-primary">Leaderboard</h1>
        </div>
        <div className="text-center py-12">
          <p className="text-status-error">{error}</p>
          <button className="btn btn-secondary mt-3" onClick={loadLeaderboard}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="stagger-fade-in">
      {/* Hero */}
      <div className="mb-8">
        <h1 className="text-3xl font-display font-medium text-text-primary tracking-tight">
          Memory Layer Benchmarks
        </h1>
        <p className="text-text-secondary mt-1">
          Comparing accuracy across memory and context layer providers.
        </p>
      </div>

      {/* Benchmark Charts */}
      {!loading && entries.length > 0 && (
        <BenchmarkCharts
          entries={entries}
          selectedBenchmark={selectedBenchmark}
          onBenchmarkChange={setSelectedBenchmark}
        />
      )}

      {/* Leaderboard Table Section */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-display font-medium text-text-primary">Rankings</h2>
            {!loading && entries.length > 0 && hasActiveFilters && (
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <span>·</span>
                <span>
                  {grouped.length} of {entries.filter((e) => e.isLatest).length} providers
                </span>
                <span>·</span>
                <button
                  onClick={clearFilters}
                  className="text-text-muted hover:text-text-primary transition-colors cursor-pointer"
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center">
            <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-text-secondary mt-3">Loading leaderboard...</p>
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            title="No entries yet"
            description="Completed benchmark runs are automatically added to the leaderboard. Start a run from the Runs page to see results here."
          />
        ) : (
          <DataTable
            columns={columns}
            data={displayEntries}
            emptyMessage="No entries match your filters"
            getRowKey={(row) => row.entry.id}
            onRowClick={(row) => navigate(`/leaderboard/${row.entry.id}`)}
            connectToFilterBar={false}
          />
        )}
      </div>
    </div>
  )
}
