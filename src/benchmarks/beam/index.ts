import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  UnifiedQuestion,
  UnifiedSession,
  UnifiedMessage,
  QuestionTypeRegistry,
} from "../../types/unified"
import type { BeamConversation, BeamChatMessage, BeamProbingQuestion } from "./types"
import { logger } from "../../utils/logger"
import { isWorkerRuntime } from "../../server/runtime"

const DEFAULT_DATA_DIR = "./data/benchmarks/beam"
const HF_DATASET = "Mohammadta/BEAM"
const HF_API_URL = `https://datasets-server.huggingface.co/rows?dataset=${HF_DATASET}&config=default&split=100K`

export const BEAM_QUESTION_TYPES: QuestionTypeRegistry = {
  abstention: {
    id: "abstention",
    alias: "abstain",
    description: "Withhold answers when evidence is missing",
  },
  contradiction_resolution: {
    id: "contradiction_resolution",
    alias: "contradict",
    description: "Detect and resolve inconsistencies across turns",
  },
  event_ordering: {
    id: "event_ordering",
    alias: "event-order",
    description: "Reconstruct sequence of events from conversation",
  },
  information_extraction: {
    id: "information_extraction",
    alias: "extract",
    description: "Recall entities and facts from conversation",
  },
  instruction_following: {
    id: "instruction_following",
    alias: "instruct",
    description: "Sustained adherence to user constraints",
  },
  knowledge_update: {
    id: "knowledge_update",
    alias: "update",
    description: "Revise facts as new information appears",
  },
  multi_session_reasoning: {
    id: "multi_session_reasoning",
    alias: "multi",
    description: "Integrate evidence across conversation segments",
  },
  preference_following: {
    id: "preference_following",
    alias: "pref",
    description: "Personalized, adaptive responses based on user preferences",
  },
  summarization: {
    id: "summarization",
    alias: "summary",
    description: "Abstract and compress dialogue content",
  },
  temporal_reasoning: {
    id: "temporal_reasoning",
    alias: "temporal",
    description: "Reason about time relations across conversations",
  },
}

export class BeamBenchmark implements Benchmark {
  name = "beam"
  private questions: UnifiedQuestion[] = []
  private sessionsMap: Map<string, UnifiedSession[]> = new Map()

  async load(config?: BenchmarkConfig): Promise<void> {
    if (isWorkerRuntime()) {
      logger.info("Loading BEAM benchmark dataset from HuggingFace...")
      const conversations = await this.fetchDataset()
      for (const conversation of conversations) this.processConversation(conversation)
      logger.info(
        `Loaded BEAM benchmark: ${this.questions.length} probing questions from ${conversations.length} conversations`
      )
      return
    }

    const dataDir = config?.dataPath || DEFAULT_DATA_DIR
    const fullDir = join(process.cwd(), dataDir)
    const dataFile = join(fullDir, "beam_100k.json")

    if (!existsSync(dataFile)) {
      logger.info("Downloading BEAM benchmark dataset from HuggingFace...")
      await this.downloadDataset(fullDir, dataFile)
    }

    const conversations: BeamConversation[] = JSON.parse(readFileSync(dataFile, "utf8"))

    for (const conversation of conversations) {
      this.processConversation(conversation)
    }

    logger.info(
      `Loaded BEAM benchmark: ${this.questions.length} probing questions from ${conversations.length} conversations`
    )
  }

  private async downloadDataset(destDir: string, destFile: string): Promise<void> {
    mkdirSync(destDir, { recursive: true })
    const conversations = await this.fetchDataset()
    writeFileSync(destFile, JSON.stringify(conversations, null, 2))
    logger.success(`Downloaded ${conversations.length} BEAM conversations (100K split)`)
  }

