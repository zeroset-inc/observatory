import { describe, expect, test } from "bun:test"
import { extractCookieValue, extractSetCookie } from "./sessionCookie"

describe("extractCookieValue", () => {
  test("returns null for malformed cookie encoding", () => {
    expect(extractCookieValue("observatory_session=%zz", "observatory_session")).toBeNull()
  })
})

describe("extractSetCookie", () => {
  test("uses the matching cookie max-age when fallback headers are combined", () => {
    const headers = {
      get(name: string) {
        if (name.toLowerCase() !== "set-cookie") return null

        return [
          "other_cookie=one; Path=/; Max-Age=600",
          "observatory_session=observatory%20session; Path=/; HttpOnly; Max-Age=60",
        ].join(", ")
      },
    } as unknown as Headers

    expect(extractSetCookie(headers, "observatory_session")).toEqual({
      value: "observatory session",
      maxAge: 60,
    })
  })

  test("ignores malformed cookie values while scanning fallback headers", () => {
    const headers = {
      get(name: string) {
        if (name.toLowerCase() !== "set-cookie") return null

        return [
          "observatory_session=%zz; Path=/; HttpOnly; Max-Age=60",
          "observatory_session=valid%20session; Path=/; HttpOnly; Max-Age=120",
        ].join(", ")
      },
    } as unknown as Headers

    expect(extractSetCookie(headers, "observatory_session")).toEqual({
      value: "valid session",
      maxAge: 120,
    })
  })
})
