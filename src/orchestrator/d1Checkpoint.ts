import type { D1Client } from "../server/db"
import type {
  RunCheckpoint,
  QuestionCheckpoint,
  PhaseStatus,
  PhaseId,
  RunStatus,
  SamplingConfig,
} from "../types/checkpoint"
import type { ConcurrencyConfig } from "../types/concurrency"
import type { Provider } from "../types/provider"
import { PHASE_ORDER } from "../types/checkpoint"
import type { ICheckpointManager } from "./checkpoint"
import { logger } from "../utils/logger"

type D1CheckpointManagerOptions = {
  skipRunRecount?: boolean
}

/**
 * D1CheckpointManager — persists runs and questions to Cloudflare D1.
 *
 * The in-memory RunCheckpoint object is the working copy
 * during a run. `save()` is fire-and-forget — it queues a DB write. Phases read/write
 * the in-memory checkpoint, and `save()` flushes the current state to DB.
 */
export class D1CheckpointManager implements ICheckpointManager {
  private db: D1Client
  private saveLock = new Map<string, Promise<void>>()
  private dirtyQuestions = new Map<string, Set<string>>() // runId -> dirty questionIds
  private skipRunRecount: boolean

  constructor(db: D1Client, options?: D1CheckpointManagerOptions) {
    this.db = db
    this.skipRunRecount = options?.skipRunRecount === true
  }

  async exists(runId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("runs")
      .select("id")
      .eq("id", runId)
      .single()

    return !error && !!data
  }

  async load(runId: string): Promise<RunCheckpoint | null> {
    // Load run
    const { data: run, error: runError } = await this.db
      .from("runs")
      .select("*")
      .eq("id", runId)
      .single()

    if (runError || !run) return null

    // Load questions
    const { data: questions, error: qError } = await this.db
      .from("questions")
      .select("*")
      .eq("run_id", runId)

    if (qError) {
      logger.warn(`Failed to load questions for run ${runId}: ${qError.message}`)
      return null
    }

    return this.buildCheckpoint(run, questions || [])
  }

  async loadQuestion(runId: string, questionId: string): Promise<RunCheckpoint | null> {
    const { data: run, error: runError } = await this.db
      .from("runs")
      .select("*")
      .eq("id", runId)
      .single()

    if (runError || !run) return null

    const { data: question, error: qError } = await this.db
      .from("questions")
      .select("*")
      .eq("run_id", runId)
      .eq("question_id", questionId)
      .single()

    if (qError || !question) {
      logger.warn(`Failed to load question ${questionId} for run ${runId}: ${qError?.message || "not found"}`)
      return null
    }

    return this.buildCheckpoint(run, [question])
  }

  private buildCheckpoint(run: any, questions: any[]): RunCheckpoint {
    const questionsMap: Record<string, QuestionCheckpoint> = {}
    for (const q of questions) {
      questionsMap[q.question_id] = {
        questionId: q.question_id,
        containerTag: q.container_tag,
        question: q.question,
        groundTruth: q.ground_truth,
        questionType: q.question_type,
        questionDate: q.question_date,
        sessions: q.sessions,
        phases: {
          ingest: q.phase_ingest,
          indexing: q.phase_indexing,
          search: q.phase_search,
          evaluate: q.phase_evaluate,
        },
      }
    }

    return {
      runId: run.id,
      dataSourceRunId: run.data_source_run_id || run.id,
      userId: run.user_id || null,
      status: run.status as RunStatus,
      activeStatus: run.active_status || null,
      activeLeaseExpiresAt: run.active_lease_expires_at || null,
      provider: run.provider,
      benchmark: run.benchmark,
      judge: run.judge,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      limit: run.limit,
      sampling: run.sampling,
      targetQuestionIds: run.target_question_ids,
      concurrency: run.concurrency,
      searchEffort: run.search_effort,
      questions: questionsMap,
    }
  }

