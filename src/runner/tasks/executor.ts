import { createBenchmark } from "../../benchmarks"
import { createJudge } from "../../judges"
import { batchManager } from "../../orchestrator/batch"
import { D1CheckpointManager } from "../../orchestrator/d1Checkpoint"
import { evaluateQuestion } from "../../orchestrator/phases/evaluate"
import { ingestQuestion } from "../../orchestrator/phases/ingest"
import { indexQuestion } from "../../orchestrator/phases/indexing"
import { generateReport, saveReport } from "../../orchestrator/phases/report"
import { searchQuestion } from "../../orchestrator/phases/search"
import { createProvider } from "../../providers"
import type { ObservatoryEnv } from "../../server/runtime"
import { fetchAllUserKeys } from "../../server/services/apiKeys"
import { autoAddToLeaderboard } from "../../server/routes/leaderboard"
import { serverEvents } from "../../server/events"
import type { BenchmarkName } from "../../types/benchmark"
import type { RunCheckpoint, SamplingConfig } from "../../types/checkpoint"
import { isRetryableFailure } from "../retry"
import type { ConcurrencyConfig } from "../../types/concurrency"
import type { JudgeName } from "../../types/judge"
import type { ProviderName } from "../../types/provider"
import type { UnifiedQuestion } from "../../types/unified"
import { getJudgeConfig, getProviderConfig } from "../../utils/config"
import { logger } from "../../utils/logger"
import { resolveModel } from "../../utils/models"
import { TaskCancelledError, isTaskCancelledError } from "../../orchestrator/taskGuard"
import type { TaskExecutionGuard } from "../../orchestrator/taskGuard"
import {
  enqueueFinalizeTask,
  enqueueReportTask,
  createAndEnqueueRunBootstrap,
  createAndEnqueueTask,
  enqueueRunPhaseTasks,
  getFirstRunnablePhase,
  initializeRunProgressFromQuestions,
  maybeScheduleNextRunWork,
} from "./scheduler"
import { RunnerTaskBusyError, RunnerTaskRetryableError, RunnerTaskStore } from "./store"
import type { RunnerTask, RunnerTaskMessage, RunTaskPhase } from "./types"

type RunRow = {
  id: string
  user_id: string | null
  provider: ProviderName
  benchmark: BenchmarkName
  judge: string
  limit: number | null
  sampling: string | SamplingConfig | null
  target_question_ids: string | string[] | null
  concurrency: string | ConcurrencyConfig | null
  search_effort: "auto" | "low" | "medium" | "high" | null
  data_source_run_id: string | null
}

const QUESTION_PHASES: RunTaskPhase[] = ["ingest", "indexing", "search", "evaluate"]
const TASK_HEARTBEAT_MS = 5 * 60 * 1000

type RunBootstrapPayloadV1 = {
  fromPhase?: string
  force: boolean
}

type ComparisonLeasePayloadV1 = {
  leaseToken: string
}

function requirePayloadVersion(task: RunnerTask, expected = 1): void {
  if (task.payloadVersion !== expected) {
    throw new Error(`Unsupported payload version ${task.payloadVersion} for task ${task.id}`)
  }
}

function decodeRunBootstrapPayload(task: RunnerTask): RunBootstrapPayloadV1 {
  requirePayloadVersion(task)
  const fromPhase = typeof task.payload.fromPhase === "string" ? task.payload.fromPhase : undefined
  return {
    fromPhase,
    force: task.payload.force === true,
  }
}

function decodeComparisonLeasePayload(task: RunnerTask): ComparisonLeasePayloadV1 {
  requirePayloadVersion(task)
  if (typeof task.payload.leaseToken !== "string" || task.payload.leaseToken.length === 0) {
    throw new Error(`Task ${task.id} is missing comparison lease token`)
  }
  return { leaseToken: task.payload.leaseToken }
}

function parseJsonValue<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== "string") return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

