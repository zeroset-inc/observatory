import type { ICheckpointManager } from "../../orchestrator/checkpoint"
import { D1CheckpointManager } from "../../orchestrator/d1Checkpoint"
import { batchManager } from "../../orchestrator/batch"
import type { CompareManifest } from "../../orchestrator/batch"
import { wsManager } from "../wsManager"
import { getRunState, requestStop as requestRunStop } from "../runState"
import { optionalAuth, AuthError } from "../middleware/auth"
import { fetchAllUserKeys } from "../services/apiKeys"
import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import type { SamplingConfig } from "../../types/checkpoint"
import type { BackgroundExecutionContext } from "../http"
import {
  deleteComparison as deleteDurableComparison,
  durableRunnerAvailable,
  enqueueCompareExecution,
  requestCompareStop as requestDurableCompareStop,
} from "../../runner/client"

function getCheckpointManager(): ICheckpointManager {
  const { db } = require("../db")
  return new D1CheckpointManager(db)
}

// Track active comparisons in memory (similar to runState.ts)
export type CompareState = {
  status: "running" | "stopping"
  startedAt: string
  benchmark?: string
  runIds: string[]
  leaseToken: string
}

const activeCompares = new Map<string, CompareState>()

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function requestCompareStop(compareId: string): boolean {
  const state = activeCompares.get(compareId)
  if (!state) return false
  state.status = "stopping"
  return true
}

function startCompare(
  compareId: string,
  benchmark: string,
  runIds: string[],
  leaseToken: string
): void {
  activeCompares.set(compareId, {
    status: "running",
    startedAt: new Date().toISOString(),
    benchmark,
    runIds,
    leaseToken,
  })
}

function endCompare(compareId: string): void {
  activeCompares.delete(compareId)
}

function isCompareActive(compareId: string): boolean {
  return activeCompares.has(compareId)
}

function getCompareState(compareId: string): CompareState | undefined {
  return activeCompares.get(compareId)
}

function isLeaseActive(expiresAt?: string | null): boolean {
  if (!expiresAt) return false
  return new Date(expiresAt).getTime() > Date.now()
}

function getPersistedCompareState(manifest: CompareManifest): "running" | "stopping" | undefined {
  if (manifest.activeStatus === "stopping" && isLeaseActive(manifest.activeLeaseExpiresAt)) {
    return "stopping"
  }
  if (manifest.activeStatus === "running" && isLeaseActive(manifest.activeLeaseExpiresAt)) {
    return "running"
  }
  return undefined
}

function isPersistedCompareActive(manifest: CompareManifest): boolean {
  return batchManager.isComparisonManifestActive(manifest)
}

function getEffectiveCompareState(manifest: CompareManifest): "running" | "stopping" | undefined {
  return getPersistedCompareState(manifest) ?? getCompareState(manifest.compareId)?.status
}

async function verifyCompareOwnership(
  compareId: string,
  user: import("../middleware/auth").AuthUser | null
): Promise<{ manifest: CompareManifest } | Response> {
  if (!user) return json({ error: "Authentication required" }, 401)
  const manifest = await batchManager.loadManifestAsync(compareId)
  if (!manifest) return json({ error: "Comparison not found" }, 404)
  if (manifest.userId !== user.id) return json({ error: "Forbidden" }, 403)
  return { manifest }
}

