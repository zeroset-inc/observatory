// Shared run state for tracking active runs and stop signals
// Used by both server routes and orchestrator phases
//
// Hybrid approach: in-memory Map for hot-path sync reads (shouldStop),
// DB write-through for crash recovery persistence.

export type RunState = {
  status: "running" | "stopping"
  startedAt: string
  benchmark?: string
  userId?: string | null
  /** Resolves when the background process finishes. */
  completion?: Promise<void>
}

// In-memory map of active runs
export const activeRuns = new Map<string, RunState>()

// Reference counter for concurrent retry sessions per run
const retryRefCount = new Map<string, number>()
const durableStopSignals = new Set<string>()

// Check if a run should stop (sync — reads Map only)
export function shouldStop(runId: string): boolean {
  if (durableStopSignals.has(runId)) return true
  const state = activeRuns.get(runId)
  return state?.status === "stopping"
}

export function startDurableStopPolling(runId: string, intervalMs = 1000): () => void {
  let stopped = false
  let polling = false

  const poll = async () => {
    if (stopped || polling) return
    polling = true
    try {
      const { db } = require("./db")
      const { data, error } = await db
        .from("runs")
        .select("active_status")
        .eq("id", runId)
        .maybeSingle()

      if (!error && data?.active_status === "stopping") {
        durableStopSignals.add(runId)
        const state = activeRuns.get(runId)
        if (state) state.status = "stopping"
      }
    } catch {
      // Stop polling is best-effort between phase boundaries; failures are retried.
    } finally {
      polling = false
    }
  }

  void poll()
  const timer = setInterval(() => void poll(), intervalMs)
  return () => {
    stopped = true
    clearInterval(timer)
    durableStopSignals.delete(runId)
  }
}

// Mark a run as stopping (write-through)
export function requestStop(runId: string): boolean {
  const state = activeRuns.get(runId)
  durableStopSignals.add(runId)
  if (state) state.status = "stopping"

  // Write-through to DB (fire-and-forget)
  const { db } = require("./db")
  db.from("runs").update({ active_status: "stopping" }).eq("id", runId).then()

  return Boolean(state)
}

// Start tracking a run (write-through)
export function startRun(runId: string, benchmark?: string, userId?: string | null): void {
  durableStopSignals.delete(runId)
  activeRuns.set(runId, {
    status: "running",
    startedAt: new Date().toISOString(),
    benchmark,
    userId,
  })

  // Write-through to DB (fire-and-forget)
  const { db } = require("./db")
  db.from("runs").update({ active_status: "running" }).eq("id", runId).then()
}

// Atomically start a run only if it's not already active.
// Returns true if the run was started, false if it was already active.
export function startRunIfIdle(runId: string, benchmark?: string, userId?: string | null): boolean {
  if (activeRuns.has(runId)) return false
  startRun(runId, benchmark, userId)
  return true
}

// Acquire a retry slot for a run. Multiple concurrent retries are allowed.
// Returns the slot number (1 = first slot) or false if a full run is active.
export function acquireRetrySlot(runId: string, benchmark?: string, userId?: string | null): number | false {
  const count = retryRefCount.get(runId) || 0
  if (count === 0 && activeRuns.has(runId)) {
    // A non-retry operation (full run) is already active — block
    return false
  }
  if (count === 0) {
    // First retry slot — start tracking the run
    startRun(runId, benchmark, userId)
  }
  const newCount = count + 1
  retryRefCount.set(runId, newCount)
  return newCount
}

// Release a retry slot. Returns true if this was the last active slot.
// When true, the caller must do async finalization (status recompute,
// report, broadcast) and then call endRun() when done.
export function releaseRetrySlot(runId: string): boolean {
  const count = retryRefCount.get(runId) || 0
  if (count <= 1) {
    retryRefCount.delete(runId)
    return true // last slot — caller must call endRun() after finalization
  }
  retryRefCount.set(runId, count - 1)
  return false // more retries still active
}

// Get the current retry ref count for a run
export function getRetrySlotCount(runId: string): number {
  return retryRefCount.get(runId) || 0
}

// Stop tracking a run (write-through)
export function endRun(runId: string): void {
  activeRuns.delete(runId)
  durableStopSignals.delete(runId)

  // Write-through to DB (fire-and-forget)
  const { db } = require("./db")
  db.from("runs").update({ active_status: null }).eq("id", runId).then()
}

// Attach a completion promise to a tracked run.
// If a completion already exists (e.g. concurrent retries), both are awaited.
// Rejections are suppressed at storage time — callers only care that the work
// has stopped, not whether it succeeded. This prevents unhandled rejection
// warnings when no one calls waitForCompletion (e.g. normal run completion).
export function setCompletion(runId: string, promise: Promise<unknown>): void {
  const state = activeRuns.get(runId)
  if (!state) return
  const wrapped = promise.then(() => {}, () => {})
  state.completion = state.completion
    ? Promise.all([state.completion, wrapped]).then(() => {})
    : wrapped
}

// Wait for a run's background process to settle (resolve or reject).
// Resolves immediately if the run is not active or has no completion promise.
// Rejections are suppressed — callers only care that the work has finished.
export function waitForCompletion(runId: string): Promise<void> {
  return activeRuns.get(runId)?.completion?.catch(() => {}) ?? Promise.resolve()
}

// Like waitForCompletion but with a timeout. Returns true if the run
// settled in time, false if the timeout fired first.
export function waitForCompletionWithTimeout(runId: string, timeoutMs: number): Promise<boolean> {
  const completion = activeRuns.get(runId)?.completion?.catch(() => {}) ?? Promise.resolve()
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  return Promise.race([
    completion.then(() => { clearTimeout(timer!); return true }),
    timeout,
  ])
}

// Check if a run is active
export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId)
}

// Get run state
export function getRunState(runId: string): RunState | undefined {
  return activeRuns.get(runId)
}

// Get all active runs with their benchmarks
export function getActiveRunsWithBenchmarks(): Array<{ runId: string; benchmark: string }> {
  const result: Array<{ runId: string; benchmark: string }> = []
  for (const [runId, state] of activeRuns) {
    if (state.benchmark) {
      result.push({ runId, benchmark: state.benchmark })
    }
  }
  return result
}

/**
 * Crash recovery: On server startup, reset any stale active_status in DB.
 * Runs that were "running" or "stopping" when the server crashed are now dead.
 */
export async function recoverStaledRuns(): Promise<void> {
  const { db } = require("./db")

  // Recover runs that were actively running/stopping when the server crashed
  const { data, error } = await db
    .from("runs")
    .update({ active_status: null, status: "failed" })
    .not("active_status", "is", null)
    .select("id")

  if (error) {
    console.warn(`[runState] Failed to recover stale runs: ${error.message}`)
  } else if (data && data.length > 0) {
    console.log(
      `[runState] Recovered ${data.length} stale run(s): ${data.map((r: any) => r.id).join(", ")}`
    )
  }

  // Recover runs stuck in "initializing" that never started (active_status is null)
  // These are runs where the server died between DB insert and startRun()
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 minutes
  const { data: staleInit, error: staleErr } = await db
    .from("runs")
    .update({ status: "failed" })
    .eq("status", "initializing")
    .is("active_status", null)
    .lt("created_at", staleThreshold)
    .select("id")

  if (staleErr) {
    console.warn(`[runState] Failed to recover stale initializing runs: ${staleErr.message}`)
  } else if (staleInit && staleInit.length > 0) {
    console.log(
      `[runState] Recovered ${staleInit.length} stale initializing run(s): ${staleInit.map((r: any) => r.id).join(", ")}`
    )
  }
}