function selectQuestionsBySampling(
  allQuestions: { questionId: string; questionType: string }[],
  sampling: SamplingConfig
): string[] {
  if (sampling.mode === "full") return allQuestions.map((q) => q.questionId)
  if (sampling.mode === "limit" && sampling.limit) {
    return allQuestions.slice(0, sampling.limit).map((q) => q.questionId)
  }
  if (sampling.mode === "sample" && sampling.perCategory) {
    const byType: Record<string, { questionId: string; questionType: string }[]> = {}
    for (const q of allQuestions) {
      byType[q.questionType] = byType[q.questionType] ?? []
      byType[q.questionType].push(q)
    }
    const selected: string[] = []
    for (const questions of Object.values(byType)) {
      if (sampling.sampleType === "random") {
        selected.push(
          ...[...questions].sort(() => Math.random() - 0.5).slice(0, sampling.perCategory).map((q) => q.questionId)
        )
      } else {
        selected.push(...questions.slice(0, sampling.perCategory).map((q) => q.questionId))
      }
    }
    return selected
  }
  return allQuestions.map((q) => q.questionId)
}

async function getRunRow(env: ObservatoryEnv, runId: string): Promise<RunRow> {
  const row = await env.OBSERVATORY_DB
    .prepare(
      `SELECT id, user_id, provider, benchmark, judge, "limit", sampling,
              target_question_ids, concurrency, search_effort, data_source_run_id
       FROM runs
       WHERE id = ?`
    )
    .bind(runId)
    .first<RunRow>()
  if (!row) throw new Error(`Run not found: ${runId}`)
  return row
}

function getQuestion(benchmarkQuestions: UnifiedQuestion[], questionId: string): UnifiedQuestion {
  const question = benchmarkQuestions.find((candidate) => candidate.questionId === questionId)
  if (!question) throw new Error(`Question not found in benchmark: ${questionId}`)
  return question
}

function createCheckpointManager(): D1CheckpointManager {
  const { db } = require("../../server/db")
  return new D1CheckpointManager(db)
}

function createTaskCheckpointManager(): D1CheckpointManager {
  const { db } = require("../../server/db")
  return new D1CheckpointManager(db, { skipRunRecount: true })
}

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

async function ensureRunInitialized(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  task: RunnerTask
): Promise<{ checkpoint: RunCheckpoint; row: RunRow }> {
  if (!task.runId) throw new Error("Run task is missing run_id")
  const row = await getRunRow(env, task.runId)
  const checkpointManager = createCheckpointManager()
  let checkpoint = await checkpointManager.load(task.runId)
  if (!checkpoint) {
    throw new Error(`Run checkpoint not found: ${task.runId}`)
  }

  const benchmark = createBenchmark(row.benchmark)
  await benchmark.load()
  const allQuestions = benchmark.getQuestions()

  if (Object.keys(checkpoint.questions).length === 0) {
    const sampling = parseJsonValue<SamplingConfig>(row.sampling)
    const storedTargetIds = parseJsonValue<string[]>(row.target_question_ids)
    let targetQuestionIds: string[]

    if (storedTargetIds && storedTargetIds.length > 0) {
      targetQuestionIds = storedTargetIds
    } else if (sampling) {
      targetQuestionIds = selectQuestionsBySampling(allQuestions, sampling)
    } else if (row.limit) {
      targetQuestionIds = allQuestions.slice(0, row.limit).map((q) => q.questionId)
    } else {
      targetQuestionIds = allQuestions.map((q) => q.questionId)
    }

    checkpoint.targetQuestionIds = targetQuestionIds
    checkpoint.limit = row.limit ?? undefined
    checkpoint.sampling = sampling
    checkpoint.concurrency = parseJsonValue<ConcurrencyConfig>(row.concurrency)
    checkpoint.searchEffort = row.search_effort ?? undefined

    const selected = allQuestions.filter((q) => targetQuestionIds.includes(q.questionId))
    for (const q of selected) {
      checkpointManager.initQuestion(checkpoint, q.questionId, `${q.questionId}-${checkpoint.dataSourceRunId}`, {
        question: q.question,
        groundTruth: q.groundTruth,
        questionType: q.questionType,
        questionDate: (q.metadata?.questionDate as string | undefined) ?? undefined,
      })
    }
  }

  checkpointManager.updateStatus(checkpoint, "running")
  await checkpointManager.flush(task.runId)
  checkpoint = (await checkpointManager.load(task.runId)) ?? checkpoint
  await initializeRunProgressFromQuestions(env.OBSERVATORY_DB, store, task.runId)
  return { checkpoint, row }
}

