import { orchestrator } from "../orchestrator"
import { batchManager } from "../orchestrator/batch"
import { wsManager } from "../server/wsManager"
import { fetchAllUserKeys } from "../server/services/apiKeys"
import { autoAddToLeaderboard } from "../server/routes/leaderboard"
import { startDurableStopPolling } from "../server/runState"
import { logger } from "../utils/logger"
import type { RunnerMessage, RunStartJob, CompareExecuteJob } from "./messages"
import { isRetryableFailure } from "./retry"

const RUNNER_JOB_LEASE_TTL_MS = 24 * 60 * 60 * 1000
const RUNNER_JOB_LEASE_RENEW_MS = 10 * 60 * 1000
const BUSY_RETRY_DELAY_SECONDS = 60

export type RunnerExecutionResult = "processed" | "busy"
type RunnerJobMessage = RunStartJob | CompareExecuteJob

function getDb() {
  const { db } = require("../server/db")
  return db
}

function nowIso(): string {
  return new Date().toISOString()
}

function leaseExpiresIso(): string {
  return new Date(Date.now() + RUNNER_JOB_LEASE_TTL_MS).toISOString()
}

type RunnerJobClaim =
  | { status: "claimed"; claimToken: string; targetStatus: "running" | "stopping" }
  | { status: "busy" }
  | { status: "terminal" }

async function releaseTargetFence(message: RunnerJobMessage): Promise<void> {
  if (message.kind === "run.start") {
    await markRunFailed(message.runId, message.executionToken)
    return
  }
  await batchManager.releaseComparisonLease(message.compareId, message.leaseToken)
}

async function activateRunLease(job: RunStartJob): Promise<"running" | "stopping"> {
  const result = await getDb().run(
    `UPDATE runs
     SET active_status = CASE
           WHEN active_status = 'stopping' AND active_execution_token = ? THEN 'stopping'
           ELSE 'running'
         END,
         active_execution_token = ?,
         active_lease_expires_at = ?,
         updated_at = ?
     WHERE id = ?
       AND (
         active_status IS NULL
         OR active_execution_token = ?
         OR active_lease_expires_at IS NULL
         OR active_lease_expires_at < ?
       )`,
    [
      job.executionToken,
      job.executionToken,
      leaseExpiresIso(),
      nowIso(),
      job.runId,
      job.executionToken,
      nowIso(),
    ]
  )
  if (result.meta.changes === 0) {
    throw new Error(`Failed to activate run lease for ${job.runId}`)
  }
  const { db } = require("../server/db")
  const { data, error } = await db
    .from("runs")
    .select("active_status")
    .eq("id", job.runId)
    .eq("active_execution_token", job.executionToken)
    .maybeSingle()
  if (error || !data?.active_status) {
    throw new Error(`Failed to read active run state for ${job.runId}`)
  }
  return data.active_status === "stopping" ? "stopping" : "running"
}

async function activateComparisonLease(job: CompareExecuteJob): Promise<"running" | "stopping"> {
  const result = await getDb().run(
    `UPDATE comparisons
     SET active_status = CASE
           WHEN active_status = 'stopping' AND active_lease_token = ? THEN 'stopping'
           ELSE 'running'
         END,
         active_lease_token = ?,
         active_lease_expires_at = ?,
         updated_at = ?
     WHERE id = ?
       AND (
         active_status IS NULL
         OR active_lease_token = ?
         OR active_lease_expires_at IS NULL
         OR active_lease_expires_at < ?
       )`,
    [
      job.leaseToken,
      job.leaseToken,
      leaseExpiresIso(),
      nowIso(),
      job.compareId,
      job.leaseToken,
      nowIso(),
    ]
  )
  if (result.meta.changes === 0) {
    throw new Error(`Failed to activate comparison lease for ${job.compareId}`)
  }
  const { db } = require("../server/db")
  const { data, error } = await db
    .from("comparisons")
    .select("active_status")
    .eq("id", job.compareId)
    .eq("active_lease_token", job.leaseToken)
    .maybeSingle()
  if (error || !data?.active_status) {
    throw new Error(`Failed to read active comparison state for ${job.compareId}`)
  }
  return data.active_status === "stopping" ? "stopping" : "running"
}

