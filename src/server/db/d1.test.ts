import { describe, expect, test } from "bun:test"
import { D1Client } from "./d1"

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

  async all() {
    return {
      results:
        this.db.allResults.length > 0 ? this.db.allResults.shift() : this.db.nextResults.splice(0),
    }
  }

  async first() {
    return this.db.nextResults.shift() ?? null
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
        changes: this.db.nextChanges,
      },
    }
  }
}

class FakeD1 {
  batches: FakeStatement[][] = []
  prepared: FakeStatement[] = []
  nextResults: Record<string, unknown>[] = []
  allResults: Record<string, unknown>[][] = []
  nextChanges = 1

  prepare(sql: string): FakeStatement {
    const statement = new FakeStatement(this, sql)
    this.prepared.push(statement)
    return statement
  }

  async batch(statements: FakeStatement[]) {
    this.batches.push([...statements])
    return statements.map(() => ({ success: true }))
  }
}

describe("D1Client adapter", () => {
  test("maybeSingle returns null without an error when no rows match", async () => {
    const d1 = new FakeD1()
    const client = new D1Client(d1 as any)

    const result = await client.from("runs").select("*").eq("id", "missing").maybeSingle()

    expect(result.error).toBeNull()
    expect(result.data).toBeNull()
  })

  test("maybeSingle errors when multiple rows match", async () => {
    const d1 = new FakeD1()
    d1.nextResults = [{ id: "one" }, { id: "two" }]
    const client = new D1Client(d1 as any)

    const result = await client.from("runs").select("*").maybeSingle()

    expect(result.data).toBeNull()
    expect(result.error?.code).toBe("PGRST116")
  })

  test("non-returning inserts are batched incrementally", async () => {
    const d1 = new FakeD1()
    const client = new D1Client(d1 as any)
    const rows = Array.from({ length: 120 }, (_, index) => ({
      run_id: "run-1",
      question_id: `q-${index}`,
    }))

    const result = await client.from("questions").upsert(rows, { onConflict: "run_id,question_id" })

    expect(result.error).toBeNull()
    expect(d1.batches.map((batch) => batch.length)).toEqual([50, 50, 20])
  })

  test("upsert emits DO NOTHING when conflict keys cover every inserted column", async () => {
    const d1 = new FakeD1()
    const client = new D1Client(d1 as any)

    const result = await client.from("runs").upsert({ id: "run-1" }, { onConflict: "id" })

    expect(result.error).toBeNull()
    expect(d1.batches[0][0].sql).toContain("DO NOTHING")
    expect(d1.batches[0][0].sql).not.toContain("DO UPDATE SET")
  })

  test("rejects statements above D1's bound-parameter cap", async () => {
    const d1 = new FakeD1()
    const client = new D1Client(d1 as any)
    const row = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`column_${index}`, index])
    )

    const result = await client.from("runs").insert(row)

    expect(result.data).toBeNull()
    expect(result.error?.message).toContain("100")
  })

  test("guards total update bindings across patch values and filters", async () => {
    const d1 = new FakeD1()
    const client = new D1Client(d1 as any)
    const ids = Array.from({ length: 98 }, (_, index) => `run-${index}`)

    const result = await client
      .from("runs")
      .update({ status: "interrupted", active_status: null })
      .in("id", ids)
      .neq("status", "completed")

    expect(result.data).toBeNull()
    expect(result.error?.message).toContain("101")
  })

  test("chunks profile join hydration under D1's binding cap", async () => {
    const d1 = new FakeD1()
    const client = new D1Client(d1 as any)
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: `user-${index}`,
      user_id: `user-${index}`,
    }))
    d1.allResults = [
      rows,
      rows.slice(0, 100).map((row) => ({
        id: row.user_id,
        display_name: `User ${row.user_id}`,
        avatar_url: null,
      })),
      rows.slice(100).map((row) => ({
        id: row.user_id,
        display_name: `User ${row.user_id}`,
        avatar_url: null,
      })),
    ]

    const result = await client.from("leaderboard_entries").select("*, profiles:user_id(*)")

    expect(result.error).toBeNull()
    expect(d1.prepared.filter((statement) => statement.sql.includes("FROM profiles"))).toHaveLength(
      2
    )
    expect((result.data as any[])[100].profiles.display_name).toBe("User user-100")
  })

  test("raw run exposes D1 change metadata", async () => {
    const d1 = new FakeD1()
    d1.nextChanges = 0
    const client = new D1Client(d1 as any)

    const result = await client.run("UPDATE comparisons SET active_status = ? WHERE id = ?", [
      "running",
      "compare-1",
    ])

    expect(result.meta.changes).toBe(0)
    expect(d1.prepared[0].bindings).toEqual(["running", "compare-1"])
  })
})