  save(checkpoint: RunCheckpoint, questionIds?: string[]): void {
    // If explicit questionIds are provided, use them directly (avoids
    // writing stale data for questions this caller didn't modify).
    // Otherwise snapshot and consume the dirty set atomically so concurrent
    // saves don't interfere. Falls back to all questions when nothing is tracked.
    let dirtySnapshot: Set<string>
    if (questionIds) {
      dirtySnapshot = new Set(questionIds)
    } else {
      const tracked = this.dirtyQuestions.get(checkpoint.runId)
      dirtySnapshot = tracked && tracked.size > 0
        ? new Set(tracked)
        : new Set(Object.keys(checkpoint.questions))
    }
    this.dirtyQuestions.set(checkpoint.runId, new Set())

    const currentQueue = this.saveLock.get(checkpoint.runId) || Promise.resolve()
    const nextQueue = currentQueue.then(() => this._performSave(checkpoint, dirtySnapshot))
    this.saveLock.set(checkpoint.runId, nextQueue)

    nextQueue.finally(() => {
      if (this.saveLock.get(checkpoint.runId) === nextQueue) {
        this.saveLock.delete(checkpoint.runId)
      }
    })
  }

  private async _performSave(checkpoint: RunCheckpoint, dirtyIds: Set<string>): Promise<void> {
    checkpoint.updatedAt = new Date().toISOString()

    // Upsert question rows first so summary counts reflect the latest state
    const questionRows = [...dirtyIds]
      .filter((qId) => checkpoint.questions[qId])
      .map((qId) => {
        const q = checkpoint.questions[qId]
        return {
          run_id: checkpoint.runId,
          question_id: q.questionId,
          container_tag: q.containerTag,
          question: q.question,
          ground_truth: q.groundTruth,
          question_type: q.questionType,
          question_date: q.questionDate || null,
          sessions: q.sessions || null,
          phase_ingest: q.phases.ingest,
          phase_indexing: q.phases.indexing,
          phase_search: q.phases.search,
          phase_evaluate: q.phases.evaluate,
        }
      })

    if (questionRows.length > 0) {
      const { error: qError } = await this.db
        .from("questions")
        .upsert(questionRows, { onConflict: "run_id,question_id" })

      if (qError) {
        logger.warn(`Failed to save questions for ${checkpoint.runId}: ${qError.message}`)
      }
    }

    if (this.skipRunRecount) {
      const { error: runError } = await this.db.from("runs").upsert({
        id: checkpoint.runId,
        slug: checkpoint.runId,
        user_id: checkpoint.userId || null,
        data_source_run_id: checkpoint.dataSourceRunId,
        status: checkpoint.status,
        provider: checkpoint.provider,
        benchmark: checkpoint.benchmark,
        judge: checkpoint.judge,
        limit: checkpoint.limit,
        sampling: checkpoint.sampling,
        target_question_ids: checkpoint.targetQuestionIds,
        concurrency: checkpoint.concurrency,
        search_effort: checkpoint.searchEffort,
        updated_at: checkpoint.updatedAt,
      })

      if (runError) {
        logger.warn(`Failed to save run ${checkpoint.runId}: ${runError.message}`)
      }
      return
    }

    // Compute summary counts from DB (not the in-memory checkpoint) so that
    // concurrent retries with separate checkpoint objects don't overwrite
    // each other's progress with stale counts.
    const { data: dbQuestions, error: countError } = await this.db
      .from("questions")
      .select("phase_ingest, phase_indexing, phase_search, phase_evaluate")
      .eq("run_id", checkpoint.runId)

    let totalQuestions = Object.keys(checkpoint.questions).length
    let ingestedCount = 0
    let indexedCount = 0
    let searchedCount = 0
    let evaluatedCount = 0
    let correctCount = 0

    if (!countError && dbQuestions) {
      totalQuestions = dbQuestions.length
      for (const q of dbQuestions) {
        if (q.phase_ingest?.status === "completed") ingestedCount++
        if (q.phase_indexing?.status === "completed") indexedCount++
        if (q.phase_search?.status === "completed") searchedCount++
        if (q.phase_evaluate?.status === "completed") {
          evaluatedCount++
          if (q.phase_evaluate?.score === 1) correctCount++
        }
      }
    } else {
      // Fallback to in-memory counts if DB query fails
      const questions = Object.values(checkpoint.questions)
      totalQuestions = questions.length
      ingestedCount = questions.filter((q) => q.phases.ingest.status === "completed").length
      indexedCount = questions.filter((q) => q.phases.indexing?.status === "completed").length
      searchedCount = questions.filter((q) => q.phases.search.status === "completed").length
      evaluatedCount = questions.filter((q) => q.phases.evaluate.status === "completed").length
      correctCount = questions.filter(
        (q) => q.phases.evaluate.status === "completed" && q.phases.evaluate.score === 1
      ).length
    }

    const accuracy = evaluatedCount > 0 ? correctCount / evaluatedCount : null

    // Upsert run row with DB-derived counts
    const { error: runError } = await this.db.from("runs").upsert({
      id: checkpoint.runId,
      slug: checkpoint.runId,
      user_id: checkpoint.userId || null,
      data_source_run_id: checkpoint.dataSourceRunId,
      status: checkpoint.status,
      provider: checkpoint.provider,
      benchmark: checkpoint.benchmark,
      judge: checkpoint.judge,
      limit: checkpoint.limit,
      sampling: checkpoint.sampling,
      target_question_ids: checkpoint.targetQuestionIds,
      concurrency: checkpoint.concurrency,
      search_effort: checkpoint.searchEffort,
      total_questions: totalQuestions,
      ingested_count: ingestedCount,
      indexed_count: indexedCount,
      searched_count: searchedCount,
      evaluated_count: evaluatedCount,
      correct_count: correctCount,
      accuracy,
      updated_at: checkpoint.updatedAt,
    })

    if (runError) {
      logger.warn(`Failed to save run ${checkpoint.runId}: ${runError.message}`)
    }
  }

