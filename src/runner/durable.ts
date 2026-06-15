import { batchManager } from "../orchestrator/batch"
import { setRuntimeEnv, type ObservatoryEnv } from "../server/runtime"
import type { RunStartJob, RunRetryQuestionsJob, CompareExecuteJob } from "./messages"
import { createAndEnqueueRunBootstrap, createAndEnqueueTask, enqueueRunPhaseTasks } from "./tasks/scheduler"
import { RunnerTaskStore } from "./tasks/store"
import { RUN_LEASE_TTL_MS } from "./constants"
import type { RunTaskPhase } from "./tasks/types"

const DELETE_LEASE_TTL_MS = 5 * 60 * 1000

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

function nowIso(): string {
  return new Date().toISOString()
}

function leaseExpiresIso(ttlMs = RUN_LEASE_TTL_MS): string {
  return new Date(Date.now() + ttlMs).toISOString()
}

const RUN_TASK_PHASES: RunTaskPhase[] = ["ingest", "indexing", "search", "evaluate"]
const PHASE_STATUS_COLUMN: Record<RunTaskPhase, string> = {
  ingest: "phase_ingest",
  indexing: "phase_indexing",
  search: "phase_search",
  evaluate: "phase_evaluate",
}
const PHASE_PENDING_VALUE: Record<RunTaskPhase, string> = {
  ingest: JSON.stringify({ status: "pending", completedSessions: [] }),
  indexing: JSON.stringify({ status: "pending" }),
  search: JSON.stringify({ status: "pending" }),
  evaluate: JSON.stringify({ status: "pending" }),
}
const PREREQUISITE_PHASE: Partial<Record<RunTaskPhase, RunTaskPhase>> = {
  indexing: "ingest",
  search: "indexing",
  evaluate: "search",
}

function createJobId(kind: RunStartJob["kind"] | CompareExecuteJob["kind"], targetId: string): string {
  return `${kind}:${targetId}:${crypto.randomUUID()}`
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function phasesFrom(phase: RunTaskPhase): RunTaskPhase[] {
  return RUN_TASK_PHASES.slice(RUN_TASK_PHASES.indexOf(phase))
}

async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T
}

