import type { Benchmark } from "../../types/benchmark"
import type { RunCheckpoint } from "../../types/checkpoint"
import type {
  BenchmarkResult,
  EvaluationResult,
  LatencyStats,
  QuestionTypeStats,
  RetrievalMetrics,
  RetrievalAggregates,
} from "../../types/unified"

import { logger } from "../../utils/logger"

function aggregateRetrievalMetrics(metrics: RetrievalMetrics[]): RetrievalAggregates | undefined {
  if (metrics.length === 0) return undefined

  const totalChars = metrics.reduce((sum, m) => sum + (m.totalChars ?? 0), 0)
  const relevantChars = metrics.reduce((sum, m) => sum + (m.relevantChars ?? 0), 0)

  return {
    memoryPrecision: totalChars > 0 ? relevantChars / totalChars : 0,
    totalChars,
  }
}

function calculateLatencyStats(durations: number[]): LatencyStats {
  if (durations.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdDev: 0, count: 0 }
  }

  const sorted = [...durations].sort((a, b) => a - b)
  const n = sorted.length
  const sum = sorted.reduce((a, b) => a + b, 0)
  const mean = sum / n

  const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n
  const stdDev = Math.sqrt(variance)

  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean: Math.round(mean),
    median: sorted[Math.floor(n / 2)],
    p95: sorted[Math.floor(n * 0.95)] || sorted[n - 1],
    p99: sorted[Math.floor(n * 0.99)] || sorted[n - 1],
    stdDev: Math.round(stdDev),
    count: n,
  }
}

export function generateReport(benchmark: Benchmark, checkpoint: RunCheckpoint): BenchmarkResult {
  const questions = benchmark.getQuestions()
  const evaluations: EvaluationResult[] = []

  const ingestDurations: number[] = []
  const indexingDurations: number[] = []
  const searchDurations: number[] = []
  const evaluateDurations: number[] = []
  const totalDurations: number[] = []

  const allRetrievalMetrics: RetrievalMetrics[] = []

  const byType: Record<
    string,
    {
      total: number
      correct: number
      searchDurations: number[]
      totalDurations: number[]
      retrievalMetrics: RetrievalMetrics[]
    }
  > = {}

  for (const question of questions) {
    const qCheckpoint = checkpoint.questions[question.questionId]
    if (!qCheckpoint) continue

    const evalPhase = qCheckpoint.phases.evaluate
    if (evalPhase.status !== "completed") continue

    const ingestPhase = qCheckpoint.phases.ingest
    const indexingPhase = qCheckpoint.phases.indexing
    const searchPhase = qCheckpoint.phases.search

    const ingestDurationMs = ingestPhase.durationMs || 0
    const indexingDurationMs = indexingPhase.durationMs || 0
    const searchDurationMs = searchPhase.durationMs || 0
    const evaluateDurationMs = evalPhase.durationMs || 0
    const totalDurationMs =
      ingestDurationMs +
      indexingDurationMs +
      searchDurationMs +
      evaluateDurationMs

    const retrievalMetrics = evalPhase.retrievalMetrics

    evaluations.push({
      questionId: question.questionId,
      questionType: question.questionType,
      question: question.question,
      score: evalPhase.score || 0,
      label: evalPhase.label || "incorrect",
      explanation: evalPhase.explanation || "",
      groundTruth: question.groundTruth,
      searchResults: searchPhase.results || [],
      searchDurationMs,
      totalDurationMs,
      retrievalMetrics,
    })

    if (retrievalMetrics) {
      allRetrievalMetrics.push(retrievalMetrics)
    }

    if (ingestPhase.durationMs) ingestDurations.push(ingestPhase.durationMs)
    if (indexingPhase.durationMs) indexingDurations.push(indexingPhase.durationMs)
    if (searchPhase.durationMs) searchDurations.push(searchPhase.durationMs)
    if (evalPhase.durationMs) evaluateDurations.push(evalPhase.durationMs)
    if (totalDurationMs > 0) totalDurations.push(totalDurationMs)

    const qType = question.questionType
    if (!byType[qType]) {
      byType[qType] = {
        total: 0,
        correct: 0,
        searchDurations: [],
        totalDurations: [],
        retrievalMetrics: [],
      }
    }
    const typeStats = byType[qType]!
    typeStats.total++
    if (evalPhase.score === 1) {
      typeStats.correct++
    }
    if (searchDurationMs) typeStats.searchDurations.push(searchDurationMs)
    if (totalDurationMs > 0) typeStats.totalDurations.push(totalDurationMs)
    if (retrievalMetrics) typeStats.retrievalMetrics.push(retrievalMetrics)
  }

  const byQuestionType: Record<string, QuestionTypeStats> = {}
  for (const type of Object.keys(byType)) {
    const raw = byType[type]!
    byQuestionType[type] = {
      total: raw.total,
      correct: raw.correct,
      accuracy: raw.total > 0 ? raw.correct / raw.total : 0,
      latency: {
        search: calculateLatencyStats(raw.searchDurations),
        total: calculateLatencyStats(raw.totalDurations),
      },
      retrieval: aggregateRetrievalMetrics(raw.retrievalMetrics),
    }
  }

  const overallRetrieval = aggregateRetrievalMetrics(allRetrievalMetrics)

  const totalQuestions = evaluations.length
  const correctCount = evaluations.filter((e) => e.score === 1).length
  const accuracy = totalQuestions > 0 ? correctCount / totalQuestions : 0

  const result: BenchmarkResult = {
    provider: checkpoint.provider,
    benchmark: checkpoint.benchmark,
    runId: checkpoint.runId,
    dataSourceRunId: checkpoint.dataSourceRunId,
    judge: checkpoint.judge,
    timestamp: new Date().toISOString(),
    summary: {
      totalQuestions,
      correctCount,
      accuracy,
    },
    latency: {
      ingest: calculateLatencyStats(ingestDurations),
      indexing: calculateLatencyStats(indexingDurations),
      search: calculateLatencyStats(searchDurations),
      evaluate: calculateLatencyStats(evaluateDurations),
      total: calculateLatencyStats(totalDurations),
    },
    retrieval: overallRetrieval,
    byQuestionType,
    questionTypeRegistry: benchmark.getQuestionTypes(),
    evaluations,
  }

  return result
}

