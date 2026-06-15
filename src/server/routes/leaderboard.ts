import type { ICheckpointManager } from "../../orchestrator/checkpoint"
import { D1CheckpointManager } from "../../orchestrator/d1Checkpoint"
import { createBenchmark } from "../../benchmarks"
import { optionalAuth } from "../middleware/auth"
import type { BenchmarkName } from "../../types/benchmark"
import { logger } from "../../utils/logger"

function getCheckpointManager(): ICheckpointManager {
  const { db } = require("../db")
  return new D1CheckpointManager(db)
}

const checkpointManager = getCheckpointManager()

const LEADERBOARD_ENTRY_ROUTE = /^\/api\/leaderboard\/(\d+)$/

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

function getDb() {
  const { db } = require("../db")
  return db
}

function mapEntryToCamelCase(entry: any) {
  return {
    ...entry,
    runId: entry.run_id,
    totalQuestions: entry.total_questions,
    correctCount: entry.correct_count,
    byQuestionType: entry.by_question_type || {},
    retrieval: entry.retrieval || null,
    latencyStats: entry.latency_stats,
    evaluations: entry.evaluations || [],
    providerCode: entry.provider_code,
    promptsUsed: entry.prompts_used,
    judgeModel: entry.judge_model,
    addedAt: entry.added_at,
    questionTypeRegistry: getQuestionTypeRegistry(entry.benchmark),
    submittedBy: entry.profiles
      ? { displayName: entry.profiles.display_name, avatarUrl: entry.profiles.avatar_url }
      : null,
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * Auto-add a completed run to the leaderboard.
 * Called automatically after a run completes successfully.
 * Skips sampled/limited runs (test/debug runs).
 */
export async function autoAddToLeaderboard(runId: string, userId?: string | null): Promise<void> {
  const db = getDb()
  const checkpoint = await checkpointManager.load(runId)
  if (!checkpoint) {
    logger.warn(`[autoAddToLeaderboard] Checkpoint not found for ${runId}, skipping`)
    return
  }

  // Skip test/debug runs (sampled or limited)
  if (checkpoint.limit) return
  if (checkpoint.sampling && checkpoint.sampling.mode !== "full") return

  const summary = checkpointManager.getSummary(checkpoint)
  if (summary.total === 0 || summary.evaluated !== summary.total) {
    logger.warn(`[autoAddToLeaderboard] Run ${runId} not fully evaluated, skipping`)
    return
  }

  // Load report for accuracy stats
  let report: any = null
  const { data: reportData } = await db
    .from("reports")
    .select("report_data")
    .eq("run_id", runId)
    .single()
  if (reportData?.report_data) {
    report = reportData.report_data
  }

  // Calculate accuracy
  const questions = Object.values(checkpoint.questions)
  const correctCount = questions.filter((q: any) => q.phases?.evaluate?.score === 1).length
  const accuracy = report?.summary?.accuracy ?? correctCount / summary.total

  // Get provider code and prompts
  const providerCode = getProviderCode(checkpoint.provider)
  const promptsUsed = getProviderPrompts(checkpoint.provider)

  // Build by question type stats — prefer report data (includes retrieval metrics)
  let byQuestionType: Record<string, any> = {}
  if (report?.byQuestionType) {
    byQuestionType = report.byQuestionType
  } else {
    for (const q of questions) {
      const qData = q as any
      const type = qData.questionType || "unknown"
      if (!byQuestionType[type]) {
        byQuestionType[type] = { total: 0, correct: 0, accuracy: 0 }
      }
      byQuestionType[type].total++
      if (qData.phases?.evaluate?.score === 1) {
        byQuestionType[type].correct++
      }
    }
    for (const type of Object.keys(byQuestionType)) {
      byQuestionType[type].accuracy = byQuestionType[type].correct / byQuestionType[type].total
    }
  }

  // Build evaluations
  let evaluations = report?.evaluations || []
  if (!report?.evaluations) {
    evaluations = questions.map((q: any) => ({
      questionId: q.questionId,
      questionType: q.questionType,
      question: q.question,
      groundTruth: q.groundTruth,
      score: q.phases?.evaluate?.score || 0,
      label: q.phases?.evaluate?.label || "incorrect",
      explanation: q.phases?.evaluate?.explanation || "",
      searchResults: q.phases?.search?.results || [],
    }))
  }

  // Resolve userId: prefer argument, fallback to checkpoint
  const resolvedUserId = userId || checkpoint.userId || null

  const entryData = {
    user_id: resolvedUserId,
    run_id: runId,
    provider: checkpoint.provider,
    benchmark: checkpoint.benchmark,
    version: runId,
    accuracy,
    total_questions: summary.total,
    correct_count: correctCount,
    by_question_type: byQuestionType,
    retrieval: report?.retrieval || null,
    latency_stats: report?.latency || null,
    evaluations,
    provider_code: providerCode,
    prompts_used: promptsUsed,
    judge_model: checkpoint.judge,
    added_at: new Date().toISOString(),
    notes: null,
  }

  // Idempotent: UNIQUE(run_id) index means re-runs via --force are silently skipped
  const { error } = await db
    .from("leaderboard_entries")
    .upsert(entryData, { onConflict: "run_id", ignoreDuplicates: true })

  if (error) {
    logger.error(`[autoAddToLeaderboard] Failed to insert leaderboard entry for ${runId}: ${error.message}`)
  } else {
    logger.info(`[autoAddToLeaderboard] Added ${runId} to leaderboard`)
  }
}

export async function handleLeaderboardRoutes(req: Request, url: URL): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname

  // GET /api/leaderboard - List all leaderboard entries
  if (method === "GET" && pathname === "/api/leaderboard") {
    try {
      const db = getDb()
      const { data: entries, error } = await db
        .from("leaderboard_entries")
        .select("*, profiles:user_id(display_name, avatar_url)")
        .order("added_at", { ascending: false })

      if (error) throw error

      const parsed = (entries || []).map(mapEntryToCamelCase)

      // Compute isLatest: true for the most recent entry per provider+benchmark
      const latestMap = new Map<string, number>()
      for (const entry of parsed) {
        const key = `${entry.provider}::${entry.benchmark}`
        if (!latestMap.has(key)) {
          latestMap.set(key, entry.id)
        }
      }
      for (const entry of parsed) {
        const key = `${entry.provider}::${entry.benchmark}`
        entry.isLatest = latestMap.get(key) === entry.id
      }

      return json({ entries: parsed })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Failed to load leaderboard" }, 500)
    }
  }

  // DELETE /api/leaderboard/:id - Remove from leaderboard
  const deleteMatch = pathname.match(LEADERBOARD_ENTRY_ROUTE)
  if (method === "DELETE" && deleteMatch) {
    try {
      const db = getDb()
      const id = parseInt(deleteMatch[1])

      const { data: entry, error: fetchError } = await db
        .from("leaderboard_entries")
        .select("id")
        .eq("id", id)
        .single()

      if (fetchError || !entry) {
        return json({ error: "Entry not found" }, 404)
      }

      const { error: deleteError } = await db
        .from("leaderboard_entries")
        .delete()
        .eq("id", id)

      if (deleteError) throw deleteError

      return json({ message: "Removed from leaderboard", id })
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Failed to remove from leaderboard" },
        500
      )
    }
  }

  // GET /api/leaderboard/:id - Get single entry with full details
  const getMatch = pathname.match(LEADERBOARD_ENTRY_ROUTE)
  if (method === "GET" && getMatch) {
    try {
      const db = getDb()
      const id = parseInt(getMatch[1])

      const { data: entry, error } = await db
        .from("leaderboard_entries")
        .select("*, profiles:user_id(display_name, avatar_url)")
        .eq("id", id)
        .single()

      if (error || !entry) {
        return json({ error: "Entry not found" }, 404)
      }

      return json(mapEntryToCamelCase(entry))
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Failed to get entry" }, 500)
    }
  }

  return null
}

function getProviderCode(provider: string): string {
  return JSON.stringify({
    provider,
    source: "Bundled in the Observatory Worker deployment.",
  })
}

function getProviderPrompts(provider: string): Record<string, string> | null {
  return { provider }
}
