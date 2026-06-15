import type { Provider, IngestResult } from "../../types/provider"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { UnifiedSession, UnifiedQuestion } from "../../types/unified"
import type { ICheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { Semaphore } from "../semaphore"
import { resolveConcurrency } from "../../types/concurrency"
import type { TaskExecutionGuard } from "../taskGuard"
import { assertTaskActive, ensureTaskActive, isTaskCancelledError } from "../taskGuard"

const RATE_LIMIT_MS = 0
const SESSION_CONCURRENCY = 5

// Global semaphore shared across all concurrent question ingests to cap total outbound Nebula load
const MAX_CONCURRENT_CHUNKS = 3
const ingestSemaphore = new Semaphore(MAX_CONCURRENT_CHUNKS)

/**
 * Ingest a single question's haystack sessions into the provider.
 * Skips if already completed. Returns null if skipped.
 */
export async function ingestQuestion(
  provider: Provider,
  benchmark: Benchmark,
  question: UnifiedQuestion,
  checkpoint: RunCheckpoint,
  checkpointManager: ICheckpointManager,
  guard?: TaskExecutionGuard,
): Promise<{ questionId: string; durationMs: number } | null> {
  assertTaskActive(guard)
  const { questionId } = question
  const status = checkpointManager.getPhaseStatus(checkpoint, questionId, "ingest")
  if (status === "completed") return null

  const containerTag = `${questionId}-${checkpoint.dataSourceRunId}`
  const sessions = benchmark.getHaystackSessions(questionId)

  const sessionsMetadata = sessions.map((s) => ({
    sessionId: s.sessionId,
    date: s.metadata?.date as string | undefined,
    messageCount: s.messages.length,
  }))
  checkpointManager.updateSessions(checkpoint, questionId, sessionsMetadata)

  const startTime = Date.now()
  assertTaskActive(guard)
  checkpointManager.updatePhase(checkpoint, questionId, "ingest", {
    status: "in_progress",
    startedAt: new Date().toISOString(),
  })

  try {
    const completedSessions =
      checkpoint.questions[questionId].phases.ingest.completedSessions
    const sessionsToProcess = sessions.filter((s) => !completedSessions.includes(s.sessionId))
    const combinedResult: IngestResult = { documentIds: [], taskIds: [] }

    // Create chunks of sessions to process
    const chunks: UnifiedSession[][] = []
    for (let i = 0; i < sessionsToProcess.length; i += SESSION_CONCURRENCY) {
      chunks.push(sessionsToProcess.slice(i, i + SESSION_CONCURRENCY))
    }

    // Process chunks through a global semaphore to cap total outbound Nebula requests
    await ensureTaskActive(guard)
    const chunkResults = await Promise.all(
      chunks.map((chunk) =>
        ingestSemaphore.run(() => provider.ingest(chunk, { containerTag }))
      )
    )
    await ensureTaskActive(guard)

    // Combine all results
    for (let i = 0; i < chunkResults.length; i++) {
      const result = chunkResults[i]
      const chunk = chunks[i]

      combinedResult.documentIds.push(...result.documentIds)
      if (result.taskIds) {
        combinedResult.taskIds!.push(...result.taskIds)
      }

      // Mark all sessions in chunk as completed
      for (const session of chunk) {
        completedSessions.push(session.sessionId)
      }
    }

    // Update checkpoint once with all completed sessions
    checkpointManager.updatePhase(checkpoint, questionId, "ingest", {
      completedSessions,
    })

    if (combinedResult.taskIds && combinedResult.taskIds.length === 0) {
      delete combinedResult.taskIds
    }

    const existingResult = checkpoint.questions[questionId].phases.ingest.ingestResult
    if (existingResult) {
      combinedResult.documentIds = [
        ...existingResult.documentIds,
        ...combinedResult.documentIds,
      ]
      if (existingResult.taskIds || combinedResult.taskIds) {
        combinedResult.taskIds = [
          ...(existingResult.taskIds || []),
          ...(combinedResult.taskIds || []),
        ]
      }
    }

    const durationMs = Date.now() - startTime
    assertTaskActive(guard)
    checkpointManager.updatePhase(checkpoint, questionId, "ingest", {
      status: "completed",
      ingestResult: combinedResult,
      completedAt: new Date().toISOString(),
      durationMs,
    })

    return { questionId, durationMs }
  } catch (e) {
    if (isTaskCancelledError(e)) throw e
    const error = e instanceof Error ? e.message : String(e)
    checkpointManager.updatePhase(checkpoint, questionId, "ingest", {
      status: "failed",
      error,
    })
    throw new Error(
      `Ingest failed at ${questionId}: ${error}. Fix the issue and resume with the same run ID.`
    )
  }
}

/**
 * Batch ingest phase — ingests all pending questions concurrently.
 */
export async function runIngestPhase(
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
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "ingest")
    return status !== "completed"
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending ingestion")
    return
  }

  const concurrency = resolveConcurrency("ingest", checkpoint.concurrency, provider.concurrency)

  logger.info(`Ingesting ${pendingQuestions.length} questions (concurrency: ${concurrency})...`)

  await ConcurrentExecutor.executeBatched({
    items: pendingQuestions,
    concurrency,
    rateLimitMs: RATE_LIMIT_MS,
    runId: checkpoint.runId,
    phaseName: "ingest",
    executeTask: async ({ item: question, index, total }) => {
      const result = await ingestQuestion(provider, benchmark, question, checkpoint, checkpointManager)
      if (result) {
        logger.progress(index + 1, total, `Ingested ${question.questionId} (${result.durationMs}ms)`)
      }
      return result
    },
  })

  logger.success("Ingest phase complete")
}
