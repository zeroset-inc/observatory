import { createServerFetchHandler } from "./server/http"
import { setRuntimeEnv, type ObservatoryEnv } from "./server/runtime"
import { executeRunnerTask } from "./runner/tasks/executor"
import { RunnerTaskBusyError, RunnerTaskRetryableError } from "./runner/tasks/store"
import type { RunnerTaskMessage } from "./runner/tasks/types"
import { sweepRunner } from "./runner/sweeper"

export { RunCoordinator, ComparisonCoordinator } from "./runner/durable"

const RUNNER_QUEUE_RETRY_DELAY_SECONDS = 60
const LEGACY_QUEUE_FAILURE = "Legacy coarse runner message is no longer supported"

type LegacyRunnerMessage = {
  kind?: unknown
  jobId?: unknown
  executionToken?: unknown
  runId?: unknown
  compareId?: unknown
  leaseToken?: unknown
}

function asLegacyRunnerMessage(value: unknown): LegacyRunnerMessage | null {
  return value && typeof value === "object" ? (value as LegacyRunnerMessage) : null
}

async function markLegacyRunnerMessageFailed(
  env: ObservatoryEnv,
  body: unknown
): Promise<boolean> {
  const legacy = asLegacyRunnerMessage(body)
  if (!legacy || (legacy.kind !== "run.start" && legacy.kind !== "compare.execute")) {
    return false
  }
  if (typeof legacy.jobId !== "string" || typeof legacy.executionToken !== "string") {
    return false
  }

  const timestamp = new Date().toISOString()
  await env.OBSERVATORY_DB
    .prepare(
      `UPDATE runner_jobs
       SET status = 'failed',
           error = ?,
           completed_at = ?,
           updated_at = ?
       WHERE id = ?
         AND execution_token = ?
         AND status IN ('queued', 'executing')`
    )
    .bind(LEGACY_QUEUE_FAILURE, timestamp, timestamp, legacy.jobId, legacy.executionToken)
    .run()

  if (legacy.kind === "run.start" && typeof legacy.runId === "string") {
    await env.OBSERVATORY_DB
      .prepare(
        `UPDATE runs
         SET status = 'failed',
             active_status = NULL,
             active_execution_token = NULL,
             active_lease_expires_at = NULL,
             updated_at = ?
         WHERE id = ?
           AND active_execution_token = ?`
      )
      .bind(timestamp, legacy.runId, legacy.executionToken)
      .run()
    return true
  }

  if (
    legacy.kind === "compare.execute" &&
    typeof legacy.compareId === "string" &&
    typeof legacy.leaseToken === "string"
  ) {
    await env.OBSERVATORY_DB
      .prepare(
        `UPDATE comparisons
         SET active_status = NULL,
             active_lease_expires_at = NULL,
             active_lease_token = NULL,
             updated_at = ?
         WHERE id = ?
           AND active_lease_token = ?`
      )
      .bind(timestamp, legacy.compareId, legacy.leaseToken)
      .run()
    return true
  }

  return true
}

async function checkReadiness(): Promise<void> {
  const { db } = await import("./server/db")
  const { error } = await db.from("runs").select("id").limit(1)
  if (error) throw error
}

async function handleApiRequest(
  req: Request,
  url: URL,
  ctx: ExecutionContext
): Promise<Response | null> {
  const [
    { handleRunsRoutes },
    { handleBenchmarksRoutes },
    { handleLeaderboardRoutes },
    { handleCompareRoutes },
    { handleAuthRoutes },
  ] = await Promise.all([
    import("./server/routes/runs"),
    import("./server/routes/benchmarks"),
    import("./server/routes/leaderboard"),
    import("./server/routes/compare"),
    import("./server/routes/auth"),
  ])

  if (url.pathname.startsWith("/api/runs")) return handleRunsRoutes(req, url)
  if (url.pathname.startsWith("/api/compare")) return handleCompareRoutes(req, url)
  if (
    url.pathname.startsWith("/api/benchmarks") ||
    url.pathname.startsWith("/api/providers") ||
    url.pathname === "/api/models" ||
    url.pathname === "/api/downloads"
  ) {
    return handleBenchmarksRoutes(req, url)
  }
  if (url.pathname.startsWith("/api/leaderboard")) return handleLeaderboardRoutes(req, url)
  if (url.pathname.startsWith("/api/auth")) return handleAuthRoutes(req, url)

  return null
}

async function serveStaticUi(req: Request, env: ObservatoryEnv): Promise<Response | null> {
  if (!env.ASSETS) return null
  const response = await env.ASSETS.fetch(req)
  if (response.status !== 404) return response

  const url = new URL(req.url)
  if (url.pathname.startsWith("/api/")) return null

  const indexUrl = new URL(req.url)
  indexUrl.pathname = "/"
  return env.ASSETS.fetch(new Request(indexUrl, req))
}

export default {
  async fetch(req: Request, env: ObservatoryEnv, ctx: ExecutionContext): Promise<Response> {
    setRuntimeEnv(env)
    const fetchHandler = createServerFetchHandler({
      checkReadiness,
      handleApiRequest: (request, url) => handleApiRequest(request, url, ctx),
      serveStaticUi: () => serveStaticUi(req, env),
    })

    return fetchHandler(req)
  },

  async queue(
    batch: MessageBatch<RunnerTaskMessage>,
    env: ObservatoryEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    setRuntimeEnv(env)
    for (const message of batch.messages) {
      try {
        const body = message.body as unknown
        if (asLegacyRunnerMessage(body)?.kind !== "task.execute") {
          if (await markLegacyRunnerMessageFailed(env, body)) {
            console.error("[worker.queue] Terminalized legacy runner message:", body)
            message.ack()
            continue
          }
          throw new Error(`Unsupported runner message: ${JSON.stringify(body)}`)
        }
        await executeRunnerTask(env, message.body)
        message.ack()
      } catch (error) {
        if (error instanceof RunnerTaskBusyError || error instanceof RunnerTaskRetryableError) {
          message.retry({ delaySeconds: RUNNER_QUEUE_RETRY_DELAY_SECONDS })
          continue
        }
        console.error(
          "[worker.queue] Runner message failed before state was preserved:",
          error instanceof Error ? error.message : String(error)
        )
        message.retry({ delaySeconds: RUNNER_QUEUE_RETRY_DELAY_SECONDS })
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: ObservatoryEnv, _ctx: ExecutionContext): Promise<void> {
    setRuntimeEnv(env)
    const result = await sweepRunner(env)
    console.log("[worker.scheduled] Runner sweep complete:", result)
  },
}