async function checkRunFence(
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string
): Promise<"running" | "cancelled" | "terminal"> {
  if (!task.runId) return "terminal"
  const fence = await store.loadRunFence(task.runId)
  if (!fence) return "terminal"
  if (fence.activeExecutionToken !== task.executionToken) return "terminal"
  if (fence.activeStatus === "stopping") {
    await store.cancelQueuedRunTasks(task.runId)
    await store.cancelTask(task.id, claimToken, "Run stop requested")
    await maybeFinalizeStoppedRun(store, task)
    return "cancelled"
  }
  if (fence.activeStatus !== "running") return "terminal"
  await store.renewRunFence(task.runId, task.executionToken)
  await store.renewTaskLease(task.id, claimToken)
  return "running"
}

async function checkComparisonFence(
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string
): Promise<"running" | "cancelled" | "terminal"> {
  if (!task.compareId) return "terminal"
  const { leaseToken } = decodeComparisonLeasePayload(task)
  const fence = await store.loadComparisonFence(task.compareId)
  if (!fence) return "terminal"
  if (fence.activeLeaseToken !== leaseToken) return "terminal"
  if (fence.activeStatus === "stopping") {
    await store.cancelQueuedComparisonTasks(task.compareId)
    await store.cancelTask(task.id, claimToken, "Comparison stop requested")
    await store.markComparisonTerminal(
      task.compareId,
      leaseToken,
      task.executionToken,
      "failed",
      "Comparison stopped by user"
    )
    serverEvents.broadcast({
      type: "compare_stopping",
      compareId: task.compareId,
    })
    return "cancelled"
  }
  if (fence.activeStatus !== "running") return "terminal"
  await store.renewComparisonFence(task.compareId, leaseToken)
  await store.renewTaskLease(task.id, claimToken)
  return "running"
}

async function checkTaskFence(
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string
): Promise<"running" | "cancelled" | "terminal"> {
  if (task.targetType === "comparison") {
    return checkComparisonFence(store, task, claimToken)
  }
  return checkRunFence(store, task, claimToken)
}

function startTaskHeartbeat(
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string
): TaskExecutionGuard & { stop: () => void } {
  let stopped = false
  let renewing = false
  let lost = false
  const renewOnce = async (): Promise<boolean> => {
    const taskRenewed = await store.renewTaskLease(task.id, claimToken)
    let parentRenewed = true
    if (task.targetType === "run" && task.runId) {
      parentRenewed = await store.renewRunningRunFence(task.runId, task.executionToken)
    } else if (task.targetType === "comparison" && task.compareId) {
      const { leaseToken } = decodeComparisonLeasePayload(task)
      parentRenewed = await store.renewRunningComparisonFence(task.compareId, leaseToken)
    }
    return taskRenewed && parentRenewed
  }
  const renew = async () => {
    if (stopped || renewing) return
    renewing = true
    try {
      if (!(await renewOnce())) lost = true
    } catch {
      lost = true
    } finally {
      renewing = false
    }
  }
  const interval = setInterval(() => {
    void renew()
  }, TASK_HEARTBEAT_MS)
  return {
    stop() {
      stopped = true
      clearInterval(interval)
    },
    assertActive() {
      if (lost) {
        throw new TaskCancelledError(`Lost runner task lease for ${task.id}`)
      }
    },
    async ensureActive() {
      if (stopped) {
        lost = true
      } else {
        try {
          if (!(await renewOnce())) lost = true
        } catch {
          lost = true
        }
      }
      this.assertActive()
    },
  }
}

async function shouldContinueRunAfterTask(
  store: RunnerTaskStore,
  task: RunnerTask
): Promise<boolean> {
  if (!task.runId) return false
  const fence = await store.loadRunFence(task.runId)
  if (!fence || fence.activeExecutionToken !== task.executionToken) return false
  if (fence.activeStatus === "stopping") {
    await store.cancelQueuedRunTasks(task.runId)
    await maybeFinalizeStoppedRun(store, task)
    return false
  }
  return fence.activeStatus === "running"
}

async function maybeFinalizeStoppedRun(store: RunnerTaskStore, task: RunnerTask): Promise<void> {
  if (!task.runId) return
  const runnable = await store.getRunnableRunTaskCount(task.runId, task.executionToken)
  if (runnable > 0) return
  await store.markRunTerminal(task.runId, task.executionToken, "interrupted", "Run stopped by user")
  serverEvents.broadcast({
    type: "run_stopped",
    runId: task.runId,
    message: "Run stopped by user",
  })
}

