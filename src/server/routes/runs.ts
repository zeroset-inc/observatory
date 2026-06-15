import type { ICheckpointManager } from "../../orchestrator/checkpoint"
import { D1CheckpointManager } from "../../orchestrator/d1Checkpoint"
import { createBenchmark } from "../../benchmarks"
import { createProvider } from "../../providers"
import { getProviderConfig, getJudgeConfig } from "../../utils/config"
import { resolveModel } from "../../utils/models"
import { optionalAuth, AuthError } from "../middleware/auth"
import { fetchAllUserKeys } from "../services/apiKeys"
import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import type { PhaseId } from "../../types/checkpoint"
import { PHASE_ORDER } from "../../types/checkpoint"
import { getRunQuestion, listRunQuestions } from "../../repositories/d1/runQuestions"
import {
  beginRunDelete,
  durableRunnerAvailable,
  enqueueRunStart,
  releaseRunDelete,
  retryRunQuestions,
  requestRunStop as requestDurableRunStop,
} from "../../runner/client"

function getCheckpointManager(): ICheckpointManager {
  const { db } = require("../db")
  return new D1CheckpointManager(db)
}

const checkpointManager = getCheckpointManager()

const benchmarkRegistryCache: Record<string, any> = {}

function getQuestionTypeRegistry(benchmarkName: string) {
  if (!benchmarkRegistryCache[benchmarkName]) {
    try {
      const benchmark = createBenchmark(benchmarkName as BenchmarkName)
      benchmarkRegistryCache[benchmarkName] = benchmark.getQuestionTypes()
    } catch {
      // Unknown benchmark (e.g. removed benchmark with historical data) — return empty registry
      benchmarkRegistryCache[benchmarkName] = {}
    }
  }
  return benchmarkRegistryCache[benchmarkName]
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

async function verifyRunOwnership(runId: string, user: import("../middleware/auth").AuthUser | null): Promise<Response | null> {
  if (!user) {
    return json({ error: "Authentication required" }, 401)
  }
  const { db } = require("../db")
  const { data: run, error } = await db
    .from("runs")
    .select("user_id")
    .eq("id", runId)
    .single()
  if (error || !run) {
    if (error && error.code !== "PGRST116") {
      return json({ error: "Failed to verify run ownership" }, 500)
    }
    return json({ error: "Run not found" }, 404)
  }
  if (run.user_id !== user.id) {
    return json({ error: "Forbidden" }, 403)
  }
  return null
}

/**
 * Verify a run is visible to the caller.
 * Completed runs are public; non-completed runs require ownership.
 */
async function verifyRunVisibility(runId: string, user: import("../middleware/auth").AuthUser | null): Promise<Response | null> {
  const { db } = require("../db")
  const { data: run, error } = await db
    .from("runs")
    .select("status, user_id")
    .eq("id", runId)
    .single()
  if (error || !run) {
    if (error && error.code !== "PGRST116") {
      return json({ error: "Failed to verify run visibility" }, 500)
    }
    return json({ error: "Run not found" }, 404)
  }
  if (isPublicRunStatus(run.status)) return null
  // Non-completed runs require ownership
  if (!user || run.user_id !== user.id) {
    return json({ error: "Run not found" }, 404)
  }
  return null
}

export async function handleRunsRoutes(
  req: Request,
  url: URL
): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname

  // GET /api/runs - List runs
  // ?view=mine  → personal runs (all statuses, requires auth)
  // default     → public log (completed runs only)
  if (method === "GET" && pathname === "/api/runs") {
    const user = await optionalAuth(req)
    const view = url.searchParams.get("view")

    const { db } = require("../db")
    let query = db.from("runs").select("*").order("created_at", { ascending: false })

    if (view === "mine") {
      if (!user) return json({ error: "Authentication required" }, 401)
      query = query.eq("user_id", user.id)
    } else {
      query = query.eq("status", "completed")
    }

    const { data: runs, error } = await query

    if (error) return json({ error: error.message }, 500)

    const runDetails = (runs || []).map((run: any) => {
      const summary = {
        total: run.total_questions,
        ingested: run.ingested_count,
        indexed: run.indexed_count,
        searched: run.searched_count,
        evaluated: run.evaluated_count,
      }

      return {
        runId: run.id,
        provider: run.provider,
        benchmark: run.benchmark,
        judge: run.judge,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        status: getRunStatusFromDb(run, summary),
        summary,
        accuracy: run.accuracy,
      }
    })

    return json(runDetails)
  }

  // GET /api/runs/:runId - Get checkpoint
  const runIdMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (method === "GET" && runIdMatch) {
    const runId = decodeURIComponent(runIdMatch[1])

    const user = await optionalAuth(req)
    const visError = await verifyRunVisibility(runId, user)
    if (visError) return visError

    const checkpoint = await checkpointManager.load(runId)
    if (!checkpoint) {
      return json({ error: "Run not found" }, 404)
    }
    const summary = checkpointManager.getSummary(checkpoint)
    const { userId: _uid, ...rest } = checkpoint
    return json({
      ...rest,
      status: getRunStatus(checkpoint, summary),
      summary,
    })
  }

  // GET /api/runs/:runId/report - Get report
  const reportMatch = pathname.match(/^\/api\/runs\/([^/]+)\/report$/)
  if (method === "GET" && reportMatch) {
    const runId = decodeURIComponent(reportMatch[1])
    const user = await optionalAuth(req)
    const visError = await verifyRunVisibility(runId, user)
    if (visError) return visError

    const { db } = require("../db")
    const { data, error } = await db
      .from("reports")
      .select("report_data")
      .eq("run_id", runId)
      .single()

    if (error || !data) {
      return json({ error: "Report not found" }, 404)
    }
    return json(data.report_data)
  }

  // GET /api/runs/:runId/questions - List questions
  const questionsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/questions$/)
  if (method === "GET" && questionsMatch) {
    const runId = decodeURIComponent(questionsMatch[1])
    const user = await optionalAuth(req)
    const visError = await verifyRunVisibility(runId, user)
    if (visError) return visError
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1)
    const limit = Math.min(
      500,
      Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50)
    )
    const status = url.searchParams.get("status")
    const type = url.searchParams.get("type")

    const result = await listRunQuestions({ runId, page, limit, status, type })
    if (!result) {
      return json({ error: "Run not found" }, 404)
    }

    return json({
      questions: result.questions,
      questionTypeRegistry: getQuestionTypeRegistry(result.benchmark),
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages: Math.ceil(result.total / limit),
      },
    })
  }

  // GET /api/runs/:runId/questions/:questionId - Get question detail
  const questionDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)\/questions\/([^/]+)$/)
  if (method === "GET" && questionDetailMatch) {
    const runId = decodeURIComponent(questionDetailMatch[1])
    const user = await optionalAuth(req)
    const visError = await verifyRunVisibility(runId, user)
    if (visError) return visError
    const questionId = decodeURIComponent(questionDetailMatch[2])
    const question = await getRunQuestion(runId, questionId)
    if (!question) {
      return json({ error: "Question not found" }, 404)
    }

    const { db } = require("../db")
    const { data } = await db
      .from("search_results")
      .select("*")
      .eq("run_id", runId)
      .eq("question_id", questionId)
      .single()
    const searchResults = data
      ? {
          questionId: data.question_id,
          results: data.results,
          ...data.metadata,
        }
      : null

    return json({
      ...question,
      searchResultsFile: searchResults,
    })
  }

  // POST /api/runs/preflight - Validate required keys exist before starting a run
  if (method === "POST" && pathname === "/api/runs/preflight") {
    try {
      const user = await optionalAuth(req)
      const body = (await req.json()) as Record<string, any>
      const { provider, judgeModel } = body

      if (!provider || !judgeModel) {
        return json({ error: "Missing required fields: provider, judgeModel" }, 400)
      }

      const judgeModelInfo = resolveModel(judgeModel)
      const judgeName = judgeModelInfo.provider

      const userKeys = user ? await fetchAllUserKeys(user.id) : undefined
      const missing: string[] = []

      // Check provider key
      try {
        const providerConfig = getProviderConfig(provider, userKeys)
        if (!providerConfig.apiKey) missing.push(provider)
      } catch {
        missing.push(provider)
      }

      // Check judge key
      try {
        const judgeConfig = getJudgeConfig(judgeName, userKeys)
        if (!judgeConfig.apiKey) missing.push(judgeName)
      } catch {
        missing.push(judgeName)
      }

      const required = [...new Set([provider, judgeName])]
      return json({ valid: missing.length === 0, missing, required })
    } catch (e) {
      if (e instanceof AuthError) {
        return json({ error: e.message }, e.status)
      }
      return json({ error: e instanceof Error ? e.message : "Preflight check failed" }, 400)
    }
  }

  // POST /api/runs/start - Start new run (requires auth)
  if (method === "POST" && pathname === "/api/runs/start") {
    try {
      const user = await optionalAuth(req)
      if (!user) {
        return json({ error: "Authentication required to start a run" }, 401)
      }

      // Rate limit: 10 runs per user per day
      const { db } = require("../db")
      const todayStart = new Date()
      todayStart.setUTCHours(0, 0, 0, 0)
      const { count, error: countError } = await db
        .from("runs")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", todayStart.toISOString())
      if (countError) {
        return json({ error: "Failed to check rate limit" }, 500)
      }
      if ((count ?? 0) >= 10) {
        return json({ error: "Daily run limit reached (10 per day). Try again tomorrow." }, 429)
      }

      const userKeys = await fetchAllUserKeys(user.id)
      const body = (await req.json()) as Record<string, any>
      console.log("[API] Start run request body:", JSON.stringify(body, null, 2))
      const {
        provider,
        benchmark,
        runId,
        judgeModel,
        limit,
        sampling,
        concurrency,
        searchEffort,
        force,
        fromPhase,
        sourceRunId,
      } = body
      console.log("[API] Extracted sampling:", sampling)
      console.log("[API] Extracted concurrency:", concurrency)

      if (!provider || !benchmark || !runId || !judgeModel) {
        return json(
          {
            error: "Missing required fields: provider, benchmark, runId, judgeModel",
          },
          400
        )
      }

      const VALID_EFFORTS = ["auto", "low", "medium", "high"]
      if (searchEffort !== undefined) {
        if (!VALID_EFFORTS.includes(searchEffort)) {
          return json(
            { error: `Invalid searchEffort: ${searchEffort}. Valid values: ${VALID_EFFORTS.join(", ")}` },
            400
          )
        }
        if (provider !== "nebula") {
          return json(
            { error: "searchEffort is only supported for the nebula provider" },
            400
          )
        }
      }

      if (fromPhase && !PHASE_ORDER.includes(fromPhase)) {
        return json(
          {
            error: `Invalid phase: ${fromPhase}. Valid phases: ${PHASE_ORDER.join(", ")}`,
          },
          400
        )
      }

      if (sourceRunId && fromPhase === "ingest") {
        return json(
          {
            error:
              "Cannot start from ingest phase in advanced mode. Use indexing, search, evaluate, or report.",
          },
          400
        )
      }

      if (!durableRunnerAvailable()) {
        return durableRunnerUnavailable()
      }

      if (!sourceRunId) {
        const { data: existingRun, error: existingRunError } = await db
          .from("runs")
          .select("user_id")
          .eq("id", runId)
          .maybeSingle()
        if (existingRunError) {
          return json({ error: "Failed to verify run ownership" }, 500)
        }
        if (existingRun?.user_id && existingRun.user_id !== user.id) {
          return json({ error: "Run already exists" }, 409)
        }
      }

      if (sourceRunId) {
        const ownerError = await verifyRunOwnership(sourceRunId, user)
        if (ownerError) return ownerError

        const sourceCheckpoint = await checkpointManager.load(sourceRunId)
        if (!sourceCheckpoint) {
          return json({ error: `Source run not found: ${sourceRunId}` }, 404)
        }

        if (sourceCheckpoint.provider !== provider) {
          return json(
            {
              error: `Provider mismatch: source run has ${sourceCheckpoint.provider}, not ${provider}`,
            },
            400
          )
        }
        if (sourceCheckpoint.benchmark !== benchmark) {
          return json(
            {
              error: `Benchmark mismatch: source run has ${sourceCheckpoint.benchmark}, not ${benchmark}`,
            },
            400
          )
        }

        if (await checkpointManager.exists(runId)) {
          return json({ error: `Run ${runId} already exists` }, 409)
        }

        const forkedCheckpoint = await checkpointManager.copyCheckpoint(sourceRunId, runId, fromPhase as PhaseId, {
          judge: judgeModel,
          userId: user.id,
        })
        if (searchEffort !== undefined) {
          forkedCheckpoint.searchEffort = searchEffort
          checkpointManager.save(forkedCheckpoint)
        }
        await checkpointManager.flush(runId)
      }

      const result = await enqueueRunStart({
        kind: "run.start",
        provider: provider as ProviderName,
        benchmark: benchmark as BenchmarkName,
        runId,
        judgeModel,
        userId: user.id,
        limit,
        sampling,
        concurrency,
        searchEffort,
        force: sourceRunId ? false : force,
        fromPhase: fromPhase as PhaseId | undefined,
      })

      if (!result.ok) {
        return json(result.data, result.status)
      }

      return json({ message: "Run started", runId })
    } catch (e) {
      if (e instanceof AuthError) {
        return json({ error: e.message }, e.status)
      }
      return json({ error: e instanceof Error ? e.message : "Invalid request body" }, 400)
    }
  }

  // POST /api/runs/:runId/questions/retry - Retry specific questions
  const retryMatch = pathname.match(/^\/api\/runs\/([^/]+)\/questions\/retry$/)
  if (method === "POST" && retryMatch) {
    const runId = decodeURIComponent(retryMatch[1])
    const user = await optionalAuth(req)
    const ownerError = await verifyRunOwnership(runId, user)
    if (ownerError) return ownerError

    // Parse and validate the request body before acquiring the slot so we
    // can bail early without affecting run state, and so we have checkpoint
    // data (benchmark name) available for the slot.
    let body: any
    try {
      body = await req.json()
    } catch {
      return json({ error: "Invalid request body" }, 400)
    }
    const { questionIds, fromPhase } = body as { questionIds?: unknown; fromPhase?: string }
    if (!Array.isArray(questionIds) || questionIds.length === 0) {
      return json({ error: "questionIds is required and must be non-empty" }, 400)
    }
    const normalizedQuestionIds = [...new Set(questionIds)].filter(
      (questionId): questionId is string => typeof questionId === "string" && questionId.length > 0
    )
    if (normalizedQuestionIds.length === 0) {
      return json({ error: "questionIds is required and must contain question ids" }, 400)
    }

    const validPhases = ["ingest", "indexing", "search", "evaluate"] as const
    if (fromPhase && !validPhases.includes(fromPhase as any)) {
      return json({ error: `Invalid fromPhase: "${fromPhase}". Must be one of: ${validPhases.join(", ")}` }, 400)
    }

    const result = await retryRunQuestions({
      kind: "run.retry_questions",
      runId,
      questionIds: normalizedQuestionIds,
      fromPhase: (fromPhase as PhaseId | undefined) ?? "ingest",
    })
    return json(result.data, result.status)
  }

  // POST /api/runs/:runId/stop - Stop running benchmark
  const stopMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/)
  if (method === "POST" && stopMatch) {
    const runId = decodeURIComponent(stopMatch[1])
    const user = await optionalAuth(req)
    if (!user) {
      return json({ error: "Authentication required" }, 401)
    }

    const ownerError = await verifyRunOwnership(runId, user)
    if (ownerError) return ownerError

    const result = await requestDurableRunStop(runId)
    return json(result.data, result.status)
  }

  // DELETE /api/runs/:runId - Delete run
  const deleteMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (method === "DELETE" && deleteMatch) {
    const runId = decodeURIComponent(deleteMatch[1])
    const user = await optionalAuth(req)
    const ownerError = await verifyRunOwnership(runId, user)
    if (ownerError) return ownerError

    const lockResult = await beginRunDelete(runId)
    if (!lockResult.ok) {
      return json(lockResult.data, lockResult.status)
    }
    let deleteLocked = true

    const cleanup = url.searchParams.get("cleanup") === "true"

    try {
      if (cleanup) {
        try {
          const checkpoint = await checkpointManager.load(runId)
          if (checkpoint) {
            const ownerId = checkpoint.userId
            const userKeys = ownerId ? await fetchAllUserKeys(ownerId) : undefined
            const provider = createProvider(checkpoint.provider as ProviderName)
            await provider.initialize(getProviderConfig(checkpoint.provider, userKeys))
            await checkpointManager.deleteWithCleanup(runId, provider)
          } else {
            await checkpointManager.delete(runId)
          }
        } catch (e) {
          return json({ error: `Failed to delete with cleanup: ${e}` }, 500)
        }
      } else {
        await checkpointManager.delete(runId)
      }
    } finally {
      if (deleteLocked) {
        await releaseRunDelete(runId)
      }
    }

    return json({ message: "Run deleted", runId })
  }

  return null
}

