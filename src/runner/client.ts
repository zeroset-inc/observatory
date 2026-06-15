import { getRuntimeEnv, type ObservatoryEnv } from "../server/runtime"
import type { RunnerMessage, RunStartJob, CompareExecuteJob } from "./messages"

type DurableCommandResult<T = unknown> = {
  ok: boolean
  status: number
  data: T
}

function hasDurableRunner(env: ObservatoryEnv | null): env is ObservatoryEnv & {
  OBSERVATORY_RUNNER_QUEUE: Queue<RunnerMessage>
  RUN_COORDINATOR: DurableObjectNamespace
  COMPARE_COORDINATOR: DurableObjectNamespace
} {
  return Boolean(env?.OBSERVATORY_RUNNER_QUEUE && env.RUN_COORDINATOR && env.COMPARE_COORDINATOR)
}

async function sendCommand<T>(
  namespace: DurableObjectNamespace,
  objectName: string,
  path: string,
  body?: unknown
): Promise<DurableCommandResult<T>> {
  const id = namespace.idFromName(objectName)
  const stub = namespace.get(id)
  const response = await stub.fetch(`https://observatory.internal${path}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  })
  const data = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, data: data as T }
}

export function durableRunnerAvailable(): boolean {
  return hasDurableRunner(getRuntimeEnv())
}

export async function enqueueRunStart(
  job: Omit<RunStartJob, "jobId" | "executionToken">
): Promise<DurableCommandResult> {
  const env = getRuntimeEnv()
  if (!hasDurableRunner(env)) {
    return { ok: false, status: 503, data: { error: "Durable runner is not configured" } }
  }
  return sendCommand(env.RUN_COORDINATOR, job.runId, "/start", job)
}

export async function requestRunStop(runId: string): Promise<DurableCommandResult> {
  const env = getRuntimeEnv()
  if (!hasDurableRunner(env)) {
    return { ok: false, status: 503, data: { error: "Durable runner is not configured" } }
  }
  return sendCommand(env.RUN_COORDINATOR, runId, `/stop?id=${encodeURIComponent(runId)}`)
}

export async function beginRunDelete(runId: string): Promise<DurableCommandResult> {
  const env = getRuntimeEnv()
  if (!hasDurableRunner(env)) {
    return { ok: false, status: 503, data: { error: "Durable runner is not configured" } }
  }
  return sendCommand(env.RUN_COORDINATOR, runId, `/begin-delete?id=${encodeURIComponent(runId)}`)
}

export async function releaseRunDelete(runId: string): Promise<void> {
  const env = getRuntimeEnv()
  if (!hasDurableRunner(env)) return
  await sendCommand(env.RUN_COORDINATOR, runId, `/release-delete?id=${encodeURIComponent(runId)}`)
}

export async function enqueueCompareExecution(
  job: Omit<CompareExecuteJob, "jobId" | "executionToken" | "leaseToken">
): Promise<DurableCommandResult<{ leaseToken?: string; error?: string }>> {
  const env = getRuntimeEnv()
  if (!hasDurableRunner(env)) {
    return { ok: false, status: 503, data: { error: "Durable runner is not configured" } }
  }
  return sendCommand(env.COMPARE_COORDINATOR, job.compareId, "/start", job)
}

export async function requestCompareStop(compareId: string): Promise<DurableCommandResult> {
  const env = getRuntimeEnv()
  if (!hasDurableRunner(env)) {
    return { ok: false, status: 503, data: { error: "Durable runner is not configured" } }
  }
  return sendCommand(env.COMPARE_COORDINATOR, compareId, `/stop?id=${encodeURIComponent(compareId)}`)
}

export async function deleteComparison(compareId: string): Promise<DurableCommandResult> {
  const env = getRuntimeEnv()
  if (!hasDurableRunner(env)) {
    return { ok: false, status: 503, data: { error: "Durable runner is not configured" } }
  }
  return sendCommand(env.COMPARE_COORDINATOR, compareId, `/delete?id=${encodeURIComponent(compareId)}`)
}
