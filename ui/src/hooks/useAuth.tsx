import { useState, useCallback, useContext, createContext, type ReactNode } from "react"
import { useMountEffect } from "./useMountEffect"
import { rememberOAuthReturnPath } from "../lib/authRedirect"

const API_BASE = import.meta.env.VITE_API_URL || ""
const NEBULA_API = import.meta.env.VITE_NEBULA_API_URL || "https://api.zeroset.com"

export interface AuthUser {
  id: string
  email: string
  displayName: string
  avatarUrl?: string
}

export interface AuthContextType {
  user: AuthUser | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<unknown>
  signUp: (email: string, password: string, displayName?: string) => Promise<unknown>
  signInWithOAuth: (provider: "github" | "google") => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

async function fetchSession(): Promise<AuthUser | null> {
  const resp = await fetch(`${API_BASE}/api/auth/session`, {
    credentials: "include",
  })
  if (!resp.ok) return null

  const data = await resp.json()
  if (!data.active) return null

  return {
    id: data.id,
    email: data.email,
    displayName: data.displayName,
    avatarUrl: data.avatarUrl || undefined,
  }
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider")
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const hydrate = useCallback(async () => {
    try {
      const sessionUser = await fetchSession()
      setUser(sessionUser)
    } catch {
      setUser(null)
    }
  }, [])

  useMountEffect(() => {
    ;(async () => {
      setLoading(true)
      await hydrate()
      setLoading(false)
    })()
  })

  const signIn = useCallback(async (email: string, password: string) => {
    const resp = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      credentials: "include",
    })
    const data = await resp.json()
    if (!resp.ok) throw new Error(data.error || "Login failed")

    const me = await fetchSession()
    if (!me) throw new Error("Failed to fetch user profile")
    setUser(me)
    return data
  }, [])

  const signUp = useCallback(async (email: string, password: string, displayName?: string) => {
    const resp = await fetch(`${API_BASE}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, displayName }),
      credentials: "include",
    })
    const data = await resp.json()
    if (!resp.ok) throw new Error(data.error || "Signup failed")
    return data
  }, [])

  const signInWithOAuth = useCallback(async (provider: "github" | "google") => {
    const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
    rememberOAuthReturnPath(returnPath)

    const params = new URLSearchParams({
      returnUrl: `${window.location.pathname}${window.location.search}`,
      frontendOrigin: window.location.origin,
    })
    window.location.href = `${NEBULA_API.replace(/\/+$/, "")}/v1/users/oauth/${provider}/authorize?${params.toString()}`
  }, [])

  const signOut = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      })
    } catch {
      // Best effort.
    }
    setUser(null)
  }, [])

  const value: AuthContextType = {
    user,
    loading,
    signIn,
    signUp,
    signInWithOAuth,
    signOut,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
