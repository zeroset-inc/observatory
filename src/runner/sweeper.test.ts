import { describe, expect, test } from "bun:test"
import { sweepRunner } from "./sweeper"

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

describe("sweepRunner", () => {
  test("expired final-attempt run tasks release the parent run fence", async () => {
    const d1 = new FakeD1()
    d1.allRows = [
      [],
      [{ id: "task-1" }],
      [
        {
          phase_ingest: JSON.stringify({ status: "completed" }),
          phase_indexing: JSON.stringify({ status: "completed" }),
          phase_search: JSON.stringify({ status: "failed" }),
          phase_evaluate: JSON.stringify({ status: "pending" }),
        },
      ],
      [],
    ]
    d1.firstRows = [
      {
        id: "task-1",
        job_id: "job-1",
        kind: "run.search_question",
        target_type: "run",
        target_id: "run-1",
        run_id: "run-1",
        compare_id: null,
        question_id: "q1",
        phase: "search",
        payload: "{}",
        payload_version: 1,
        status: "executing",
        attempts: 3,
        max_attempts: 3,
        claim_token: "claim-1",
        lease_expires_at: "2000-01-01T00:00:00.000Z",
        idempotency_key: "job-1:search:q1",
        error: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        completed_at: null,
        execution_token: "execution-1",
      },
    ]
    const sentMessages: unknown[] = []

    const result = await sweepRunner({
      OBSERVATORY_DB: d1,
      OBSERVATORY_RUNNER_QUEUE: {
        send: async (message: unknown) => {
          sentMessages.push(message)
        },
      },
    } as any)

    expect(result.failedExpiredTasks).toBe(1)
    expect(sentMessages).toEqual([])
    expect(
      d1.prepared.some((statement) =>
        statement.sql.includes("UPDATE run_phase_progress") &&
        statement.sql.includes("failed = failed + 1")
      )
    ).toBe(true)
    expect(
      d1.prepared.some((statement) =>
        statement.sql.includes("UPDATE runs") &&
        statement.sql.includes("active_execution_token = NULL")
      )
    ).toBe(true)
    expect(
      d1.prepared.some((statement) =>
        statement.sql.includes("UPDATE runner_jobs") &&
        statement.sql.includes("WHERE execution_token = ?")
      )
    ).toBe(true)
  })

  test("terminal parent runs repair stale queued runner jobs", async () => {
    const d1 = new FakeD1()
    d1.allRows = [
      [],
      [],
      [],
      [],
      [],
      [{ id: "job-1", run_status: "interrupted" }],
      [],
    ]

    const result = await sweepRunner({
      OBSERVATORY_DB: d1,
      OBSERVATORY_RUNNER_QUEUE: {
        send: async () => {},
      },
    } as any)

    expect(result.repairedTerminalJobs).toBe(1)
    expect(
      d1.prepared.some((statement) =>
        statement.sql.includes("UPDATE runner_jobs") &&
        statement.sql.includes("lease_expires_at = ?") &&
        statement.bindings.includes("Parent run is already terminal")
      )
    ).toBe(true)
  })

  test("stopped parents terminalize even when runnable tasks were already cancelled", async () => {
    const d1 = new FakeD1()
    d1.allRows = [
      [],
      [],
      [],
      [{ id: "run-1" }],
      [],
      [{ id: "compare-1" }],
      [],
      [],
      [],
    ]
    d1.firstRows = [
      {
        status: "running",
        active_status: "stopping",
        active_execution_token: "execution-1",
        active_lease_expires_at: "2999-01-01T00:00:00.000Z",
      },
      { count: 0 },
      {
        active_status: "stopping",
        active_lease_token: "lease-1",
        active_lease_expires_at: "2999-01-01T00:00:00.000Z",
      },
      { execution_token: "compare-execution-1" },
      { count: 0 },
    ]

    const result = await sweepRunner({
      OBSERVATORY_DB: d1,
      OBSERVATORY_RUNNER_QUEUE: {
        send: async () => {},
      },
    } as any)

    expect(result.stoppedRuns).toBe(1)
    expect(result.stoppedComparisons).toBe(1)
    expect(
      d1.prepared.some((statement) =>
        statement.sql.includes("FROM runs") &&
        statement.sql.includes("active_status = 'stopping'") &&
        !statement.sql.includes("JOIN runner_tasks")
      )
    ).toBe(true)
    expect(
      d1.prepared.some((statement) =>
        statement.sql.includes("FROM comparisons") &&
        statement.sql.includes("active_status = 'stopping'") &&
        !statement.sql.includes("JOIN runner_tasks")
      )
    ).toBe(true)
  })
})
