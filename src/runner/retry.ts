export function isRetryableFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  if (normalized.includes("stopped by user")) return false
  if (normalized.includes("authentication required")) return false
  if (normalized.includes("forbidden")) return false
  return true
}
