import type { PhaseId } from "../../types/checkpoint"

export type RunnerTaskKind =
  | "run.bootstrap"
  | "run.ingest_question"
  | "run.index_question"
  | "run.search_question"
  | "run.evaluate_question"
  | "run.generate_report"
  | "run.finalize"
  | "compare.bootstrap"
  | "compare.aggregate"
  | "leaderboard.publish"

export type RunnerTaskStatus = "queued" | "executing" | "completed" | "failed" | "cancelled"

export type RunTaskPhase = Extract<PhaseId, "ingest" | "indexing" | "search" | "evaluate">

export interface RunnerTask {
  id: string
  jobId: string
  kind: RunnerTaskKind
  targetType: "run" | "comparison"
  targetId: string
  runId: string | null
  compareId: string | null
  questionId: string | null
  phase: RunTaskPhase | null
  payload: Record<string, unknown>
  payloadVersion: number
  status: RunnerTaskStatus
  attempts: number
  maxAttempts: number
  claimToken: string | null
  leaseExpiresAt: string | null
  idempotencyKey: string
  error: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  executionToken: string
}

export interface RunnerTaskCreateInput {
  jobId: string
  kind: RunnerTaskKind
  targetType: "run" | "comparison"
  targetId: string
  runId?: string | null
  compareId?: string | null
  questionId?: string | null
  phase?: RunTaskPhase | null
  payload?: Record<string, unknown>
  maxAttempts?: number
  idempotencyKey: string
  payloadVersion?: number
}

export interface RunnerTaskMessage {
  kind: "task.execute"
  taskId: string
}

export type RunnerTaskClaim =
  | { status: "claimed"; task: RunnerTask; claimToken: string }
  | { status: "busy" }
  | { status: "terminal"; task?: RunnerTask }
