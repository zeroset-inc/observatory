import { db } from "../db"
import { queueSessionCookieClear, queueSessionCookieSet } from "../sessionCookie"
import { config } from "../../utils/config"

const NEBULA_SESSION_COOKIE = "nebula_session"

export type NebulaOAuthProvider = "github" | "google"

export type NebulaIdentity = {
  id: string
  email: string
  displayName: string
  avatarUrl: string | null
}

export type LocalProfile = {
  id: string
  email: string
  display_name: string
  avatar_url: string | null
  nebula_user_id: string | null
}

export class NebulaAuthError extends Error {
  status: number

  constructor(message: string, status = 401) {
    super(message)
    this.name = "NebulaAuthError"
    this.status = status
  }
}

function nebulaApiBase(): string {
  return `${config.nebulaBaseUrl.replace(/\/+$/, "")}/v1`
}

export function nebulaApiUrl(path: string): string {
  return `${nebulaApiBase()}${path.startsWith("/") ? path : `/${path}`}`
}

export function nebulaSessionCookieHeader(sessionId: string): string {
  return `${NEBULA_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`
}

export async function parseNebulaError(resp: Response, fallback: string): Promise<string> {
  try {
    const body = (await resp.json()) as any
    return body?.detail ?? body?.message ?? body?.error ?? fallback
  } catch {
    return fallback
  }
}

export function extractNebulaSessionCookie(
  headers: Headers
): { value: string; maxAge?: number } | null {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const values =
    typeof getSetCookie === "function"
      ? getSetCookie.call(headers)
      : (headers.get("set-cookie")?.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g) ?? [])

  for (const raw of values) {
    const valueMatch = raw.trim().match(/^nebula_session=([^;]*)/)
    if (!valueMatch) continue
    let value: string
    try {
      value = decodeURIComponent(valueMatch[1])
    } catch {
      continue
    }
    const maxAgeMatch = raw.match(/Max-Age=(\d+)/i)
    return { value, maxAge: maxAgeMatch ? Number(maxAgeMatch[1]) : undefined }
  }

  return null
}

function unwrapResults(body: any): any {
  return body?.results ?? body
}

function normalizeIdentity(input: any): NebulaIdentity | null {
  const user = unwrapResults(input)?.user ?? unwrapResults(input)
  if (!user?.id) return null
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : ""
  if (!email) return null
  const metadata = user.user_metadata ?? {}
  const displayName =
    user.name ??
    user.full_name ??
    metadata.name ??
    metadata.full_name ??
    email.split("@")[0] ??
    "Nebula User"
  const avatarUrl = user.profile_picture ?? user.avatar_url ?? metadata.avatar_url ?? null
  return {
    id: String(user.id),
    email,
    displayName: String(displayName),
    avatarUrl: avatarUrl ? String(avatarUrl) : null,
  }
}

export async function resolveNebulaSession(
  req: Request,
  sessionId: string
): Promise<NebulaIdentity | null> {
  const resp = await fetch(nebulaApiUrl("/users/session"), {
    headers: { Cookie: nebulaSessionCookieHeader(sessionId) },
  })

  const rotatedSession = extractNebulaSessionCookie(resp.headers)
  if (rotatedSession) queueSessionCookieSet(req, rotatedSession.value, rotatedSession.maxAge)

  if (!resp.ok) {
    queueSessionCookieClear(req)
    throw new NebulaAuthError(
      await parseNebulaError(resp, "Invalid or expired session"),
      resp.status
    )
  }

  const body = await resp.json()
  const session = unwrapResults(body)
  if (!session?.active || !session.user) {
    queueSessionCookieClear(req)
    return null
  }

  return normalizeIdentity(session.user)
}

export async function syncNebulaProfile(identity: NebulaIdentity): Promise<LocalProfile> {
  const now = new Date().toISOString()
  const existingByNebula = await db
    .from<LocalProfile>("profiles")
    .select("id, email, display_name, avatar_url, nebula_user_id")
    .eq("nebula_user_id", identity.id)
    .maybeSingle()

  if (existingByNebula.error) throw new Error(existingByNebula.error.message)

  let profile = existingByNebula.data
  if (!profile) {
    const existingByEmail = await db
      .from<LocalProfile>("profiles")
      .select("id, email, display_name, avatar_url, nebula_user_id")
      .eq("email", identity.email)
      .maybeSingle()
    if (existingByEmail.error) throw new Error(existingByEmail.error.message)
    profile = existingByEmail.data
  }

  if (profile) {
    const { error } = await db
      .from("profiles")
      .update({
        email: identity.email,
        display_name: identity.displayName,
        avatar_url: identity.avatarUrl,
        nebula_user_id: identity.id,
        updated_at: now,
      })
      .eq("id", profile.id)
    if (error) throw new Error(error.message)
    return {
      ...profile,
      email: identity.email,
      display_name: identity.displayName,
      avatar_url: identity.avatarUrl,
      nebula_user_id: identity.id,
    }
  }

  const id = crypto.randomUUID()
  const { error } = await db.from("profiles").insert({
    id,
    email: identity.email,
    display_name: identity.displayName,
    avatar_url: identity.avatarUrl,
    nebula_user_id: identity.id,
    created_at: now,
    updated_at: now,
  })
  if (error) throw new Error(error.message)

  return {
    id,
    email: identity.email,
    display_name: identity.displayName,
    avatar_url: identity.avatarUrl,
    nebula_user_id: identity.id,
  }
}
