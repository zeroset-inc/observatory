export class ServerEventBroadcaster {
  broadcast(message: object): void {
    void message
  }
}

export const serverEvents = new ServerEventBroadcaster()
