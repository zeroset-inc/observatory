import type { ProviderName } from "../types/provider"
import type { BenchmarkName } from "../types/benchmark"
import type { JudgeName } from "../types/judge"
import type { RunCheckpoint, SamplingConfig } from "../types/checkpoint"
import type { ConcurrencyConfig } from "../types/concurrency"
import { createProvider } from "../providers"
import { createBenchmark } from "../benchmarks"
import { createJudge } from "../judges"
import type { ICheckpointManager } from "./checkpoint"
import { D1CheckpointManager } from "./d1Checkpoint"
import { getProviderConfig, getJudgeConfig } from "../utils/config"
import { resolveModel } from "../utils/models"
import { logger } from "../utils/logger"
import { generateReport, saveReport, printReport } from "./phases/report"
import { runPipeline } from "./pipeline"

export interface OrchestratorOptions {
  provider: ProviderName
  benchmark: BenchmarkName
  judgeModel: string
  runId: string
  userId?: string | null
  userKeys?: Record<string, string>
  limit?: number
  sampling?: SamplingConfig
  concurrency?: ConcurrencyConfig
  searchEffort?: "auto" | "low" | "medium" | "high"
  force?: boolean
  questionIds?: string[]
  phases?: ("ingest" | "indexing" | "search" | "evaluate" | "report")[]
}

function selectQuestionsBySampling(
  allQuestions: { questionId: string; questionType: string }[],
  sampling: SamplingConfig
): string[] {
  if (sampling.mode === "full") {
    return allQuestions.map((q) => q.questionId)
  }

  if (sampling.mode === "limit" && sampling.limit) {
    return allQuestions.slice(0, sampling.limit).map((q) => q.questionId)
  }

  if (sampling.mode === "sample" && sampling.perCategory) {
    const byType: Record<string, { questionId: string; questionType: string }[]> = {}
    for (const q of allQuestions) {
      if (!byType[q.questionType]) byType[q.questionType] = []
      byType[q.questionType].push(q)
    }

    const selected: string[] = []
    for (const questions of Object.values(byType)) {
      if (sampling.sampleType === "random") {
        const shuffled = [...questions].sort(() => Math.random() - 0.5)
        selected.push(...shuffled.slice(0, sampling.perCategory).map((q) => q.questionId))
      } else {
        selected.push(...questions.slice(0, sampling.perCategory).map((q) => q.questionId))
      }
    }
    return selected
  }

  return allQuestions.map((q) => q.questionId)
}

function createCheckpointManager(): ICheckpointManager {
  const { db } = require("../server/db")
  return new D1CheckpointManager(db)
}

export class Orchestrator {
  private checkpointManager: ICheckpointManager

  constructor(checkpointManager?: ICheckpointManager) {
    this.checkpointManager = checkpointManager || createCheckpointManager()
  }

  getCheckpointManager(): ICheckpointManager {
    return this.checkpointManager
  }