async function claimRunnerJob(message: RunnerJobMessage): Promise<RunnerJobClaim> {
  const timestamp = nowIso()
  const claimToken = crypto.randomUUID()
  const result = await getDb().run(
    `UPDATE runner_jobs
     SET status = 'executing',
         claim_token = ?,
         attempts = attempts + 1,
         started_at = COALESCE(started_at, ?),
         lease_expires_at = ?,
         updated_at = ?
     WHERE id = ?
       AND execution_token = ?
       AND (
         status = 'queued'
         OR (
           status = 'executing'
           AND lease_expires_at < ?
         )
       )
       AND attempts < max_attempts`,
    [
      claimToken,
      timestamp,
      leaseExpiresIso(),
      timestamp,
      message.jobId,
      message.executionToken,
      timestamp,
    ]
  )
  if (result.meta.changes > 0) {
    let targetStatus: "running" | "stopping"
    if (message.kind === "run.start") {
      targetStatus = await activateRunLease(message)
    } else {
      targetStatus = await activateComparisonLease(message)
    }
    return { status: "claimed", claimToken, targetStatus }
  }

  const { db } = require("../server/db")
  const { data, error } = await db
    .from("runner_jobs")
    .select("status, attempts, max_attempts, lease_expires_at")
    .eq("id", message.jobId)
    .eq("execution_token", message.executionToken)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to inspect runner job ${message.jobId}: ${error.message}`)
  }
  if (data?.status === "executing") {
    const leaseExpired =
      Boolean(data.lease_expires_at) &&
      new Date(data.lease_expires_at).getTime() < Date.now()
    const attemptsExhausted =
      typeof data.attempts === "number" &&
      typeof data.max_attempts === "number" &&
      data.attempts >= data.max_attempts

    if (leaseExpired && attemptsExhausted) {
      const terminalized = await getDb().run(
        `UPDATE runner_jobs
         SET status = 'failed',
             error = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?
           AND execution_token = ?
           AND status = 'executing'
           AND lease_expires_at < ?
           AND attempts >= max_attempts`,
        [
          "Runner job expired after exhausting retry attempts.",
          timestamp,
          timestamp,
          message.jobId,
          message.executionToken,
          timestamp,
        ]
      )
      if (terminalized.meta.changes > 0) {
        await releaseTargetFence(message)
        return { status: "terminal" }
      }
    }
    return { status: "busy" }
  }
  return { status: "terminal" }
}

async function markRunnerJobCompleted(message: RunnerJobMessage, claimToken: string): Promise<void> {
  const timestamp = nowIso()
  const result = await getDb().run(
    `UPDATE runner_jobs
     SET status = 'completed',
         completed_at = ?,
         updated_at = ?
     WHERE id = ?
       AND execution_token = ?
       AND claim_token = ?
       AND status = 'executing'`,
    [timestamp, timestamp, message.jobId, message.executionToken, claimToken]
  )
  if (result.meta.changes === 0) {
    throw new Error(`Failed to mark runner job ${message.jobId} completed`)
  }
}

async function markRunnerJobFailed(
  message: RunnerJobMessage,
  errorMessage: string,
  retryable: boolean,
  claimToken: string
): Promise<"retry" | "failed"> {
  const timestamp = nowIso()
  if (retryable) {
    const retryResult = await getDb().run(
      `UPDATE runner_jobs
       SET status = 'queued',
           error = ?,
           lease_expires_at = ?,
           updated_at = ?
       WHERE id = ?
         AND execution_token = ?
         AND claim_token = ?
         AND status = 'executing'
         AND attempts < max_attempts`,
      [errorMessage, timestamp, timestamp, message.jobId, message.executionToken, claimToken]
    )
    if (retryResult.meta.changes > 0) return "retry"
  }

  const result = await getDb().run(
    `UPDATE runner_jobs
     SET status = 'failed',
         error = ?,
         completed_at = ?,
         updated_at = ?
     WHERE id = ?
       AND execution_token = ?
       AND claim_token = ?
       AND status = 'executing'`,
    [errorMessage, timestamp, timestamp, message.jobId, message.executionToken, claimToken]
  )
  if (result.meta.changes === 0) {
    throw new Error(`Failed to mark runner job ${message.jobId} failed`)
  }
  return "failed"
}

async function renewQueuedRetryFence(message: RunnerJobMessage): Promise<void> {
  const expiresAt = leaseExpiresIso()
  const timestamp = nowIso()
  if (message.kind === "run.start") {
    const result = await getDb().run(
      `UPDATE runs
       SET active_lease_expires_at = ?,
           updated_at = ?
       WHERE id = ?
         AND active_execution_token = ?
         AND active_status IS NOT NULL`,
      [expiresAt, timestamp, message.runId, message.executionToken]
    )
    if (result.meta.changes === 0) {
      throw new Error(`Failed to renew queued retry fence for run ${message.runId}`)
    }
    return
  }

  const result = await getDb().run(
    `UPDATE comparisons
     SET active_lease_expires_at = ?,
         updated_at = ?
     WHERE id = ?
       AND active_lease_token = ?
       AND active_status IS NOT NULL`,
    [expiresAt, timestamp, message.compareId, message.leaseToken]
  )
  if (result.meta.changes === 0) {
    throw new Error(`Failed to renew queued retry fence for comparison ${message.compareId}`)
  }
}

function startRunnerJobLeaseRenewal(
  message: RunnerJobMessage,
  claimToken: string,
  runId?: string
): () => void {
  let stopped = false
  let renewing = false

  const renew = async () => {
    if (stopped || renewing) return
    renewing = true
    try {
      const expiresAt = leaseExpiresIso()
      await getDb().run(
        `UPDATE runner_jobs
         SET lease_expires_at = ?,
             updated_at = ?
         WHERE id = ?
           AND execution_token = ?
           AND claim_token = ?
           AND status = 'executing'`,
        [expiresAt, nowIso(), message.jobId, message.executionToken, claimToken]
      )
      if (runId) {
        await getDb().run(
          `UPDATE runs
           SET active_lease_expires_at = ?,
               updated_at = ?
           WHERE id = ?
             AND active_execution_token = ?
             AND active_status IS NOT NULL`,
          [expiresAt, nowIso(), runId, message.executionToken]
        )
      }
    } catch (error) {
      logger.warn(
        `Failed to renew runner job lease ${message.jobId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    } finally {
      renewing = false
    }
  }

  const interval = setInterval(() => void renew(), RUNNER_JOB_LEASE_RENEW_MS)
  return () => {
    stopped = true
    clearInterval(interval)
  }
}

