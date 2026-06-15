export async function isRunStopRequested(runId: string): Promise<boolean> {
  const { db } = require("./db")
  const { data, error } = await db
    .from("runs")
    .select("active_status")
    .eq("id", runId)
    .maybeSingle()

  if (error) return false
  return data?.active_status === "stopping"
}
