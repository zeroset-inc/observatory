import { handleRunsRoutes } from "./routes/runs"
import { handleBenchmarksRoutes } from "./routes/benchmarks"
import { handleLeaderboardRoutes } from "./routes/leaderboard"
import { handleCompareRoutes } from "./routes/compare"
import { handleAuthRoutes } from "./routes/auth"
import { AuthError } from "./middleware/auth"
import { wsManager } from "./wsManager"
import {
  recoverStaledRuns,
  activeRuns,
  requestStop,
  startRun,
  endRun,
  setCompletion,
} from "./runState"
import { orchestrator } from "../orchestrator"
import { fetchAllUserKeys } from "./services/apiKeys"
import { getProviderConfig, getJudgeConfig } from "../utils/config"
import type { ProviderName } from "../types/provider"
import type { BenchmarkName } from "../types/benchmark"
import { runMigrations } from "./db/migrate"
import { logger } from "../utils/logger"
import { join } from "path"
import { Subprocess } from "bun"
import { createServerFetchHandler } from "./http"

export interface ServerOptions {
  port: number
  open?: boolean
}

const isProduction = process.env.NODE_ENV === "production"
let uiProcess: Subprocess | null = null
const D1_INTERRUPTED_RUN_ID_CHUNK_SIZE = 97

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

/**
 * Auto-resume runs that were gracefully interrupted by a previous shutdown.
 * Loads checkpoint data to reconstruct run parameters and restarts them.
 */
async function resumeInterruptedRuns(): Promise<void> {
  const { db } = require("./db")

  const { data: interrupted, error } = await db
    .from("runs")
    .select("id, provider, benchmark, judge, user_id, sampling, concurrency")
    .eq("status", "interrupted")

  if (error) {
    logger.warn(`Failed to query interrupted runs: ${error.message}`)
    return
  }

  if (!interrupted || interrupted.length === 0) return

  logger.info(`Auto-resuming ${interrupted.length} interrupted run(s)...`)

  const checkpointManager = orchestrator.getCheckpointManager()

  for (const run of interrupted) {
    try {
      const userKeys = run.user_id ? await fetchAllUserKeys(run.user_id) : undefined

      startRun(run.id, run.benchmark, run.user_id)

      const completion = orchestrator
        .run({
          provider: run.provider as ProviderName,
          benchmark: run.benchmark as BenchmarkName,
          runId: run.id,
          judgeModel: run.judge,
          userId: run.user_id,
          userKeys,
          sampling: run.sampling,
          concurrency: run.concurrency,
        })
        .then(async () => {
          const finalCheckpoint = await checkpointManager.load(run.id)
          wsManager.broadcast({
            type: "run_finished",
            runId: run.id,
            status: finalCheckpoint?.status || "completed",
          })
        })
        .catch(async (err: Error) => {
          logger.error(`Resumed run ${run.id} failed: ${err.message}`)
          const checkpoint = await checkpointManager.load(run.id)
          if (checkpoint) {
            checkpointManager.updateStatus(checkpoint, "failed")
          }
          wsManager.broadcast({ type: "error", runId: run.id, message: err.message })
        })
        .finally(() => {
          endRun(run.id)
        })
      setCompletion(run.id, completion)

      logger.info(`Resumed run ${run.id} (${run.provider}/${run.benchmark})`)
    } catch (e) {
      logger.error(`Failed to resume run ${run.id}: ${e}`)
      // Mark as failed so it doesn't retry on next startup
      await db.from("runs").update({ status: "failed" }).eq("id", run.id)
    }
  }
}

async function checkReadiness(): Promise<void> {
  const { db } = await import("./db")
  const { error } = await db
    .from("runs")
    .select("id")
    .limit(1)
    .abortSignal(AbortSignal.timeout(2000))

  if (error) {
    throw error
  }
}

async function handleApiRequest(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname.startsWith("/api/runs")) {
    return handleRunsRoutes(req, url)
  }
  if (url.pathname.startsWith("/api/compare")) {
    return handleCompareRoutes(req, url)
  }
  if (
    url.pathname.startsWith("/api/benchmarks") ||
    url.pathname.startsWith("/api/providers") ||
    url.pathname === "/api/models" ||
    url.pathname === "/api/downloads"
  ) {
    return handleBenchmarksRoutes(req, url)
  }
  if (url.pathname.startsWith("/api/leaderboard")) {
    return handleLeaderboardRoutes(req, url)
  }
  if (url.pathname.startsWith("/api/auth")) {
    return handleAuthRoutes(req, url)
  }

  return null
}

