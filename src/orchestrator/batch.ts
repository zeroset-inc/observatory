import type { ProviderName } from "../types/provider"
import type { BenchmarkName } from "../types/benchmark"
import type { SamplingConfig } from "../types/checkpoint"
import type { BenchmarkResult } from "../types/unified"
import { orchestrator } from "./index"
import { createBenchmark } from "../benchmarks"
import { logger } from "../utils/logger"
import { startRun, endRun, requestStop } from "../server/runState"

const COMPARE_LEASE_TTL_MS = 24 * 60 * 60 * 1000
const COMPARE_LEASE_RENEW_MS = 10 * 60 * 1000

function getDb() {
  const { db } = require("../server/db")
  return db
}

export interface CompareManifest {
  compareId: string
  createdAt: string
  updatedAt: string
  userId?: string | null
  activeStatus?: "running" | "stopping" | null
  activeLeaseExpiresAt?: string | null
  benchmark: string
  judge: string
  sampling?: SamplingConfig
  targetQuestionIds: string[]
  runs: Array<{
    provider: string
    runId: string
  }>
}

export interface CompareOptions {
  providers: ProviderName[]
  benchmark: BenchmarkName
  judgeModel: string
  userId?: string | null
  userKeys?: Record<string, string>
  sampling?: SamplingConfig
  force?: boolean
}

export interface CompareResult {
  compareId: string
  manifest: CompareManifest
  successes: number
  failures: number
}

function generateCompareId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, "")
  const time = now.toISOString().slice(11, 19).replace(/:/g, "")
  return `compare-${date}-${time}`
}

function selectQuestionsBySampling(
  allQuestions: { questionId: string; questionType: string }[],
  sampling: SamplingConfig
): string[] {
  if (sampling.mode === "full") {
    return allQuestions.map((q) => q.questionId)
  }
  if (sampling.mode === "limit" && sampling.limit) {
    return allQuestions.slice(0, sampling.limit).map((q) => q.questionId)
  }
  if (sampling.mode === "sample" && sampling.perCategory) {
    const byType: Record<string, { questionId: string; questionType: string }[]> = {}
    for (const q of allQuestions) {
      if (!byType[q.questionType]) byType[q.questionType] = []
      byType[q.questionType].push(q)
    }
    const selected: string[] = []
    for (const questions of Object.values(byType)) {
      if (sampling.sampleType === "random") {
        const shuffled = [...questions].sort(() => Math.random() - 0.5)
        selected.push(...shuffled.slice(0, sampling.perCategory).map((q) => q.questionId))
      } else {
        selected.push(...questions.slice(0, sampling.perCategory).map((q) => q.questionId))
      }
    }
    return selected
  }
  return allQuestions.map((q) => q.questionId)
}

export class BatchManager {
  private getDb() {
    return getDb()
  }

  async existsAsync(compareId: string): Promise<boolean> {
    const db = this.getDb()
    const { data } = await db
      .from("comparisons")
      .select("id")
      .eq("id", compareId)
      .maybeSingle()
    return !!data
  }

  async acquireComparisonLease(compareId: string): Promise<string | null> {
    const db = this.getDb()
    const now = new Date()
    const nowIso = now.toISOString()
    const expiresIso = new Date(now.getTime() + COMPARE_LEASE_TTL_MS).toISOString()
    const token = crypto.randomUUID()
    const result = await db.run(
      `UPDATE comparisons
       SET active_status = 'running',
           active_lease_expires_at = ?,
           active_lease_token = ?,
           updated_at = ?
       WHERE id = ?
         AND (
           active_status IS NULL
           OR active_lease_expires_at IS NULL
           OR active_lease_expires_at < ?
         )`,
      [expiresIso, token, nowIso, compareId, nowIso]
    )
    return result.meta.changes > 0 ? token : null
  }