  async run(options: OrchestratorOptions): Promise<void> {
    const {
      provider: providerName,
      benchmark: benchmarkName,
      judgeModel,
      runId,
      limit,
      sampling,
      concurrency,
      searchEffort,
      force = false,
      questionIds,
      phases = ["ingest", "indexing", "search", "evaluate", "report"],
    } = options

    const judgeModelInfo = resolveModel(judgeModel)
    const judgeName = judgeModelInfo.provider as JudgeName

    logger.info(`Starting Observatory run: ${providerName} + ${benchmarkName}`)
    logger.info(`Run ID: ${runId}`)
    logger.info(
      `Judge: ${judgeModelInfo.displayName} (${judgeModelInfo.id})`
    )
    logger.info(`Force: ${force}, Phases: ${phases?.join(", ") || "all"}`)
    if (sampling) {
      logger.info(`Sampling config received: ${JSON.stringify(sampling)}`)
      if (sampling.mode === "sample") {
        logger.info(
          `Sampling: ${sampling.perCategory} per category (${sampling.sampleType || "consecutive"})`
        )
      } else if (sampling.mode === "limit") {
        logger.info(`Limit: ${sampling.limit} questions`)
      } else {
        logger.info(`Selection: full (all questions)`)
      }
    } else if (limit) {
      logger.info(`Limit: ${limit} questions`)
    } else {
      logger.info(`No sampling or limit provided`)
    }

    if (force && (await this.checkpointManager.exists(runId))) {
      await this.checkpointManager.delete(runId)
      logger.info("Cleared existing checkpoint (--force)")
    }

    let checkpoint!: RunCheckpoint
    let effectiveLimit: number | undefined
    let targetQuestionIds: string[] | undefined
    let isNewRun = false

    if (!(await this.checkpointManager.exists(runId))) {
      isNewRun = true
      checkpoint = await this.checkpointManager.create(
        runId,
        providerName,
        benchmarkName,
        judgeModel,
        { userId: options.userId, limit, sampling, concurrency, searchEffort, status: "initializing" }
      )
      logger.info("Created checkpoint (initializing)")
    }

    const benchmark = createBenchmark(benchmarkName)
    await benchmark.load()
    const allQuestions = benchmark.getQuestions()

    if ((await this.checkpointManager.exists(runId)) && !isNewRun) {
      checkpoint = (await this.checkpointManager.load(runId))!

      if (
        checkpoint.status === "initializing" &&
        Object.keys(checkpoint.questions).length === 0
      ) {
        isNewRun = true
        logger.info("Initializing pre-created checkpoint")
      }
    }

    if ((await this.checkpointManager.exists(runId)) && !isNewRun) {
      if (!checkpoint) checkpoint = (await this.checkpointManager.load(runId))!
      effectiveLimit = checkpoint.limit
      targetQuestionIds = checkpoint.targetQuestionIds

      if (!targetQuestionIds) {
        const startedQuestions = Object.values(checkpoint.questions)
          .filter((q) => Object.values(q.phases).some((p) => p.status !== "pending"))
          .map((q) => q.questionId)

        if (startedQuestions.length > 0) {
          const pendingQuestions = Object.values(checkpoint.questions)
            .filter((q) => Object.values(q.phases).every((p) => p.status === "pending"))
            .map((q) => q.questionId)

          if (limit) {
            const remainingSlots = limit - startedQuestions.length
            targetQuestionIds = [
              ...startedQuestions,
              ...pendingQuestions.slice(0, Math.max(0, remainingSlots)),
            ]
            effectiveLimit = limit
            logger.warn(
              `Old checkpoint detected. Using limit (${limit}) to determine target questions.`
            )
          } else {
            targetQuestionIds = startedQuestions
            logger.warn(
              `Old checkpoint without stored limit. Only processing ${startedQuestions.length} already-started questions.`
            )
          }

          checkpoint.limit = effectiveLimit
          checkpoint.targetQuestionIds = targetQuestionIds
          this.checkpointManager.save(checkpoint)
        } else {
          if (limit) {
            const limitedQuestions = allQuestions.slice(0, limit).map((q) => q.questionId)
            targetQuestionIds = limitedQuestions
            effectiveLimit = limit
            checkpoint.limit = limit
            checkpoint.targetQuestionIds = targetQuestionIds
            this.checkpointManager.save(checkpoint)
            logger.warn(
              `Old checkpoint with no progress. Applying limit (${limit}) to first ${limit} questions.`
            )
          }
        }
      }

      const summary = this.checkpointManager.getSummary(checkpoint)
      const targetCount = targetQuestionIds?.length || summary.total

      const inProgressQuestions = Object.values(checkpoint.questions)
        .filter((q) => Object.values(q.phases).some((p) => p.status === "in_progress"))
        .map((q) => q.questionId)

      logger.info(
        `Resuming from checkpoint: ${summary.ingested}/${targetCount} ingested, ${summary.evaluated}/${targetCount} evaluated`
      )
      if (inProgressQuestions.length > 0) {
        logger.info(`In-progress questions: ${inProgressQuestions.join(", ")}`)
      }

      this.checkpointManager.updateStatus(checkpoint, "running")
    } else {
      logger.info(
        `New run path: isNewRun=${isNewRun}, sampling=${JSON.stringify(sampling)}, limit=${limit}`
      )
      effectiveLimit = limit

      if (questionIds && questionIds.length > 0) {
        logger.info(`Using explicit questionIds: ${questionIds.length} questions`)
        targetQuestionIds = questionIds
      } else if (sampling) {
        logger.info(`Using sampling mode: ${sampling.mode}`)
        targetQuestionIds = selectQuestionsBySampling(allQuestions, sampling)
        checkpoint.sampling = sampling
        logger.info(
          `Sampling selected ${targetQuestionIds.length} questions from ${allQuestions.length} total`
        )
      } else if (effectiveLimit) {
        logger.info(`Using limit: ${effectiveLimit}`)
        targetQuestionIds = allQuestions.slice(0, effectiveLimit).map((q) => q.questionId)
      } else {
        logger.info(`No sampling/limit specified, using all ${allQuestions.length} questions`)
      }

      checkpoint.targetQuestionIds = targetQuestionIds
      checkpoint.limit = effectiveLimit

      const questionsToInit = targetQuestionIds
        ? allQuestions.filter((q) => targetQuestionIds!.includes(q.questionId))
        : allQuestions

      for (const q of questionsToInit) {
        const containerTag = `${q.questionId}-${checkpoint.dataSourceRunId}`
        this.checkpointManager.initQuestion(checkpoint, q.questionId, containerTag, {
          question: q.question,
          groundTruth: q.groundTruth,
          questionType: q.questionType,
        })
      }

      this.checkpointManager.updateStatus(checkpoint, "running")
    }

    const provider = createProvider(providerName)
    await provider.initialize(getProviderConfig(providerName, options.userKeys))

    // Initialize judge upfront if evaluate phase is requested
    let judge: ReturnType<typeof createJudge> | undefined
    if (phases.includes("evaluate")) {
      judge = createJudge(judgeName)
      const judgeConfig = getJudgeConfig(judgeName, options.userKeys)
      judgeConfig.model = judgeModel
      await judge.initialize(judgeConfig)
    }

    // Resolve target questions for the pipeline
    // If explicit questionIds were passed (e.g. retry), use those for the pipeline
    // even during resume — this doesn't change the checkpoint's targetQuestionIds
    const pipelineQuestions = (questionIds && questionIds.length > 0)
      ? allQuestions.filter((q) => questionIds.includes(q.questionId))
      : targetQuestionIds
        ? allQuestions.filter((q) => targetQuestionIds!.includes(q.questionId))
        : allQuestions

    // Run per-question pipeline (each question progresses through phases independently)
    const pipelinePhases = phases.filter((p) => p !== "report")
    if (pipelinePhases.length > 0) {
      await runPipeline({
        provider,
        benchmark,
        judge,
        checkpoint,
        checkpointManager: this.checkpointManager,
        phases: pipelinePhases,
        questions: pipelineQuestions,
      })
    }

    if (phases.includes("report")) {
      const report = generateReport(benchmark, checkpoint)
      await saveReport(report)
      printReport(report)
    }

    // Flush all pending checkpoint saves before determining final status
    await this.checkpointManager.flush(checkpoint.runId)

    // Only mark completed if ALL questions in the run are fully evaluated
    const allDone = Object.values(checkpoint.questions).every(
      (q) => q.phases.evaluate.status === "completed"
    )
    const anyFailed = Object.values(checkpoint.questions).some(
      (q) => Object.values(q.phases).some((p) => p.status === "failed")
    )

    if (allDone) {
      this.checkpointManager.updateStatus(checkpoint, "completed")
      logger.success("Run complete!")
    } else if (anyFailed) {
      this.checkpointManager.updateStatus(checkpoint, "failed")
      logger.warn("Run finished with failures.")
    } else {
      // Some questions still pending (partial retry case)
      this.checkpointManager.updateStatus(checkpoint, "interrupted")
      logger.info("Retried questions complete. Run has remaining unfinished questions.")
    }

    // Flush the final status update so clients see it immediately
    await this.checkpointManager.flush(checkpoint.runId)
  }

}

export const orchestrator = new Orchestrator()
export { type ICheckpointManager } from "./checkpoint"
