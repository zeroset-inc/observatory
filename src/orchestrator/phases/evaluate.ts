import type { Judge } from "../../types/judge"
import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider } from "../../types/provider"
import type { UnifiedQuestion } from "../../types/unified"
import type { ICheckpointManager } from "../checkpoint"
import { logger } from "../../utils/logger"
import { ConcurrentExecutor } from "../concurrent"
import { resolveConcurrency } from "../../types/concurrency"
import { calculateRetrievalMetrics } from "./retrieval-eval"
import { buildContextString } from "../../types/prompts"
import type { TaskExecutionGuard } from "../taskGuard"
import { assertTaskActive, ensureTaskActive, isTaskCancelledError } from "../taskGuard"

/**
 * Evaluate a single question using the judge.
 * Skips if already completed or if search hasn't completed. Returns null if skipped.
 */
export async function evaluateQuestion(
  judge: Judge,
  question: UnifiedQuestion,
  checkpoint: RunCheckpoint,
  checkpointManager: ICheckpointManager,
  provider?: Provider,
  guard?: TaskExecutionGuard,
): Promise<{ questionId: string; durationMs: number; label: string } | null> {
  assertTaskActive(guard)
  const { questionId } = question
  const evalStatus = checkpointManager.getPhaseStatus(checkpoint, questionId, "evaluate")
  const searchStatus = checkpointManager.getPhaseStatus(checkpoint, questionId, "search")
  if (evalStatus === "completed" || searchStatus !== "completed") return null

  const startTime = Date.now()
  assertTaskActive(guard)
  checkpointManager.updatePhase(checkpoint, questionId, "evaluate", {
    status: "in_progress",
    startedAt: new Date().toISOString(),
  })

  try {
    // Load search results from checkpoint or DB
    let searchResults: unknown[] = []

    const searchPhase = checkpoint.questions[questionId]?.phases.search
    if (searchPhase?.results && searchPhase.results.length > 0) {
      searchResults = searchPhase.results
    } else {
      const { db } = require("../../server/db")
      const { data } = await db
        .from("search_results")
        .select("results")
        .eq("run_id", checkpoint.runId)
        .eq("question_id", questionId)
        .single()
      searchResults = data?.results || []
    }

    const contextStr = buildContextString(searchResults)

    // Use the benchmark's question_date if available (e.g. LongMemEval "2023/09/04 (Mon) 17:07").
    // The judge needs this for temporal projection. No fallback — if the benchmark doesn't
    // provide a date, the judge simply won't have one.
    let evaluationDate: string | undefined
    const rawQuestionDate = question.metadata?.questionDate as string | undefined
    if (rawQuestionDate) {
      const dateMatch = rawQuestionDate.match(/(\d{4})\/(\d{2})\/(\d{2})/)
      if (dateMatch) {
        evaluationDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
      }
    }

    await ensureTaskActive(guard)
    const [result, retrievalMetrics] = await Promise.all([
      judge.evaluate({
        question: question.question,
        questionType: question.questionType,
        groundTruth: question.groundTruth,
        context: contextStr,
        providerPrompts: provider?.prompts,
        currentDate: evaluationDate,
      }),
      calculateRetrievalMetrics(
        judge.getModel(),
        question.question,
        question.groundTruth,
        searchResults
      ),
    ])
    await ensureTaskActive(guard)

    const durationMs = Date.now() - startTime
    checkpointManager.updatePhase(checkpoint, questionId, "evaluate", {
      status: "completed",
      score: result.score,
      label: result.label,
      explanation: result.explanation,
      retrievalMetrics,
      completedAt: new Date().toISOString(),
      durationMs,
    })

    return { questionId, durationMs, label: result.label }
  } catch (e) {
    if (isTaskCancelledError(e)) throw e
    const error = e instanceof Error ? e.message : String(e)
    checkpointManager.updatePhase(checkpoint, questionId, "evaluate", {
      status: "failed",
      error,
    })
    throw new Error(
      `Evaluate failed at ${questionId}: ${error}. Fix the issue and resume with the same run ID.`
    )
  }
}

/**
 * Batch evaluate phase — evaluates all pending questions concurrently.
 */
export async function runEvaluatePhase(
  judge: Judge,
  benchmark: Benchmark,
  checkpoint: RunCheckpoint,
  checkpointManager: ICheckpointManager,
  questionIds?: string[],
  provider?: Provider
): Promise<void> {
  const questions = benchmark.getQuestions()
  const targetQuestions = questionIds
    ? questions.filter((q) => questionIds.includes(q.questionId))
    : questions

  const pendingQuestions = targetQuestions.filter((q) => {
    const status = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "evaluate")
    const searchStatus = checkpointManager.getPhaseStatus(checkpoint, q.questionId, "search")
    return status !== "completed" && searchStatus === "completed"
  })

  if (pendingQuestions.length === 0) {
    logger.info("No questions pending evaluation")
    return
  }

  const concurrency = resolveConcurrency("evaluate", checkpoint.concurrency, provider?.concurrency)

  logger.info(
    `Evaluating ${pendingQuestions.length} questions with ${judge.name} (concurrency: ${concurrency})...`
  )

  await ConcurrentExecutor.execute(
    pendingQuestions,
    concurrency,
    checkpoint.runId,
    "evaluate",
    async ({ item: question, index, total }) => {
      const result = await evaluateQuestion(judge, question, checkpoint, checkpointManager, provider)
      if (result) {
        logger.progress(
          index + 1,
          total,
          `Evaluated ${question.questionId}: ${result.label} (${result.durationMs}ms)`
        )
      }
      return result
    }
  )

  logger.success("Evaluate phase complete")
}
