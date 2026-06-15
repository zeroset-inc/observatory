/**
 * Per-question pipeline runner.
 *
 * Instead of running all questions through each phase sequentially
 * (ALL ingest → ALL index → ALL search → ALL evaluate), this runs
 * each question through its full phase chain independently:
 *
 *   Q1: ingest → index → search → evaluate
 *   Q2: ingest → index → search → evaluate
 *   ...all running concurrently with per-phase concurrency limits.
 *
 * This means a question that finishes ingesting can immediately start
 * indexing, even while other questions are still being ingested.
 */

import type { Provider } from "../types/provider"
import type { Benchmark } from "../types/benchmark"
import type { Judge } from "../types/judge"
import type { RunCheckpoint } from "../types/checkpoint"
import type { UnifiedQuestion } from "../types/unified"
import type { ICheckpointManager } from "./checkpoint"
import { Semaphore } from "./semaphore"
import { IndexingCoordinator } from "./indexingCoordinator"
import { resolveConcurrency, type PhaseId } from "../types/concurrency"
import { isRunStopRequested } from "../server/runControl"
import { logger } from "../utils/logger"
import { ingestQuestion } from "./phases/ingest"
import { indexQuestion } from "./phases/indexing"
import { searchQuestion } from "./phases/search"
import { evaluateQuestion } from "./phases/evaluate"

interface PipelineOptions {
  provider: Provider
  benchmark: Benchmark
  judge?: Judge
  checkpoint: RunCheckpoint
  checkpointManager: ICheckpointManager
  phases: string[]
  questions: UnifiedQuestion[]
}

/** Thread-safe per-phase progress counters */
class PipelineProgress {
  private counts: Record<string, { completed: number; total: number }> = {}

  init(phase: string, total: number): void {
    this.counts[phase] = { completed: 0, total }
  }

  increment(phase: string, detail: string): void {
    const c = this.counts[phase]
    if (!c) return
    c.completed++
    logger.progress(c.completed, c.total, `[${phase}] ${detail}`)
  }
}

/**
 * Run all questions through the phase pipeline concurrently.
 * Each question progresses through phases independently, with per-phase
 * semaphores to respect concurrency limits.
 */
export async function runPipeline(options: PipelineOptions): Promise<void> {
  const { provider, benchmark, judge, checkpoint, checkpointManager, phases, questions } = options

  // Build per-phase semaphores (indexing uses a shared coordinator instead)
  const semaphores: Partial<Record<PhaseId, Semaphore>> = {}
  const phaseIds: PhaseId[] = ["ingest", "indexing", "search", "evaluate"]
  const useCoordinator = phases.includes("indexing") && !!provider.checkIndexingStatus
  const coordinator = useCoordinator
    ? new IndexingCoordinator(provider, checkpointManager, checkpoint)
    : null

  for (const phase of phaseIds) {
    if (phases.includes(phase)) {
      if (phase === "indexing" && coordinator) {
        logger.info(`Pipeline phase "indexing": shared coordinator (no concurrency limit)`)
        continue
      }
      const concurrency = resolveConcurrency(phase, checkpoint.concurrency, provider.concurrency)
      semaphores[phase] = new Semaphore(concurrency)
      logger.info(`Pipeline phase "${phase}" concurrency: ${concurrency}`)
    }
  }

  // Build progress trackers
  const progress = new PipelineProgress()
  for (const phase of phaseIds) {
    if (phases.includes(phase)) {
      progress.init(phase, questions.length)
    }
  }

  // Fail-fast: on first error, all questions that haven't started their next phase
  // will bail out. Questions already executing a phase will finish that phase (we don't
  // kill in-flight work). This is intentional — partial phase execution is worse than
  // letting the current phase complete and checkpointing cleanly for resume.
  let firstError: Error | null = null

  // Run each question through its pipeline concurrently
  const pipelines = questions.map(async (question) => {
    for (const phase of phaseIds) {
      // Fail-fast: stop if another question errored
      if (firstError) return
      // Check for stop signal
      if (await isRunStopRequested(checkpoint.runId)) {
        if (!firstError) {
          firstError = new Error("Run stopped by user.")
        }
        return
      }

      if (!phases.includes(phase)) continue

      try {
        // Indexing with coordinator bypasses the semaphore — the coordinator
        // batches all questions into a single shared polling loop.
        if (phase === "indexing" && coordinator) {
          if (firstError || (await isRunStopRequested(checkpoint.runId))) return
          const result = await coordinator.awaitQuestion(question.questionId)
          if (result) {
            progress.increment("indexing", `${question.questionId} (${result.durationMs}ms)`)
          } else {
            progress.increment("indexing", `${question.questionId} (skipped)`)
          }
        } else {
        await semaphores[phase]!.run(async () => {
          // Re-check after acquiring semaphore
          if (firstError || (await isRunStopRequested(checkpoint.runId))) return

          switch (phase) {
            case "ingest": {
              const result = await ingestQuestion(
                provider, benchmark, question, checkpoint, checkpointManager
              )
              if (result) {
                progress.increment("ingest", `${question.questionId} (${result.durationMs}ms)`)
              } else {
                progress.increment("ingest", `${question.questionId} (skipped)`)
              }
              break
            }
            case "indexing": {
              const result = await indexQuestion(
                provider, checkpoint, checkpointManager, question.questionId
              )
              if (result) {
                progress.increment("indexing", `${question.questionId} (${result.durationMs}ms)`)
              } else {
                progress.increment("indexing", `${question.questionId} (skipped)`)
              }
              break
            }
            case "search": {
              const result = await searchQuestion(
                provider, question, checkpoint, checkpointManager
              )
              if (result) {
                progress.increment("search", `${question.questionId} (${result.durationMs}ms)`)
              } else {
                progress.increment("search", `${question.questionId} (skipped)`)
              }
              break
            }
            case "evaluate": {
              if (!judge) break
              const result = await evaluateQuestion(
                judge, question, checkpoint, checkpointManager, provider
              )
              if (result) {
                progress.increment("evaluate", `${question.questionId}: ${result.label} (${result.durationMs}ms)`)
              } else {
                progress.increment("evaluate", `${question.questionId} (skipped)`)
              }
              break
            }
          }
        })
        }
      } catch (e) {
        if (!firstError) {
          firstError = e instanceof Error ? e : new Error(String(e))
        }
        return
      }
    }
  })

  await Promise.allSettled(pipelines)

  if (firstError) {
    throw firstError
  }
}