export class RunCoordinator implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: ObservatoryEnv
  ) {
    setRuntimeEnv(env)
  }

  async fetch(request: Request): Promise<Response> {
    setRuntimeEnv(this.env)
    const url = new URL(request.url)
    const pathname = url.pathname

    return this.state.blockConcurrencyWhile(async () => {
      if (pathname === "/start") {
        return this.start(await readJson<Omit<RunStartJob, "jobId" | "executionToken">>(request))
      }
      if (pathname === "/retry-questions") {
        return this.retryQuestions(
          await readJson<Omit<RunRetryQuestionsJob, "jobId" | "executionToken">>(request)
        )
      }
      if (pathname === "/stop") {
        return this.stop(url.searchParams.get("id"))
      }
      if (pathname === "/begin-delete") {
        return this.beginDelete(url.searchParams.get("id"))
      }
      if (pathname === "/release-delete") {
        return this.releaseDelete(url.searchParams.get("id"))
      }
      return json({ error: "Not found" }, 404)
    })
  }

  private async start(input: Omit<RunStartJob, "jobId" | "executionToken">): Promise<Response> {
    const db = this.env.OBSERVATORY_DB
    const job: RunStartJob = {
      ...input,
      jobId: createJobId("run.start", input.runId),
      executionToken: crypto.randomUUID(),
    }
    const timestamp = nowIso()
    const expiresAt = leaseExpiresIso()
    const existing = await db
      .prepare("SELECT id, active_status, active_lease_expires_at FROM runs WHERE id = ?")
      .bind(job.runId)
      .first<{ id: string; active_status: string | null; active_lease_expires_at: string | null }>()

    if (
      existing?.active_status &&
      existing.active_lease_expires_at &&
      existing.active_lease_expires_at >= timestamp
    ) {
      return json({ error: "Run is already active" }, 409)
    }

    if (job.force && existing) {
      await db
        .prepare(
          `DELETE FROM runs
           WHERE id = ?
             AND (
               active_status IS NULL
               OR active_lease_expires_at IS NULL
               OR active_lease_expires_at < ?
             )`
        )
        .bind(job.runId, timestamp)
        .run()
    }

    if (existing && !job.force) {
      const result = await db
        .prepare(
          `UPDATE runs
           SET active_status = 'running',
               status = 'running',
               provider = ?,
               benchmark = ?,
               judge = ?,
               "limit" = ?,
               sampling = ?,
               concurrency = ?,
               search_effort = ?,
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
          job.provider,
          job.benchmark,
          job.judgeModel,
          job.limit ?? null,
          serialize(job.sampling),
          serialize(job.concurrency),
          job.searchEffort ?? null,
          job.executionToken,
          expiresAt,
          timestamp,
          job.runId,
          timestamp
        )
        .run()

      if (result.meta.changes === 0) {
        return json({ error: "Run is already active" }, 409)
      }
    } else {
      const result = await db
        .prepare(
          `INSERT INTO runs (
             id, slug, user_id, data_source_run_id, status, active_status,
             provider, benchmark, judge, "limit", sampling, concurrency,
             search_effort, active_execution_token, active_lease_expires_at,
             total_questions, created_at, updated_at
           )
           VALUES (?, ?, ?, ?, 'initializing', 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        )
        .bind(
          job.runId,
          job.runId,
          job.userId,
          job.runId,
          job.provider,
          job.benchmark,
          job.judgeModel,
          job.limit ?? null,
          serialize(job.sampling),
          serialize(job.concurrency),
          job.searchEffort ?? null,
          job.executionToken,
          expiresAt,
          timestamp,
          timestamp
        )
        .run()

      if (result.meta.changes === 0) {
        return json({ error: "Run already exists" }, 409)
      }
    }

    try {
      await db
        .prepare(
          `INSERT INTO runner_jobs (
             id, kind, target_id, status, execution_token, attempts,
             max_attempts, lease_expires_at, created_at, updated_at
           )
           VALUES (?, 'run.start', ?, 'queued', ?, 0, 3, ?, ?, ?)`
        )
        .bind(job.jobId, job.runId, job.executionToken, expiresAt, timestamp, timestamp)
        .run()
      const taskStore = new RunnerTaskStore(this.env.OBSERVATORY_DB)
      await createAndEnqueueRunBootstrap(this.env, taskStore, {
        jobId: job.jobId,
        runId: job.runId,
        fromPhase: job.fromPhase,
        force: job.force,
      })
    } catch (error) {
      await db
        .prepare(
          `UPDATE runs
           SET active_status = NULL,
               active_execution_token = NULL,
               active_lease_expires_at = NULL,
               status = 'failed',
               updated_at = ?
           WHERE id = ?
             AND active_execution_token = ?`
        )
        .bind(nowIso(), job.runId, job.executionToken)
        .run()
      await db
        .prepare("UPDATE runner_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .bind(error instanceof Error ? error.message : String(error), nowIso(), job.jobId)
        .run()
      return json(
        { error: error instanceof Error ? error.message : "Failed to enqueue run" },
        500
      )
    }

    return json({ message: "Run enqueued", runId: job.runId })
  }

  private async resetQuestionsForRetry(
    runId: string,
    questionIds: string[],
    fromPhase: RunTaskPhase
  ): Promise<void> {
    const timestamp = nowIso()
    const resetPhases = phasesFrom(fromPhase)
    const assignments = resetPhases
      .map((phase) => `${PHASE_STATUS_COLUMN[phase]} = ?`)
      .join(", ")
    const phaseValues = resetPhases.map((phase) => PHASE_PENDING_VALUE[phase])

    for (const questionIdChunk of chunks(questionIds, 80)) {
      const placeholders = questionIdChunk.map(() => "?").join(", ")
      await this.env.OBSERVATORY_DB
        .prepare(
          `UPDATE questions
           SET ${assignments}
           WHERE run_id = ?
             AND question_id IN (${placeholders})`
        )
        .bind(...phaseValues, runId, ...questionIdChunk)
        .run()
    }

    if (resetPhases.includes("search")) {
      for (const questionIdChunk of chunks(questionIds, 98)) {
        const placeholders = questionIdChunk.map(() => "?").join(", ")
        await this.env.OBSERVATORY_DB
          .prepare(
            `DELETE FROM search_results
             WHERE run_id = ?
               AND question_id IN (${placeholders})`
          )
          .bind(runId, ...questionIdChunk)
          .run()
      }
    }

    await this.env.OBSERVATORY_DB
      .prepare("DELETE FROM reports WHERE run_id = ?")
      .bind(runId)
      .run()

    await this.env.OBSERVATORY_DB
      .prepare("UPDATE runs SET updated_at = ? WHERE id = ?")
      .bind(timestamp, runId)
      .run()
  }

  private async validateRetryPrerequisites(
    runId: string,
    questionIds: string[],
    fromPhase: RunTaskPhase
  ): Promise<string[]> {
    const prerequisite = PREREQUISITE_PHASE[fromPhase]
    if (!prerequisite) return []
    const incomplete: string[] = []
    const column = PHASE_STATUS_COLUMN[prerequisite]

    for (const questionIdChunk of chunks(questionIds, 98)) {
      const placeholders = questionIdChunk.map(() => "?").join(", ")
      const rows = await this.env.OBSERVATORY_DB
        .prepare(
          `SELECT question_id, ${column} AS phase_status
           FROM questions
           WHERE run_id = ?
             AND question_id IN (${placeholders})`
        )
        .bind(runId, ...questionIdChunk)
        .all<{ question_id: string; phase_status: string | null }>()

      for (const row of rows.results ?? []) {
        try {
          const phase = row.phase_status ? JSON.parse(row.phase_status) : null
          if (phase?.status !== "completed") incomplete.push(row.question_id)
        } catch {
          incomplete.push(row.question_id)
        }
      }
    }
    return incomplete
  }

  private async retryQuestions(
    input: Omit<RunRetryQuestionsJob, "jobId" | "executionToken">
  ): Promise<Response> {
    if (input.kind !== "run.retry_questions") {
      return json({ error: "Invalid retry command" }, 400)
    }
    const fromPhase = input.fromPhase as RunTaskPhase
    if (!RUN_TASK_PHASES.includes(fromPhase)) {
      return json({ error: `Invalid fromPhase: ${input.fromPhase}` }, 400)
    }
    const inputQuestionIds = Array.isArray(input.questionIds) ? input.questionIds : []
    const questionIds = [...new Set(inputQuestionIds)].filter(
      (questionId): questionId is string => typeof questionId === "string" && questionId.length > 0
    )
    if (questionIds.length === 0) {
      return json({ error: "questionIds is required and must be non-empty" }, 400)
    }

    const timestamp = nowIso()
    const expiresAt = leaseExpiresIso()
    const run = await this.env.OBSERVATORY_DB
      .prepare(
        `SELECT id, active_status, active_lease_expires_at
         FROM runs
         WHERE id = ?`
      )
      .bind(input.runId)
      .first<{ id: string; active_status: string | null; active_lease_expires_at: string | null }>()
    if (!run) return json({ error: "Run not found" }, 404)
    if (run.active_status && run.active_lease_expires_at && run.active_lease_expires_at >= timestamp) {
      return json({ error: "Run is already active" }, 409)
    }

    const found = new Set<string>()
    for (const questionIdChunk of chunks(questionIds, 98)) {
      const placeholders = questionIdChunk.map(() => "?").join(", ")
      const existingQuestions = await this.env.OBSERVATORY_DB
        .prepare(
          `SELECT question_id
           FROM questions
           WHERE run_id = ?
             AND question_id IN (${placeholders})`
        )
        .bind(input.runId, ...questionIdChunk)
        .all<{ question_id: string }>()
      for (const row of existingQuestions.results ?? []) {
        found.add(row.question_id)
      }
    }
    const missing = questionIds.filter((questionId) => !found.has(questionId))
    if (missing.length > 0) {
      return json({ error: `Questions not found: ${missing.join(", ")}` }, 400)
    }
    const prerequisiteFailures = await this.validateRetryPrerequisites(input.runId, questionIds, fromPhase)
    if (prerequisiteFailures.length > 0) {
      return json(
        {
          error: `Cannot retry from ${fromPhase}; prerequisite phase is incomplete for: ${prerequisiteFailures.join(", ")}`,
        },
        400
      )
    }

    const job: RunRetryQuestionsJob = {
      ...input,
      questionIds,
      jobId: createJobId("run.start", input.runId),
      executionToken: crypto.randomUUID(),
    }

    const activated = await this.env.OBSERVATORY_DB
      .prepare(
        `UPDATE runs
         SET active_status = 'running',
             status = 'running',
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
      .bind(job.executionToken, expiresAt, timestamp, input.runId, timestamp)
      .run()
    if (activated.meta.changes === 0) {
      return json({ error: "Run is already active" }, 409)
    }

    try {
      const taskStore = new RunnerTaskStore(this.env.OBSERVATORY_DB)
      await this.resetQuestionsForRetry(input.runId, questionIds, fromPhase)
      await taskStore.refreshRunSummaryFromQuestions(input.runId)
      await this.env.OBSERVATORY_DB
        .prepare(
          `INSERT INTO runner_jobs (
             id, kind, target_id, status, execution_token, attempts,
             max_attempts, lease_expires_at, created_at, updated_at
           )
           VALUES (?, 'run.start', ?, 'queued', ?, 0, 3, ?, ?, ?)`
        )
        .bind(job.jobId, job.runId, job.executionToken, expiresAt, timestamp, timestamp)
        .run()

      for (const phase of phasesFrom(fromPhase)) {
        await taskStore.setRunProgressCounts(input.runId, phase, {
          total: questionIds.length,
          completed: 0,
          failed: 0,
        })
      }
      await enqueueRunPhaseTasks(this.env, taskStore, {
        jobId: job.jobId,
        runId: input.runId,
        phase: fromPhase,
        questionIds,
        retryCleanup: fromPhase === "ingest",
      })
    } catch (error) {
      await this.env.OBSERVATORY_DB
        .prepare(
          `UPDATE runs
           SET active_status = NULL,
               active_execution_token = NULL,
               active_lease_expires_at = NULL,
               status = 'failed',
               updated_at = ?
           WHERE id = ?
             AND active_execution_token = ?`
        )
        .bind(nowIso(), input.runId, job.executionToken)
        .run()
      await this.env.OBSERVATORY_DB
        .prepare("UPDATE runner_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .bind(error instanceof Error ? error.message : String(error), nowIso(), job.jobId)
        .run()
      return json(
        { error: error instanceof Error ? error.message : "Failed to enqueue retry" },
        500
      )
    }

    return json({ message: "Retry enqueued", runId: input.runId, questionIds })
  }

  private async stop(id: string | null): Promise<Response> {
    if (!id) return json({ error: "Missing run id" }, 400)
    const result = await this.env.OBSERVATORY_DB
      .prepare(
        `UPDATE runs
         SET active_status = 'stopping',
             updated_at = ?
         WHERE id = ?
           AND active_status = 'running'
           AND active_lease_expires_at IS NOT NULL
           AND active_lease_expires_at >= ?`
      )
      .bind(nowIso(), id, nowIso())
      .run()

    if (result.meta.changes === 0) {
      return json({ error: "Run is not active" }, 404)
    }
    const taskStore = new RunnerTaskStore(this.env.OBSERVATORY_DB)
    await taskStore.cancelQueuedRunTasks(id)
    await taskStore.markStoppedRunTerminalIfIdle(id)
    return json({ message: "Stop requested", runId: id })
  }

  private async beginDelete(id: string | null): Promise<Response> {
    if (!id) return json({ error: "Missing run id" }, 400)
    const timestamp = nowIso()
    const row = await this.env.OBSERVATORY_DB
      .prepare("SELECT active_status, active_lease_expires_at FROM runs WHERE id = ?")
      .bind(id)
      .first<{ active_status: string | null; active_lease_expires_at: string | null }>()

    if (
      (row?.active_status === "running" || row?.active_status === "stopping") &&
      row.active_lease_expires_at &&
      row.active_lease_expires_at >= timestamp
    ) {
      return json({ error: "Cannot delete active run" }, 409)
    }

    const token = crypto.randomUUID()
    await this.env.OBSERVATORY_DB
      .prepare(
        `UPDATE runs
         SET active_status = 'stopping',
             active_execution_token = ?,
             active_lease_expires_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(token, leaseExpiresIso(DELETE_LEASE_TTL_MS), timestamp, id)
      .run()
    return json({ message: "Delete lock acquired", runId: id })
  }

  private async releaseDelete(id: string | null): Promise<Response> {
    if (!id) return json({ error: "Missing run id" }, 400)
    await this.env.OBSERVATORY_DB
      .prepare(
        `UPDATE runs
         SET active_status = NULL,
             active_execution_token = NULL,
             active_lease_expires_at = NULL,
             updated_at = ?
         WHERE id = ?
           AND active_status = 'stopping'`
      )
      .bind(nowIso(), id)
      .run()
    return json({ message: "Delete lock released", runId: id })
  }
}

export class ComparisonCoordinator implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: ObservatoryEnv
  ) {
    setRuntimeEnv(env)
  }

  async fetch(request: Request): Promise<Response> {
    setRuntimeEnv(this.env)
    const url = new URL(request.url)
    const pathname = url.pathname

    return this.state.blockConcurrencyWhile(async () => {
      if (pathname === "/start") {
        return this.start(
          await readJson<Omit<CompareExecuteJob, "jobId" | "executionToken" | "leaseToken">>(request)
        )
      }
      if (pathname === "/stop") {
        return this.stop(url.searchParams.get("id"))
      }
      if (pathname === "/delete") {
        return this.delete(url.searchParams.get("id"))
      }
      return json({ error: "Not found" }, 404)
    })
  }

  private async start(
    input: Omit<CompareExecuteJob, "jobId" | "executionToken" | "leaseToken">
  ): Promise<Response> {
    const leaseToken = await batchManager.acquireComparisonLease(input.compareId)
    if (!leaseToken) {
      return json({ error: "Comparison is already active" }, 409)
    }

    const job: CompareExecuteJob = {
      ...input,
      kind: "compare.execute",
      jobId: createJobId("compare.execute", input.compareId),
      executionToken: crypto.randomUUID(),
      leaseToken,
    }
    const timestamp = nowIso()
    const expiresAt = leaseExpiresIso()

    try {
      await this.env.OBSERVATORY_DB
        .prepare(
          `INSERT INTO runner_jobs (
             id, kind, target_id, status, execution_token, attempts,
             max_attempts, lease_expires_at, created_at, updated_at
           )
           VALUES (?, 'compare.execute', ?, 'queued', ?, 0, 3, ?, ?, ?)`
        )
        .bind(job.jobId, job.compareId, job.executionToken, expiresAt, timestamp, timestamp)
        .run()
      const taskStore = new RunnerTaskStore(this.env.OBSERVATORY_DB)
      await createAndEnqueueTask(this.env, taskStore, {
        jobId: job.jobId,
        kind: "compare.bootstrap",
        targetType: "comparison",
        targetId: job.compareId,
        compareId: job.compareId,
        payload: { leaseToken },
        idempotencyKey: `${job.jobId}:compare.bootstrap`,
      })
    } catch (error) {
      await batchManager.releaseComparisonLease(input.compareId, leaseToken)
      await this.env.OBSERVATORY_DB
        .prepare("UPDATE runner_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .bind(error instanceof Error ? error.message : String(error), nowIso(), job.jobId)
        .run()
      return json(
        { error: error instanceof Error ? error.message : "Failed to enqueue comparison" },
        500
      )
    }

    return json({ message: "Comparison enqueued", compareId: job.compareId, leaseToken })
  }

  private async stop(compareId: string | null): Promise<Response> {
    if (!compareId) return json({ error: "Missing comparison id" }, 400)
    const manifest = await batchManager.loadManifestAsync(compareId)
    if (!manifest) return json({ error: "Comparison not found" }, 404)

    const stopped = await batchManager.requestComparisonStop(compareId)
    if (!stopped) return json({ error: "Comparison is not active" }, 404)

    const timestamp = nowIso()
    const taskStore = new RunnerTaskStore(this.env.OBSERVATORY_DB)
    await taskStore.cancelQueuedComparisonTasks(compareId)
    for (const run of manifest.runs) {
      await this.env.OBSERVATORY_DB
        .prepare(
          `UPDATE runs
           SET active_status = 'stopping',
               updated_at = ?
           WHERE id = ?
             AND active_status = 'running'`
        )
        .bind(timestamp, run.runId)
        .run()
      await taskStore.cancelQueuedRunTasks(run.runId)
      await taskStore.markStoppedRunTerminalIfIdle(run.runId)
    }
    await taskStore.markStoppedComparisonTerminalIfIdle(compareId)

    return json({
      message: "Stop requested for comparison",
      compareId,
      stoppedRunIds: manifest.runs.map((run) => run.runId),
    })
  }

  private async delete(compareId: string | null): Promise<Response> {
    if (!compareId) return json({ error: "Missing comparison id" }, 400)
    try {
      await batchManager.delete(compareId)
      return json({ message: "Comparison deleted", compareId })
    } catch (error) {
      if (error instanceof Error && error.message.includes("Cannot delete active comparison")) {
        return json({ error: "Cannot delete active comparison" }, 409)
      }
      return json(
        { error: error instanceof Error ? error.message : "Failed to delete comparison" },
        500
      )
    }
  }
}