  async flush(runId?: string): Promise<void> {
    if (runId) {
      await this.saveLock.get(runId)
    } else {
      await Promise.all(Array.from(this.saveLock.values()))
    }
  }

  async create(
    runId: string,
    provider: string,
    benchmark: string,
    judge: string,
    options?: {
      userId?: string | null
      limit?: number
      sampling?: SamplingConfig
      targetQuestionIds?: string[]
      dataSourceRunId?: string
      status?: RunStatus
      concurrency?: ConcurrencyConfig
      searchEffort?: "auto" | "low" | "medium" | "high"
    }
  ): Promise<RunCheckpoint> {
    const checkpoint: RunCheckpoint = {
      runId,
      dataSourceRunId: options?.dataSourceRunId || runId,
      userId: options?.userId || null,
      status: options?.status || "initializing",
      provider,
      benchmark,
      judge,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      limit: options?.limit,
      sampling: options?.sampling,
      targetQuestionIds: options?.targetQuestionIds,
      concurrency: options?.concurrency,
      searchEffort: options?.searchEffort,
      questions: {},
    }

    // Insert run row directly
    const { error } = await this.db.from("runs").insert({
      id: runId,
      slug: runId,
      user_id: options?.userId || null,
      data_source_run_id: options?.dataSourceRunId || runId,
      status: checkpoint.status,
      provider,
      benchmark,
      judge,
      limit: options?.limit,
      sampling: options?.sampling,
      target_question_ids: options?.targetQuestionIds,
      concurrency: options?.concurrency,
      search_effort: options?.searchEffort,
      total_questions: 0,
      created_at: checkpoint.createdAt,
      updated_at: checkpoint.updatedAt,
    })

    if (error) {
      throw new Error(`Failed to create run: ${error.message}`)
    }

    return checkpoint
  }

  async delete(runId: string): Promise<void> {
    // Cascading deletes handle questions, search_results, reports
    const { error } = await this.db.from("runs").delete().eq("id", runId)
    if (error) {
      logger.warn(`Failed to delete run ${runId}: ${error.message}`)
    } else {
      logger.info(`Deleted run: ${runId}`)
    }
  }

  async deleteWithCleanup(runId: string, provider: Provider): Promise<void> {
    try {
      const checkpoint = await this.load(runId)

      if (checkpoint && provider) {
        const containerTags = Object.values(checkpoint.questions)
          .map((q) => q.containerTag)
          .filter((tag, index, arr) => arr.indexOf(tag) === index)

        for (const containerTag of containerTags) {
          try {
            await provider.clear(containerTag)
            logger.info(`Cleared collection: ${containerTag}`)
          } catch (e) {
            logger.warn(`Failed to clear collection ${containerTag}: ${e}`)
          }
        }
      }
    } catch (e) {
      logger.warn(`Failed to load checkpoint for cleanup: ${e}`)
    }

    await this.delete(runId)
  }

