import type { ICheckpointManager } from "../../orchestrator/checkpoint"
import { D1CheckpointManager } from "../../orchestrator/d1Checkpoint"
import { batchManager } from "../../orchestrator/batch"
import type { CompareManifest } from "../../orchestrator/batch"
import { serverEvents } from "../events"
import { optionalAuth, AuthError } from "../middleware/auth"
import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import type { SamplingConfig } from "../../types/checkpoint"
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function durableRunnerUnavailable(): Response {
  return json({ error: "Durable runner is not configured" }, 503)
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

function getEffectiveCompareState(manifest: CompareManifest): "running" | "stopping" | undefined {
  return getPersistedCompareState(manifest)
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
  url: URL
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
      if (!durableRunnerAvailable()) {
        return durableRunnerUnavailable()
      }

      // Initialize comparison and wait for manifest + checkpoints to be created
      const { compareId } = await initializeComparison({
        providers: providers as ProviderName[],
        benchmark: benchmark as BenchmarkName,
        judgeModel,
        userId: user.id,
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
    const result = await requestDurableCompareStop(compareId)
    if (!result.ok) return json(result.data, result.status)

    serverEvents.broadcast({
      type: "compare_stopping",
      compareId,
    })

    return json(result.data, result.status)
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

      const result = await enqueueCompareExecution({
        kind: "compare.execute",
        compareId,
        manifest,
      })
      if (!result.ok) return json(result.data, result.status)

      serverEvents.broadcast({
        type: "compare_resumed",
        compareId,
      })

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

    const result = await deleteDurableComparison(compareId)
    return json(result.data, result.status)
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
  sampling?: SamplingConfig
  force?: boolean
}): Promise<{ compareId: string }> {
  // Only await manifest creation - this is fast
  const manifest = await batchManager.createManifest(options)
  const compareId = manifest.compareId

  const result = await enqueueCompareExecution({
    kind: "compare.execute",
    compareId,
    manifest,
  })
  if (!result.ok) {
    throw new Error((result.data as any)?.error || "Failed to enqueue comparison")
  }

  serverEvents.broadcast({
    type: "compare_started",
    compareId,
    benchmark: options.benchmark,
    providers: options.providers,
  })

  return { compareId }
}
