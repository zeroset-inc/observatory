import { describe, expect, test } from "bun:test"
import { enqueueRunPhaseTasks } from "./scheduler"
import { RunnerTaskStore } from "./store"

class FakeStatement {
  bindings: unknown[] = []

  constructor(
    private readonly db: FakeD1,
    readonly sql: string
  ) {}

  bind(...bindings: unknown[]): this {
    this.bindings = bindings
    return this
  }

  async first() {
    return this.db.firstRows.shift() ?? null
  }

  async all() {
    return { results: this.db.allRows.shift() ?? [] }
  }

  async run() {
    return {
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: 1,
        last_row_id: 0,
        changed_db: true,
        changes: this.db.runChanges.shift() ?? 1,
      },
    }
  }
}

class FakeD1 {
  prepared: FakeStatement[] = []
  firstRows: Record<string, unknown>[] = []
  allRows: Record<string, unknown>[][] = []
  runChanges: number[] = []

  prepare(sql: string): FakeStatement {
    const statement = new FakeStatement(this, sql)
    this.prepared.push(statement)
    return statement
  }
}

describe("RunnerTaskStore", () => {
  test("createTask reports whether the idempotent insert created a new row", async () => {
    const d1 = new FakeD1()
    d1.runChanges = [0]
    d1.firstRows = [{ id: "existing-task" }]
    const store = new RunnerTaskStore(d1 as any)

    const result = await store.createTask({
      jobId: "job-1",
      kind: "run.bootstrap",
      targetType: "run",
      targetId: "run-1",
      runId: "run-1",
      idempotencyKey: "job-1:run.bootstrap",
    })

    expect(result).toEqual({ id: "existing-task", created: false })
  })

  test("terminalizes expired executing task on final attempt instead of returning busy", async () => {
    const d1 = new FakeD1()
    d1.runChanges = [0, 1]
    d1.firstRows = [
      {
        status: "executing",
        attempts: 3,
        max_attempts: 3,
        lease_expires_at: "2000-01-01T00:00:00.000Z",
      },
    ]
    const store = new RunnerTaskStore(d1 as any)

    const claim = await store.claimTask("task-1")

    expect(claim.status).toBe("terminal")
    const terminalUpdate = d1.prepared.find((statement) =>
      statement.sql.includes("attempts >= max_attempts")
    )
    expect(terminalUpdate?.sql).toContain("attempts >= max_attempts")
  })

  test("returns busy for a live executing task", async () => {
    const d1 = new FakeD1()
    d1.runChanges = [0]
    d1.firstRows = [
      {
        status: "executing",
        attempts: 1,
        max_attempts: 3,
        lease_expires_at: "2999-01-01T00:00:00.000Z",
      },
    ]
    const store = new RunnerTaskStore(d1 as any)

    const claim = await store.claimTask("task-1")

    expect(claim.status).toBe("busy")
  })

  test("running fence renewal only succeeds while parent is running", async () => {
    const d1 = new FakeD1()
    const store = new RunnerTaskStore(d1 as any)

    await store.renewRunningRunFence("run-1", "execution-1")
    await store.renewRunningComparisonFence("compare-1", "lease-1")

    expect(d1.prepared[0].sql).toContain("active_status = 'running'")
    expect(d1.prepared[1].sql).toContain("active_status = 'running'")
  })

  test("terminalizes stopped comparison when no runnable comparison tasks remain", async () => {
    const d1 = new FakeD1()
    d1.firstRows = [
      {
        active_status: "stopping",
        active_lease_token: "lease-1",
        active_lease_expires_at: "2999-01-01T00:00:00.000Z",
      },
      { execution_token: "execution-1" },
      { count: 0 },
    ]
    const store = new RunnerTaskStore(d1 as any)

    const terminalized = await store.markStoppedComparisonTerminalIfIdle("compare-1")

    expect(terminalized).toBe(true)
    expect(
      d1.prepared.some((statement) =>
        statement.sql.includes("UPDATE comparisons") &&
        statement.sql.includes("active_lease_token = ?")
      )
    ).toBe(true)
    expect(
      d1.prepared.some((statement) =>
        statement.sql.includes("UPDATE runner_jobs") &&
        statement.sql.includes("WHERE execution_token = ?")
      )
    ).toBe(true)
  })

  test("loads distinct question ids for a runner job", async () => {
    const d1 = new FakeD1()
    d1.allRows = [[{ question_id: "q1" }, { question_id: "q2" }]]
    const store = new RunnerTaskStore(d1 as any)

    const questionIds = await store.getJobQuestionIds("job-1")

    expect(questionIds).toEqual(["q1", "q2"])
    expect(d1.prepared[0].sql).toContain("SELECT DISTINCT question_id")
    expect(d1.prepared[0].bindings).toEqual(["job-1"])
  })

  test("progress increments do not copy retry-subset counts into run aggregates", async () => {
    const d1 = new FakeD1()
    const store = new RunnerTaskStore(d1 as any)

    await store.incrementRunProgress("run-1", "search", "completed")

    expect(
      d1.prepared.some((statement) => statement.sql.includes("UPDATE runs"))
    ).toBe(false)
  })

  test("run terminalization refreshes aggregate counts from questions", async () => {
    const d1 = new FakeD1()
    d1.allRows = [
      [
        {
          phase_ingest: JSON.stringify({ status: "completed" }),
          phase_indexing: JSON.stringify({ status: "completed" }),
          phase_search: JSON.stringify({ status: "pending" }),
          phase_evaluate: JSON.stringify({ status: "pending" }),
        },
        {
          phase_ingest: JSON.stringify({ status: "completed" }),
          phase_indexing: JSON.stringify({ status: "completed" }),
          phase_search: JSON.stringify({ status: "completed" }),
          phase_evaluate: JSON.stringify({ status: "completed", score: 1 }),
        },
      ],
    ]
    const store = new RunnerTaskStore(d1 as any)

    await store.markRunTerminal("run-1", "execution-1", "interrupted", "Stopped")

    const summaryUpdate = d1.prepared.find((statement) =>
      statement.sql.includes("ingested_count = ?")
    )
    const terminalUpdate = d1.prepared.find((statement) =>
      statement.sql.includes("active_execution_token = NULL")
    )
    expect(summaryUpdate?.bindings.slice(0, 7)).toEqual([2, 2, 2, 1, 1, 1, 1])
    expect(terminalUpdate?.bindings[0]).toBe("interrupted")
  })

  test("enqueues retry phase tasks only for the requested question subset", async () => {
    const d1 = new FakeD1()
    const sentMessages: unknown[] = []
    d1.allRows = [
      [
        { question_id: "q1", phase_status: JSON.stringify({ status: "pending" }) },
        { question_id: "q2", phase_status: JSON.stringify({ status: "pending" }) },
        { question_id: "q3", phase_status: JSON.stringify({ status: "pending" }) },
      ],
    ]
    d1.firstRows = [{ id: "task-q1" }, { id: "task-q3" }]
    const store = new RunnerTaskStore(d1 as any)

    await enqueueRunPhaseTasks(
      {
        OBSERVATORY_DB: d1,
        OBSERVATORY_RUNNER_QUEUE: {
          send: async (message: unknown) => {
            sentMessages.push(message)
          },
        },
      } as any,
      store,
      {
        jobId: "job-1",
        runId: "run-1",
        phase: "ingest",
        questionIds: ["q1", "q3"],
        retryCleanup: true,
      }
    )

    const insertBindings = d1.prepared
      .filter((statement) => statement.sql.includes("INSERT INTO runner_tasks"))
      .map((statement) => statement.bindings)

    expect(insertBindings).toHaveLength(2)
    expect(insertBindings.map((bindings) => bindings[7])).toEqual(["q1", "q3"])
    expect(insertBindings.map((bindings) => bindings[9])).toEqual([
      JSON.stringify({ questionId: "q1", retryCleanup: true }),
      JSON.stringify({ questionId: "q3", retryCleanup: true }),
    ])
    expect(sentMessages).toEqual([
      { kind: "task.execute", taskId: "task-q1" },
      { kind: "task.execute", taskId: "task-q3" },
    ])
  })
})
