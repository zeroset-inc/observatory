import type { ObservatoryEnv } from "../server/runtime"
import { RunnerTaskStore } from "./tasks/store"
import type { RunnerTaskMessage } from "./tasks/types"

const SWEEP_TASK_LIMIT = 100

type TaskRow = {
  id: string
}

type TargetRow = {
  id: string
}

type RunJobRow = {
  id: string
  run_status: string
}

async function enqueueTask(env: ObservatoryEnv, taskId: string): Promise<void> {
  await env.OBSERVATORY_RUNNER_QUEUE?.send({ kind: "task.execute", taskId } satisfies RunnerTaskMessage)
}

export async function sweepRunner(env: ObservatoryEnv): Promise<{
  requeuedExpiredTasks: number
  replayedQueuedTasks: number
  failedExpiredTasks: number
  expiredRuns: number
  expiredComparisons: number
  stoppedRuns: number
  stoppedComparisons: number
  repairedTerminalJobs: number
}> {
  const now = new Date().toISOString()
  const store = new RunnerTaskStore(env.OBSERVATORY_DB)
  const requeueRows = await env.OBSERVATORY_DB
    .prepare(
      `SELECT id
       FROM runner_tasks
       WHERE status = 'executing'
         AND (lease_expires_at IS NULL OR lease_expires_at < ?)
         AND attempts < max_attempts
       LIMIT ?`
    )
    .bind(now, SWEEP_TASK_LIMIT)
    .all<TaskRow>()

  let requeuedExpiredTasks = 0
  for (const row of requeueRows.results ?? []) {
    const result = await env.OBSERVATORY_DB
      .prepare(
        `UPDATE runner_tasks
         SET status = 'queued',
             claim_token = NULL,
             lease_expires_at = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'executing'
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)
           AND attempts < max_attempts`
      )
      .bind(now, row.id, now)
      .run()
    if (result.meta.changes > 0) {
      requeuedExpiredTasks++
      await enqueueTask(env, row.id)
    }
  }

  const finalAttemptRows = await env.OBSERVATORY_DB
    .prepare(
      `SELECT id
       FROM runner_tasks
       WHERE status = 'executing'
         AND (lease_expires_at IS NULL OR lease_expires_at < ?)
         AND attempts >= max_attempts
       LIMIT ?`
    )
    .bind(now, SWEEP_TASK_LIMIT)
    .all<TaskRow>()

  let failedExpiredTasks = 0
  for (const row of finalAttemptRows.results ?? []) {
    const task = await store.getTask(row.id)
    const result = await env.OBSERVATORY_DB
      .prepare(
        `UPDATE runner_tasks
         SET status = 'failed',
             error = COALESCE(error, 'Task lease expired on final attempt'),
             claim_token = NULL,
             lease_expires_at = NULL,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'executing'
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)
           AND attempts >= max_attempts`
      )
      .bind(now, now, row.id, now)
      .run()
    if (result.meta.changes > 0) {
      failedExpiredTasks++
      if (task) {
        await store.releaseTerminalTaskFence(task, "Task lease expired on final attempt")
      }
    }
  }

  const queuedRows = await env.OBSERVATORY_DB
    .prepare(
      `SELECT id
       FROM runner_tasks
       WHERE status = 'queued'
       ORDER BY updated_at ASC
       LIMIT ?`
    )
    .bind(SWEEP_TASK_LIMIT)
    .all<TaskRow>()

  let replayedQueuedTasks = 0
  for (const row of queuedRows.results ?? []) {
    await enqueueTask(env, row.id)
    replayedQueuedTasks++
  }

  const stoppingRunRows = await env.OBSERVATORY_DB
    .prepare(
      `SELECT DISTINCT runs.id
       FROM runs
       JOIN runner_tasks ON runner_tasks.run_id = runs.id
       WHERE runs.active_status = 'stopping'
         AND runner_tasks.status IN ('queued', 'executing')
       LIMIT ?`
    )
    .bind(SWEEP_TASK_LIMIT)
    .all<TargetRow>()

  let stoppedRuns = 0
  for (const row of stoppingRunRows.results ?? []) {
    await store.cancelRunnableRunTasks(row.id)
    if (await store.markStoppedRunTerminalIfIdle(row.id)) stoppedRuns++
  }

  const stoppingComparisonRows = await env.OBSERVATORY_DB
    .prepare(
      `SELECT DISTINCT comparisons.id
       FROM comparisons
       JOIN runner_tasks ON runner_tasks.compare_id = comparisons.id
       WHERE comparisons.active_status = 'stopping'
         AND runner_tasks.status IN ('queued', 'executing')
       LIMIT ?`
    )
    .bind(SWEEP_TASK_LIMIT)
    .all<TargetRow>()

  let stoppedComparisons = 0
  for (const row of stoppingComparisonRows.results ?? []) {
    await store.cancelRunnableComparisonTasks(row.id)
    if (await store.markStoppedComparisonTerminalIfIdle(row.id)) stoppedComparisons++
  }

  const terminalRunJobRows = await env.OBSERVATORY_DB
    .prepare(
      `SELECT runner_jobs.id, runs.status AS run_status
       FROM runner_jobs
       JOIN runs ON runs.id = runner_jobs.target_id
       WHERE runner_jobs.kind = 'run.start'
         AND runner_jobs.status IN ('queued', 'executing')
         AND runs.active_status IS NULL
         AND runs.status IN ('completed', 'failed', 'interrupted')
       LIMIT ?`
    )
    .bind(SWEEP_TASK_LIMIT)
    .all<RunJobRow>()

  let repairedTerminalJobs = 0
  for (const row of terminalRunJobRows.results ?? []) {
    const status = row.run_status === "completed" ? "completed" : "failed"
    const result = await env.OBSERVATORY_DB
      .prepare(
        `UPDATE runner_jobs
         SET status = ?,
             error = COALESCE(error, ?),
             completed_at = COALESCE(completed_at, ?),
             updated_at = ?,
             lease_expires_at = ?,
             claim_token = NULL
         WHERE id = ?
           AND status IN ('queued', 'executing')`
      )
      .bind(status, "Parent run is already terminal", now, now, now, row.id)
      .run()
    if (result.meta.changes > 0) repairedTerminalJobs++
  }

  const terminalComparisonJobRows = await env.OBSERVATORY_DB
    .prepare(
      `SELECT runner_jobs.id
       FROM runner_jobs
       JOIN comparisons ON comparisons.id = runner_jobs.target_id
       WHERE runner_jobs.kind = 'compare.execute'
         AND runner_jobs.status IN ('queued', 'executing')
         AND comparisons.active_status IS NULL
       LIMIT ?`
    )
    .bind(SWEEP_TASK_LIMIT)
    .all<TargetRow>()

  for (const row of terminalComparisonJobRows.results ?? []) {
    const result = await env.OBSERVATORY_DB
      .prepare(
        `UPDATE runner_jobs
         SET status = 'failed',
             error = COALESCE(error, 'Parent comparison is inactive before job terminalized'),
             completed_at = COALESCE(completed_at, ?),
             updated_at = ?,
             lease_expires_at = ?,
             claim_token = NULL
         WHERE id = ?
           AND status IN ('queued', 'executing')`
      )
      .bind(now, now, now, row.id)
      .run()
    if (result.meta.changes > 0) repairedTerminalJobs++
  }

  const expiredRuns = await env.OBSERVATORY_DB
    .prepare(
      `UPDATE runs
       SET status = CASE WHEN status = 'completed' THEN status ELSE 'failed' END,
           active_status = NULL,
           active_execution_token = NULL,
           active_lease_expires_at = NULL,
           updated_at = ?
       WHERE active_status IS NOT NULL
         AND active_lease_expires_at IS NOT NULL
         AND active_lease_expires_at < ?`
    )
    .bind(now, now)
    .run()

  const expiredComparisons = await env.OBSERVATORY_DB
    .prepare(
      `UPDATE comparisons
       SET active_status = NULL,
           active_lease_expires_at = NULL,
           active_lease_token = NULL,
           updated_at = ?
       WHERE active_status IS NOT NULL
         AND active_lease_expires_at IS NOT NULL
         AND active_lease_expires_at < ?`
    )
    .bind(now, now)
    .run()

  return {
    requeuedExpiredTasks,
    replayedQueuedTasks,
    failedExpiredTasks,
    expiredRuns: expiredRuns.meta.changes ?? 0,
    expiredComparisons: expiredComparisons.meta.changes ?? 0,
    stoppedRuns,
    stoppedComparisons,
    repairedTerminalJobs,
  }
}