  async requestComparisonStop(compareId: string): Promise<boolean> {
    const db = this.getDb()
    const nowIso = new Date().toISOString()
    const result = await db.run(
      `UPDATE comparisons
       SET active_status = 'stopping',
           updated_at = ?
       WHERE id = ?
         AND active_status IS NOT NULL
         AND active_lease_expires_at IS NOT NULL
         AND active_lease_expires_at >= ?`,
      [nowIso, compareId, nowIso]
    )
    return result.meta.changes > 0
  }

  async renewComparisonLease(compareId: string, token: string): Promise<boolean> {
    const db = this.getDb()
    const now = new Date()
    const nowIso = now.toISOString()
    const expiresIso = new Date(now.getTime() + COMPARE_LEASE_TTL_MS).toISOString()
    const result = await db.run(
      `UPDATE comparisons
       SET active_lease_expires_at = ?,
           updated_at = ?
       WHERE id = ?
         AND active_lease_token = ?
         AND active_status IS NOT NULL`,
      [expiresIso, nowIso, compareId, token]
    )
    return result.meta.changes > 0
  }

  async releaseComparisonLease(compareId: string, token: string): Promise<void> {
    const db = this.getDb()
    const { error } = await db
      .from("comparisons")
      .update({
        active_status: null,
        active_lease_expires_at: null,
        active_lease_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", compareId)
      .eq("active_lease_token", token)

    if (error) {
      logger.warn(`Failed to release comparison lease ${compareId}: ${error.message}`)
    }
  }

  isComparisonManifestActive(manifest: CompareManifest): boolean {
    if (manifest.activeStatus !== "running" && manifest.activeStatus !== "stopping") return false
    if (!manifest.activeLeaseExpiresAt) return false
    return new Date(manifest.activeLeaseExpiresAt).getTime() > Date.now()
  }

  private startComparisonLeaseMaintenance(
    manifest: CompareManifest,
    leaseToken?: string
  ): () => void {
    let stopped = false
    let polling = false
    let nextRenewAt = Date.now() + COMPARE_LEASE_RENEW_MS
    const poll = async () => {
      if (stopped || polling) return
      polling = true
      try {
        if (leaseToken && Date.now() >= nextRenewAt) {
          const renewed = await this.renewComparisonLease(manifest.compareId, leaseToken)
          nextRenewAt = Date.now() + COMPARE_LEASE_RENEW_MS
          if (!renewed) {
            logger.warn(`Lost comparison lease ${manifest.compareId}; stopping child runs`)
            for (const run of manifest.runs) {
              requestStop(run.runId)
            }
            return
          }
        }

        const db = this.getDb()
        const { data, error } = await db
          .from("comparisons")
          .select("active_status")
          .eq("id", manifest.compareId)
          .maybeSingle()

        if (!error && data?.active_status === "stopping") {
          for (const run of manifest.runs) {
            requestStop(run.runId)
          }
        }
      } catch (error) {
        logger.warn(
          `Failed to poll comparison stop state ${manifest.compareId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      } finally {
        polling = false
      }
    }

    const interval = setInterval(() => {
      void poll()
    }, 2000)
    void poll()

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }

  async saveManifest(manifest: CompareManifest): Promise<void> {
    manifest.updatedAt = new Date().toISOString()

    const db = this.getDb()
    const { error } = await db
      .from("comparisons")
      .upsert(
        {
          id: manifest.compareId,
          user_id: manifest.userId || null,
          benchmark: manifest.benchmark,
          judge: manifest.judge,
          sampling: manifest.sampling || null,
          target_question_ids: manifest.targetQuestionIds,
          runs: manifest.runs,
          created_at: manifest.createdAt,
          updated_at: manifest.updatedAt,
        },
        { onConflict: "id" }
      )

    if (error) {
      throw new Error(`Failed to save comparison to DB: ${error.message}`)
    }
  }

  async loadManifestAsync(compareId: string): Promise<CompareManifest | null> {
    const db = this.getDb()
    const { data, error } = await db
      .from("comparisons")
      .select("*")
      .eq("id", compareId)
      .maybeSingle()

    if (error) {
      throw new Error(`Failed to load comparison ${compareId}: ${error.message}`)
    }
    if (!data) return null

    return {
      compareId: data.id,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      userId: data.user_id || null,
      activeStatus: data.active_status || null,
      activeLeaseExpiresAt: data.active_lease_expires_at || null,
      benchmark: data.benchmark,
      judge: data.judge,
      sampling: data.sampling,
      targetQuestionIds: data.target_question_ids || [],
      runs: data.runs || [],
    }
  }

  async listComparisons(): Promise<CompareManifest[]> {
    const db = this.getDb()
    const { data, error } = await db
      .from("comparisons")
      .select("*")
      .order("created_at", { ascending: false })

    if (error || !data) return []

    return (data as any[]).map((row) => ({
      compareId: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      userId: row.user_id || null,
      activeStatus: row.active_status || null,
      activeLeaseExpiresAt: row.active_lease_expires_at || null,
      benchmark: row.benchmark,
      judge: row.judge,
      sampling: row.sampling,
      targetQuestionIds: row.target_question_ids || [],
      runs: row.runs || [],
    }))
  }

  async delete(compareId: string): Promise<void> {
    const db = this.getDb()
    // Load manifest to get run IDs before deleting
    const manifest = await this.loadManifestAsync(compareId)
    if (manifest && this.isComparisonManifestActive(manifest)) {
      throw new Error(`Cannot delete active comparison: ${compareId}`)
    }

    // Delete comparison (cascading won't delete runs — they're separate)
    const result = await db.run(
      `DELETE FROM comparisons
       WHERE id = ?
         AND (
           active_status IS NULL
           OR active_lease_expires_at IS NULL
           OR (
             active_status IN ('running', 'stopping')
             AND active_lease_expires_at IS NOT NULL
             AND active_lease_expires_at < ?
           )
         )`,
      [compareId, new Date().toISOString()]
    )
    if (manifest && result.meta.changes === 0) {
      throw new Error(`Cannot delete active comparison: ${compareId}`)
    }

    // Delete associated runs
    if (manifest) {
      const checkpointManager = orchestrator.getCheckpointManager()
      for (const run of manifest.runs) {
        await checkpointManager.delete(run.runId)
      }
    }
  }

  async loadReport(runId: string): Promise<BenchmarkResult | null> {
    const db = this.getDb()
    const { data, error } = await db
      .from("reports")
      .select("report_data")
      .eq("run_id", runId)
      .single()

    if (error || !data) return null
    return data.report_data as BenchmarkResult
  }

  async compare(options: CompareOptions): Promise<CompareResult> {
    const manifest = await this.createManifest(options)
    return this.executeRunsWithLease(manifest, options.userKeys)
  }

  async createManifest(options: CompareOptions): Promise<CompareManifest> {
    const { providers, benchmark, judgeModel, sampling, userId } = options
    const compareId = generateCompareId()

    logger.info(`Loading benchmark: ${benchmark}`)
    const benchmarkInstance = createBenchmark(benchmark)
    await benchmarkInstance.load()
    const allQuestions = benchmarkInstance.getQuestions()

    let targetQuestionIds: string[]
    if (sampling) {
      targetQuestionIds = selectQuestionsBySampling(allQuestions, sampling)
    } else {
      targetQuestionIds = allQuestions.map((q) => q.questionId)
    }

    const manifest: CompareManifest = {
      compareId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId: userId || null,
      benchmark,
      judge: judgeModel,
      sampling,
      targetQuestionIds,
      runs: providers.map((provider) => ({
        provider,
        runId: `${compareId}-${provider}`,
      })),
    }

    await this.saveManifest(manifest)
    logger.info(`Created comparison: ${compareId}`)
    logger.info(`Providers: ${providers.join(", ")}`)
    logger.info(`Questions: ${targetQuestionIds.length}`)

    return manifest
  }

  async resume(
    compareId: string,
    force?: boolean,
    userKeys?: Record<string, string>
  ): Promise<CompareResult> {
    if (force) {
      await this.delete(compareId)
      throw new Error(`Comparison ${compareId} deleted with --force. Start a new comparison.`)
    }

    const manifest = await this.loadManifestAsync(compareId)
    if (!manifest) {
      throw new Error(`Comparison not found: ${compareId}`)
    }

    logger.info(`Resuming comparison: ${manifest.compareId}`)
    return this.executeRunsWithLease(manifest, userKeys)
  }

  async executeRunsWithLease(
    manifest: CompareManifest,
    userKeys?: Record<string, string>
  ): Promise<CompareResult> {
    const leaseToken = await this.acquireComparisonLease(manifest.compareId)
    if (!leaseToken) {
      throw new Error(`Comparison is already active: ${manifest.compareId}`)
    }

    try {
      return await this.executeRuns(manifest, userKeys, leaseToken)
    } finally {
      await this.releaseComparisonLease(manifest.compareId, leaseToken)
    }
  }

  async executeRuns(
    manifest: CompareManifest,
    userKeys?: Record<string, string>,
    leaseToken?: string
  ): Promise<CompareResult> {
    logger.info(`Starting ${manifest.runs.length} parallel runs...`)

    // Register all runs in activeRuns before starting
    for (const run of manifest.runs) {
      startRun(run.runId, manifest.benchmark, manifest.userId)
    }

    const checkpointManager = orchestrator.getCheckpointManager()
    const stopPolling = this.startComparisonLeaseMaintenance(manifest, leaseToken)

    let results: PromiseSettledResult<void>[]
    try {
      results = await Promise.allSettled(
        manifest.runs.map(async (run) => {
          try {
            return await orchestrator.run({
              provider: run.provider as ProviderName,
              benchmark: manifest.benchmark as BenchmarkName,
              judgeModel: manifest.judge,
              runId: run.runId,
              userId: manifest.userId,
              userKeys,
              questionIds: manifest.targetQuestionIds,
            })
          } catch (error) {
            // Update checkpoint status to persist the failure state
            await checkpointManager.flush(run.runId)
            const checkpoint = await checkpointManager.load(run.runId)
            if (checkpoint) {
              checkpointManager.updateStatus(checkpoint, "failed")
              await checkpointManager.flush(run.runId)
            }
            throw error
          } finally {
            // Always unregister the run when done (success or failure)
            endRun(run.runId)
          }
        })
      )
    } finally {
      stopPolling()
    }

    const failures = results.filter((r) => r.status === "rejected")
    const successes = results.filter((r) => r.status === "fulfilled").length

    if (failures.length > 0) {
      logger.warn(`${failures.length} run(s) failed`)
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (result.status === "rejected") {
          logger.error(`  ${manifest.runs[i].provider}: ${result.reason}`)
        }
      }
    }

    if (successes > 0) {
      logger.success(`${successes} run(s) completed successfully`)
    }

    await this.saveManifest(manifest)

    return {
      compareId: manifest.compareId,
      manifest,
      successes,
      failures: failures.length,
    }
  }

  async getReports(manifest: CompareManifest): Promise<Array<{ provider: string; report: BenchmarkResult }>> {
    const reports: Array<{ provider: string; report: BenchmarkResult }> = []
    for (const run of manifest.runs) {
      const report = await this.loadReport(run.runId)
      if (report) {
        reports.push({ provider: run.provider, report })
      }
    }
    return reports
  }

  async printComparisonReport(manifest: CompareManifest): Promise<void> {
    const reports = await this.getReports(manifest)

    if (reports.length === 0) {
      logger.error("No reports found to compare")
      return
    }

    const pad = (s: string, n: number) => s.padEnd(n)
    const padNum = (n: number, width: number) => n.toString().padStart(width)
    const padPct = (n: number, width: number) => `${(n * 100).toFixed(1)}%`.padStart(width)

    console.log("\n" + "═".repeat(80))
    console.log(`                    COMPARISON: ${manifest.compareId}`)
    console.log(
      `                    Benchmark: ${manifest.benchmark} | Questions: ${manifest.targetQuestionIds.length} | Judge: ${manifest.judge}`
    )
    console.log("═".repeat(80))

    const sortedByAccuracy = [...reports].sort(
      (a, b) => b.report.summary.accuracy - a.report.summary.accuracy
    )
    const bestAccuracy = sortedByAccuracy[0]?.provider

    console.log("\nOVERALL ACCURACY")
    console.log(
      "┌" + "─".repeat(17) + "┬" + "─".repeat(10) + "┬" + "─".repeat(9) + "┬" + "─".repeat(10) + "┐"
    )
    console.log(
      "│ " +
        pad("Provider", 15) +
        " │ " +
        pad("Correct", 8) +
        " │ " +
        pad("Total", 7) +
        " │ " +
        pad("Accuracy", 8) +
        " │"
    )
    console.log(
      "├" + "─".repeat(17) + "┼" + "─".repeat(10) + "┼" + "─".repeat(9) + "┼" + "─".repeat(10) + "┤"
    )
    for (const { provider, report } of sortedByAccuracy) {
      const best = provider === bestAccuracy ? " ←" : ""
      console.log(
        "│ " +
          pad(provider, 15) +
          " │ " +
          padNum(report.summary.correctCount, 8) +
          " │ " +
          padNum(report.summary.totalQuestions, 7) +
          " │ " +
          padPct(report.summary.accuracy, 7) +
          best.padEnd(2) +
          " │"
      )
    }
    console.log(
      "└" + "─".repeat(17) + "┴" + "─".repeat(10) + "┴" + "─".repeat(9) + "┴" + "─".repeat(10) + "┘"
    )

    console.log("\nLATENCY (avg ms)")
    console.log(
      "┌" +
        "─".repeat(17) +
        "┬" +
        "─".repeat(9) +
        "┬" +
        "─".repeat(9) +
        "┬" +
        "─".repeat(10) +
        "┬" +
        "─".repeat(9) +
        "┐"
    )
    console.log(
      "│ " +
        pad("Provider", 15) +
        " │ " +
        pad("Ingest", 7) +
        " │ " +
        pad("Search", 7) +
        " │ " +
        pad("Evaluate", 8) +
        " │ " +
        pad("Total", 7) +
        " │"
    )
    console.log(
      "├" +
        "─".repeat(17) +
        "┼" +
        "─".repeat(9) +
        "┼" +
        "─".repeat(9) +
        "┼" +
        "─".repeat(10) +
        "┼" +
        "─".repeat(9) +
        "┤"
    )

    const latencyMins = {
      ingest: Math.min(...reports.map((r) => r.report.latency.ingest.mean)),
      search: Math.min(...reports.map((r) => r.report.latency.search.mean)),
      evaluate: Math.min(...reports.map((r) => r.report.latency.evaluate.mean)),
      total: Math.min(...reports.map((r) => r.report.latency.total.mean)),
    }

    for (const { provider, report } of reports) {
      const ingestMark = report.latency.ingest.mean === latencyMins.ingest ? "←" : " "
      const searchMark = report.latency.search.mean === latencyMins.search ? "←" : " "
      const evaluateMark = report.latency.evaluate.mean === latencyMins.evaluate ? "←" : " "
      const totalMark = report.latency.total.mean === latencyMins.total ? "←" : " "
      console.log(
        "│ " +
          pad(provider, 15) +
          " │ " +
          padNum(report.latency.ingest.mean, 6) +
          ingestMark +
          " │ " +
          padNum(report.latency.search.mean, 6) +
          searchMark +
          " │ " +
          padNum(report.latency.evaluate.mean, 7) +
          evaluateMark +
          " │ " +
          padNum(report.latency.total.mean, 6) +
          totalMark +
          " │"
      )
    }
    console.log(
      "└" +
        "─".repeat(17) +
        "┴" +
        "─".repeat(9) +
        "┴" +
        "─".repeat(9) +
        "┴" +
        "─".repeat(10) +
        "┴" +
        "─".repeat(9) +
        "┘"
    )

    const hasRetrieval = reports.some((r) => r.report.retrieval)
    if (hasRetrieval) {
      console.log(`\nRETRIEVAL EFFICIENCY`)
      console.log(
        "┌" +
          "─".repeat(17) +
          "┬" +
          "─".repeat(12) +
          "┬" +
          "─".repeat(14) +
          "┐"
      )
      console.log(
        "│ " +
          pad("Provider", 15) +
          " │ " +
          pad("Mem Prec", 10) +
          " │ " +
          pad("Context Size", 12) +
          " │"
      )
      console.log(
        "├" +
          "─".repeat(17) +
          "┼" +
          "─".repeat(12) +
          "┼" +
          "─".repeat(14) +
          "┤"
      )

      for (const { provider, report } of reports) {
        if (report.retrieval) {
          const r = report.retrieval
          console.log(
            "│ " +
              pad(provider, 15) +
              " │ " +
              padPct(r.memoryPrecision, 10) +
              " │ " +
              pad(`${r.totalChars}`, 12) +
              " │"
          )
        } else {
          console.log(
            "│ " +
              pad(provider, 15) +
              " │ " +
              pad("N/A", 10) +
              " │ " +
              pad("N/A", 12) +
              " │"
          )
        }
      }
      console.log(
        "└" +
          "─".repeat(17) +
          "┴" +
          "─".repeat(12) +
          "┴" +
          "─".repeat(14) +
          "┘"
      )
    }

    const allTypes = new Set<string>()
    for (const { report } of reports) {
      for (const type of Object.keys(report.byQuestionType)) {
        allTypes.add(type)
      }
    }

    if (allTypes.size > 0) {
      console.log("\nBY QUESTION TYPE")
      const providerWidth = 13
      const headerRow = ["│ " + pad("Type", 17)]
      for (const { provider } of reports) {
        headerRow.push(pad(provider, providerWidth))
      }
      headerRow.push(pad("Best", 13) + " │")

      const borderTop =
        "┌" +
        "─".repeat(19) +
        reports.map(() => "┬" + "─".repeat(providerWidth + 2)).join("") +
        "┬" +
        "─".repeat(15) +
        "┐"
      const borderMid =
        "├" +
        "─".repeat(19) +
        reports.map(() => "┼" + "─".repeat(providerWidth + 2)).join("") +
        "┼" +
        "─".repeat(15) +
        "┤"
      const borderBot =
        "└" +
        "─".repeat(19) +
        reports.map(() => "┴" + "─".repeat(providerWidth + 2)).join("") +
        "┴" +
        "─".repeat(15) +
        "┘"

      console.log(borderTop)
      console.log(headerRow.join(" │ "))
      console.log(borderMid)

      for (const type of [...allTypes].sort()) {
        const row = ["│ " + pad(type, 17)]
        let bestProvider = ""
        let bestAccuracyForType = -1

        for (const { provider, report } of reports) {
          const stats = report.byQuestionType[type]
          if (stats) {
            row.push(padPct(stats.accuracy, providerWidth))
            if (stats.accuracy > bestAccuracyForType) {
              bestAccuracyForType = stats.accuracy
              bestProvider = provider
            }
          } else {
            row.push(pad("N/A", providerWidth))
          }
        }
        row.push(pad(bestProvider, 13) + " │")
        console.log(row.join(" │ "))
      }
      console.log(borderBot)
    }

    console.log("\n" + "═".repeat(80))
    if (bestAccuracy) {
      const bestReport = reports.find((r) => r.provider === bestAccuracy)?.report
      console.log(
        `WINNER: ${bestAccuracy} (${(bestReport!.summary.accuracy * 100).toFixed(1)}% overall accuracy)`
      )
    }
    console.log("═".repeat(80) + "\n")
  }
}

export const batchManager = new BatchManager()
