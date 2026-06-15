import type { RunnerTask, RunnerTaskClaim, RunnerTaskCreateInput, RunTaskPhase } from "./types"
import { RUN_LEASE_TTL_MS } from "../constants"

const TASK_LEASE_TTL_MS = 30 * 60 * 1000

function nowIso(): string {
  return new Date().toISOString()
}

function leaseIso(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString()
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "object") return value as Record<string, unknown>
  if (typeof value !== "string") return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function mapTask(row: Record<string, any>): RunnerTask {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    targetType: row.target_type,
    targetId: row.target_id,
    runId: row.run_id,
    compareId: row.compare_id,
    questionId: row.question_id,
    phase: row.phase,
    payload: parsePayload(row.payload),
    payloadVersion: row.payload_version ?? 1,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    claimToken: row.claim_token,
    leaseExpiresAt: row.lease_expires_at,
    idempotencyKey: row.idempotency_key,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    executionToken: row.execution_token,
  }
}

export class RunnerTaskBusyError extends Error {
  constructor() {
    super("Runner task is already executing")
    this.name = "RunnerTaskBusyError"
  }
}

export class RunnerTaskRetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RunnerTaskRetryableError"
  }
}

export class RunnerTaskStore {
  constructor(private readonly db: D1Database) {}

  async createTask(input: RunnerTaskCreateInput): Promise<{ id: string; created: boolean }> {
    const id = crypto.randomUUID()
    const timestamp = nowIso()
    const result = await this.db
      .prepare(
        `INSERT INTO runner_tasks (
           id, job_id, kind, target_type, target_id, run_id, compare_id,
           question_id, phase, payload, status, attempts, max_attempts,
           idempotency_key, payload_version, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`
      )
      .bind(
        id,
        input.jobId,
        input.kind,
        input.targetType,
        input.targetId,
        input.runId ?? null,
        input.compareId ?? null,
        input.questionId ?? null,
        input.phase ?? null,
        JSON.stringify(input.payload ?? {}),
        input.maxAttempts ?? 3,
        input.idempotencyKey,
        input.payloadVersion ?? 1,
        timestamp,
        timestamp
      )
      .run()

    const row = await this.db
      .prepare("SELECT id FROM runner_tasks WHERE idempotency_key = ?")
      .bind(input.idempotencyKey)
      .first<{ id: string }>()
    if (!row) throw new Error(`Failed to create runner task ${input.idempotencyKey}`)
    return { id: row.id, created: result.meta.changes > 0 }
  }

  async getTask(taskId: string): Promise<RunnerTask | null> {
    const row = await this.db
      .prepare(
        `SELECT runner_tasks.*, runner_jobs.execution_token
         FROM runner_tasks
         JOIN runner_jobs ON runner_jobs.id = runner_tasks.job_id
         WHERE runner_tasks.id = ?`
      )
      .bind(taskId)
      .first<Record<string, any>>()
    return row ? mapTask(row) : null
  }

  async claimTask(taskId: string): Promise<RunnerTaskClaim> {
    const claimToken = crypto.randomUUID()
    const timestamp = nowIso()
    const expiresAt = leaseIso(TASK_LEASE_TTL_MS)
    const result = await this.db
      .prepare(
        `UPDATE runner_tasks
         SET status = 'executing',
             claim_token = ?,
             attempts = attempts + 1,
             lease_expires_at = ?,
             updated_at = ?
         WHERE id = ?
           AND (
             status = 'queued'
             OR (status = 'executing' AND lease_expires_at < ?)
           )
           AND attempts < max_attempts`
      )
      .bind(claimToken, expiresAt, timestamp, taskId, timestamp)
      .run()

    if (result.meta.changes > 0) {
      const task = await this.getTask(taskId)
      if (!task) return { status: "terminal" }
      return { status: "claimed", task, claimToken }
    }

    const row = await this.db
      .prepare("SELECT status, attempts, max_attempts, lease_expires_at FROM runner_tasks WHERE id = ?")
      .bind(taskId)
      .first<{
        status: string
        attempts: number
        max_attempts: number
        lease_expires_at: string | null
      }>()
    if (!row) return { status: "terminal" }
    if (row.status !== "executing") return { status: "terminal" }

    const expired = !row.lease_expires_at || row.lease_expires_at < timestamp
    const exhausted = row.attempts >= row.max_attempts
    if (!expired) return { status: "busy" }
    if (!exhausted) return { status: "busy" }

    const task = await this.getTask(taskId)
    await this.db
      .prepare(
        `UPDATE runner_tasks
         SET status = 'failed',
             error = ?,
             lease_expires_at = NULL,
             claim_token = NULL,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'executing'
           AND attempts >= max_attempts
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)`
      )
      .bind("Task lease expired on final attempt", timestamp, timestamp, taskId, timestamp)
      .run()
    return { status: "terminal", task: task ?? undefined }
  }