function isPublicRunStatus(status: string): boolean {
  return status === "completed"
}

function getRunStatusFromDb(run: any, summary: any): string {
  if (
    (run.active_status === "running" || run.active_status === "stopping") &&
    isActiveLeaseCurrent(run.active_lease_expires_at)
  ) {
    return run.active_status
  }

  if (run.status === "completed") return "completed"
  if (run.status === "failed") return "failed"
  if (run.status === "interrupted") return "partial"

  if (summary.evaluated === summary.total && summary.total > 0) return "completed"

  if (run.status === "running" || run.status === "initializing") {
    if (summary.ingested > 0 || run.status === "running") return "partial"
    return "pending"
  }

  if (summary.ingested === 0) return "pending"
  return "partial"
}

function getRunStatus(checkpoint: any, summary: any): string {
  if (
    (checkpoint.activeStatus === "running" || checkpoint.activeStatus === "stopping") &&
    isActiveLeaseCurrent(checkpoint.activeLeaseExpiresAt)
  ) {
    return checkpoint.activeStatus
  }

  if (checkpoint.status === "completed") {
    return "completed"
  }
  if (checkpoint.status === "failed") {
    return "failed"
  }
  if (checkpoint.status === "interrupted") {
    return "partial"
  }

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

  if (checkpoint.status === "running" || checkpoint.status === "initializing") {
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
