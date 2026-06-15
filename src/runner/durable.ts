import { batchManager } from "../orchestrator/batch"
import { setRuntimeEnv, type ObservatoryEnv } from "../server/runtime"
import type { RunnerMessage, RunStartJob, CompareExecuteJob } from "./messages"
import { createAndEnqueueRunBootstrap, createAndEnqueueTask } from "./tasks/scheduler"
import { RunnerTaskStore } from "./tasks/store"
import { RUN_LEASE_TTL_MS } from "./constants"

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

function createJobId(kind: RunnerMessage["kind"], targetId: string): string {
  return `${kind}:${targetId}:${crypto.randomUUID()}`
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