export async function handleCompareRoutes(
  req: Request,
  url: URL,
  executionContext?: BackgroundExecutionContext
): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname
  const checkpointManager = getCheckpointManager()

  // GET /api/compare - List all comparisons
  if (method === "GET" && pathname === "/api/compare") {
    const user = await optionalAuth(req)
    if (!user) return json({ error: "Authentication required" }, 401)
    const manifests = (await batchManager.listComparisons()).filter(
      (manifest) => manifest.userId === user.id
    )

    const compareDetails = await Promise.all(
      manifests.map(async (manifest) => {
        // Calculate progress for each run
        const runProgress = await Promise.all(
          manifest.runs.map(async (run) => {
            const checkpoint = await checkpointManager.load(run.runId)
            if (!checkpoint) {
              return {
                provider: run.provider,
                runId: run.runId,
                progress: { total: 0, evaluated: 0 },
                status: "pending",
              }
            }
            const summary = checkpointManager.getSummary(checkpoint)
            const status = getRunStatus(checkpoint, summary)
            return {
              provider: run.provider,
              runId: run.runId,
              progress: summary,
              status,
            }
          })
        )

        // Overall comparison status
        const allCompleted = runProgress.every((r) => r.status === "completed")
        const anyFailed = runProgress.some((r) => r.status === "failed")
        const anyRunning = runProgress.some((r) => r.status === "running")
        const compareState = getEffectiveCompareState(manifest)

        let overallStatus: string
        if (compareState === "stopping") {
          overallStatus = "stopping"
        } else if (compareState === "running" || anyRunning) {
          overallStatus = "running"
        } else if (anyFailed) {
          overallStatus = "failed"
        } else if (allCompleted) {
          overallStatus = "completed"
        } else {
          overallStatus = "partial"
        }

        return {
          compareId: manifest.compareId,
          benchmark: manifest.benchmark,
          judge: manifest.judge,
          createdAt: manifest.createdAt,
          updatedAt: manifest.updatedAt,
          targetQuestionCount: manifest.targetQuestionIds.length,
          providers: manifest.runs.map((r) => r.provider),
          status: overallStatus,
          runProgress,
        }
      })
    )

    return json(compareDetails)
  }

  // POST /api/compare/start - Start new comparison
  if (method === "POST" && pathname === "/api/compare/start") {
    try {
      const user = await optionalAuth(req)
      if (!user) return json({ error: "Authentication required" }, 401)
      const userKeys = await fetchAllUserKeys(user.id)
      const body = (await req.json()) as Record<string, any>
      const { providers, benchmark, judgeModel, sampling, force } = body

      if (!providers || !Array.isArray(providers) || providers.length === 0) {
        return json({ error: "Missing or invalid providers array" }, 400)
      }
      if (!benchmark || !judgeModel) {
        return json(
          { error: "Missing required fields: benchmark, judgeModel" },
          400
        )
      }

      // Initialize comparison and wait for manifest + checkpoints to be created
      const { compareId } = await initializeComparison({
        providers: providers as ProviderName[],
        benchmark: benchmark as BenchmarkName,
        judgeModel,
        userId: user.id,
        userKeys,
        executionContext,
        sampling,
        force,
      })

      return json({ message: "Comparison started", compareId })
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message }, e.status)
      return json({ error: e instanceof Error ? e.message : "Invalid request body" }, 400)
    }
  }

  // GET /api/compare/:compareId - Get comparison detail with run progress
  const compareIdMatch = pathname.match(/^\/api\/compare\/([^/]+)$/)
  if (method === "GET" && compareIdMatch) {
    const compareId = decodeURIComponent(compareIdMatch[1])
    const user = await optionalAuth(req)
    const ownership = await verifyCompareOwnership(compareId, user)
    if (ownership instanceof Response) return ownership
    const { manifest } = ownership

    // Get detailed progress for each run
    const runDetails = await Promise.all(
      manifest.runs.map(async (run) => {
        const checkpoint = await checkpointManager.load(run.runId)
        if (!checkpoint) {
          return {
            provider: run.provider,
            runId: run.runId,
            status: "pending",
            summary: { total: 0, ingested: 0, indexed: 0, searched: 0, evaluated: 0 },
          }
        }

        const summary = checkpointManager.getSummary(checkpoint)
        const status = getRunStatus(checkpoint, summary)

        // Calculate accuracy from checkpoint questions
        const questions = Object.values(checkpoint.questions)
        const evaluatedQuestions = questions.filter(
          (q: any) => q.phases?.evaluate?.status === "completed"
        )
        const correctCount = evaluatedQuestions.filter(
          (q: any) => q.phases?.evaluate?.score === 1
        ).length
        const accuracy =
          evaluatedQuestions.length > 0 ? correctCount / evaluatedQuestions.length : null

        return {
          provider: run.provider,
          runId: run.runId,
          status,
          progress: summary,
          accuracy,
        }
      })
    )

    // Calculate overall status - must match list endpoint logic exactly
    const compareState = getEffectiveCompareState(manifest)
    const allCompleted = runDetails.every((r) => r.status === "completed")
    const anyFailed = runDetails.some((r) => r.status === "failed")
    const anyRunning = runDetails.some((r) => r.status === "running")

    let overallStatus: string
    if (compareState === "stopping") {
      overallStatus = "stopping"
    } else if (compareState === "running" || anyRunning) {
      overallStatus = "running"
    } else if (anyFailed) {
      overallStatus = "failed"
    } else if (allCompleted) {
      overallStatus = "completed"
    } else {
      overallStatus = "partial"
    }

    return json({
      ...manifest,
      providers: manifest.runs.map((r) => r.provider),
      status: overallStatus,
      runs: runDetails,
    })
  }

  // GET /api/compare/:compareId/report - Get aggregated reports
  const reportMatch = pathname.match(/^\/api\/compare\/([^/]+)\/report$/)
  if (method === "GET" && reportMatch) {
    const compareId = decodeURIComponent(reportMatch[1])
    const user = await optionalAuth(req)
    const ownership = await verifyCompareOwnership(compareId, user)
    if (ownership instanceof Response) return ownership
    const { manifest } = ownership

    const reports = await batchManager.getReports(manifest)
    if (reports.length === 0) {
      return json({ error: "No reports available yet" }, 404)
    }

    // Return aggregated data
    return json({
      compareId: manifest.compareId,
      benchmark: manifest.benchmark,
      judge: manifest.judge,
      reports: reports.map((r) => ({
        provider: r.provider,
        report: r.report,
      })),
    })
  }

  // POST /api/compare/:compareId/stop - Stop all runs in comparison
  const stopMatch = pathname.match(/^\/api\/compare\/([^/]+)\/stop$/)
  if (method === "POST" && stopMatch) {
    const compareId = decodeURIComponent(stopMatch[1])
    const user = await optionalAuth(req)
    const ownership = await verifyCompareOwnership(compareId, user)
    if (ownership instanceof Response) return ownership
    const { manifest } = ownership

    if (durableRunnerAvailable()) {
      const result = await requestDurableCompareStop(compareId)
      if (!result.ok) return json(result.data, result.status)

      wsManager.broadcast({
        type: "compare_stopping",
        compareId,
      })

      return json(result.data, result.status)
    }

    const compareStopRequested = requestCompareStop(compareId)
    const stoppedRunIds = manifest.runs
      .filter((run) => requestRunStop(run.runId))
      .map((run) => run.runId)
    const persistedStopRequested = await batchManager.requestComparisonStop(compareId)

    if (!compareStopRequested && stoppedRunIds.length === 0 && !persistedStopRequested) {
      return json({ error: "Comparison is not active" }, 404)
    }

    // Broadcast stop event
    wsManager.broadcast({
      type: "compare_stopping",
      compareId,
    })

    return json({ message: "Stop requested for comparison", compareId, stoppedRunIds })
  }

  // POST /api/compare/:compareId/resume - Resume comparison
  const resumeMatch = pathname.match(/^\/api\/compare\/([^/]+)\/resume$/)
  if (method === "POST" && resumeMatch) {
    const compareId = decodeURIComponent(resumeMatch[1])
    try {
      const user = await optionalAuth(req)
      const ownership = await verifyCompareOwnership(compareId, user)
      if (ownership instanceof Response) return ownership
      const { manifest } = ownership

      if (durableRunnerAvailable()) {
        const result = await enqueueCompareExecution({
          kind: "compare.execute",
          compareId,
          manifest,
        })
        if (!result.ok) return json(result.data, result.status)

        wsManager.broadcast({
          type: "compare_resumed",
          compareId,
        })

        return json({ message: "Comparison resumed", compareId })
      }

      if (isCompareActive(compareId)) {
        return json({ error: "Comparison is already active" }, 409)
      }

      const userKeys = manifest.userId ? await fetchAllUserKeys(manifest.userId) : undefined

      if (isCompareActive(compareId)) {
        return json({ error: "Comparison is already active" }, 409)
      }
      const leaseToken = await batchManager.acquireComparisonLease(compareId)
      if (!leaseToken) {
        return json({ error: "Comparison is already active" }, 409)
      }

      startCompare(
        compareId,
        manifest.benchmark,
        manifest.runs.map((r) => r.runId),
        leaseToken
      )

      wsManager.broadcast({
        type: "compare_resumed",
        compareId,
      })

      const completion = executeResumedComparison(manifest, leaseToken, userKeys)
      executionContext?.waitUntil(completion)

      return json({ message: "Comparison resumed", compareId })
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message }, e.status)
      return json({ error: e instanceof Error ? e.message : "Failed to resume comparison" }, 500)
    }
  }

  // DELETE /api/compare/:compareId - Delete comparison
  const deleteMatch = pathname.match(/^\/api\/compare\/([^/]+)$/)
  if (method === "DELETE" && deleteMatch) {
    const compareId = decodeURIComponent(deleteMatch[1])
    const user = await optionalAuth(req)
    const ownership = await verifyCompareOwnership(compareId, user)
    if (ownership instanceof Response) return ownership

    if (durableRunnerAvailable()) {
      const result = await deleteDurableComparison(compareId)
      return json(result.data, result.status)
    }

    if (isCompareActive(compareId) || isPersistedCompareActive(ownership.manifest)) {
      return json({ error: "Cannot delete active comparison" }, 409)
    }

    try {
      await batchManager.delete(compareId)
    } catch (error) {
      if (error instanceof Error && error.message.includes("Cannot delete active comparison")) {
        return json({ error: "Cannot delete active comparison" }, 409)
      }
      throw error
    }
    return json({ message: "Comparison deleted", compareId })
  }

  return null
}