  private async fetchDataset(): Promise<BeamConversation[]> {
    const conversations: BeamConversation[] = []
    let offset = 0
    const pageSize = 100
    let hasMore = true

    while (hasMore) {
      const url = `${HF_API_URL}&offset=${offset}&length=${pageSize}`
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Failed to fetch BEAM dataset: ${response.status} ${response.statusText}`)
      }

      const data = await response.json() as { rows: Array<{ row: BeamConversation }>; num_rows_total: number }
      const rows = data.rows || []

      for (const row of rows) {
        conversations.push(row.row)
      }

      offset += rows.length
      hasMore = rows.length === pageSize && offset < data.num_rows_total

      if (offset % 100 === 0) {
        logger.info(`Downloaded ${offset} BEAM conversations...`)
      }
    }

    return conversations
  }

  private processConversation(conversation: BeamConversation): void {
    const convId = conversation.conversation_id

    // Build sessions from chat turns (each inner array is a session/batch)
    const sessions: UnifiedSession[] = []
    const chatGroups = conversation.chat

    for (let groupIdx = 0; groupIdx < chatGroups.length; groupIdx++) {
      const group = chatGroups[groupIdx]
      if (!Array.isArray(group)) continue

      const messages: UnifiedMessage[] = group.map((msg: BeamChatMessage) => ({
        role: msg.role as "user" | "assistant",
        content: msg.content,
        timestamp: msg.time_anchor,
      }))

      sessions.push({
        sessionId: `beam-${convId}-session-${groupIdx}`,
        messages,
        metadata: {
          conversationId: convId,
          timeAnchor: group[0]?.time_anchor,
        },
      })
    }

    const sessionIds = sessions.map((s) => s.sessionId)

    // Parse probing questions — stored as Python repr() string with single quotes
    let probingQuestions: Record<string, BeamProbingQuestion[]>
    if (typeof conversation.probing_questions === "string") {
      try {
        probingQuestions = parsePythonDict(conversation.probing_questions)
      } catch {
        logger.warn(`Failed to parse probing_questions for conversation ${convId}, skipping`)
        return
      }
    } else {
      probingQuestions = conversation.probing_questions
    }

    for (const [questionType, questions] of Object.entries(probingQuestions)) {
      if (!Array.isArray(questions)) continue

      for (let qIdx = 0; qIdx < questions.length; qIdx++) {
        const q = questions[qIdx]
        const groundTruth = q.ideal_response || q.ideal_answer || q.answer
          || q.expected_compliance || q.ideal_summary
        if (!q.question || !groundTruth) continue

        const questionId = `beam-${convId}-${questionType}-${qIdx}`

        this.questions.push({
          questionId,
          question: q.question,
          questionType,
          groundTruth,
          haystackSessionIds: sessionIds,
          metadata: {
            conversationId: convId,
            difficulty: q.difficulty,
            category: conversation.conversation_seed?.category,
            theme: conversation.conversation_seed?.theme,
          },
        })

        this.sessionsMap.set(questionId, sessions)
      }
    }
  }

  getQuestions(filter?: QuestionFilter): UnifiedQuestion[] {
    let result = [...this.questions]

    if (filter?.questionTypes?.length) {
      result = result.filter((q) => filter.questionTypes!.includes(q.questionType))
    }

    if (filter?.offset) {
      result = result.slice(filter.offset)
    }

    if (filter?.limit) {
      result = result.slice(0, filter.limit)
    }

    return result
  }

  getHaystackSessions(questionId: string): UnifiedSession[] {
    return this.sessionsMap.get(questionId) || []
  }

  getGroundTruth(questionId: string): string {
    const question = this.questions.find((q) => q.questionId === questionId)
    return question?.groundTruth || ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return BEAM_QUESTION_TYPES
  }
}

export default BeamBenchmark

/**
 * Parse a Python dict/list literal string into a JS object.
 * Handles single-quoted strings with embedded apostrophes, True/False/None.
 */
function parsePythonDict(src: string): any {
  let i = 0

  function skipWhitespace() {
    while (i < src.length && /\s/.test(src[i])) i++
  }

  function parseValue(): any {
    skipWhitespace()
    const ch = src[i]
    if (ch === "{") return parseDict()
    if (ch === "[") return parseList()
    if (ch === "'") return parseString()
    if (ch === '"') return parseDoubleString()
    // True, False, None
    if (src.startsWith("True", i)) { i += 4; return true }
    if (src.startsWith("False", i)) { i += 5; return false }
    if (src.startsWith("None", i)) { i += 4; return null }
    // Number
    const numMatch = src.slice(i).match(/^-?\d+(\.\d+)?/)
    if (numMatch) { i += numMatch[0].length; return Number(numMatch[0]) }
    throw new Error(`Unexpected char at ${i}: ${src.slice(i, i + 20)}`)
  }

  function parseString(): string {
    i++ // skip opening '
    let result = ""
    while (i < src.length) {
      if (src[i] === "\\") {
        i++
        if (src[i] === "'") { result += "'"; i++ }
        else if (src[i] === "\\") { result += "\\"; i++ }
        else if (src[i] === "n") { result += "\n"; i++ }
        else if (src[i] === "t") { result += "\t"; i++ }
        else { result += src[i]; i++ }
      } else if (src[i] === "'") {
        i++ // skip closing '
        return result
      } else {
        result += src[i]
        i++
      }
    }
    return result
  }

  function parseDoubleString(): string {
    i++ // skip opening "
    let result = ""
    while (i < src.length) {
      if (src[i] === "\\") {
        i++
        if (src[i] === '"') { result += '"'; i++ }
        else if (src[i] === "\\") { result += "\\"; i++ }
        else if (src[i] === "n") { result += "\n"; i++ }
        else if (src[i] === "t") { result += "\t"; i++ }
        else { result += src[i]; i++ }
      } else if (src[i] === '"') {
        i++
        return result
      } else {
        result += src[i]
        i++
      }
    }
    return result
  }

  function parseDict(): any {
    i++ // skip {
    const obj: any = {}
    skipWhitespace()
    if (src[i] === "}") { i++; return obj }
    while (i < src.length) {
      skipWhitespace()
      const key = parseValue()
      skipWhitespace()
      i++ // skip :
      skipWhitespace()
      obj[key] = parseValue()
      skipWhitespace()
      if (src[i] === ",") { i++; skipWhitespace() }
      if (src[i] === "}") { i++; return obj }
    }
    return obj
  }

  function parseList(): any {
    i++ // skip [
    const arr: any[] = []
    skipWhitespace()
    if (src[i] === "]") { i++; return arr }
    while (i < src.length) {
      arr.push(parseValue())
      skipWhitespace()
      if (src[i] === ",") { i++; skipWhitespace() }
      if (src[i] === "]") { i++; return arr }
    }
    return arr
  }

  return parseValue()
}