  async renewTaskLease(taskId: string, claimToken: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE runner_tasks
         SET lease_expires_at = ?,
             updated_at = ?
         WHERE id = ?
           AND claim_token = ?
           AND status = 'executing'`
      )
      .bind(leaseIso(TASK_LEASE_TTL_MS), nowIso(), taskId, claimToken)
      .run()
    return result.meta.changes > 0
  }

  async completeTask(taskId: string, claimToken: string): Promise<boolean> {
    const timestamp = nowIso()
    const result = await this.db
      .prepare(
        `UPDATE runner_tasks
         SET status = 'completed',
             completed_at = ?,
             updated_at = ?,
             lease_expires_at = NULL,
             claim_token = NULL
         WHERE id = ?
           AND claim_token = ?
           AND status = 'executing'`
      )
      .bind(timestamp, timestamp, taskId, claimToken)
      .run()
    return result.meta.changes > 0
  }

  async cancelTask(taskId: string, claimToken: string, reason: string): Promise<boolean> {
    const timestamp = nowIso()
    const result = await this.db
      .prepare(
        `UPDATE runner_tasks
         SET status = 'cancelled',
             error = ?,
             completed_at = ?,
             updated_at = ?,
             lease_expires_at = NULL,
             claim_token = NULL
         WHERE id = ?
           AND claim_token = ?
           AND status = 'executing'`
      )
      .bind(reason, timestamp, timestamp, taskId, claimToken)
      .run()
    return result.meta.changes > 0
  }

  async markFailed(
    taskId: string,
    claimToken: string,
    error: string,
    retryable: boolean
  ): Promise<"retry" | "failed" | "stale"> {
    const timestamp = nowIso()
    if (retryable) {
      const retry = await this.db
        .prepare(
          `UPDATE runner_tasks
           SET status = 'queued',
               error = ?,
               lease_expires_at = NULL,
               claim_token = NULL,
               updated_at = ?
           WHERE id = ?
             AND claim_token = ?
             AND status = 'executing'
             AND attempts < max_attempts`
        )
        .bind(error, timestamp, taskId, claimToken)
        .run()
      if (retry.meta.changes > 0) return "retry"
    }

    const failed = await this.db
      .prepare(
        `UPDATE runner_tasks
         SET status = 'failed',
             error = ?,
             completed_at = ?,
             updated_at = ?,
             lease_expires_at = NULL,
             claim_token = NULL
         WHERE id = ?
           AND claim_token = ?
           AND status = 'executing'`
      )
      .bind(error, timestamp, timestamp, taskId, claimToken)
      .run()
    return failed.meta.changes > 0 ? "failed" : "stale"
  }

  async deferTask(taskId: string, claimToken: string, reason: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE runner_tasks
         SET status = 'queued',
             error = ?,
             lease_expires_at = NULL,
             claim_token = NULL,
             updated_at = ?
         WHERE id = ?
           AND claim_token = ?
           AND status = 'executing'`
      )
      .bind(reason, nowIso(), taskId, claimToken)
      .run()
    return result.meta.changes > 0
  }

  async ensureRunProgress(runId: string, totals: Record<RunTaskPhase, number>): Promise<void> {
    const timestamp = nowIso()
    for (const [phase, total] of Object.entries(totals) as [RunTaskPhase, number][]) {
      await this.db
        .prepare(
          `INSERT INTO run_phase_progress (
             run_id, phase, total, completed, failed, created_at, updated_at
           )
           VALUES (?, ?, ?, 0, 0, ?, ?)
           ON CONFLICT(run_id, phase) DO UPDATE SET
             total = excluded.total,
             updated_at = excluded.updated_at`
        )
        .bind(runId, phase, total, timestamp, timestamp)
        .run()
    }
  }

  async setRunProgressCounts(
    runId: string,
    phase: RunTaskPhase,
    counts: { total: number; completed: number; failed: number }
  ): Promise<void> {
    const timestamp = nowIso()
    await this.db
      .prepare(
        `INSERT INTO run_phase_progress (
           run_id, phase, total, completed, failed, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, phase) DO UPDATE SET
           total = excluded.total,
           completed = excluded.completed,
           failed = excluded.failed,
           updated_at = excluded.updated_at`
      )
      .bind(runId, phase, counts.total, counts.completed, counts.failed, timestamp, timestamp)
      .run()
  }

  async incrementRunProgress(runId: string, phase: RunTaskPhase, field: "completed" | "failed"): Promise<void> {
    await this.db
      .prepare(
        `UPDATE run_phase_progress
         SET ${field} = ${field} + 1,
             updated_at = ?
         WHERE run_id = ?
           AND phase = ?`
    )
      .bind(nowIso(), runId, phase)
      .run()
  }

  async refreshRunSummaryFromQuestions(runId: string): Promise<void> {
    const rows = await this.db
      .prepare(
        `SELECT phase_ingest, phase_indexing, phase_search, phase_evaluate
         FROM questions
         WHERE run_id = ?`
      )
      .bind(runId)
      .all<Record<string, unknown>>()

    let ingestedCount = 0
    let indexedCount = 0
    let searchedCount = 0
    let evaluatedCount = 0
    let correctCount = 0

    const parsePhase = (value: unknown): any => {
      if (!value || typeof value !== "string") return value
      try {
        return JSON.parse(value)
      } catch {
        return null
      }
    }

    for (const row of rows.results ?? []) {
      const ingest = parsePhase(row.phase_ingest)
      const indexing = parsePhase(row.phase_indexing)
      const search = parsePhase(row.phase_search)
      const evaluate = parsePhase(row.phase_evaluate)
      if (ingest?.status === "completed") ingestedCount++
      if (indexing?.status === "completed") indexedCount++
      if (search?.status === "completed") searchedCount++
      if (evaluate?.status === "completed") {
        evaluatedCount++
        if (evaluate.score === 1) correctCount++
      }
    }

    const totalQuestions = rows.results?.length ?? 0
    const accuracy = evaluatedCount > 0 ? correctCount / evaluatedCount : null
    await this.db
      .prepare(
        `UPDATE runs
         SET total_questions = ?,
             ingested_count = ?,
             indexed_count = ?,
             searched_count = ?,
             evaluated_count = ?,
             correct_count = ?,
             accuracy = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .bind(
        totalQuestions,
        ingestedCount,
        indexedCount,
        searchedCount,
        evaluatedCount,
        correctCount,
        accuracy,
        nowIso(),
        runId
      )
      .run()
  }

  async getRunProgress(
    runId: string,
    phase: RunTaskPhase
  ): Promise<{ total: number; completed: number; failed: number } | null> {
    const row = await this.db
      .prepare("SELECT total, completed, failed FROM run_phase_progress WHERE run_id = ? AND phase = ?")
      .bind(runId, phase)
      .first<{ total: number; completed: number; failed: number }>()
    return row ?? null
  }

  async getJobQuestionIds(jobId: string): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `SELECT DISTINCT question_id
         FROM runner_tasks
         WHERE job_id = ?
           AND question_id IS NOT NULL
         ORDER BY question_id`
      )
      .bind(jobId)
      .all<{ question_id: string }>()
    return (rows.results ?? []).map((row) => row.question_id)
  }

  async getRunnableTaskCount(runId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runner_tasks
         WHERE run_id = ?
           AND status IN ('queued', 'executing')`
      )
      .bind(runId)
      .first<{ count: number }>()
    return row?.count ?? 0
  }

  async getRunnableRunTaskCount(runId: string, executionToken: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runner_tasks
         JOIN runner_jobs ON runner_jobs.id = runner_tasks.job_id
         WHERE runner_tasks.run_id = ?
           AND runner_jobs.execution_token = ?
           AND runner_tasks.status IN ('queued', 'executing')`
      )
      .bind(runId, executionToken)
      .first<{ count: number }>()
    return row?.count ?? 0
  }

  async getRunnableComparisonTaskCount(compareId: string, executionToken: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runner_tasks
         JOIN runner_jobs ON runner_jobs.id = runner_tasks.job_id
         WHERE runner_tasks.compare_id = ?
           AND runner_jobs.execution_token = ?
           AND runner_tasks.status IN ('queued', 'executing')`
      )
      .bind(compareId, executionToken)
      .first<{ count: number }>()
    return row?.count ?? 0
  }

  async loadActiveComparisonExecution(compareId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT execution_token
         FROM runner_jobs
         WHERE kind = 'compare.execute'
           AND target_id = ?
           AND status IN ('queued', 'executing')
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .bind(compareId)
      .first<{ execution_token: string }>()
    return row?.execution_token ?? null
  }

  async cancelQueuedRunTasks(runId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runner_tasks
         SET status = 'cancelled',
             error = 'Run stop requested',
             completed_at = ?,
             updated_at = ?
         WHERE run_id = ?
           AND status = 'queued'`
      )
      .bind(nowIso(), nowIso(), runId)
      .run()
  }

  async cancelQueuedComparisonTasks(compareId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runner_tasks
         SET status = 'cancelled',
             error = 'Comparison stop requested',
             completed_at = ?,
             updated_at = ?
         WHERE compare_id = ?
           AND status = 'queued'`
      )
      .bind(nowIso(), nowIso(), compareId)
      .run()
  }

  async renewRunFence(runId: string, executionToken: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE runs
         SET active_lease_expires_at = ?,
             updated_at = ?
         WHERE id = ?
           AND active_execution_token = ?
           AND active_status IS NOT NULL`
      )
      .bind(leaseIso(RUN_LEASE_TTL_MS), nowIso(), runId, executionToken)
      .run()
    return result.meta.changes > 0
  }

  async renewRunningRunFence(runId: string, executionToken: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE runs
         SET active_lease_expires_at = ?,
             updated_at = ?
         WHERE id = ?
           AND active_execution_token = ?
           AND active_status = 'running'`
      )
      .bind(leaseIso(RUN_LEASE_TTL_MS), nowIso(), runId, executionToken)
      .run()
    return result.meta.changes > 0
  }

  async loadRunFence(runId: string): Promise<{
    activeStatus: string | null
    activeExecutionToken: string | null
    activeLeaseExpiresAt: string | null
    status: string
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT status, active_status, active_execution_token, active_lease_expires_at
         FROM runs
         WHERE id = ?`
      )
      .bind(runId)
      .first<{
        status: string
        active_status: string | null
        active_execution_token: string | null
        active_lease_expires_at: string | null
      }>()
    if (!row) return null
    return {
      status: row.status,
      activeStatus: row.active_status,
      activeExecutionToken: row.active_execution_token,
      activeLeaseExpiresAt: row.active_lease_expires_at,
    }
  }

  async loadComparisonFence(compareId: string): Promise<{
    activeStatus: string | null
    activeLeaseToken: string | null
    activeLeaseExpiresAt: string | null
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT active_status, active_lease_token, active_lease_expires_at
         FROM comparisons
         WHERE id = ?`
      )
      .bind(compareId)
      .first<{
        active_status: string | null
        active_lease_token: string | null
        active_lease_expires_at: string | null
      }>()
    if (!row) return null
    return {
      activeStatus: row.active_status,
      activeLeaseToken: row.active_lease_token,
      activeLeaseExpiresAt: row.active_lease_expires_at,
    }
  }

  async renewComparisonFence(compareId: string, leaseToken: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE comparisons
         SET active_lease_expires_at = ?,
             updated_at = ?
         WHERE id = ?
           AND active_lease_token = ?
           AND active_status IS NOT NULL`
      )
      .bind(leaseIso(RUN_LEASE_TTL_MS), nowIso(), compareId, leaseToken)
      .run()
    return result.meta.changes > 0
  }

  async renewRunningComparisonFence(compareId: string, leaseToken: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE comparisons
         SET active_lease_expires_at = ?,
             updated_at = ?
         WHERE id = ?
           AND active_lease_token = ?
           AND active_status = 'running'`
      )
      .bind(leaseIso(RUN_LEASE_TTL_MS), nowIso(), compareId, leaseToken)
      .run()
    return result.meta.changes > 0
  }

  async markRunTerminal(
    runId: string,
    executionToken: string,
    status: "completed" | "failed" | "interrupted",
    error?: string
  ): Promise<void> {
    const timestamp = nowIso()
    await this.refreshRunSummaryFromQuestions(runId)
    await this.db
      .prepare(
        `UPDATE runs
         SET status = ?,
             active_status = NULL,
             active_execution_token = NULL,
             active_lease_expires_at = NULL,
             updated_at = ?
         WHERE id = ?
           AND active_execution_token = ?`
      )
      .bind(status, timestamp, runId, executionToken)
      .run()
    await this.db
      .prepare(
        `UPDATE runner_jobs
         SET status = ?,
             error = COALESCE(?, error),
             completed_at = ?,
             updated_at = ?,
             lease_expires_at = NULL,
             claim_token = NULL
         WHERE execution_token = ?`
      )
      .bind(status === "completed" ? "completed" : "failed", error ?? null, timestamp, timestamp, executionToken)
      .run()
  }

  async markStoppedRunTerminalIfIdle(runId: string): Promise<boolean> {
    const fence = await this.loadRunFence(runId)
    if (
      !fence?.activeExecutionToken ||
      fence.activeStatus !== "stopping"
    ) {
      return false
    }
    const runnable = await this.getRunnableRunTaskCount(runId, fence.activeExecutionToken)
    if (runnable > 0) return false
    await this.markRunTerminal(runId, fence.activeExecutionToken, "interrupted", "Run stopped by user")
    return true
  }

  async releaseTerminalTaskFence(task: RunnerTask, errorMessage: string): Promise<void> {
    if (task.phase && task.runId) {
      await this.incrementRunProgress(task.runId, task.phase, "failed")
    }

    if (task.targetType === "comparison") {
      if (!task.compareId) return
      const leaseToken =
        typeof task.payload.leaseToken === "string" ? task.payload.leaseToken : null
      if (!leaseToken) return
      await this.cancelQueuedComparisonTasks(task.compareId)
      await this.markComparisonTerminal(
        task.compareId,
        leaseToken,
        task.executionToken,
        "failed",
        errorMessage
      )
      return
    }

    if (!task.runId) return
    await this.cancelQueuedRunTasks(task.runId)
    await this.markRunTerminal(task.runId, task.executionToken, "failed", errorMessage)
  }

  async markStoppedComparisonTerminalIfIdle(compareId: string): Promise<boolean> {
    const fence = await this.loadComparisonFence(compareId)
    if (
      !fence?.activeLeaseToken ||
      fence.activeStatus !== "stopping"
    ) {
      return false
    }

    const executionToken = await this.loadActiveComparisonExecution(compareId)
    if (!executionToken) {
      const timestamp = nowIso()
      await this.db
        .prepare(
          `UPDATE comparisons
           SET active_status = NULL,
               active_lease_expires_at = NULL,
               active_lease_token = NULL,
               updated_at = ?
           WHERE id = ?
             AND active_lease_token = ?`
        )
        .bind(timestamp, compareId, fence.activeLeaseToken)
        .run()
      return true
    }

    const runnable = await this.getRunnableComparisonTaskCount(compareId, executionToken)
    if (runnable > 0) return false
    await this.markComparisonTerminal(
      compareId,
      fence.activeLeaseToken,
      executionToken,
      "failed",
      "Comparison stopped by user"
    )
    return true
  }

  async markComparisonTerminal(
    compareId: string,
    leaseToken: string,
    executionToken: string,
    status: "completed" | "failed",
    error?: string
  ): Promise<void> {
    const timestamp = nowIso()
    await this.db
      .prepare(
        `UPDATE comparisons
         SET active_status = NULL,
             active_lease_expires_at = NULL,
             active_lease_token = NULL,
             updated_at = ?
         WHERE id = ?
           AND active_lease_token = ?`
      )
      .bind(timestamp, compareId, leaseToken)
      .run()
    await this.db
      .prepare(
        `UPDATE runner_jobs
         SET status = ?,
             error = COALESCE(?, error),
             completed_at = ?,
             updated_at = ?,
             lease_expires_at = NULL,
             claim_token = NULL
         WHERE execution_token = ?`
      )
      .bind(status, error ?? null, timestamp, timestamp, executionToken)
      .run()
  }
}
