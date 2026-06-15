import { createServerFetchHandler } from "./server/http"
import { setRuntimeEnv, type ObservatoryEnv } from "./server/runtime"
import {
  executeRunnerMessage,
  getRunnerBusyRetryDelaySeconds,
  RunnerJobBusyError,
  RunnerJobRetryableError,
} from "./runner/execution"
import {
  executeRunnerTask,
} from "./runner/tasks/executor"
import {
  RunnerTaskBusyError,
  RunnerTaskRetryableError,
} from "./runner/tasks/store"
import type { RunnerMessage } from "./runner/messages"

export { RunCoordinator, ComparisonCoordinator } from "./runner/durable"

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

  if (url.pathname.startsWith("/api/runs")) return handleRunsRoutes(req, url, ctx)
  if (url.pathname.startsWith("/api/compare")) return handleCompareRoutes(req, url, ctx)
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

    const response = await fetchHandler(req, {
      upgrade() {
        return false
      },
    })
    return response ?? new Response(null, { status: 101 })
  },

  async queue(
    batch: MessageBatch<RunnerMessage>,
    env: ObservatoryEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    setRuntimeEnv(env)
    for (const message of batch.messages) {
      try {
        if (message.body.kind === "task.execute") {
          await executeRunnerTask(env, message.body)
        } else {
          await executeRunnerMessage(message.body)
        }
        message.ack()
      } catch (error) {
        if (error instanceof RunnerJobBusyError || error instanceof RunnerTaskBusyError) {
          message.retry({ delaySeconds: getRunnerBusyRetryDelaySeconds() })
          continue
        }
        if (error instanceof RunnerJobRetryableError || error instanceof RunnerTaskRetryableError) {
          message.retry({ delaySeconds: getRunnerBusyRetryDelaySeconds() })
          continue
        }
        console.error(
          "[worker.queue] Runner message failed before state was preserved:",
          error instanceof Error ? error.message : String(error)
        )
        message.retry({ delaySeconds: getRunnerBusyRetryDelaySeconds() })
      }
    }
  },
}
