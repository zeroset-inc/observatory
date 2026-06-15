import { requireAuth, AuthError } from "../middleware/auth"
import {
  getUserApiKey,
  setUserApiKey,
  deleteUserApiKey,
  listUserApiKeyNames,
  isValidKeyName,
} from "../services/apiKeys"
import { clearSessionCookie, getSessionIdFromRequest, setSessionCookie } from "../sessionCookie"
import { db } from "../db"
import {
  extractNebulaSessionCookie,
  nebulaApiUrl,
  nebulaSessionCookieHeader,
} from "../services/nebulaAuth"

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

async function readNebulaJson(resp: Response): Promise<any> {
  return resp.json().catch(() => ({}))
}

function nebulaError(data: any, fallback: string): string {
  return data?.detail ?? data?.message ?? data?.error ?? fallback
}

function responseWithNebulaSession(req: Request, resp: Response, body: unknown): Response {
  const session = extractNebulaSessionCookie(resp.headers)
  if (!session?.value) return json({ error: "Nebula did not return a session" }, 502)
  const headers = new Headers({ "Content-Type": "application/json" })
  setSessionCookie(headers, req, session.value, session.maxAge)
  return new Response(JSON.stringify(body), { status: 200, headers })
}

export async function handleAuthRoutes(req: Request, url: URL): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname

  if (method === "POST" && pathname === "/api/auth/signup") {
    try {
      const body = (await req.json()) as Record<string, any>
      const email = normalizeEmail(body.email || "")
      const password = String(body.password || "")
      const displayName = String(body.displayName || email.split("@")[0])

      if (!email || !password) return json({ error: "Email and password are required" }, 400)
      if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400)

      const resp = await fetch(nebulaApiUrl("/users/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          name: displayName || email.split("@")[0],
        }),
      })

      const data = await readNebulaJson(resp)
      if (!resp.ok) return json({ error: nebulaError(data, "Signup failed") }, resp.status)
      const result = data.results ?? data
      return json({
        message: result.message ?? "Account created. Check your email to verify your account.",
        needsVerification:
          result.next_step === "verify_email" || result.verification_email_sent !== false,
        nextStep: result.next_step ?? "verify_email",
        verificationEmailSent: Boolean(result.verification_email_sent ?? true),
      })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400)
    }
  }

  if (method === "POST" && pathname === "/api/auth/verify-email") {
    try {
      const body = (await req.json()) as Record<string, any>
      const email = normalizeEmail(body.email || "")
      const verificationCode = String(body.verificationCode || body.verification_code || "")
      if (!email || !verificationCode)
        return json({ error: "Email and verification code are required" }, 400)

      const resp = await fetch(nebulaApiUrl("/users/verify-email"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, verification_code: verificationCode }),
      })
      const data = await readNebulaJson(resp)
      if (!resp.ok)
        return json({ error: data.detail ?? data.message ?? "Verification failed" }, resp.status)
      return json(data.results ?? data)
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400)
    }
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    try {
      const body = (await req.json()) as Record<string, any>
      const email = normalizeEmail(body.email || "")
      const password = String(body.password || "")
      if (!email || !password) return json({ error: "Email and password are required" }, 400)

      const resp = await fetch(nebulaApiUrl("/users/session/login"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: email, password }).toString(),
      })

      const data = await readNebulaJson(resp)
      if (!resp.ok)
        return json({ error: data.detail ?? data.message ?? "Login failed" }, resp.status)
      return responseWithNebulaSession(req, resp, data.results ?? data)
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400)
    }
  }

  if (method === "POST" && pathname === "/api/auth/oauth/exchange") {
    try {
      const body = (await req.json()) as Record<string, any>
      const code = String(body.code || "")
      if (!code) return json({ error: "Missing OAuth code" }, 400)

      const resp = await fetch(nebulaApiUrl("/users/session/oauth/exchange"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
      const data = await readNebulaJson(resp)
      if (!resp.ok)
        return json({ error: data.detail ?? data.message ?? "OAuth exchange failed" }, resp.status)
      return responseWithNebulaSession(req, resp, data.results ?? data)
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400)
    }
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    const sessionId = getSessionIdFromRequest(req)
    if (sessionId) {
      await fetch(nebulaApiUrl("/users/logout"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: nebulaSessionCookieHeader(sessionId),
        },
      }).catch(() => null)
    }
    const headers = new Headers({ "Content-Type": "application/json" })
    clearSessionCookie(headers, req)
    return new Response(JSON.stringify({ message: "Logged out" }), { status: 200, headers })
  }

  if (method === "GET" && pathname === "/api/auth/session") {
    try {
      const user = await requireAuth(req)
      return json({
        id: user.id,
        email: user.email,
        displayName: user.displayName || user.email.split("@")[0],
        avatarUrl: user.avatarUrl || null,
        nebulaUserId: user.nebulaUserId,
        active: true,
      })
    } catch (e) {
      if (e instanceof AuthError && e.status === 401) return json({ active: false, user: null })
      if (e instanceof AuthError) return json({ error: e.message }, e.status)
      return json({ error: "Authentication service unavailable" }, 503)
    }
  }

  if (method === "PUT" && pathname === "/api/auth/profile") {
    try {
      const user = await requireAuth(req)
      const body = (await req.json()) as Record<string, any>
      const updates: Record<string, any> = { updated_at: new Date().toISOString() }
      if (body.displayName !== undefined) updates.display_name = body.displayName
      if (body.avatarUrl !== undefined) updates.avatar_url = body.avatarUrl
      const { error } = await db.from("profiles").update(updates).eq("id", user.id)
      if (error) return json({ error: error.message }, 500)
      return json({ message: "Profile updated" })
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message }, e.status)
      return json({ error: "Unauthorized" }, 401)
    }
  }

  if (method === "GET" && pathname === "/api/auth/keys") {
    try {
      const user = await requireAuth(req)
      return json({ keys: await listUserApiKeyNames(user.id) })
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message }, e.status)
      return json({ error: "Unauthorized" }, 401)
    }
  }

  const keySetMatch = pathname.match(/^\/api\/auth\/keys\/([^/]+)$/)
  if (method === "PUT" && keySetMatch) {
    try {
      const user = await requireAuth(req)
      const keyName = decodeURIComponent(keySetMatch[1])
      if (!isValidKeyName(keyName)) {
        return json(
          {
            error: `Invalid key name: ${keyName}. Valid: supermemory, mem0, zep, nebula, openai, anthropic, google`,
          },
          400
        )
      }
      const body = (await req.json()) as Record<string, any>
      if (!body.value || typeof body.value !== "string") {
        return json({ error: "Missing or invalid 'value' field" }, 400)
      }
      await setUserApiKey(user.id, keyName, body.value)
      return json({ message: `Key '${keyName}' saved` })
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message }, e.status)
      return json({ error: e instanceof Error ? e.message : "Failed to save key" }, 500)
    }
  }

  const keyDeleteMatch = pathname.match(/^\/api\/auth\/keys\/([^/]+)$/)
  if (method === "DELETE" && keyDeleteMatch) {
    try {
      const user = await requireAuth(req)
      const keyName = decodeURIComponent(keyDeleteMatch[1])
      if (!isValidKeyName(keyName)) return json({ error: `Invalid key name: ${keyName}` }, 400)
      await deleteUserApiKey(user.id, keyName)
      return json({ message: `Key '${keyName}' deleted` })
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message }, e.status)
      return json({ error: e instanceof Error ? e.message : "Failed to delete key" }, 500)
    }
  }

  const keyGetMatch = pathname.match(/^\/api\/auth\/keys\/([^/]+)$/)
  if (method === "GET" && keyGetMatch) {
    try {
      const user = await requireAuth(req)
      const keyName = decodeURIComponent(keyGetMatch[1])
      if (!isValidKeyName(keyName)) return json({ error: `Invalid key name: ${keyName}` }, 400)
      return json({ value: await getUserApiKey(user.id, keyName) })
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message }, e.status)
      return json({ error: e instanceof Error ? e.message : "Failed to load key" }, 500)
    }
  }

  return null
}
