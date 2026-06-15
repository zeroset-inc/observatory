export interface TaskExecutionGuard {
  readonly signal?: AbortSignal
  assertActive(): void
  ensureActive?(): Promise<void>
}

export class TaskCancelledError extends Error {
  constructor(message = "Runner task cancelled") {
    super(message)
    this.name = "TaskCancelledError"
  }
}

export function isTaskCancelledError(error: unknown): error is TaskCancelledError {
  return error instanceof TaskCancelledError || (
    error instanceof Error && error.name === "TaskCancelledError"
  )
}

export function assertTaskActive(guard?: TaskExecutionGuard): void {
  if (!guard) return
  guard.assertActive()
  if (guard.signal?.aborted) {
    throw new TaskCancelledError("Runner task aborted")
  }
}

export async function ensureTaskActive(guard?: TaskExecutionGuard): Promise<void> {
  if (!guard) return
  if (guard.ensureActive) {
    await guard.ensureActive()
    return
  }
  assertTaskActive(guard)
}
