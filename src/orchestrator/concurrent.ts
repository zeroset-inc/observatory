import { logger } from "../utils/logger"
import { isRunStopRequested } from "../server/runControl"

export interface ConcurrentTaskContext<T> {
  item: T
  index: number
  total: number
}

export interface ConcurrentExecutionOptions<T, R> {
  items: T[]
  concurrency: number
  rateLimitMs: number
  runId: string
  phaseName: string
  executeTask: (context: ConcurrentTaskContext<T>) => Promise<R>
  onBatchStart?: (batchIndex: number, batchSize: number) => void
  onBatchComplete?: (batchIndex: number, results: R[]) => void
  onTaskComplete?: (context: ConcurrentTaskContext<T>, result: R) => void
  onError?: (context: ConcurrentTaskContext<T>, error: Error) => void
}

export class ConcurrentExecutor {
  /**
   * Execute tasks concurrently in batches with rate limiting
   * Throws on first error (fail-fast), but ensures in-flight operations complete
   */
  static async executeBatched<T, R>(options: ConcurrentExecutionOptions<T, R>): Promise<R[]> {
    const {
      items,
      concurrency,
      rateLimitMs,
      runId,
      phaseName,
      executeTask,
      onTaskComplete,
      onError,
    } = options

    if (items.length === 0) return []
    const results: R[] = new Array(items.length)
    let nextIndex = 0
    let activeTasks = 0
    let hasError = false

    logger.info(
      `[${phaseName}] Processing ${items.length} items with concurrency ${concurrency} (pooled)`
    )

    return new Promise((resolve, reject) => {
      const runNext = async () => {
        if (hasError) return

        if (await isRunStopRequested(runId)) {
          if (activeTasks === 0 && !hasError) {
            reject(new Error(`Run stopped by user.`))
          }
          return
        }

        if (nextIndex >= items.length) {
          if (activeTasks === 0 && !hasError) {
            resolve(results)
          }
          return
        }

        const index = nextIndex++
        activeTasks++
        const context = { item: items[index], index, total: items.length }

        try {
          const result = await executeTask(context)
          results[index] = result
          onTaskComplete?.(context, result)
        } catch (error) {
          hasError = true
          const err = error instanceof Error ? error : new Error(String(error))
          onError?.(context, err)
          reject(err)
          return
        } finally {
          activeTasks--
          if (rateLimitMs > 0 && nextIndex < items.length && !hasError) {
            setTimeout(runNext, rateLimitMs)
          } else {
            runNext()
          }
        }
      }

      // Start the initial set of concurrent tasks
      const initialBatch = Math.min(concurrency, items.length)
      for (let i = 0; i < initialBatch; i++) {
        runNext()
      }
    })
  }

  /**
   * Simple concurrent execution without batching (for phases without rate limits)
   */
  static async execute<T, R>(
    items: T[],
    concurrency: number,
    runId: string,
    phaseName: string,
    executeTask: (context: ConcurrentTaskContext<T>) => Promise<R>
  ): Promise<R[]> {
    return this.executeBatched({
      items,
      concurrency,
      rateLimitMs: 0,
      runId,
      phaseName,
      executeTask,
    })
  }
}
