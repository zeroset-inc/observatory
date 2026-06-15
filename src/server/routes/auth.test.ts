import { beforeEach, describe, expect, mock, test } from "bun:test"

type Row = Record<string, any>
type State = {
  auth_users: Row[]
  profiles: Row[]
  auth_sessions: Row[]
  user_api_keys: Row[]
  failProfileInsert: boolean
}

const state: State = {
  auth_users: [],
  profiles: [],
  auth_sessions: [],
  user_api_keys: [],
  failProfileInsert: false,
}

function tableRows(table: string): Row[] {
  return (state as any)[table] as Row[]
}

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([column, value]) => row[column] === value)
}

function createResult(data: unknown = null, error: unknown = null) {
  return Promise.resolve({ data, error })
}

class FakeQuery {
  private filters: Array<[string, unknown]> = []
  private action: "select" | "insert" | "delete" | "upsert" = "select"
  private values: Row | null = null
  private singleRow = false

  constructor(private readonly table: string) {}

  select(): this {
    this.action = "select"
    return this
  }

  insert(values: Row): this {
    this.action = "insert"
    this.values = values
    return this
  }

  upsert(values: Row): this {
    this.action = "upsert"
    this.values = values
    return this
  }

  delete(): this {
    this.action = "delete"
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value])
    return this
  }

  single(): this {
    this.singleRow = true
    return this
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  private execute() {
    const rows = tableRows(this.table)

    if (this.action === "insert") {
      if (this.table === "profiles" && state.failProfileInsert) {
        return createResult(null, { message: "profile insert failed" })
      }
      rows.push({ ...this.values })
      return createResult(null, null)
    }

    if (this.action === "upsert") {
      const existingIndex = rows.findIndex(
        (row) => row.user_id === this.values?.user_id && row.key_name === this.values?.key_name
      )
      if (existingIndex >= 0) rows[existingIndex] = { ...rows[existingIndex], ...this.values }
      else rows.push({ id: crypto.randomUUID(), ...this.values })
      return createResult(null, null)
    }

    if (this.action === "delete") {
      const remaining = rows.filter((row) => !matches(row, this.filters))
      rows.splice(0, rows.length, ...remaining)
      return createResult(null, null)
    }

    const selected = rows.filter((row) => matches(row, this.filters)).map((row) => ({ ...row }))
    if (this.singleRow) {
      if (selected.length !== 1) {
        return createResult(null, { code: "PGRST116", message: "not found" })
      }
      return createResult(selected[0], null)
    }
    return createResult(selected, null)
  }
}

const fakeDb = {
  from(table: string) {
    return new FakeQuery(table)
  },
}

mock.module("../db", () => ({ db: fakeDb }))

describe("first-party auth routes", () => {
  beforeEach(() => {
    state.auth_users = []
    state.profiles = []
    state.auth_sessions = []
    state.user_api_keys = []
    state.failProfileInsert = false
    process.env.OBSERVATORY_SECRET = "test-secret"
  })

  test("cleans up auth user when profile creation fails", async () => {
    state.failProfileInsert = true
    const { handleAuthRoutes } = await import("./auth")

    const response = await handleAuthRoutes(
      new Request("http://test.local/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          email: "Orphan@Test.Example",
          password: "password123",
          displayName: "Orphan",
        }),
      }),
      new URL("http://test.local/api/auth/signup")
    )

    expect(response?.status).toBe(500)
    expect(state.auth_users).toHaveLength(0)
  })

  test("signs up, logs in, and resolves the session profile", async () => {
    const { handleAuthRoutes } = await import("./auth")

    const signup = await handleAuthRoutes(
      new Request("http://test.local/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          email: "User@Test.Example",
          password: "password123",
          displayName: "Worker User",
        }),
      }),
      new URL("http://test.local/api/auth/signup")
    )
    expect(signup?.status).toBe(200)
    expect(state.auth_users[0].email).toBe("user@test.example")
    expect(state.profiles[0].display_name).toBe("Worker User")

    const login = await handleAuthRoutes(
      new Request("http://test.local/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: "user@test.example",
          password: "password123",
        }),
      }),
      new URL("http://test.local/api/auth/login")
    )
    expect(login?.status).toBe(200)
    const setCookie = login?.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("observatory_session=")

    const sessionId = state.auth_sessions[0].id
    const session = await handleAuthRoutes(
      new Request("http://test.local/api/auth/session", {
        headers: { cookie: `observatory_session=${sessionId}` },
      }),
      new URL("http://test.local/api/auth/session")
    )
    expect(session?.status).toBe(200)
    await expect(session?.json()).resolves.toMatchObject({
      active: true,
      email: "user@test.example",
      displayName: "Worker User",
    })
  })

  test("stores user API keys encrypted and returns decrypted values", async () => {
    const { handleAuthRoutes } = await import("./auth")

    await handleAuthRoutes(
      new Request("http://test.local/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          email: "keys@test.example",
          password: "password123",
        }),
      }),
      new URL("http://test.local/api/auth/signup")
    )
    await handleAuthRoutes(
      new Request("http://test.local/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: "keys@test.example",
          password: "password123",
        }),
      }),
      new URL("http://test.local/api/auth/login")
    )

    const sessionId = state.auth_sessions[0].id
    const cookie = `observatory_session=${sessionId}`
    const put = await handleAuthRoutes(
      new Request("http://test.local/api/auth/keys/openai", {
        method: "PUT",
        headers: { cookie },
        body: JSON.stringify({ value: "sk-test" }),
      }),
      new URL("http://test.local/api/auth/keys/openai")
    )
    expect(put?.status).toBe(200)
    expect(state.user_api_keys[0].encrypted_key).not.toBe("sk-test")

    const list = await handleAuthRoutes(
      new Request("http://test.local/api/auth/keys", { headers: { cookie } }),
      new URL("http://test.local/api/auth/keys")
    )
    await expect(list?.json()).resolves.toEqual({ keys: ["openai"] })

    const get = await handleAuthRoutes(
      new Request("http://test.local/api/auth/keys/openai", { headers: { cookie } }),
      new URL("http://test.local/api/auth/keys/openai")
    )
    await expect(get?.json()).resolves.toEqual({ value: "sk-test" })
  })
})
