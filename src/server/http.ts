import { applyQueuedSessionCookie } from "./sessionCookie"
import { applyResponseCorsHeaders, buildPreflightResponse } from "./cors"

export interface UpgradeCapableServer {
  upgrade(req: Request): boolean
}

export interface ServerFetchDependencies {
  checkReadiness: () => Promise<void>
  getErrorStatus?: (error: unknown) => number
  handleApiRequest: (req: Request, url: URL) => Promise<Response | null>
  serveStaticUi?: (url: URL) => Promise<Response | null>
}

export interface BackgroundExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set("Content-Type", "application/json")
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  })
}

export function finalizeResponse(req: Request, response: Response): Response {
  const headers = new Headers(response.headers)
  applyQueuedSessionCookie(req, headers)
  applyResponseCorsHeaders(headers, req.headers.get("origin"))

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function createServerFetchHandler(dependencies: ServerFetchDependencies) {
  const getErrorStatus = dependencies.getErrorStatus ?? (() => 500)

  return async function handleServerFetch(
    req: Request,
    server: UpgradeCapableServer
  ): Promise<Response | undefined> {
    const url = new URL(req.url)

    if (req.method === "OPTIONS") {
      return buildPreflightResponse(req.headers.get("origin"))
    }

    if (url.pathname === "/api/live") {
      return finalizeResponse(req, jsonResponse({ status: "ok" }))
    }

    if (url.pathname === "/api/ready") {
      try {
        await dependencies.checkReadiness()
        return finalizeResponse(req, jsonResponse({ status: "ok" }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return finalizeResponse(
          req,
          jsonResponse({ status: "not_ready", error: message }, { status: 503 })
        )
      }
    }

    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req)
      if (upgraded) return undefined
      return new Response("WebSocket upgrade failed", { status: 400 })
    }

    try {
      const routeResponse = await dependencies.handleApiRequest(req, url)
      if (routeResponse) {
        return finalizeResponse(req, routeResponse)
      }

      const staticResponse = await dependencies.serveStaticUi?.(url)
      if (staticResponse) {
        return staticResponse
      }

      return finalizeResponse(req, jsonResponse({ error: "Not found" }, { status: 404 }))
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error"
      return finalizeResponse(
        req,
        jsonResponse({ error: message }, { status: getErrorStatus(error) })
      )
    }
  }
}
