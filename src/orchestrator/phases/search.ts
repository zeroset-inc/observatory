import type { Provider } from "../../types/provider"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { UnifiedQuestion } from "../../types/unified"
import type { ICheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"
import type { TaskExecutionGuard } from "../taskGuard"
import { assertTaskActive, ensureTaskActive, isTaskCancelledError } from "../taskGuard"

/**
 * Search a single question against the provider.
 * Skips if already completed or if indexing hasn't completed. Returns null if skipped.
 */
export async function searchQuestion(
  provider: Provider,
  question: UnifiedQuestion,
  checkpoint: RunCheckpoint,
  checkpointManager: ICheckpointManager,
  guard?: TaskExecutionGuard,
): Promise<{ questionId: string; durationMs: number } | null> {
  assertTaskActive(guard)
  const { questionId } = question
  const searchStatus = checkpointManager.getPhaseStatus(checkpoint, questionId, "search")
  const indexingStatus = checkpointManager.getPhaseStatus(checkpoint, questionId, "indexing")
  if (searchStatus === "completed" || indexingStatus !== "completed") return null

  const containerTag = `${questionId}-${checkpoint.dataSourceRunId}`

  const startTime = Date.now()
  assertTaskActive(guard)
  checkpointManager.updatePhase(checkpoint, questionId, "search", {
    status: "in_progress",
    startedAt: new Date().toISOString(),
  })

  try {
    const results = await provider.search(question.question, {
      containerTag,
      limit: 10,
      threshold: 0.3,
      ...(checkpoint.searchEffort && { effort: checkpoint.searchEffort }),
    })
    await ensureTaskActive(guard)

    const durationMs = Date.now() - startTime

    const { db } = require("../../server/db")
    await ensureTaskActive(guard)
    await db.from("search_results").upsert(
      {
        run_id: checkpoint.runId,
        question_id: questionId,
        results,
        metadata: {
          containerTag,
          questionType: question.questionType,
          groundTruth: question.groundTruth,
          timestamp: new Date().toISOString(),
          durationMs,
        },
      },
      { onConflict: "run_id,question_id" }
    )

    await ensureTaskActive(guard)
    checkpointManager.updatePhase(checkpoint, questionId, "search", {
      status: "completed",
      results,
      completedAt: new Date().toISOString(),
      durationMs,
    })

    return { questionId, durationMs }
  } catch (e) {
    if (isTaskCancelledError(e)) throw e
    const error = e instanceof Error ? e.message : String(e)
    checkpointManager.updatePhase(checkpoint, questionId, "search", {
      status: "failed",
      error,
    })
    throw new Error(
      `Search failed at ${questionId}: ${error}. Fix the issue and resume with the same run ID.`
    )
  }
}

/**
 * Batch search phase — searches all pending questions concurrently.
 */
export async function runSearchPhase(
  provider: Provider,
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: ICheckpointManager,
  questionIds?: string[]
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((q) => questionIds.includes(q.questionId))
    : questions

  const pendingQuestions = targetQuestions.filter((q) => {
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "search")
    const indexingStatus = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "indexing")
    return status !== "completed" && indexingStatus === "completed"
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending search")
    return
  }

  const concurrency = resolveConcurrency("search", checkpoint.concurrency, provider.concurrency)

  logger.info(`Searching ${pendingQuestions.length} questions (concurrency: ${concurrency})...`)

  await ConcurrentExecutor.execute(
    pendingQuestions,
    concurrency,
    checkpoint.runId,
    "search",
    async ({ item: question, index, total }) => {
      const result = await searchQuestion(provider, question, checkpoint, checkpointManager)
      if (result) {
        logger.progress(index + 1, total, `Searched ${question.questionId} (${result.durationMs}ms)`)
      }
      return result
    }
  )

  logger.success("Search phase complete")
}
