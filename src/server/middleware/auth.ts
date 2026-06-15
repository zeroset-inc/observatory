import { getSessionIdFromRequest, queueSessionCookieClear } from "../sessionCookie"
import { NebulaAuthError, resolveNebulaSession, syncNebulaProfile } from "../services/nebulaAuth"

export interface AuthUser {
  id: string
  email: string
  nebulaUserId: string
  displayName: string
  avatarUrl: string | null
}

export class AuthError extends Error {
  status: number

  constructor(message: string, status: number = 401) {
    super(message)
    this.name = "AuthError"
    this.status = status
  }
}

async function resolveSession(req: Request): Promise<AuthUser> {
  const sessionId = getSessionIdFromRequest(req)
  if (!sessionId) {
    throw new AuthError("Missing authentication", 401)
  }

  try {
    const identity = await resolveNebulaSession(req, sessionId)
    if (!identity) {
      queueSessionCookieClear(req)
      throw new AuthError("Invalid or expired session", 401)
    }
    const profile = await syncNebulaProfile(identity)
    return {
      id: profile.id,
      email: profile.email,
      nebulaUserId: identity.id,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_url,
    }
  } catch (error) {
    if (error instanceof AuthError) throw error
    if (error instanceof NebulaAuthError) {
      if (error.status === 401 || error.status === 403) queueSessionCookieClear(req)
      throw new AuthError(error.message, error.status)
    }
    queueSessionCookieClear(req)
    throw new AuthError("Authentication service unavailable", 503)
  }
}

/**
 * Resolve the Nebula-backed Observatory session from the HttpOnly cookie.
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
