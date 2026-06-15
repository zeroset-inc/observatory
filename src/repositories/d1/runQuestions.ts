import { db } from "../../server/db"
import type { QuestionCheckpoint } from "../../types/checkpoint"

type QuestionRow = {
  question_id: string
  container_tag: string
  question: string
  ground_truth: string
  question_type: string
  question_date: string | null
  sessions: unknown
  phase_ingest: unknown
  phase_indexing: unknown
  phase_search: unknown
  phase_evaluate: unknown
}

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value !== "string") return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function questionFromRow(row: QuestionRow): QuestionCheckpoint {
  return {
    questionId: row.question_id,
    containerTag: row.container_tag,
    question: row.question,
    groundTruth: row.ground_truth,
    questionType: row.question_type,
    questionDate: row.question_date ?? undefined,
    sessions: parseJsonValue(row.sessions, undefined),
    phases: {
      ingest: parseJsonValue(row.phase_ingest, { status: "pending", completedSessions: [] }),
      indexing: parseJsonValue(row.phase_indexing, { status: "pending" }),
      search: parseJsonValue(row.phase_search, { status: "pending" }),
      evaluate: parseJsonValue(row.phase_evaluate, { status: "pending" }),
    },
  }
}

function questionStatusSql(status: string | null): string | null {
  if (status === "completed") return "json_extract(phase_evaluate, '$.status') = 'completed'"
  if (status === "failed") return "json_extract(phase_evaluate, '$.status') = 'failed'"
  if (status === "pending") {
    return "COALESCE(json_extract(phase_evaluate, '$.status'), 'pending') NOT IN ('completed', 'failed')"
  }
  return null
}

export async function listRunQuestions(input: {
  runId: string
  page: number
  limit: number
  status: string | null
  type: string | null
}): Promise<{ questions: QuestionCheckpoint[]; total: number; benchmark: string } | null> {
  const run = await db.first<{ benchmark: string }>("SELECT benchmark FROM runs WHERE id = ?", [
    input.runId,
  ])
  if (!run) return null

  const where = ["run_id = ?"]
  const bindings: unknown[] = [input.runId]
  const statusSql = questionStatusSql(input.status)
  if (statusSql) where.push(statusSql)
  if (input.type) {
    where.push("question_type = ?")
    bindings.push(input.type)
  }

  const whereSql = `WHERE ${where.join(" AND ")}`
  const count = await db.first<{ total: number }>(
    `SELECT COUNT(*) AS total FROM questions ${whereSql}`,
    bindings
  )
  const rows = await db.all<QuestionRow>(
    `SELECT question_id, container_tag, question, ground_truth, question_type,
            question_date, sessions, phase_ingest, phase_indexing, phase_search, phase_evaluate
     FROM questions
     ${whereSql}
     ORDER BY question_id ASC
     LIMIT ? OFFSET ?`,
    [...bindings, input.limit, (input.page - 1) * input.limit]
  )

  return {
    questions: rows.map(questionFromRow),
    total: count?.total ?? 0,
    benchmark: run.benchmark,
  }
}

export async function getRunQuestion(
  runId: string,
  questionId: string
): Promise<QuestionCheckpoint | null> {
  const row = await db.first<QuestionRow>(
    `SELECT question_id, container_tag, question, ground_truth, question_type,
            question_date, sessions, phase_ingest, phase_indexing, phase_search, phase_evaluate
     FROM questions
     WHERE run_id = ?
       AND question_id = ?`,
    [runId, questionId]
  )
  return row ? questionFromRow(row) : null
}
