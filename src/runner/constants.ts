// Shared lease lifetime for run/comparison fences, used by the Durable Object
// coordinators (durable.ts) and the task store (tasks/store.ts).
export const RUN_LEASE_TTL_MS = 24 * 60 * 60 * 1000
