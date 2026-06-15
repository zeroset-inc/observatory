import { useState, useEffect, useRef, useCallback } from "react"
import { Link, useParams, useNavigate } from "react-router-dom"
import { getRun, getRunReport, stopRun, startRun, preflightRun, retryQuestions, type RunDetail } from "@/lib/api"
import { useAuth } from "@/hooks/useAuth"
import { formatDate, getStatusColor, cn } from "@/lib/utils"
import { PipelineOverview } from "@/components/pipeline-overview"
import { LiveStats } from "@/components/live-stats"
import { QuestionPipelineTable } from "@/components/question-pipeline-table"
import { RadarChart } from "@/components/radar-chart"
import { LatencyTable } from "@/components/benchmark-results"

const POLL_INTERVAL = 2000 // 2 seconds

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return `${m}m ${rem}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export default function RunDetailPage() {
  const params = useParams()
  const navigate = useNavigate()
  const runId = decodeURIComponent(params.runId as string)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const [run, setRun] = useState<RunDetail | null>(null)
  const [report, setReport] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [terminating, setTerminating] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [retryingQuestions, setRetryingQuestions] = useState<Set<string>>(new Set())
  const mountedRef = useRef(true)
  const retryingIdsRef = useRef<Set<string>>(new Set()) // synchronous dedup for rapid clicks
  const { user } = useAuth()

  // Check if run is in progress
  const isInitializing = run?.status === "initializing"
  const isRunning =
    run?.status === "running" ||
    run?.status === "pending" ||
    run?.status === "stopping" ||
    isInitializing
  const isStopping = run?.status === "stopping"
  const isFailed = run?.status === "failed"
  const isPartial = run?.status === "partial"
  const canContinue = isFailed || isPartial
  const isComplete = run?.status === "completed"

  // Elapsed time ticker (live when running, frozen when complete)
  const totalElapsedMs = run?.createdAt && run?.updatedAt && !isRunning
    ? new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime()
    : undefined

  useEffect(() => {
    if (!run?.createdAt || !isRunning) {
      if (totalElapsedMs) setElapsedMs(totalElapsedMs)
      return
    }
    const startTime = new Date(run.createdAt).getTime()
    const tick = () => setElapsedMs(Date.now() - startTime)
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [run?.createdAt, isRunning, totalElapsedMs])

  async function handleContinue() {
    if (continuing || !run) return
    setContinuing(true)
    try {
      const preflight = await preflightRun({
        provider: run.provider,
        judgeModel: run.judge,
      })
      if (!preflight.valid) {
        const labels: Record<string, string> = {
          supermemory: "Supermemory", mem0: "Mem0", zep: "Zep", nebula: "Nebula",
          openai: "OpenAI", anthropic: "Anthropic", google: "Google",
        }
        const names = preflight.missing.map((k) => labels[k] || k).join(", ")
        alert(`Missing API keys: ${names}. Add them in Settings before continuing.`)
        return
      }
      await startRun({
        provider: run.provider,
        benchmark: run.benchmark,
        runId: run.runId,
        judgeModel: run.judge,
      })
      await refreshData()
    } catch (e) {
      console.error("Failed to continue:", e)
    } finally {
      setContinuing(false)
    }
  }

  async function handleTerminate() {
    if (terminating) return
    setTerminating(true)
    try {
      await stopRun(runId)
      await refreshData()
    } catch (e) {
      console.error("Failed to terminate:", e)
    } finally {
      setTerminating(false)
    }
  }

  // Silent refresh (no loading state)
  const refreshData = useCallback(async () => {
    try {
      const runData = await getRun(runId)
      setRun(runData)
      setError(null)

      // Only fetch report when run is no longer in progress
      const active = ["running", "pending", "stopping", "initializing"].includes(runData.status)
      if (!active) {
        // Run finished — clear all retrying state so buttons re-enable
        if (retryingIdsRef.current.size > 0) {
          retryingIdsRef.current.clear()
          setRetryingQuestions(new Set())
        }
        const reportData = await getRunReport(runId).catch(() => null)
        setReport(reportData)
      }
    } catch (e) {
      // Silent fail on poll
    }
  }, [runId])

  // The durable runner serializes retry generations per run.
  async function handleRetry(questionIds: string[], fromPhase?: string) {
    if (!run || isRunning || retryingIdsRef.current.size > 0) return
    // Synchronous dedup against ref to handle rapid clicks safely
    const newIds = questionIds.filter((id) => !retryingIdsRef.current.has(id))
    if (newIds.length === 0) return
    newIds.forEach((id) => retryingIdsRef.current.add(id))

    // Mark as retrying immediately (visual feedback)
    setRetryingQuestions((prev) => {
      const next = new Set(prev)
      newIds.forEach((id) => next.add(id))
      return next
    })

    try {
      await retryQuestions(runId, newIds, fromPhase)
      if (mountedRef.current) setReport(null)
      await refreshData()
      // retryingIdsRef stays set — cleared by poll when questions leave "pending" status.
      // This prevents duplicate retries during the window between POST return and
      // backend processing start.
    } catch (e) {
      console.error("Failed to retry:", e)
      // Only clear on failure so the user can try again
      newIds.forEach((id) => retryingIdsRef.current.delete(id))
      if (mountedRef.current) {
        setRetryingQuestions((prev) => {
          const next = new Set(prev)
          newIds.forEach((id) => next.delete(id))
          return next
        })
        alert(e instanceof Error ? e.message : "Failed to retry questions")
      }
    }
  }

  // Initial load
  useEffect(() => {
    loadData()
  }, [runId])

  // Unmount: suppress state updates from in-flight retries
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Polling when run is in progress
  useEffect(() => {
    if (isRunning) {
      pollIntervalRef.current = setInterval(refreshData, POLL_INTERVAL)
    } else {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [isRunning, refreshData])

  async function loadData(retries = 3) {
    try {
      setLoading(true)
      const runData = await getRun(runId)
      setRun(runData)

      // Only fetch report when run is no longer in progress
      const active = ["running", "pending", "stopping", "initializing"].includes(runData.status)
      if (!active) {
        const reportData = await getRunReport(runId).catch(() => null)
        setReport(reportData)
      }
      setError(null)
    } catch (e) {
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 1000))
        return loadData(retries - 1)
      }
      setError(e instanceof Error ? e.message : "Failed to load run")
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error || !run) {
    return (
      <div className="text-center py-12">
        <p className="text-status-error">{error || "Run not found"}</p>
        <Link to="/runs" className="btn btn-secondary mt-4">
          Back to runs
        </Link>
      </div>
    )
  }

  // Show initializing state while benchmark is loading/downloading
  if (isInitializing) {
    return (
      <div className="stagger-fade-in">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-text-secondary mb-4">
          <Link to="/runs" className="hover:text-text-primary">
            Runs
          </Link>
          <span>/</span>
          <span className="text-text-primary">{runId}</span>
        </div>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-display font-medium text-text-primary flex items-center gap-3">
            {runId}
            <span className="badge text-sm bg-accent/10 text-accent">initializing</span>
          </h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-text-secondary">
            <span>
              <span className="text-text-muted">Provider:</span>{" "}
              <span className="capitalize">{run.provider}</span>
            </span>
            <span>
              <span className="text-text-muted">Benchmark:</span>{" "}
              <span className="capitalize">{run.benchmark}</span>
            </span>
          </div>
        </div>

        {/* Loading State */}
        <div className="flex flex-col items-center justify-center py-16 border border-border rounded-lg">
          <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin mb-4" />
          <p className="text-text-secondary text-lg">Loading benchmark dataset...</p>
          <p className="text-text-muted text-sm mt-2">
            This may take a moment for first-time downloads
          </p>
        </div>
      </div>
    )
  }

  const allQuestions = Object.values(run.questions)
  const evaluatedQuestions = allQuestions.filter((q) => q.phases.evaluate.status === "completed")
  const accuracy =
    report?.summary?.accuracy != null
      ? report.summary.accuracy * 100
      : evaluatedQuestions.length > 0
        ? (evaluatedQuestions.filter((q) => q.phases.evaluate.score === 1).length /
            evaluatedQuestions.length) *
          100
        : 0

  // Find error from failed phases
  const runError = (() => {
    for (const q of allQuestions) {
      const phases = q.phases as Record<string, { status?: string; error?: string }>
      for (const phase of ["ingest", "indexing", "search", "evaluate"]) {
        if (phases[phase]?.status === "failed" && phases[phase]?.error) {
          return phases[phase].error
        }
      }
    }
    return null
  })()

  const hasReport = !!report
  const isSettled = !isRunning || isInitializing

  function copyResults() {
    const rows = evaluatedQuestions.map((q) => ({
      collectionId: q.containerTag,
      questionId: q.questionId,
      questionType: q.questionType,
      question: q.question,
      groundTruth: q.groundTruth,
      retrievedContext: q.phases.search.results ?? [],
      judge: {
        label: q.phases.evaluate.label ?? null,
        score: q.phases.evaluate.score ?? null,
        explanation: q.phases.evaluate.explanation ?? null,
      },
    }))
    navigator.clipboard.writeText(JSON.stringify(rows, null, 2)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="stagger-fade-in">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-text-secondary mb-4">
        <Link to="/runs" className="hover:text-text-primary">
          Runs
        </Link>
        <span>/</span>
        <span className="text-text-primary">{runId}</span>
      </div>

      {/* Hero Section */}
      <div className="card mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-display font-medium text-text-primary flex items-center gap-3">
              {runId}
              <span className={cn("badge text-sm", getStatusColor(run.status))}>{run.status}</span>
            </h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-text-secondary">
              <span>
                <span className="text-text-muted">Provider:</span>{" "}
                <span className="capitalize">{run.provider}</span>
              </span>
              <span>
                <span className="text-text-muted">Benchmark:</span>{" "}
                <span className="capitalize">{run.benchmark}</span>
              </span>
              <span>
                <span className="text-text-muted">Judge:</span> {run.judge}
              </span>
              <span>
                <span className="text-text-muted">Created:</span> {formatDate(run.createdAt)}
              </span>
              {elapsedMs > 0 && (
                <span>
                  <span className="text-text-muted">{isRunning ? "Elapsed:" : "Duration:"}</span>{" "}
                  <span className="tabular-nums">{formatElapsed(elapsedMs)}</span>
                </span>
              )}
            </div>
          </div>

          {/* Right side: action buttons + accuracy */}
          <div className="flex items-start gap-4 flex-shrink-0 ml-8">
            {/* Action buttons */}
            {(isRunning || isStopping) && (
              <button
                onClick={handleTerminate}
                disabled={terminating || isStopping}
                className={cn(
                  "px-3 py-1.5 text-sm rounded-lg transition-colors cursor-pointer border",
                  "border-border text-text-muted hover:border-status-error hover:text-status-error hover:bg-status-error/10",
                  (terminating || isStopping) && "opacity-50 cursor-not-allowed"
                )}
              >
                {terminating || isStopping ? "Stopping..." : "Terminate"}
              </button>
            )}
            {canContinue && (
              <button
                onClick={handleContinue}
                disabled={continuing}
                className={cn(
                  "px-3 py-1.5 text-sm rounded-lg transition-colors cursor-pointer",
                  "bg-accent/10 text-accent hover:bg-accent/20",
                  continuing && "opacity-50 cursor-not-allowed"
                )}
              >
                {continuing ? "Resuming..." : "Continue"}
              </button>
            )}

            {/* Large accuracy display */}
            <div className="text-right">
              <div className="text-5xl font-display font-medium text-text-primary tabular-nums">
                {accuracy ? `${accuracy.toFixed(1)}%` : "—"}
              </div>
              <div className="text-sm text-text-secondary mt-1">
                {report
                  ? `${report.summary.correctCount}/${report.summary.totalQuestions} correct`
                  : evaluatedQuestions.length > 0
                    ? `${evaluatedQuestions.filter((q) => q.phases.evaluate.score === 1).length}/${evaluatedQuestions.length} correct`
                    : "accuracy"}
              </div>
            </div>
          </div>
        </div>

        {/* Thin accuracy progress bar */}
        <div className="mt-5 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-500"
            style={{ width: `${accuracy || 0}%` }}
          />
        </div>
      </div>

      {/* Error Display */}
      {runError && (
        <div className="mb-6">
          <div className="px-5 py-4 border border-border rounded-lg">
            <p className="text-sm">
              <span className="text-status-error font-semibold">Error</span>
              <span className="text-text-secondary"> {runError}</span>
            </p>
          </div>
        </div>
      )}

      {/* === Unified View: same skeleton for running & settled === */}
      <div className="space-y-6">
        {/* Pipeline Overview */}
        <PipelineOverview summary={run.summary} />

        {/* Live Stats */}
        <LiveStats
          summary={run.summary}
          questions={allQuestions}
          elapsedMs={elapsedMs}
          isComplete={isSettled}
          totalElapsedMs={totalElapsedMs}
        />

        {/* Analytics — unlocked when report exists */}
        {hasReport && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <RadarChart data={report?.byQuestionType} />
            <LatencyTable latency={report?.latency} />
          </div>
        )}

        {/* Question Pipeline Table */}
        <div>
          <h2 className="text-lg font-display font-medium text-text-primary mb-4">
            Questions
            <span className="text-text-muted text-sm font-normal ml-2">
              {allQuestions.length} total
            </span>
          </h2>
          <QuestionPipelineTable
            questions={allQuestions}
            questionTypeRegistry={report?.questionTypeRegistry}
            stickyFilter={isSettled}
            autoExpandFailures={isSettled}
            showCopyResults={isSettled && evaluatedQuestions.length > 0}
            onCopyResults={copyResults}
            copied={copied}
            canRetry={!isRunning && retryingQuestions.size === 0 && !!user}
            onRetry={handleRetry}
            retrying={retryingQuestions}
          />
        </div>
      </div>
    </div>
  )
}