function getRunStatus(checkpoint: any, summary: any): string {
  if (
    (checkpoint.activeStatus === "running" || checkpoint.activeStatus === "stopping") &&
    isActiveLeaseCurrent(checkpoint.activeLeaseExpiresAt)
  ) {
    return checkpoint.activeStatus
  }

  // Active process takes priority
  const runState = getRunState(checkpoint.runId)
  if (runState) {
    return runState.status // "running" or "stopping"
  }

  // Use persisted status from checkpoint (handles crash/stop cases)
  if (checkpoint.status === "completed") {
    return "completed"
  }
  if (checkpoint.status === "failed") {
    return "failed"
  }

  // Check if any question has a failed phase
  const questions = Object.values(checkpoint.questions || {}) as any[]
  const hasFailed = questions.some((q: any) => {
    const phases = q.phases || {}
    return (
      phases.ingest?.status === "failed" ||
      phases.indexing?.status === "failed" ||
      phases.search?.status === "failed" ||
      phases.evaluate?.status === "failed"
    )
  })

  if (hasFailed) {
    return "failed"
  }

  if (summary.evaluated === summary.total && summary.total > 0) {
    return "completed"
  }

  // If checkpoint was ever started (status changed from initializing), it's partial
  if (checkpoint.status === "running" || checkpoint.status === "initializing") {
    // Was started but no active process - must have crashed/stopped
    if (summary.ingested > 0 || checkpoint.status === "running") {
      return "partial"
    }
    return "pending"
  }

  if (summary.ingested === 0) {
    return "pending"
  }
  return "partial"
}