export async function saveReport(result: BenchmarkResult): Promise<string> {
  const { db } = require("../../server/db")
  const { error } = await db.from("reports").upsert(
    {
      run_id: result.runId,
      report_data: result,
    },
    { onConflict: "run_id" }
  )

  if (error) {
    logger.warn(`Failed to save report to DB: ${error.message}`)
  } else {
    logger.success(`Report saved to database for run ${result.runId}`)
  }
  return `db://reports/${result.runId}`
}

function formatLatencyRow(stats: LatencyStats): string {
  const pad = (n: number) => n.toString().padStart(7)
  return `${pad(stats.min)} ${pad(stats.max)} ${pad(stats.mean)} ${pad(stats.median)} ${pad(stats.p95)} ${pad(stats.p99)}`
}

export function printReport(result: BenchmarkResult): void {
  console.log("\n" + "=".repeat(60))
  console.log("MARINA RESULTS")
  console.log("=".repeat(60))
  console.log(`Provider: ${result.provider}`)
  console.log(`Benchmark: ${result.benchmark}`)
  console.log(`Run ID: ${result.runId}`)
  console.log(`Data Source: ${result.dataSourceRunId}`)
  console.log(`Judge: ${result.judge}`)
  console.log("-".repeat(60))
  console.log("\nSUMMARY:")
  console.log(`  Total Questions: ${result.summary.totalQuestions}`)
  console.log(`  Correct: ${result.summary.correctCount}`)
  console.log(`  Accuracy: ${(result.summary.accuracy * 100).toFixed(2)}%`)
  console.log("-".repeat(60))
  console.log("\nLATENCY (ms):")
  console.log("                    min     max    mean  median     p95     p99")
  console.log(`  Ingest:       ${formatLatencyRow(result.latency.ingest)}`)
  console.log(`  Indexing:     ${formatLatencyRow(result.latency.indexing)}`)
  console.log(`  Search:       ${formatLatencyRow(result.latency.search)}`)
  console.log(`  Evaluate:     ${formatLatencyRow(result.latency.evaluate)}`)
  console.log(`  Total:        ${formatLatencyRow(result.latency.total)}`)

  if (result.retrieval) {
    console.log("-".repeat(60))
    console.log("\nRETRIEVAL EFFICIENCY:")
    console.log(`  Memory Precision:       ${(result.retrieval.memoryPrecision * 100).toFixed(1)}%`)
    console.log(`  Retrieved Context Size: ${result.retrieval.totalChars} chars`)
  }

  console.log("-".repeat(60))
  console.log("\nBY QUESTION TYPE:")
  for (const [type, stats] of Object.entries(result.byQuestionType)) {
    const typeInfo = result.questionTypeRegistry?.[type]
    const description = typeInfo?.description ? ` (${typeInfo.description})` : ""
    console.log(`  ${type}${description}:`)
    console.log(
      `    Total: ${stats.total}, Correct: ${stats.correct}, Accuracy: ${(stats.accuracy * 100).toFixed(2)}%`
    )
    console.log(
      `    Latency: search=${stats.latency.search.median}ms, total=${stats.latency.total.median}ms (median)`
    )
    if (stats.retrieval) {
      console.log(
        `    Memory Precision: ${(stats.retrieval.memoryPrecision * 100).toFixed(0)}%, Context: ${stats.retrieval.totalChars} chars`
      )
    }
  }
  console.log("=".repeat(60) + "\n")
}