  updateStatus(checkpoint: RunCheckpoint, status: RunStatus): void {
    checkpoint.status = status
    this.save(checkpoint)
  }

  async listRuns(): Promise<string[]> {
    const { data, error } = await this.db
      .from("runs")
      .select("id")
      .order("created_at", { ascending: true })

    if (error) {
      logger.warn(`Failed to list runs: ${error.message}`)
      return []
    }

    return (data || []).map((r: any) => r.id)
  }

  initQuestion(
    checkpoint: RunCheckpoint,
    questionId: string,
    containerTag: string,
    metadata: {
      question: string
      groundTruth: string
      questionType: string
      questionDate?: string
    }
  ): void {
    if (!checkpoint.questions[questionId]) {
      checkpoint.questions[questionId] = {
        questionId,
        containerTag,
        question: metadata.question,
        groundTruth: metadata.groundTruth,
        questionType: metadata.questionType,
        questionDate: metadata.questionDate,
        phases: {
          ingest: { status: "pending", completedSessions: [] },
          indexing: { status: "pending" },
          search: { status: "pending" },
          evaluate: { status: "pending" },
        },
      }
      // Mark as dirty
      const dirty = this.dirtyQuestions.get(checkpoint.runId) || new Set()
      dirty.add(questionId)
      this.dirtyQuestions.set(checkpoint.runId, dirty)
    }
  }

  updateSessions(
    checkpoint: RunCheckpoint,
    questionId: string,
    sessions: Array<{ sessionId: string; date?: string; messageCount: number }>
  ): void {
    const q = checkpoint.questions[questionId]
    if (!q) return
    q.sessions = sessions
    const dirty = this.dirtyQuestions.get(checkpoint.runId) || new Set()
    dirty.add(questionId)
    this.dirtyQuestions.set(checkpoint.runId, dirty)
    this.save(checkpoint)
  }

  updatePhase<P extends keyof QuestionCheckpoint["phases"]>(
    checkpoint: RunCheckpoint,
    questionId: string,
    phase: P,
    updates: Partial<QuestionCheckpoint["phases"][P]>
  ): void {
    const q = checkpoint.questions[questionId]
    if (!q) return

    Object.assign(q.phases[phase], updates)
    const dirty = this.dirtyQuestions.get(checkpoint.runId) || new Set()
    dirty.add(questionId)
    this.dirtyQuestions.set(checkpoint.runId, dirty)
    this.save(checkpoint)
  }

  getPhaseStatus(
    checkpoint: RunCheckpoint,
    questionId: string,
    phase: keyof QuestionCheckpoint["phases"]
  ): PhaseStatus {
    return checkpoint.questions[questionId]?.phases[phase].status || "pending"
  }

  getSummary(checkpoint: RunCheckpoint): {
    total: number
    ingested: number
    indexed: number
    searched: number
    evaluated: number
    indexingEpisodes?: {
      total: number
      completed: number
      failed: number
    }
  } {
    const questions = Object.values(checkpoint.questions)

    let episodesTotal = 0
    let episodesCompleted = 0
    let episodesFailed = 0

    for (const q of questions) {
      const ingestResult = q.phases.ingest.ingestResult
      const total = (ingestResult?.documentIds?.length || 0) + (ingestResult?.taskIds?.length || 0)
      episodesTotal += total

      const indexing = q.phases.indexing
      episodesCompleted += indexing?.completedIds?.length || 0
      episodesFailed += indexing?.failedIds?.length || 0
    }

    return {
      total: questions.length,
      ingested: questions.filter((q) => q.phases.ingest.status === "completed").length,
      indexed: questions.filter((q) => q.phases.indexing?.status === "completed").length,
      searched: questions.filter((q) => q.phases.search.status === "completed").length,
      evaluated: questions.filter((q) => q.phases.evaluate.status === "completed").length,
      ...(episodesTotal > 0
        ? {
            indexingEpisodes: {
              total: episodesTotal,
              completed: episodesCompleted,
              failed: episodesFailed,
            },
          }
        : {}),
    }
  }

