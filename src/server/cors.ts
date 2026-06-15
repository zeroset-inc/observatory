import { getEnvValue } from "./runtime"

function getAllowedOrigins(): string[] {
  return (getEnvValue("OBSERVATORY_ALLOWED_ORIGINS") || "http://localhost:3003")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
}

const PREFLIGHT_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With, Baggage, Sentry-Trace",
  "Access-Control-Max-Age": "86400",
} as const

export function isAllowedOrigin(origin: string | null): origin is string {
  return Boolean(origin && getAllowedOrigins().includes(origin))
}

function appendVaryHeader(headers: Headers, value: string): void {
  const existing = headers.get("Vary")
  if (!existing) {
    headers.set("Vary", value)
    return
  }

  const normalizedValue = value.toLowerCase()
  const varyValues = existing.split(",").map((part) => part.trim().toLowerCase())
  if (varyValues.includes(normalizedValue)) {
    return
  }

  headers.set("Vary", `${existing}, ${value}`)
}

export function applyResponseCorsHeaders(headers: Headers, origin: string | null): void {
  headers.delete("Access-Control-Allow-Origin")
  headers.delete("Access-Control-Allow-Credentials")
  if (isAllowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin)
    headers.set("Access-Control-Allow-Credentials", "true")
  }

  appendVaryHeader(headers, "Origin")
}

export function buildPreflightResponse(origin: string | null): Response {
  const headers = new Headers()
  applyResponseCorsHeaders(headers, origin)
  Object.entries(PREFLIGHT_CORS_HEADERS).forEach(([key, value]) => {
    headers.set(key, value)
  })

  return new Response(null, {
    status: 204,
    headers,
  })
}
