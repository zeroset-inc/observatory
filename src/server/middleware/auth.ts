import { db } from "../db"
import { getSessionIdFromRequest, queueSessionCookieClear } from "../sessionCookie"

export interface AuthUser {
  id: string
  email: string
  nebulaUserId: string
}

export class AuthError extends Error {
  status: number

  constructor(message: string, status: number = 401) {
    super(message)
    this.name = "AuthError"
    this.status = status
  }
}

type SessionRow = {
  user_id: string
  expires_at: string
  email: string
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

async function resolveSession(req: Request): Promise<AuthUser> {
  const sessionId = getSessionIdFromRequest(req)
  if (!sessionId) {
    throw new AuthError("Missing authentication", 401)
  }

  const { data: session, error } = await db
    .from<SessionRow>("auth_sessions")
    .select("user_id, expires_at, email")
    .eq("id", sessionId)
    .single()

  if (error || !session) {
    queueSessionCookieClear(req)
    throw new AuthError("Invalid or expired session", 401)
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await db.from("auth_sessions").delete().eq("id", sessionId)
    queueSessionCookieClear(req)
    throw new AuthError("Invalid or expired session", 401)
  }

  return {
    id: session.user_id,
    email: normalizeEmail(session.email),
    nebulaUserId: session.user_id,
  }
}

/**
 * Resolve the first-party Observatory session from the HttpOnly cookie.
 */
export async function requireAuth(req: Request): Promise<AuthUser> {
  return resolveSession(req)
}

/**
 * Return the current user when present; suppress only unauthenticated cases.
 */
export async function optionalAuth(req: Request): Promise<AuthUser | null> {
  try {
    return await requireAuth(req)
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) return null
    throw err
  }
}
