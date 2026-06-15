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

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
const PBKDF2_ITERATIONS = 210_000

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function hashPassword(password: string, salt?: Uint8Array): Promise<{ salt: string; hash: string }> {
  const passwordSalt = salt ?? crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(passwordSalt),
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    256
  )
  return { salt: bytesToBase64(passwordSalt), hash: bytesToBase64(hash) }
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = base64ToBytes(a)
  const right = base64ToBytes(b)
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i]
  return diff === 0
}

async function createSession(userId: string, email: string): Promise<{ id: string; expiresAt: string }> {
  const sessionId = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString()
  const { error } = await db.from("auth_sessions").insert({
    id: sessionId,
    user_id: userId,
    email,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  })
  if (error) throw new Error(error.message)
  return { id: sessionId, expiresAt }
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

      const existing = await db.from("auth_users").select("id").eq("email", email).single()
      if (existing.data) return json({ error: "An account with that email already exists" }, 409)

      const userId = crypto.randomUUID()
      const { salt, hash } = await hashPassword(password)
      const now = new Date().toISOString()
      const { error: userError } = await db.from("auth_users").insert({
        id: userId,
        email,
        password_salt: salt,
        password_hash: hash,
        created_at: now,
        updated_at: now,
      })
      if (userError) return json({ error: userError.message }, 500)

      const { error: profileError } = await db.from("profiles").insert({
        id: userId,
        display_name: displayName || email.split("@")[0],
        email,
        avatar_url: null,
        created_at: now,
        updated_at: now,
      })
      if (profileError) {
        await db.from("auth_users").delete().eq("id", userId)
        return json({ error: profileError.message }, 500)
      }

      return json({ message: "Account created. You can now sign in.", needsVerification: false })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400)
    }
  }

  if (method === "POST" && pathname === "/api/auth/verify-email") {
    return json({ message: "Email verification is not required for this deployment." })
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    try {
      const body = (await req.json()) as Record<string, any>
      const email = normalizeEmail(body.email || "")
      const password = String(body.password || "")
      if (!email || !password) return json({ error: "Email and password are required" }, 400)

      const { data: user } = await db
        .from<{ id: string; email: string; password_salt: string; password_hash: string }>("auth_users")
        .select("id, email, password_salt, password_hash")
        .eq("email", email)
        .single()

      if (!user) return json({ error: "Invalid email or password" }, 401)

      const candidate = await hashPassword(password, base64ToBytes(user.password_salt))
      if (!timingSafeEqual(candidate.hash, user.password_hash)) {
        return json({ error: "Invalid email or password" }, 401)
      }

      const session = await createSession(user.id, user.email)
      const headers = new Headers({ "Content-Type": "application/json" })
      setSessionCookie(headers, req, session.id, SESSION_MAX_AGE_SECONDS)
      return new Response(JSON.stringify({ message: "Logged in" }), { status: 200, headers })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Invalid request" }, 400)
    }
  }

  if (method === "POST" && pathname === "/api/auth/oauth/exchange") {
    return json({ error: "OAuth sign-in is not configured for the Cloudflare Worker deployment" }, 410)
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    const sessionId = getSessionIdFromRequest(req)
    if (sessionId) {
      await db.from("auth_sessions").delete().eq("id", sessionId)
    }
    const headers = new Headers({ "Content-Type": "application/json" })
    clearSessionCookie(headers, req)
    return new Response(JSON.stringify({ message: "Logged out" }), { status: 200, headers })
  }

  if (method === "GET" && pathname === "/api/auth/session") {
    try {
      const user = await requireAuth(req)
      const { data: profile } = await db.from<any>("profiles").select("*").eq("id", user.id).single()
      return json({
        id: user.id,
        email: user.email,
        displayName: profile?.display_name || user.email.split("@")[0],
        avatarUrl: profile?.avatar_url || null,
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
          { error: `Invalid key name: ${keyName}. Valid: supermemory, mem0, zep, nebula, openai, anthropic, google` },
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