async function serveStaticUi(url: URL): Promise<Response | null> {
  if (!isProduction) {
    return null
  }

  const uiDist = join(import.meta.dir, "../../ui/dist")
  const filePath = url.pathname === "/" ? "/index.html" : url.pathname
  const file = Bun.file(join(uiDist, filePath))
  if (await file.exists()) {
    return new Response(file)
  }

  const indexFile = Bun.file(join(uiDist, "index.html"))
  if (await indexFile.exists()) {
    return new Response(indexFile)
  }

  return null
}

export async function startServer(options: ServerOptions): Promise<void> {
  const { port, open = true } = options

  // D1 migrations are applied by Wrangler; this hook is retained for the legacy
  // Bun server path and intentionally does not apply schema changes at runtime.
  try {
    await runMigrations()
  } catch (e) {
    logger.error(`Migration failed, continuing startup: ${e instanceof Error ? e.message : e}`)
  }

  // Crash recovery: reset stale active_status in DB for runs that were running when server died
  await recoverStaledRuns()

  // Auto-resume runs that were gracefully interrupted by a previous shutdown
  await resumeInterruptedRuns()

  const fetchHandler = createServerFetchHandler({
    checkReadiness,
    getErrorStatus(error) {
      return error instanceof AuthError ? error.status : 500
    },
    handleApiRequest,
    serveStaticUi,
  })

  const server = Bun.serve({
    port,

    fetch: fetchHandler,

    websocket: {
      open(ws) {
        wsManager.addClient(ws)
      },
      message(ws, message) {
        wsManager.handleMessage(ws, message)
      },
      close(ws) {
        wsManager.removeClient(ws)
      },
    },
  })

  logger.success(`Observatory API server running at http://localhost:${port}`)
  logger.info(`WebSocket available at ws://localhost:${port}/ws`)

  if (isProduction) {
    logger.info("Production mode: serving static UI from ui/dist")
  } else {
    // Start UI dev server in development
    const uiDir = join(process.cwd(), "ui")
    const uiPort = 3003

    uiProcess = Bun.spawn(["bun", "run", "dev"], {
      cwd: uiDir,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        VITE_API_URL: `http://localhost:${port}`,
      },
    })

    logger.success(`UI dev server starting at http://localhost:${uiPort}`)

    if (open) {
      const openCommand =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
      Bun.spawn([openCommand, `http://localhost:${uiPort}`])
    }
  }

  // Handle graceful shutdown
  const SHUTDOWN_TIMEOUT_MS = 30_000
  let shuttingDown = false

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true

    const runIds = [...activeRuns.keys()]
    if (runIds.length > 0) {
      logger.info(`Graceful shutdown: stopping ${runIds.length} active run(s)...`)
      for (const runId of runIds) {
        requestStop(runId)
      }

      // Wait for runs to finish and checkpoint, with a hard timeout
      const waitForDrain = new Promise<void>((resolve) => {
        const check = () => {
          if (activeRuns.size === 0) return resolve()
          setTimeout(check, 200)
        }
        check()
      })

      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (activeRuns.size > 0) {
            logger.warn(`Shutdown timeout: ${activeRuns.size} run(s) still active, forcing exit.`)
          }
          resolve()
        }, SHUTDOWN_TIMEOUT_MS)
      })

      await Promise.race([waitForDrain, timeout])

      // Flush any remaining checkpoint writes
      await orchestrator.getCheckpointManager().flush()

      // Only mark runs that are still active (didn't finish during drain) as interrupted
      const stillActive = runIds.filter((id) => activeRuns.has(id))
      if (stillActive.length > 0) {
        const { db } = require("./db")
        let interruptedCount = 0
        for (const runIdChunk of chunks(stillActive, D1_INTERRUPTED_RUN_ID_CHUNK_SIZE)) {
          const { error: updateError } = await db
            .from("runs")
            .update({ status: "interrupted", active_status: null })
            .in("id", runIdChunk)
            .neq("status", "completed")
          if (updateError) {
            logger.error(`Failed to mark runs as interrupted: ${updateError.message}`)
          } else {
            interruptedCount += runIdChunk.length
          }
        }
        if (interruptedCount > 0) {
          logger.info(`${interruptedCount} run(s) marked as interrupted for auto-resume.`)
        }
      }
    }

    if (uiProcess) {
      logger.info("Shutting down UI server...")
      uiProcess.kill()
      uiProcess = null
    }

    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