async function failRunForTask(
  store: RunnerTaskStore,
  task: RunnerTask,
  errorMessage: string
): Promise<void> {
  if (!task.runId) return
  await store.cancelQueuedRunTasks(task.runId)
  await store.markRunTerminal(task.runId, task.executionToken, "failed", errorMessage)
  serverEvents.broadcast({
    type: "error",
    runId: task.runId,
    message: errorMessage,
  })
}

async function failComparisonForTask(
  store: RunnerTaskStore,
  task: RunnerTask,
  errorMessage: string
): Promise<void> {
  if (!task.compareId) return
  const { leaseToken } = decodeComparisonLeasePayload(task)
  await store.cancelQueuedComparisonTasks(task.compareId)
  await store.markComparisonTerminal(task.compareId, leaseToken, task.executionToken, "failed", errorMessage)
  serverEvents.broadcast({
    type: "error",
    compareId: task.compareId,
    message: errorMessage,
  })
}

async function releaseTerminalTaskFence(store: RunnerTaskStore, task: RunnerTask): Promise<void> {
  const message = "Task lease expired on final attempt"
  if (task.phase && task.runId) {
    await store.incrementRunProgress(task.runId, task.phase, "failed")
  }
  if (task.targetType === "comparison") {
    await failComparisonForTask(store, task, message)
    return
  }
  await failRunForTask(store, task, message)
}

async function completeTask(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string
): Promise<void> {
  const completed = await store.completeTask(task.id, claimToken)
  if (!completed || !task.runId) return
  if (!(await shouldContinueRunAfterTask(store, task))) return
  await store.renewRunFence(task.runId, task.executionToken)
  if (task.phase) {
    await store.incrementRunProgress(task.runId, task.phase, "completed")
    await maybeScheduleNextRunWork(env, store, task.jobId, task.runId, task.phase)
  }
}

async function executeBootstrap(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string
): Promise<void> {
  if (!task.runId) throw new Error("Bootstrap task is missing run_id")
  const { checkpoint } = await ensureRunInitialized(env, store, task)
  const completed = await store.completeTask(task.id, claimToken)
  if (!completed) return
  if (!(await shouldContinueRunAfterTask(store, task))) return

  serverEvents.broadcast({
    type: "run_started",
    runId: task.runId,
    provider: checkpoint.provider,
    benchmark: checkpoint.benchmark,
  })

  const { fromPhase } = decodeRunBootstrapPayload(task)
  if (fromPhase === "report") {
    await enqueueReportTask(env, store, task.jobId, task.runId)
    return
  }
  const phase = getFirstRunnablePhase(fromPhase)
  await enqueueRunPhaseTasks(env, store, {
    jobId: task.jobId,
    runId: task.runId,
    phase,
  })
}

async function executeQuestionPhase(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string,
  guard: TaskExecutionGuard
): Promise<void> {
  if (!task.runId || !task.questionId || !task.phase) {
    throw new Error(`Malformed task ${task.id}`)
  }
  const row = await getRunRow(env, task.runId)
  const userKeys = row.user_id ? await fetchAllUserKeys(row.user_id) : undefined
  const checkpointManager = createTaskCheckpointManager()
  const checkpoint = await checkpointManager.loadQuestion(task.runId, task.questionId)
  if (!checkpoint) throw new Error(`Run checkpoint not found: ${task.runId}`)

  const benchmark = createBenchmark(row.benchmark)
  await benchmark.load()
  const question = getQuestion(benchmark.getQuestions(), task.questionId)

  let result: unknown = null
  if (task.kind === "run.ingest_question") {
    const provider = createProvider(row.provider)
    await provider.initialize(getProviderConfig(row.provider, userKeys))
    if (task.payload.retryCleanup === true) {
      const target = checkpoint.questions[task.questionId]
      if (target?.containerTag) {
        await provider.clear(target.containerTag)
        await guard.ensureActive?.()
        guard.assertActive()
      }
    }
    result = await ingestQuestion(provider, benchmark, question, checkpoint, checkpointManager, guard)
  } else if (task.kind === "run.index_question") {
    const provider = createProvider(row.provider)
    await provider.initialize(getProviderConfig(row.provider, userKeys))
    result = await indexQuestion(provider, checkpoint, checkpointManager, task.questionId, undefined, guard)
  } else if (task.kind === "run.search_question") {
    const provider = createProvider(row.provider)
    await provider.initialize(getProviderConfig(row.provider, userKeys))
    result = await searchQuestion(provider, question, checkpoint, checkpointManager, guard)
  } else if (task.kind === "run.evaluate_question") {
    const provider = createProvider(row.provider)
    await provider.initialize(getProviderConfig(row.provider, userKeys))
    const judgeModelInfo = resolveModel(row.judge)
    const judgeName = judgeModelInfo.provider as JudgeName
    const judge = createJudge(judgeName)
    const judgeConfig = getJudgeConfig(judgeName, userKeys)
    judgeConfig.model = row.judge
    await judge.initialize(judgeConfig)
    result = await evaluateQuestion(judge, question, checkpoint, checkpointManager, provider, guard)
  }

  await guard.ensureActive?.()
  guard.assertActive()
  await checkpointManager.flush(task.runId)
  if (result === null) {
    await store.completeTask(task.id, claimToken)
    return
  }
  await completeTask(env, store, task, claimToken)
}

