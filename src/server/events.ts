export class PollingEventSink {
  broadcast(message: object): void {
    // The Worker deployment is polling-first; state changes are persisted to D1.
    // This sink preserves the orchestration call sites without implying process-local realtime delivery.
    void message
  }
}

export const serverEvents = new PollingEventSink()
