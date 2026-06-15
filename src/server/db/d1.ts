import { getRequiredRuntimeEnv } from "../runtime"

type QueryResult<T = any> = {
  data: T | null
  error: D1QueryError | null
  count?: number | null
}

type D1QueryError = {
  message: string
  code?: string
  details?: string
  name?: string
}

type Filter =
  | { op: "eq" | "neq" | "gte" | "lt"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "is_null" | "not_is_null"; column: string }

const JSON_COLUMNS = new Set([
  "sampling",
  "target_question_ids",
  "concurrency",
  "sessions",
  "phase_ingest",
  "phase_indexing",
  "phase_search",
  "phase_answer",
  "phase_evaluate",
  "results",
  "metadata",
  "report_data",
  "by_question_type",
  "latency_stats",
  "evaluations",
  "retrieval",
  "prompts_used",
  "runs",
  "payload",
])

const INSERT_IDS = new Set([
  "auth_users",
  "profiles",
  "user_api_keys",
  "questions",
  "search_results",
  "reports",
  "comparisons",
])

const DEFAULT_CONFLICTS: Record<string, string[]> = {
  auth_users: ["email"],
  profiles: ["id"],
  user_api_keys: ["user_id", "key_name"],
  runs: ["id"],
  questions: ["run_id", "question_id"],
  search_results: ["run_id", "question_id"],
  reports: ["run_id"],
  leaderboard_entries: ["run_id"],
  comparisons: ["id"],
}

