import type { ObservatoryEnv } from "../server/runtime"
import type { RunnerTaskMessage } from "./tasks/types"

const SWEEP_TASK_LIMIT = 100

type TaskRow = {
  id: string
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
}> {
  const now = new Date().toISOString()
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

  const failed = await env.OBSERVATORY_DB
    .prepare(
      `UPDATE runner_tasks
       SET status = 'failed',
           error = COALESCE(error, 'Task lease expired on final attempt'),
           claim_token = NULL,
           lease_expires_at = NULL,
           completed_at = ?,
           updated_at = ?
       WHERE status = 'executing'
         AND (lease_expires_at IS NULL OR lease_expires_at < ?)
         AND attempts >= max_attempts`
    )
    .bind(now, now, now)
    .run()

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
    failedExpiredTasks: failed.meta.changes ?? 0,
    expiredRuns: expiredRuns.meta.changes ?? 0,
    expiredComparisons: expiredComparisons.meta.changes ?? 0,
  }
}
