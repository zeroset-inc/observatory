import { describe, expect, test } from "bun:test"
import { searchQuestion } from "./search"
import { TaskCancelledError } from "../taskGuard"
import type { RunCheckpoint } from "../../types/checkpoint"
import type { Provider } from "../../types/provider"
import type { UnifiedQuestion } from "../../types/unified"
import type { ICheckpointManager } from "../checkpoint"

function createCheckpoint(): RunCheckpoint {
  return {
    runId: "run-1",
    dataSourceRunId: "run-1",
    status: "running",
    provider: "mem0",
    benchmark: "locomo",
    judge: "openai:gpt-4o-mini",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    questions: {
      q1: {
        questionId: "q1",
        containerTag: "q1-run-1",
        question: "What happened?",
        groundTruth: "Something",
        questionType: "single-hop",
        phases: {
          ingest: { status: "completed", completedSessions: [] },
          indexing: { status: "completed" },
          search: { status: "pending" },
          evaluate: { status: "pending" },
        },
      },
    },
  }
}

describe("searchQuestion", () => {
  test("rethrows task cancellation without marking the phase failed", async () => {
    const checkpoint = createCheckpoint()
    const updates: Array<Record<string, unknown>> = []
    const checkpointManager = {
      getPhaseStatus(run: RunCheckpoint, questionId: string, phase: any) {
        return run.questions[questionId].phases[phase].status
      },
      updatePhase(_run: RunCheckpoint, _questionId: string, _phase: any, update: Record<string, unknown>) {
        updates.push(update)
      },
    } as unknown as ICheckpointManager
    const provider = {
      search: async () => [{ id: "result-1" }],
    } as unknown as Provider
    const question = {
      questionId: "q1",
      question: "What happened?",
      groundTruth: "Something",
      questionType: "single-hop",
    } as UnifiedQuestion
    let checks = 0

    await expect(
      searchQuestion(provider, question, checkpoint, checkpointManager, {
        assertActive() {
          checks++
          if (checks > 2) throw new TaskCancelledError("stopped")
        },
      })
    ).rejects.toBeInstanceOf(TaskCancelledError)

    expect(updates.some((update) => update.status === "failed")).toBe(false)
  })
})
