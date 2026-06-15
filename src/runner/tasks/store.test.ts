import { describe, expect, test } from "bun:test"
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
    return { results: [] }
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
})