  async copyCheckpoint(
    sourceRunId: string,
    newRunId: string,
    fromPhase: PhaseId,
    overrides?: { judge?: string; userId?: string | null }
  ): Promise<RunCheckpoint> {
    const source = await this.load(sourceRunId)
    if (!source) {
      throw new Error(`Source checkpoint not found: ${sourceRunId}`)
    }

    const fromIndex = PHASE_ORDER.indexOf(fromPhase)
    const phasesToReset = PHASE_ORDER.slice(fromIndex)

    const questionPhaseKeys: (keyof QuestionCheckpoint["phases"])[] = [
      "ingest",
      "indexing",
      "search",
      "evaluate",
    ]

    const newQuestions: Record<string, QuestionCheckpoint> = {}
    for (const [qId, q] of Object.entries(source.questions)) {
      const newQ: QuestionCheckpoint = JSON.parse(JSON.stringify(q))

      for (const phaseKey of questionPhaseKeys) {
        if (phasesToReset.includes(phaseKey as PhaseId)) {
          if (phaseKey === "ingest") {
            newQ.phases.ingest = { status: "pending", completedSessions: [] }
          } else if (phaseKey === "indexing") {
            newQ.phases.indexing = { status: "pending" }
          } else if (phaseKey === "search") {
            newQ.phases.search = { status: "pending" }
          } else if (phaseKey === "evaluate") {
            newQ.phases.evaluate = { status: "pending" }
          }
        }
      }

      newQuestions[qId] = newQ
    }

    const newCheckpoint: RunCheckpoint = {
      runId: newRunId,
      dataSourceRunId: source.dataSourceRunId || sourceRunId,
      userId: overrides?.userId !== undefined ? overrides.userId : source.userId,
      status: "running",
      provider: source.provider,
      benchmark: source.benchmark,
      judge: overrides?.judge || source.judge,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      limit: source.limit,
      sampling: source.sampling,
      targetQuestionIds: source.targetQuestionIds,
      concurrency: source.concurrency,
      searchEffort: source.searchEffort,
      questions: newQuestions,
    }

    // If keeping search results, copy them in DB
    if (fromIndex > PHASE_ORDER.indexOf("search")) {
      const { data: searchResults } = await this.db
        .from("search_results")
        .select("*")
        .eq("run_id", sourceRunId)

      if (searchResults && searchResults.length > 0) {
        const copied = searchResults.map((sr: any) => ({
          run_id: newRunId,
          question_id: sr.question_id,
          results: sr.results,
          metadata: sr.metadata,
        }))
        await this.db.from("search_results").upsert(copied, {
          onConflict: "run_id,question_id",
        })
      }
    }

    // Insert via create + save
    await this.db.from("runs").insert({
      id: newRunId,
      slug: newRunId,
      user_id: newCheckpoint.userId || null,
      data_source_run_id: newCheckpoint.dataSourceRunId,
      status: newCheckpoint.status,
      provider: newCheckpoint.provider,
      benchmark: newCheckpoint.benchmark,
      judge: newCheckpoint.judge,
      limit: newCheckpoint.limit,
      sampling: newCheckpoint.sampling,
      target_question_ids: newCheckpoint.targetQuestionIds,
      concurrency: newCheckpoint.concurrency,
      search_effort: newCheckpoint.searchEffort,
      total_questions: Object.keys(newQuestions).length,
      created_at: newCheckpoint.createdAt,
      updated_at: newCheckpoint.updatedAt,
    })

    // Insert all questions
    const questionRows = Object.values(newQuestions).map((q) => ({
      run_id: newRunId,
      question_id: q.questionId,
      container_tag: q.containerTag,
      question: q.question,
      ground_truth: q.groundTruth,
      question_type: q.questionType,
      question_date: q.questionDate || null,
      sessions: q.sessions || null,
      phase_ingest: q.phases.ingest,
      phase_indexing: q.phases.indexing,
      phase_search: q.phases.search,
      phase_evaluate: q.phases.evaluate,
    }))

    if (questionRows.length > 0) {
      await this.db
        .from("questions")
        .upsert(questionRows, { onConflict: "run_id,question_id" })
    }

    logger.info(
      `Created new checkpoint ${newRunId} from ${sourceRunId}, starting from ${fromPhase}`
    )

    return newCheckpoint
  }
}