function isActiveLeaseCurrent(expiresAt?: string | null): boolean {
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() > Date.now()
}

async function initializeComparison(options: {
  providers: ProviderName[]
  benchmark: BenchmarkName
  judgeModel: string
  userId: string
  userKeys?: Record<string, string>
  executionContext?: BackgroundExecutionContext
  sampling?: SamplingConfig
  force?: boolean
}): Promise<{ compareId: string }> {
  // Only await manifest creation - this is fast
  const manifest = await batchManager.createManifest(options)
  const compareId = manifest.compareId

  if (durableRunnerAvailable()) {
    const result = await enqueueCompareExecution({
      kind: "compare.execute",
      compareId,
      manifest,
    })
    if (!result.ok) {
      throw new Error((result.data as any)?.error || "Failed to enqueue comparison")
    }

    wsManager.broadcast({
      type: "compare_started",
      compareId,
      benchmark: options.benchmark,
      providers: options.providers,
    })

    return { compareId }
  }

  const leaseToken = await batchManager.acquireComparisonLease(compareId)
  if (!leaseToken) {
    throw new Error(`Comparison is already active: ${compareId}`)
  }

  startCompare(
    compareId,
    options.benchmark,
    manifest.runs.map((r) => r.runId),
    leaseToken
  )

  wsManager.broadcast({
    type: "compare_started",
    compareId,
    benchmark: options.benchmark,
    providers: options.providers,
  })

  // Run execution in background - don't await
  const completion = batchManager
    .executeRuns(manifest, options.userKeys, leaseToken)
    .then(() => {
      wsManager.broadcast({
        type: "compare_complete",
        compareId,
      })
    })
    .catch((error) => {
      wsManager.broadcast({
        type: "error",
        compareId,
        message: error instanceof Error ? error.message : "Unknown error",
      })
    })
    .finally(async () => {
      endCompare(compareId)
      await batchManager.releaseComparisonLease(compareId, leaseToken)
    })
  options.executionContext?.waitUntil(completion)

  return { compareId }
}

async function executeResumedComparison(
  manifest: CompareManifest,
  leaseToken: string,
  userKeys?: Record<string, string>
) {
  const compareId = manifest.compareId
  try {
    await batchManager.executeRuns(manifest, userKeys, leaseToken)

    wsManager.broadcast({
      type: "compare_complete",
      compareId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    wsManager.broadcast({
      type: "error",
      compareId,
      message,
    })
  } finally {
    endCompare(compareId)
    await batchManager.releaseComparisonLease(compareId, leaseToken)
  }
}
