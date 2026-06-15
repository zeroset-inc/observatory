export interface ObservatoryEnv {
  OBSERVATORY_DB: D1Database
  OBSERVATORY_RUNNER_QUEUE?: Queue<import("../runner/tasks/types").RunnerTaskMessage>
  RUN_COORDINATOR?: DurableObjectNamespace
  COMPARE_COORDINATOR?: DurableObjectNamespace
  ASSETS?: Fetcher
  OBSERVATORY_SECRET?: string
  OBSERVATORY_ALLOWED_ORIGINS?: string
  SUPERMEMORY_API_KEY?: string
  SUPERMEMORY_BASE_URL?: string
  MEM0_API_KEY?: string
  ZEP_API_KEY?: string
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  GOOGLE_API_KEY?: string
  NEBULA_API_KEY?: string
  NEBULA_BASE_URL?: string
}

let runtimeEnv: ObservatoryEnv | null = null

export function setRuntimeEnv(env: ObservatoryEnv): void {
  runtimeEnv = env
}

export function getRuntimeEnv(): ObservatoryEnv | null {
  return runtimeEnv
}

export function getRequiredRuntimeEnv(): ObservatoryEnv {
  if (!runtimeEnv) {
    throw new Error("Cloudflare runtime environment has not been initialized")
  }
  return runtimeEnv
}

export function isWorkerRuntime(): boolean {
  return Boolean(runtimeEnv?.OBSERVATORY_DB)
}

export function getEnvValue(name: keyof ObservatoryEnv | string): string | undefined {
  const envValue = runtimeEnv?.[name as keyof ObservatoryEnv]
  if (typeof envValue === "string") return envValue
  if (typeof process !== "undefined") return process.env[name]
  return undefined
}
