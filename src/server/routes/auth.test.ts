import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

type Row = Record<string, any>
type State = {
  profiles: Row[]
  user_api_keys: Row[]
}

const state: State = {
  profiles: [],
  user_api_keys: [],
}

let fetchHandler: (url: string, init?: RequestInit) => Response | Promise<Response>

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
  private action: "select" | "insert" | "update" | "delete" | "upsert" = "select"
  private values: Row | null = null
  private singleRow = false
  private maybeSingleRow = false

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

  update(values: Row): this {
    this.action = "update"
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

  maybeSingle(): this {
    this.maybeSingleRow = true
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

    if (this.action === "update") {
      for (const row of rows) {
        if (matches(row, this.filters)) Object.assign(row, this.values)
      }
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
    if (this.maybeSingleRow) {
      if (selected.length > 1) {
        return createResult(null, { code: "PGRST116", message: "multiple rows" })
      }
      return createResult(selected[0] ?? null, null)
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

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
}

function nebulaSessionResponse(): Response {
  return jsonResponse({
    active: true,
    user: {
      id: "nebula-user-1",
      email: "User@Test.Example",
      name: "Worker User",
      profile_picture: "https://zeroset.com/avatar.png",
      created_at: "2026-01-01T00:00:00Z",
    },
    auth: { providers: ["github"], has_password_auth: true },
  })
}

describe("Nebula-backed auth routes", () => {
  beforeEach(() => {
    state.profiles = []
    state.user_api_keys = []
    process.env.OBSERVATORY_SECRET = "test-secret"
    process.env.NEBULA_BASE_URL = "https://api.zeroset.com"
    fetchHandler = (url, init) => {
      if (url.endsWith("/users/session")) {
        expect(init?.headers).toMatchObject({ Cookie: "nebula_session=nebula-session" })
        return nebulaSessionResponse()
      }
      return jsonResponse({ detail: `Unexpected fetch: ${url}` }, { status: 500 })
    }
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      return Promise.resolve(fetchHandler(url, init))
    }) as typeof fetch
  })

  afterEach(() => {
    mock.restore()
  })

  test("proxies signup and email verification to Nebula", async () => {
    fetchHandler = (url, init) => {
      if (url.endsWith("/users/register")) {
        expect(init?.method).toBe("POST")
        expect(JSON.parse(String(init?.body))).toEqual({
          email: "user@test.example",
          password: "password123",
          name: "Worker User",
        })
        return jsonResponse({
          results: {
            message: "A verification email has been sent.",
            next_step: "verify_email",
            verification_email_sent: true,
          },
        })
      }
      if (url.endsWith("/users/verify-email")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          email: "user@test.example",
          verification_code: "123456",
        })
        return jsonResponse({ message: "Email verified" })
      }
      return jsonResponse({ detail: `Unexpected fetch: ${url}` }, { status: 500 })
    }

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
    await expect(signup?.json()).resolves.toMatchObject({ needsVerification: true })

    const verify = await handleAuthRoutes(
      new Request("http://test.local/api/auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ email: "User@Test.Example", verificationCode: "123456" }),
      }),
      new URL("http://test.local/api/auth/verify-email")
    )
    expect(verify?.status).toBe(200)
  })

  test("logs in through Nebula, stores the Nebula session, and projects the local profile", async () => {
    fetchHandler = (url, init) => {
      if (url.endsWith("/users/session/login")) {
        expect(init?.method).toBe("POST")
        expect(String(init?.body)).toBe("username=user%40test.example&password=password123")
        return jsonResponse(
          { message: "Logged in" },
          {
            headers: {
              "Set-Cookie": "nebula_session=nebula-session; Path=/; HttpOnly; Max-Age=3600",
            },
          }
        )
      }
      if (url.endsWith("/users/session")) return nebulaSessionResponse()
      return jsonResponse({ detail: `Unexpected fetch: ${url}` }, { status: 500 })
    }

    const { handleAuthRoutes } = await import("./auth")
    const login = await handleAuthRoutes(
      new Request("http://test.local/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: "User@Test.Example",
          password: "password123",
        }),
      }),
      new URL("http://test.local/api/auth/login")
    )
    expect(login?.status).toBe(200)
    expect(login?.headers.get("set-cookie")).toContain("observatory_session=nebula-session")

    const session = await handleAuthRoutes(
      new Request("http://test.local/api/auth/session", {
        headers: { cookie: "observatory_session=nebula-session" },
      }),
      new URL("http://test.local/api/auth/session")
    )
    expect(session?.status).toBe(200)
    await expect(session?.json()).resolves.toMatchObject({
      active: true,
      email: "user@test.example",
      displayName: "Worker User",
      avatarUrl: "https://zeroset.com/avatar.png",
      nebulaUserId: "nebula-user-1",
    })
    expect(state.profiles).toHaveLength(1)
    expect(state.profiles[0]).toMatchObject({
      email: "user@test.example",
      display_name: "Worker User",
      nebula_user_id: "nebula-user-1",
    })
  })

  test("exchanges OAuth codes through Nebula and stores the returned session", async () => {
    fetchHandler = (url, init) => {
      if (url.endsWith("/users/session/oauth/exchange")) {
        expect(JSON.parse(String(init?.body))).toEqual({ code: "oauth-code" })
        return jsonResponse(
          { return_url: "/runs" },
          { headers: { "Set-Cookie": "nebula_session=nebula-session; Path=/; HttpOnly" } }
        )
      }
      return jsonResponse({ detail: `Unexpected fetch: ${url}` }, { status: 500 })
    }

    const { handleAuthRoutes } = await import("./auth")
    const exchange = await handleAuthRoutes(
      new Request("http://test.local/api/auth/oauth/exchange", {
        method: "POST",
        body: JSON.stringify({ code: "oauth-code" }),
      }),
      new URL("http://test.local/api/auth/oauth/exchange")
    )
    expect(exchange?.status).toBe(200)
    expect(exchange?.headers.get("set-cookie")).toContain("observatory_session=nebula-session")
    await expect(exchange?.json()).resolves.toEqual({ return_url: "/runs" })
  })

  test("stores user API keys encrypted under the projected Observatory profile", async () => {
    const { handleAuthRoutes } = await import("./auth")
    const cookie = "observatory_session=nebula-session"
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
    expect(state.user_api_keys[0].user_id).toBe(state.profiles[0].id)

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
