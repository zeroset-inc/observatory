import type { ProviderName } from "../types/provider"
import type { BenchmarkName } from "../types/benchmark"
import type { PhaseId, SamplingConfig } from "../types/checkpoint"
import type { ConcurrencyConfig } from "../types/concurrency"
import type { CompareManifest } from "../orchestrator/batch"
import type { RunnerTaskMessage } from "./tasks/types"

export interface RunStartJob {
  kind: "run.start"
  jobId: string
  executionToken: string
  runId: string
  provider: ProviderName
  benchmark: BenchmarkName
  judgeModel: string
  userId: string
  limit?: number
  sampling?: SamplingConfig
  concurrency?: ConcurrencyConfig
  searchEffort?: "auto" | "low" | "medium" | "high"
  force?: boolean
  fromPhase?: PhaseId
}

export interface CompareExecuteJob {
  kind: "compare.execute"
  jobId: string
  executionToken: string
  compareId: string
  manifest: CompareManifest
  leaseToken: string
}

export type RunnerMessage = RunStartJob | CompareExecuteJob | RunnerTaskMessage
