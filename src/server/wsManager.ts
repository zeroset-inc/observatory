type SendableWebSocket = {
  send(message: string): void
}

interface ClientInfo {
  subscribedRuns: Set<string>
}

export class WebSocketManager<TSocket extends SendableWebSocket = SendableWebSocket> {
  private clients: Map<TSocket, ClientInfo> = new Map()

  addClient(ws: TSocket): void {
    this.clients.set(ws, { subscribedRuns: new Set() })
  }

  removeClient(ws: TSocket): void {
    this.clients.delete(ws)
  }

  handleMessage(ws: TSocket, message: string | Buffer): void {
    try {
      const data = JSON.parse(message.toString())
      const client = this.clients.get(ws)
      if (!client) return

      switch (data.type) {
        case "subscribe":
          if (data.runId) {
            client.subscribedRuns.add(data.runId)
            ws.send(JSON.stringify({ type: "subscribed", runId: data.runId }))
          }
          break
        case "unsubscribe":
          if (data.runId) {
            client.subscribedRuns.delete(data.runId)
            ws.send(JSON.stringify({ type: "unsubscribed", runId: data.runId }))
          }
          break
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }))
          break
      }
    } catch {
      // Ignore invalid messages.
    }
  }

  broadcastToRun(runId: string, message: object): void {
    const payload = JSON.stringify(message)
    for (const [ws, client] of this.clients) {
      if (!client.subscribedRuns.has(runId)) continue
      try {
        ws.send(payload)
      } catch {
        // Disconnected clients are cleaned up by the server close handler.
      }
    }
  }

  broadcast(message: object): void {
    const payload = JSON.stringify(message)
    for (const [ws] of this.clients) {
      try {
        ws.send(payload)
      } catch {
        // Disconnected clients are cleaned up by the server close handler.
      }
    }
  }
}

export const wsManager = new WebSocketManager()