async function executeReport(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string,
  guard: TaskExecutionGuard
): Promise<void> {
  if (!task.runId) throw new Error("Report task is missing run_id")
  const row = await getRunRow(env, task.runId)
  const checkpointManager = createCheckpointManager()
  const checkpoint = await checkpointManager.load(task.runId)
  if (!checkpoint) throw new Error(`Run checkpoint not found: ${task.runId}`)
  const benchmark = createBenchmark(row.benchmark)
  await benchmark.load()
  const report = generateReport(benchmark, checkpoint)
  await guard.ensureActive?.()
  guard.assertActive()
  await saveReport(report)
  await guard.ensureActive?.()
  guard.assertActive()
  const completed = await store.completeTask(task.id, claimToken)
  if (!completed) return
  if (!(await shouldContinueRunAfterTask(store, task))) return
  await enqueueFinalizeTask(env, store, task.jobId, task.runId)
}

async function executeFinalize(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string,
  guard: TaskExecutionGuard
): Promise<void> {
  if (!task.runId) throw new Error("Finalize task is missing run_id")
  const checkpointManager = createCheckpointManager()
  const checkpoint = await checkpointManager.load(task.runId)
  if (!checkpoint) throw new Error(`Run checkpoint not found: ${task.runId}`)

  const progress = await Promise.all(
    QUESTION_PHASES.map(async (phase) => [phase, await store.getRunProgress(task.runId!, phase)] as const)
  )
  const anyFailedProgress = progress.some(([, value]) => (value?.failed ?? 0) > 0)
  const allEvaluated = Object.values(checkpoint.questions).every(
    (q) => q.phases.evaluate.status === "completed"
  )
  const anyFailedCheckpoint = Object.values(checkpoint.questions).some((q) =>
    Object.values(q.phases).some((phase) => phase.status === "failed")
  )

  const finalStatus =
    allEvaluated && !anyFailedProgress && !anyFailedCheckpoint ? "completed" : "failed"
  await guard.ensureActive?.()
  guard.assertActive()
  const completed = await store.completeTask(task.id, claimToken)
  if (!completed) return

  await guard.ensureActive?.()
  guard.assertActive()
  await store.markRunTerminal(task.runId, task.executionToken, finalStatus)
  if (finalStatus === "completed") {
    try {
      const row = await getRunRow(env, task.runId)
      if (row.user_id) await autoAddToLeaderboard(task.runId, row.user_id)
    } catch (error) {
      logger.warn(
        `Failed to auto-add run ${task.runId} to leaderboard: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  serverEvents.broadcast({
    type: "run_finished",
    runId: task.runId,
    status: finalStatus,
  })
}

async function createOrResumeChildRun(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  input: {
    runId: string
    provider: ProviderName
    benchmark: BenchmarkName
    judge: string
    userId?: string | null
    targetQuestionIds: string[]
  }
): Promise<void> {
  const timestamp = new Date().toISOString()
  const executionToken = crypto.randomUUID()
  const jobId = `run.start:${input.runId}:${crypto.randomUUID()}`
  const leaseExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  const existing = await env.OBSERVATORY_DB
    .prepare(
      `SELECT status, active_status, active_lease_expires_at
       FROM runs
       WHERE id = ?`
    )
    .bind(input.runId)
    .first<{ status: string; active_status: string | null; active_lease_expires_at: string | null }>()

  if (existing?.status === "completed") return
  if (
    existing?.active_status &&
    existing.active_lease_expires_at &&
    existing.active_lease_expires_at >= timestamp
  ) {
    return
  }

  if (existing) {
    const updated = await env.OBSERVATORY_DB
      .prepare(
        `UPDATE runs
         SET active_status = 'running',
             status = 'running',
             provider = ?,
             benchmark = ?,
             judge = ?,
             target_question_ids = ?,
             total_questions = ?,
             active_execution_token = ?,
             active_lease_expires_at = ?,
             updated_at = ?
         WHERE id = ?
           AND (
             active_status IS NULL
             OR active_lease_expires_at IS NULL
             OR active_lease_expires_at < ?
           )`
      )
      .bind(
        input.provider,
        input.benchmark,
        input.judge,
        serialize(input.targetQuestionIds),
        input.targetQuestionIds.length,
        executionToken,
        leaseExpiresAt,
        timestamp,
        input.runId,
        timestamp
      )
      .run()
    if (updated.meta.changes === 0) return
  } else {
    await env.OBSERVATORY_DB
      .prepare(
        `INSERT INTO runs (
           id, slug, user_id, data_source_run_id, status, active_status,
           provider, benchmark, judge, target_question_ids, active_execution_token,
           active_lease_expires_at, total_questions, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, 'initializing', 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.runId,
        input.runId,
        input.userId ?? null,
        input.runId,
        input.provider,
        input.benchmark,
        input.judge,
        serialize(input.targetQuestionIds),
        executionToken,
        leaseExpiresAt,
        input.targetQuestionIds.length,
        timestamp,
        timestamp
      )
      .run()
  }

  await env.OBSERVATORY_DB
    .prepare(
      `INSERT INTO runner_jobs (
         id, kind, target_id, status, execution_token, attempts,
         max_attempts, lease_expires_at, created_at, updated_at
       )
       VALUES (?, 'run.start', ?, 'queued', ?, 0, 3, ?, ?, ?)`
    )
    .bind(jobId, input.runId, executionToken, leaseExpiresAt, timestamp, timestamp)
    .run()

  await createAndEnqueueRunBootstrap(env, store, {
    jobId,
    runId: input.runId,
    fromPhase: "ingest",
  })
}

async function executeCompareBootstrap(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string
): Promise<void> {
  if (!task.compareId) throw new Error("Comparison bootstrap task is missing compare_id")
  const manifest = await batchManager.loadManifestAsync(task.compareId)
  if (!manifest) throw new Error(`Comparison not found: ${task.compareId}`)

  for (const run of manifest.runs) {
    await createOrResumeChildRun(env, store, {
      runId: run.runId,
      provider: run.provider as ProviderName,
      benchmark: manifest.benchmark as BenchmarkName,
      judge: manifest.judge,
      userId: manifest.userId,
      targetQuestionIds: manifest.targetQuestionIds,
    })
  }

  const completed = await store.completeTask(task.id, claimToken)
  if (!completed) return
  await createAndEnqueueTask(env, store, {
    jobId: task.jobId,
    kind: "compare.aggregate",
    targetType: "comparison",
    targetId: task.compareId,
    compareId: task.compareId,
    payload: { leaseToken: decodeComparisonLeasePayload(task).leaseToken },
    maxAttempts: 1440,
    idempotencyKey: `${task.jobId}:compare.aggregate`,
  })
}

async function executeCompareAggregate(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string
): Promise<void> {
  if (!task.compareId) throw new Error("Comparison aggregate task is missing compare_id")
  const { leaseToken } = decodeComparisonLeasePayload(task)
  const manifest = await batchManager.loadManifestAsync(task.compareId)
  if (!manifest) throw new Error(`Comparison not found: ${task.compareId}`)

  const rows = await Promise.all(
    manifest.runs.map(async (run) => {
      const row = await env.OBSERVATORY_DB
        .prepare("SELECT status FROM runs WHERE id = ?")
        .bind(run.runId)
        .first<{ status: string }>()
      return row?.status ?? "initializing"
    })
  )

  const allCompleted = rows.every((status) => status === "completed")
  const anyFailed = rows.some((status) => status === "failed" || status === "interrupted")
  if (!allCompleted && !anyFailed) {
    await store.renewComparisonFence(task.compareId, leaseToken)
    await store.deferTask(task.id, claimToken, "Waiting for child runs to finish")
    throw new RunnerTaskRetryableError("Waiting for child runs to finish")
  }

  const completed = await store.completeTask(task.id, claimToken)
  if (!completed) return

  if (allCompleted) {
    await batchManager.saveManifest(manifest)
    await store.markComparisonTerminal(task.compareId, leaseToken, task.executionToken, "completed")
    serverEvents.broadcast({
      type: "compare_complete",
      compareId: task.compareId,
    })
    return
  }

  await store.markComparisonTerminal(
    task.compareId,
    leaseToken,
    task.executionToken,
    "failed",
    "One or more child runs failed"
  )
  serverEvents.broadcast({
    type: "error",
    compareId: task.compareId,
    message: "One or more child runs failed",
  })
}

async function dispatchTask(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  task: RunnerTask,
  claimToken: string,
  guard: { assertActive(): void }
): Promise<void> {
  if (task.kind === "run.bootstrap") {
    await executeBootstrap(env, store, task, claimToken)
  } else if (task.kind === "run.generate_report") {
    await executeReport(env, store, task, claimToken, guard)
  } else if (task.kind === "run.finalize") {
    await executeFinalize(env, store, task, claimToken, guard)
  } else if (task.kind === "compare.bootstrap") {
    await executeCompareBootstrap(env, store, task, claimToken)
  } else if (task.kind === "compare.aggregate") {
    await executeCompareAggregate(env, store, task, claimToken)
  } else if (task.kind.startsWith("run.")) {
    await executeQuestionPhase(env, store, task, claimToken, guard)
  } else {
    throw new Error(`Unsupported runner task kind: ${task.kind}`)
  }
}

export async function executeRunnerTask(
  env: ObservatoryEnv,
  message: RunnerTaskMessage
): Promise<void> {
  const store = new RunnerTaskStore(env.OBSERVATORY_DB)
  const claim = await store.claimTask(message.taskId)
  if (claim.status === "busy") throw new RunnerTaskBusyError()
  if (claim.status === "terminal") {
    if (claim.task) await releaseTerminalTaskFence(store, claim.task)
    logger.info(`Skipping terminal runner task ${message.taskId}`)
    return
  }

  const { task, claimToken } = claim
  const fence = await checkTaskFence(store, task, claimToken)
  if (fence !== "running") return

  const heartbeat = startTaskHeartbeat(store, task, claimToken)
  try {
    await dispatchTask(env, store, task, claimToken, heartbeat)
    heartbeat.assertActive()
  } catch (error) {
    if (isTaskCancelledError(error)) {
      if (task.targetType === "comparison" && task.compareId) {
        await store.cancelQueuedComparisonTasks(task.compareId)
        await store.cancelTask(task.id, claimToken, error.message)
        await store.markStoppedComparisonTerminalIfIdle(task.compareId)
        return
      }
      if (task.runId) {
        await store.cancelQueuedRunTasks(task.runId)
        await store.cancelTask(task.id, claimToken, error.message)
        await maybeFinalizeStoppedRun(store, task)
      }
      return
    }
    if (error instanceof RunnerTaskRetryableError) {
      throw error
    }
    const messageText = error instanceof Error ? error.message : String(error)
    logger.error(`Runner task ${task.id} failed: ${messageText}`)
    const result = await store.markFailed(
      task.id,
      claimToken,
      messageText,
      isRetryableFailure(messageText)
    )
    if (result === "retry") {
      if (task.runId) await store.renewRunFence(task.runId, task.executionToken)
      if (task.compareId) {
        await store.renewComparisonFence(
          task.compareId,
          decodeComparisonLeasePayload(task).leaseToken
        )
      }
      throw new RunnerTaskRetryableError(messageText)
    }
    if (result === "failed") {
      if (task.phase && task.runId) {
        await store.incrementRunProgress(task.runId, task.phase, "failed")
      }
      if (task.targetType === "comparison") {
        await failComparisonForTask(store, task, messageText)
      } else {
        await failRunForTask(store, task, messageText)
      }
    }
  } finally {
    heartbeat.stop()
  }
}