const D1_MAX_BOUND_PARAMETERS = 100
const D1_BATCH_MAX_STATEMENTS = 50
const D1_BATCH_MAX_BINDING_BYTES = 512 * 1024

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`)
  }
  return `"${value}"`
}

function serializeValue(value: unknown): unknown {
  if (value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object" && value !== null) return JSON.stringify(value)
  return value
}

function deserializeRow(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...row }
  for (const key of Object.keys(out)) {
    if (!JSON_COLUMNS.has(key) || typeof out[key] !== "string") continue
    try {
      out[key] = JSON.parse(out[key])
    } catch {
      // Keep legacy/plain string data as-is.
    }
  }
  return out
}

function normalizeRows<T extends Record<string, any>>(table: string, values: T | T[]): T[] {
  const rows = Array.isArray(values) ? values : [values]
  return rows.map((input) => {
    const row: Record<string, any> = {}
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) row[key] = value
    }
    if (INSERT_IDS.has(table) && !row.id) {
      row.id = crypto.randomUUID()
    }
    return row as T
  })
}

function parseSelectColumns(selection: string): string {
  if (selection.includes("profiles:")) return "*"
  if (selection.trim() === "*") return "*"
  return selection
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(quoteIdent)
    .join(", ")
}

function singleNotFound(): D1QueryError {
  return {
    name: "PostgrestError",
    code: "PGRST116",
    message: "JSON object requested, multiple (or no) rows returned",
  }
}

function estimateBindingBytes(values: unknown[]): number {
  return values.reduce<number>((total, value) => {
    if (value === null || value === undefined) return total + 4
    if (typeof value === "string") return total + value.length
    if (typeof value === "number" || typeof value === "boolean") {
      return total + String(value).length
    }
    try {
      return total + JSON.stringify(value).length
    } catch {
      return total + String(value).length
    }
  }, 0)
}

function assertD1BindingLimit(table: string, operation: string, bindings: unknown[]): void {
  if (bindings.length <= D1_MAX_BOUND_PARAMETERS) return
  throw new Error(
    `D1 ${operation} for ${table} has ${bindings.length} bound parameters; max is ${D1_MAX_BOUND_PARAMETERS}`
  )
}

class D1QueryBuilder<T = any> implements PromiseLike<QueryResult<T>> {
  private action: "select" | "insert" | "upsert" | "update" | "delete" = "select"
  private selection = "*"
  private rows: Record<string, any>[] = []
  private patch: Record<string, any> = {}
  private filters: Filter[] = []
  private orderBy: { column: string; ascending: boolean } | null = null
  private maxRows: number | null = null
  private singleRow = false
  private maybeSingleRow = false
  private wantCount = false
  private headOnly = false
  private conflictColumns: string[] | null = null
  private ignoreDuplicates = false
  private returning: string | null = null

  constructor(private readonly db: D1Database, private readonly table: string) {}

  select(selection = "*", options?: { count?: "exact"; head?: boolean }): this {
    if (this.action !== "select") {
      this.returning = selection
    } else {
      this.selection = selection
    }
    this.wantCount = options?.count === "exact"
    this.headOnly = options?.head === true
    return this
  }

  insert(values: Record<string, any> | Record<string, any>[]): this {
    this.action = "insert"
    this.rows = normalizeRows(this.table, values)
    return this
  }

  upsert(
    values: Record<string, any> | Record<string, any>[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean }
  ): this {
    this.action = "upsert"
    this.rows = normalizeRows(this.table, values)
    this.conflictColumns = options?.onConflict
      ? options.onConflict.split(",").map((part) => part.trim())
      : null
    this.ignoreDuplicates = options?.ignoreDuplicates === true
    return this
  }

  update(values: Record<string, any>): this {
    this.action = "update"
    this.patch = values
    return this
  }

  delete(): this {
    this.action = "delete"
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ op: "eq", column, value })
    return this
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ op: "neq", column, value })
    return this
  }

  gte(column: string, value: unknown): this {
    this.filters.push({ op: "gte", column, value })
    return this
  }

  lt(column: string, value: unknown): this {
    this.filters.push({ op: "lt", column, value })
    return this
  }

  is(column: string, value: unknown): this {
    if (value === null) {
      this.filters.push({ op: "is_null", column })
      return this
    }
    throw new Error(`Unsupported D1 adapter filter: is(${column}, ${value})`)
  }

  in(column: string, values: unknown[]): this {
    this.filters.push({ op: "in", column, values })
    return this
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator === "is" && value === null) {
      this.filters.push({ op: "not_is_null", column })
      return this
    }
    throw new Error(`Unsupported D1 adapter filter: not(${column}, ${operator}, ${value})`)
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: options?.ascending !== false }
    return this
  }

  limit(count: number): this {
    this.maxRows = count
    return this
  }

  single(): this {
    this.singleRow = true
    return this
  }

  maybeSingle(): this {
    this.maybeSingleRow = true
    return this
  }

  abortSignal(..._args: unknown[]): this {
    return this
  }

  then<TResult1 = QueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  private whereClause(): { sql: string; bindings: unknown[] } {
    if (this.filters.length === 0) return { sql: "", bindings: [] }
    const parts: string[] = []
    const bindings: unknown[] = []
    for (const filter of this.filters) {
      if (filter.op === "is_null") {
        parts.push(`${quoteIdent(filter.column)} IS NULL`)
        continue
      }
      if (filter.op === "not_is_null") {
        parts.push(`${quoteIdent(filter.column)} IS NOT NULL`)
        continue
      }
      if (filter.op === "in") {
        if (filter.values.length === 0) {
          parts.push("1 = 0")
          continue
        }
        parts.push(`${quoteIdent(filter.column)} IN (${filter.values.map(() => "?").join(", ")})`)
        bindings.push(...filter.values.map(serializeValue))
        continue
      }
      const operator =
        filter.op === "eq" ? "=" : filter.op === "neq" ? "!=" : filter.op === "gte" ? ">=" : "<"
      parts.push(`${quoteIdent(filter.column)} ${operator} ?`)
      bindings.push(serializeValue((filter as { value: unknown }).value))
    }
    return { sql: ` WHERE ${parts.join(" AND ")}`, bindings }
  }

  private orderLimitClause(): string {
    let sql = ""
    if (this.orderBy) {
      sql += ` ORDER BY ${quoteIdent(this.orderBy.column)} ${this.orderBy.ascending ? "ASC" : "DESC"}`
    }
    if (this.maxRows !== null) sql += ` LIMIT ${this.maxRows}`
    return sql
  }

  private async execute(): Promise<QueryResult<T>> {
    try {
      if (this.action === "select") return await this.executeSelect()
      if (this.action === "insert") return await this.executeInsert(false)
      if (this.action === "upsert") return await this.executeInsert(true)
      if (this.action === "update") return await this.executeUpdate()
      return await this.executeDelete()
    } catch (error) {
      return {
        data: null,
        error: {
          name: "D1QueryError",
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  private async executeSelect(): Promise<QueryResult<T>> {
    const { sql: where, bindings } = this.whereClause()
    assertD1BindingLimit(this.table, "select", bindings)
    if (this.wantCount && this.headOnly) {
      const countRow = await this.db
        .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(this.table)}${where}`)
        .bind(...bindings)
        .first<{ count: number }>()
      return { data: null, error: null, count: countRow?.count ?? 0 }
    }

    const columns = parseSelectColumns(this.selection)
    const result = await this.db
      .prepare(`SELECT ${columns} FROM ${quoteIdent(this.table)}${where}${this.orderLimitClause()}`)
      .bind(...bindings)
      .all<Record<string, any>>()

    let rows = (result.results || []).map(deserializeRow)
    rows = await this.hydrateJoins(rows)
    return this.formatRows(rows)
  }

  private async executeInsert(isUpsert: boolean): Promise<QueryResult<T>> {
    const returned: Record<string, any>[] = []
    const statements: D1PreparedStatement[] = []
    let statementBindingBytes = 0
    const conflictColumns = this.conflictColumns || DEFAULT_CONFLICTS[this.table] || ["id"]
    const flushStatements = async () => {
      if (statements.length === 0) return
      const batch = statements.splice(0)
      statementBindingBytes = 0
      await this.db.batch(batch)
    }

    for (const row of this.rows) {
      const keys = Object.keys(row)
      const placeholders = keys.map(() => "?").join(", ")
      const values = keys.map((key) => serializeValue(row[key]))
      assertD1BindingLimit(this.table, "insert", values)
      const updateKeys = keys.filter((key) => !conflictColumns.includes(key))
      const conflict = isUpsert
        ? this.ignoreDuplicates || updateKeys.length === 0
          ? ` ON CONFLICT (${conflictColumns.map(quoteIdent).join(", ")}) DO NOTHING`
          : ` ON CONFLICT (${conflictColumns.map(quoteIdent).join(", ")}) DO UPDATE SET ${updateKeys
              .map((key) => `${quoteIdent(key)} = excluded.${quoteIdent(key)}`)
              .join(", ")}`
        : ""
      const returning = this.returning ? ` RETURNING ${parseSelectColumns(this.returning)}` : ""
      const sql = `INSERT INTO ${quoteIdent(this.table)} (${keys.map(quoteIdent).join(", ")}) VALUES (${placeholders})${conflict}${returning}`
      if (this.returning) {
        const result = await this.db.prepare(sql).bind(...values).all<Record<string, any>>()
        returned.push(...(result.results || []).map(deserializeRow))
      } else {
        const bindingBytes = estimateBindingBytes(values)
        if (
          statements.length >= D1_BATCH_MAX_STATEMENTS ||
          (statements.length > 0 &&
            statementBindingBytes + bindingBytes > D1_BATCH_MAX_BINDING_BYTES)
        ) {
          await flushStatements()
        }
        statements.push(this.db.prepare(sql).bind(...values))
        statementBindingBytes += bindingBytes
      }
    }
    if (!this.returning) await flushStatements()
    return this.returning ? this.formatRows(returned) : { data: null, error: null }
  }

  private async executeUpdate(): Promise<QueryResult<T>> {
    const keys = Object.keys(this.patch).filter((key) => this.patch[key] !== undefined)
    const values = keys.map((key) => serializeValue(this.patch[key]))
    const { sql: where, bindings } = this.whereClause()
    const returning = this.returning ? ` RETURNING ${parseSelectColumns(this.returning)}` : ""
    const sql = `UPDATE ${quoteIdent(this.table)} SET ${keys
      .map((key) => `${quoteIdent(key)} = ?`)
      .join(", ")}${where}${returning}`
    const bound = [...values, ...bindings]
    assertD1BindingLimit(this.table, "update", bound)
    if (this.returning) {
      const result = await this.db.prepare(sql).bind(...bound).all<Record<string, any>>()
      return this.formatRows((result.results || []).map(deserializeRow))
    }
    await this.db.prepare(sql).bind(...bound).run()
    return { data: null, error: null }
  }

  private async executeDelete(): Promise<QueryResult<T>> {
    const { sql: where, bindings } = this.whereClause()
    assertD1BindingLimit(this.table, "delete", bindings)
    await this.db.prepare(`DELETE FROM ${quoteIdent(this.table)}${where}`).bind(...bindings).run()
    return { data: null, error: null }
  }

  private async hydrateJoins(rows: Record<string, any>[]): Promise<Record<string, any>[]> {
    if (!this.selection.includes("profiles:") || rows.length === 0) return rows
    const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))]
    if (userIds.length === 0) return rows.map((row) => ({ ...row, profiles: null }))
    const profileRows: Record<string, any>[] = []
    for (const userIdChunk of chunks(userIds, D1_MAX_BOUND_PARAMETERS)) {
      const placeholders = userIdChunk.map(() => "?").join(", ")
      const profiles = await this.db
        .prepare(`SELECT id, display_name, avatar_url FROM profiles WHERE id IN (${placeholders})`)
        .bind(...userIdChunk)
        .all<Record<string, any>>()
      profileRows.push(...(profiles.results || []))
    }
    const byId = new Map(profileRows.map((row) => [row.id, row]))
    return rows.map((row) => ({ ...row, profiles: byId.get(row.user_id) ?? null }))
  }

  private formatRows(rows: Record<string, any>[]): QueryResult<T> {
    if (this.singleRow) {
      if (rows.length !== 1) return { data: null, error: singleNotFound() }
      return { data: rows[0] as T, error: null }
    }
    if (this.maybeSingleRow) {
      if (rows.length > 1) return { data: null, error: singleNotFound() }
      return { data: (rows[0] ?? null) as T | null, error: null }
    }
    return { data: rows as T, error: null }
  }
}

export class D1Client {
  constructor(private readonly db: D1Database) {}

  from<T = any>(table: string): D1QueryBuilder<T> {
    return new D1QueryBuilder<T>(this.db, table)
  }

  async run(sql: string, bindings: unknown[] = []): Promise<D1Result> {
    assertD1BindingLimit("raw", "run", bindings)
    return this.db.prepare(sql).bind(...bindings.map(serializeValue)).run()
  }
}

export function getD1Client(): D1Client {
  return new D1Client(getRequiredRuntimeEnv().OBSERVATORY_DB)
}

export const db = {
  from<T = any>(table: string): D1QueryBuilder<T> {
    return getD1Client().from<T>(table)
  },
  run(sql: string, bindings: unknown[] = []): Promise<D1Result> {
    return getD1Client().run(sql, bindings)
  },
}
