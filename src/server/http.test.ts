import { describe, expect, test } from "bun:test"
import { createServerFetchHandler } from "./http"

function createHandler(overrides: Partial<Parameters<typeof createServerFetchHandler>[0]> = {}) {
  return createServerFetchHandler({
    async checkReadiness() {},
    getErrorStatus() {
      return 500
    },
    async handleApiRequest() {
      return null
    },
    async serveStaticUi() {
      return null
    },
    ...overrides,
  })
}

describe("server http boundary", () => {
  test("handles preflight through the dedicated boundary builder", async () => {
    const handler = createHandler()
    const response = await handler(
      new Request("https://observatory.test/api/runs", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3003",
        },
      })
    )

    expect(response?.status).toBe(204)
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3003")
    expect(response?.headers.get("Access-Control-Allow-Credentials")).toBe("true")
    expect(response?.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, PUT, DELETE, OPTIONS, PATCH"
    )
    expect(response?.headers.get("Vary")).toBe("Origin")
  })

  test("adds response CORS headers to readiness failures", async () => {
    const handler = createHandler({
      async checkReadiness() {
        throw new Error("database unavailable")
      },
    })
    const response = await handler(
      new Request("https://observatory.test/api/ready", {
        headers: {
          Origin: "http://localhost:3003",
        },
      })
    )

    expect(response?.status).toBe(503)
    expect(await response?.json()).toEqual({
      error: "database unavailable",
      status: "not_ready",
    })
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3003")
    expect(response?.headers.get("Access-Control-Allow-Credentials")).toBe("true")
    expect(response?.headers.get("Vary")).toBe("Origin")
    expect(response?.headers.get("Access-Control-Allow-Methods")).toBeNull()
  })

  test("adds response CORS headers to 404s without exposing disallowed origins", async () => {
    const handler = createHandler()
    const response = await handler(
      new Request("https://observatory.test/api/unknown", {
        headers: {
          Origin: "https://evil.example",
        },
      })
    )

    expect(response?.status).toBe(404)
    expect(await response?.json()).toEqual({ error: "Not found" })
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBeNull()
    expect(response?.headers.get("Access-Control-Allow-Credentials")).toBeNull()
    expect(response?.headers.get("Vary")).toBe("Origin")
    expect(response?.headers.get("Access-Control-Allow-Methods")).toBeNull()
  })

  test("merges existing Vary metadata on normal route responses", async () => {
    const handler = createHandler({
      async handleApiRequest() {
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "Content-Type": "application/json",
            Vary: "Accept-Encoding",
          },
        })
      },
    })
    const response = await handler(
      new Request("https://observatory.test/api/runs", {
        headers: {
          Origin: "http://localhost:3003",
        },
      })
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ ok: true })
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3003")
    expect(response?.headers.get("Vary")).toBe("Accept-Encoding, Origin")
    expect(response?.headers.get("Access-Control-Allow-Methods")).toBeNull()
  })
})
