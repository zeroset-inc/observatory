import type { ObservatoryEnv } from "../../server/runtime"
import type { RunnerTaskMessage } from "./types"
import { RunnerTaskStore } from "./store"
import type { RunnerTaskCreateInput, RunTaskPhase } from "./types"

const PHASES: RunTaskPhase[] = ["ingest", "indexing", "search", "evaluate"]
const TASK_KIND_BY_PHASE: Record<RunTaskPhase, RunnerTaskCreateInput["kind"]> = {
  ingest: "run.ingest_question",
  indexing: "run.index_question",
  search: "run.search_question",
  evaluate: "run.evaluate_question",
}

const PHASE_STATUS_COLUMN: Record<RunTaskPhase, string> = {
  ingest: "phase_ingest",
  indexing: "phase_indexing",
  search: "phase_search",
  evaluate: "phase_evaluate",
}

const PREREQUISITE_PHASE: Partial<Record<RunTaskPhase, RunTaskPhase>> = {
  indexing: "ingest",
  search: "indexing",
  evaluate: "search",
}

function phaseOrderIndex(phase: RunTaskPhase): number {
  return PHASES.indexOf(phase)
}

function isCompletedPhase(value: unknown): boolean {
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  return Boolean(parsed && typeof parsed === "object" && (parsed as any).status === "completed")
}

export async function sendTaskMessage(env: ObservatoryEnv, taskId: string): Promise<void> {
  if (!env.OBSERVATORY_RUNNER_QUEUE) {
    throw new Error("OBSERVATORY_RUNNER_QUEUE binding is not configured")
  }
  await env.OBSERVATORY_RUNNER_QUEUE.send({ kind: "task.execute", taskId } satisfies RunnerTaskMessage)
}

export async function createAndEnqueueTask(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  input: RunnerTaskCreateInput
): Promise<string> {
  const task = await store.createTask(input)
  if (task.created) {
    await sendTaskMessage(env, task.id)
  }
  return task.id
}

export async function createAndEnqueueRunBootstrap(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  input: {
    jobId: string
    runId: string
    fromPhase?: string
    force?: boolean
  }
): Promise<string> {
  return createAndEnqueueTask(env, store, {
    jobId: input.jobId,
    kind: "run.bootstrap",
    targetType: "run",
    targetId: input.runId,
    runId: input.runId,
    payload: {
      fromPhase: input.fromPhase,
      force: input.force === true,
    },
    idempotencyKey: `${input.jobId}:run.bootstrap`,
  })
}

export async function initializeRunProgressFromQuestions(
  db: D1Database,
  store: RunnerTaskStore,
  runId: string
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT phase_ingest, phase_indexing, phase_search, phase_evaluate
       FROM questions
       WHERE run_id = ?`
    )
    .bind(runId)
    .all<Record<string, unknown>>()

  const totals: Record<RunTaskPhase, { total: number; completed: number; failed: number }> = {
    ingest: { total: rows.results?.length ?? 0, completed: 0, failed: 0 },
    indexing: { total: rows.results?.length ?? 0, completed: 0, failed: 0 },
    search: { total: rows.results?.length ?? 0, completed: 0, failed: 0 },
    evaluate: { total: rows.results?.length ?? 0, completed: 0, failed: 0 },
  }

  for (const row of rows.results ?? []) {
    for (const phase of PHASES) {
      const raw = row[PHASE_STATUS_COLUMN[phase]]
      let status: string | undefined
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
        status = parsed?.status
      } catch {
        status = undefined
      }
      if (status === "completed") totals[phase].completed++
      if (status === "failed") totals[phase].failed++
    }
  }

  for (const phase of PHASES) {
    await store.setRunProgressCounts(runId, phase, totals[phase])
  }
}

async function getRunQuestionIdsForPhase(
  db: D1Database,
  runId: string,
  phase: RunTaskPhase
): Promise<string[]> {
  const prerequisite = PREREQUISITE_PHASE[phase]
  const prerequisiteSelect = prerequisite
    ? `, ${PHASE_STATUS_COLUMN[prerequisite]} AS prerequisite_status`
    : ""
  const rows = await db
    .prepare(
      `SELECT question_id, ${PHASE_STATUS_COLUMN[phase]} AS phase_status${prerequisiteSelect}
       FROM questions
       WHERE run_id = ?`
    )
    .bind(runId)
    .all<{ question_id: string; phase_status: unknown; prerequisite_status?: unknown }>()

  return (rows.results ?? [])
    .filter((row) => {
      try {
        if (isCompletedPhase(row.phase_status)) return false
        if (!prerequisite) return true
        return isCompletedPhase(row.prerequisite_status)
      } catch {
        return false
      }
    })
    .map((row) => row.question_id)
}

export async function enqueueRunPhaseTasks(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  input: {
    jobId: string
    runId: string
    phase: RunTaskPhase
  }
): Promise<void> {
  const questionIds = await getRunQuestionIdsForPhase(env.OBSERVATORY_DB, input.runId, input.phase)

  for (const questionId of questionIds) {
    await createAndEnqueueTask(env, store, {
      jobId: input.jobId,
      kind: TASK_KIND_BY_PHASE[input.phase],
      targetType: "run",
      targetId: input.runId,
      runId: input.runId,
      questionId,
      phase: input.phase,
      payload: { questionId },
      idempotencyKey: `${input.jobId}:${input.phase}:${questionId}`,
    })
  }

  if (questionIds.length === 0) {
    await maybeScheduleNextRunWork(env, store, input.jobId, input.runId, input.phase)
  }
}

export async function enqueueReportTask(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  jobId: string,
  runId: string
): Promise<void> {
  await createAndEnqueueTask(env, store, {
    jobId,
    kind: "run.generate_report",
    targetType: "run",
    targetId: runId,
    runId,
    payload: {},
    idempotencyKey: `${jobId}:run.generate_report`,
  })
}

export async function enqueueFinalizeTask(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  jobId: string,
  runId: string
): Promise<void> {
  await createAndEnqueueTask(env, store, {
    jobId,
    kind: "run.finalize",
    targetType: "run",
    targetId: runId,
    runId,
    payload: {},
    idempotencyKey: `${jobId}:run.finalize`,
  })
}

export async function maybeScheduleNextRunWork(
  env: ObservatoryEnv,
  store: RunnerTaskStore,
  jobId: string,
  runId: string,
  completedPhase: RunTaskPhase
): Promise<void> {
  const progress = await store.getRunProgress(runId, completedPhase)
  if (!progress) return
  if (progress.completed + progress.failed < progress.total) return
  if (progress.failed > 0) {
    await enqueueFinalizeTask(env, store, jobId, runId)
    return
  }

  const nextPhase = PHASES[phaseOrderIndex(completedPhase) + 1]
  if (nextPhase) {
    const previous = await store.getRunProgress(runId, completedPhase)
    if (!previous || previous.completed + previous.failed < previous.total) return
    await enqueueRunPhaseTasks(env, store, { jobId, runId, phase: nextPhase })
    return
  }

  await enqueueReportTask(env, store, jobId, runId)
}

export function getFirstRunnablePhase(fromPhase?: unknown): RunTaskPhase {
  if (fromPhase && PHASES.includes(fromPhase as RunTaskPhase)) {
    return fromPhase as RunTaskPhase
  }
  return "ingest"
}
