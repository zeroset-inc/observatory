import type { Provider, IndexingProgress } from "../../types/provider"
import type { RunCheckpoint, QuestionCheckpoint } from "../../types/checkpoint"
import type { ICheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"
import type { TaskExecutionGuard } from "../taskGuard"
import { assertTaskActive, ensureTaskActive, isTaskCancelledError } from "../taskGuard"

function getEpisodeCount(question: QuestionCheckpoint): number {
  const ingestResult = question.phases.ingest.ingestResult
  if (!ingestResult) return 0
  return (ingestResult.documentIds?.length || 0) + (ingestResult.taskIds?.length || 0)
}

class IndexingProgressTracker {
  private progressByQuestion: Map<string, { completed: number; failed: number; total: number }> =
    new Map()
  private totalEpisodes: number = 0
  private lastDisplayed: string = ""

  constructor(questions: QuestionCheckpoint[]) {
    for (const q of questions) {
      const count = getEpisodeCount(q)
      this.totalEpisodes += count
      this.progressByQuestion.set(q.questionId, { completed: 0, failed: 0, total: count })
    }
  }

  update(questionId: string, progress: IndexingProgress): void {
    const current = this.progressByQuestion.get(questionId)
    if (current) {
      this.progressByQuestion.set(questionId, {
        completed: progress.completedIds.length,
        failed: progress.failedIds.length,
        total: progress.total,
      })
    }
    this.display()
  }

  markQuestionDone(questionId: string): void {
    const current = this.progressByQuestion.get(questionId)
    if (current) {
      this.progressByQuestion.set(questionId, {
        completed: current.total,
        failed: current.failed,
        total: current.total,
      })
    }
  }

  getAggregated(): { completed: number; failed: number; total: number } {
    let completed = 0
    let failed = 0
    for (const p of this.progressByQuestion.values()) {
      completed += p.completed
      failed += p.failed
    }
    return { completed, failed, total: this.totalEpisodes }
  }

  display(): void {
    const agg = this.getAggregated()
    const displayStr = `${agg.completed}/${agg.total}`
    if (displayStr !== this.lastDisplayed) {
      this.lastDisplayed = displayStr
      const percent = agg.total > 0 ? Math.round((agg.completed / agg.total) * 100) : 0
      const bar = "█".repeat(Math.floor(percent / 5)) + "░".repeat(20 - Math.floor(percent / 5))
      const failedStr = agg.failed > 0 ? ` (${agg.failed} failed)` : ""
      const stdout = (globalThis as any).process?.stdout
      const message = `${percent}% Indexing: ${agg.completed}/${agg.total} episodes${failedStr}`
      if (typeof stdout?.write === "function") {
        stdout.write(`\r\x1b[36m[${bar}]\x1b[0m ${message}`)
      } else {
        logger.info(message)
      }
    }
  }

  finish(): void {
    const agg = this.getAggregated()
    const failedStr = agg.failed > 0 ? ` (${agg.failed} failed)` : ""
    const stdout = (globalThis as any).process?.stdout
    const message = `100% Indexing: ${agg.completed}/${agg.total} episodes${failedStr}`
    if (typeof stdout?.write === "function") {
      stdout.write(`\r\x1b[36m[${"█".repeat(20)}]\x1b[0m ${message}\n`)
    } else {
      logger.info(message)
    }
  }

  getTotalEpisodes(): number {
    return this.totalEpisodes
  }
}

/**
 * Await indexing for a single question.
 * Skips if already completed or if ingest hasn't completed. Returns null if skipped.
 *
 * @param onProgress Optional callback for live per-episode progress (used by batch path).
 */
export async function indexQuestion(
  provider: Provider,
  checkpoint: RunCheckpoint,
  checkpointManager: ICheckpointManager,
  questionId: string,
  onProgress?: (questionId: string, progress: IndexingProgress) => void,
  guard?: TaskExecutionGuard,
): Promise<{ questionId: string; durationMs: number } | null> {
  assertTaskActive(guard)
  const question = checkpoint.questions[questionId]
  if (!question) return null
  if (question.phases.ingest.status !== "completed") return null
  if (question.phases.indexing.status === "completed") return null

  const ingestResult = question.phases.ingest.ingestResult
  const episodeCount = getEpisodeCount(question)

  if (!ingestResult || episodeCount === 0) {
    checkpointManager.updatePhase(checkpoint, questionId, "indexing", {
      status: "completed",
      completedIds: [],
      failedIds: [],
      completedAt: new Date().toISOString(),
      durationMs: 0,
    })
    return { questionId, durationMs: 0 }
  }

  const startTime = Date.now()
  assertTaskActive(guard)
  checkpointManager.updatePhase(checkpoint, questionId, "indexing", {
    status: "in_progress",
    completedIds: [],
    failedIds: [],
    startedAt: new Date().toISOString(),
  })

  try {
    let lastProgress: IndexingProgress = {
      completedIds: [],
      failedIds: [],
      total: episodeCount,
    }

    await provider.awaitIndexing(ingestResult, question.containerTag, (progress) => {
      assertTaskActive(guard)
      lastProgress = progress
      onProgress?.(questionId, progress)
      checkpointManager.updatePhase(checkpoint, questionId, "indexing", {
        status: "in_progress",
        completedIds: progress.completedIds,
        failedIds: progress.failedIds,
      })
    })

    const durationMs = Date.now() - startTime
    await ensureTaskActive(guard)
    checkpointManager.updatePhase(checkpoint, questionId, "indexing", {
      status: "completed",
      completedIds: lastProgress.completedIds,
      failedIds: lastProgress.failedIds,
      completedAt: new Date().toISOString(),
      durationMs,
    })

    return { questionId, durationMs }
  } catch (e) {
    if (isTaskCancelledError(e)) throw e
    const error = e instanceof Error ? e.message : String(e)
    checkpointManager.updatePhase(checkpoint, questionId, "indexing", {
      status: "failed",
      error,
    })
    throw new Error(
      `Indexing failed at ${questionId}: ${error}. Fix the issue and resume with the same run ID.`
    )
  }
}

/**
 * Batch indexing phase — awaits indexing for all pending questions concurrently.
 */
export async function runIndexingPhase(
  provider: Provider,
  checkpoint: RunCheckpoint,
  checkpointManager: ICheckpointManager,
  questionIds?: string[]
): Promise<void> {
  const allQuestions = Object.values(checkpoint.questions)
  const targetQuestions = questionIds
    ? allQuestions.filter((q) => questionIds.includes(q.questionId))
    : allQuestions

  const toIndex = targetQuestions.filter(
    (q) => q.phases.ingest.status === "completed" && q.phases.indexing.status !== "completed"
  )

  if (toIndex.length === 0) {
    logger.info("No questions pending indexing")
    return
  }

  const concurrency = resolveConcurrency("indexing", checkpoint.concurrency, provider.concurrency)

  const tracker = new IndexingProgressTracker(toIndex)
  const totalEpisodes = tracker.getTotalEpisodes()

  logger.info(
    `Awaiting indexing for ${toIndex.length} questions, ${totalEpisodes} episodes (concurrency: ${concurrency})...`
  )

  tracker.display()

  await ConcurrentExecutor.execute(
    toIndex,
    concurrency,
    checkpoint.runId,
    "indexing",
    async ({ item: question }) => {
      const result = await indexQuestion(
        provider, checkpoint, checkpointManager, question.questionId,
        (qId, progress) => tracker.update(qId, progress),
      )
      if (result) {
        tracker.markQuestionDone(question.questionId)
      }
      return result
    }
  )

  tracker.finish()
  logger.success("Indexing phase complete")
}