async function clearRunActiveStatus(runId: string, executionToken: string): Promise<void> {
  const { error } = await getDb()
    .from("runs")
    .update({
      active_status: null,
      active_execution_token: null,
      active_lease_expires_at: null,
    })
    .eq("id", runId)
    .eq("active_execution_token", executionToken)

  if (error) {
    logger.warn(`Failed to clear active status for run ${runId}: ${error.message}`)
  }
}

async function markRunFailed(runId: string, executionToken: string): Promise<void> {
  const { error } = await getDb()
    .from("runs")
    .update({
      status: "failed",
      active_status: null,
      active_execution_token: null,
      active_lease_expires_at: null,
    })
    .eq("id", runId)
    .eq("active_execution_token", executionToken)

  if (error) {
    logger.warn(`Failed to mark run ${runId} as failed: ${error.message}`)
  }
}

export async function executeRunStartJob(job: RunStartJob): Promise<void> {
  const claim = await claimRunnerJob(job)
  if (claim.status === "busy") {
    throw new RunnerJobBusyError(job.jobId)
  }
  if (claim.status === "terminal") {
    logger.info(`Skipping terminal runner job ${job.jobId}`)
    return
  }
  const claimToken = claim.claimToken

  if (claim.targetStatus === "stopping") {
    const message = "Run stopped by user."
    await markRunnerJobFailed(job, message, false, claimToken)
    await markRunFailed(job.runId, job.executionToken)
    await clearRunActiveStatus(job.runId, job.executionToken)
    wsManager.broadcast({
      type: "run_stopped",
      runId: job.runId,
      message,
    })
    return
  }

  const stopPolling = startDurableStopPolling(job.runId)
  const stopLeaseRenewal = startRunnerJobLeaseRenewal(job, claimToken, job.runId)
  let failureMessage: string | null = null
  let retryJob = false
  try {
    const userKeys = await fetchAllUserKeys(job.userId)

    wsManager.broadcast({
      type: "run_started",
      runId: job.runId,
      provider: job.provider,
      benchmark: job.benchmark,
    })

    await orchestrator.run({
      provider: job.provider,
      benchmark: job.benchmark,
      runId: job.runId,
      judgeModel: job.judgeModel,
      userId: job.userId,
      userKeys,
      limit: job.limit,
      sampling: job.sampling,
      concurrency: job.concurrency,
      searchEffort: job.searchEffort,
      force: false,
      phases: job.fromPhase
        ? (await import("../types/checkpoint")).getPhasesFromPhase(job.fromPhase)
        : undefined,
    })

    const finalCheckpoint = await orchestrator.getCheckpointManager().load(job.runId)
    const finalStatus = finalCheckpoint?.status || "completed"

    if (finalStatus === "completed") {
      try {
        await autoAddToLeaderboard(job.runId, job.userId)
      } catch (error) {
        logger.warn(
          `Failed to auto-add run ${job.runId} to leaderboard: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }

    wsManager.broadcast({
      type: "run_finished",
      runId: job.runId,
      status: finalStatus,
    })
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Run ${job.runId} failed: ${failureMessage}`)
  } finally {
    try {
      if (failureMessage) {
        const result = await markRunnerJobFailed(
          job,
          failureMessage,
          isRetryableFailure(failureMessage),
          claimToken
        )
        retryJob = result === "retry"
        if (!retryJob) {
          await markRunFailed(job.runId, job.executionToken)
          wsManager.broadcast({
            type: failureMessage.includes("stopped by user") ? "run_stopped" : "error",
            runId: job.runId,
            message: failureMessage,
          })
        }
      } else {
        await markRunnerJobCompleted(job, claimToken)
      }
    } finally {
      stopLeaseRenewal()
      stopPolling()
      if (retryJob) {
        await renewQueuedRetryFence(job)
      } else {
        await clearRunActiveStatus(job.runId, job.executionToken)
      }
    }
    if (retryJob) {
      throw new RunnerJobRetryableError(job.jobId, failureMessage)
    }
  }
}

export async function executeCompareJob(job: CompareExecuteJob): Promise<void> {
  const claim = await claimRunnerJob(job)
  if (claim.status === "busy") {
    throw new RunnerJobBusyError(job.jobId)
  }
  if (claim.status === "terminal") {
    logger.info(`Skipping terminal runner job ${job.jobId}`)
    return
  }
  const claimToken = claim.claimToken

  if (claim.targetStatus === "stopping") {
    const message = "Comparison stopped by user."
    await markRunnerJobFailed(job, message, false, claimToken)
    await batchManager.releaseComparisonLease(job.compareId, job.leaseToken)
    wsManager.broadcast({
      type: "compare_stopping",
      compareId: job.compareId,
    })
    return
  }

  const stopLeaseRenewal = startRunnerJobLeaseRenewal(job, claimToken)
  let failureMessage: string | null = null
  let retryJob = false
  try {
    const userKeys = job.manifest.userId
      ? await fetchAllUserKeys(job.manifest.userId)
      : undefined

    await batchManager.executeRuns(job.manifest, userKeys, job.leaseToken)

    wsManager.broadcast({
      type: "compare_complete",
      compareId: job.compareId,
    })
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error)
    logger.error(`Comparison ${job.compareId} failed: ${failureMessage}`)
  } finally {
    try {
      if (failureMessage) {
        const result = await markRunnerJobFailed(
          job,
          failureMessage,
          isRetryableFailure(failureMessage),
          claimToken
        )
        retryJob = result === "retry"
        if (!retryJob) {
          wsManager.broadcast({
            type: "error",
            compareId: job.compareId,
            message: failureMessage,
          })
        }
      } else {
        await markRunnerJobCompleted(job, claimToken)
      }
    } finally {
      stopLeaseRenewal()
      if (retryJob) {
        await renewQueuedRetryFence(job)
      } else {
        await batchManager.releaseComparisonLease(job.compareId, job.leaseToken)
      }
    }
    if (retryJob) {
      throw new RunnerJobRetryableError(job.jobId, failureMessage)
    }
  }
}

export class RunnerJobBusyError extends Error {
  constructor(readonly jobId: string) {
    super(`Runner job ${jobId} is still executing`)
    this.name = "RunnerJobBusyError"
  }
}

export class RunnerJobRetryableError extends Error {
  constructor(readonly jobId: string, causeMessage: string | null) {
    super(`Runner job ${jobId} failed retryably${causeMessage ? `: ${causeMessage}` : ""}`)
    this.name = "RunnerJobRetryableError"
  }
}

export async function executeRunnerMessage(message: RunnerMessage): Promise<RunnerExecutionResult> {
  if (message.kind === "run.start") {
    await executeRunStartJob(message)
    return "processed"
  }
  if (message.kind === "task.execute") {
    throw new Error("Task messages must be dispatched with executeRunnerTask")
  }
  await executeCompareJob(message)
  return "processed"
}

export function getRunnerBusyRetryDelaySeconds(): number {
  return BUSY_RETRY_DELAY_SECONDS
}
