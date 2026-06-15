import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "fs"
import { join } from "path"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  UnifiedQuestion,
  UnifiedSession,
  UnifiedMessage,
  QuestionTypeRegistry,
} from "../../types/unified"
import type { AtlasBenchmarkFile } from "./types"
import { logger } from "../../utils/logger"
import { isWorkerRuntime } from "../../server/runtime"

const DEFAULT_DATA_DIR = "./data/benchmarks/atlas"
const GITHUB_BASE_URL = "https://raw.githubusercontent.com/nebula-agi/atlas/main"

const SIMPLE_FILES = [
  "benchmark_nebula_devtools_010", "benchmark_nebula_devtools_011", "benchmark_nebula_devtools_022",
  "benchmark_nebula_devtools_033", "benchmark_nebula_devtools_035", "benchmark_nebula_devtools_038",
  "benchmark_nebula_devtools_044", "benchmark_nebula_devtools_048", "benchmark_nebula_devtools_049",
  "benchmark_nebula_edtech_008", "benchmark_nebula_edtech_012", "benchmark_nebula_edtech_015",
  "benchmark_nebula_edtech_017", "benchmark_nebula_edtech_018", "benchmark_nebula_edtech_021",
  "benchmark_nebula_edtech_025", "benchmark_nebula_edtech_029", "benchmark_nebula_edtech_036",
  "benchmark_nebula_edtech_039", "benchmark_nebula_edtech_050",
  "benchmark_nebula_fintech_004", "benchmark_nebula_fintech_005", "benchmark_nebula_fintech_006",
  "benchmark_nebula_fintech_009", "benchmark_nebula_fintech_016", "benchmark_nebula_fintech_023",
  "benchmark_nebula_fintech_030", "benchmark_nebula_fintech_041", "benchmark_nebula_fintech_047",
  "benchmark_nebula_healthtech_002", "benchmark_nebula_healthtech_003", "benchmark_nebula_healthtech_013",
  "benchmark_nebula_healthtech_020", "benchmark_nebula_healthtech_027", "benchmark_nebula_healthtech_031",
  "benchmark_nebula_healthtech_034", "benchmark_nebula_healthtech_037", "benchmark_nebula_healthtech_045",
  "benchmark_nebula_logistics_001", "benchmark_nebula_logistics_007", "benchmark_nebula_logistics_014",
  "benchmark_nebula_logistics_019", "benchmark_nebula_logistics_024", "benchmark_nebula_logistics_026",
  "benchmark_nebula_logistics_028", "benchmark_nebula_logistics_032", "benchmark_nebula_logistics_040",
  "benchmark_nebula_logistics_042", "benchmark_nebula_logistics_043", "benchmark_nebula_logistics_046",
]

const COMPLEX_FILES = Array.from({ length: 50 }, (_, i) => `benchmark_complex_${String(i + 1).padStart(3, "0")}`)

/** Use pillars as the question type for Observatory's leaderboard grouping */
export const ATLAS_QUESTION_TYPES: QuestionTypeRegistry = {
  world_modeling: {
    id: "world_modeling",
    alias: "world",
    description: "Entity resolution & relationship mapping",
  },
  declarative_reasoning: {
    id: "declarative_reasoning",
    alias: "declarative",
    description: "Fact composition, belief revision & constraint propagation",
  },
  temporal_episodic: {
    id: "temporal_episodic",
    alias: "temporal",
    description: "Temporal sequencing, episode reconstruction & causal explanation",
  },
  preference_learning: {
    id: "preference_learning",
    alias: "preference",
    description: "Preference induction, drift & scope tracking",
  },
  knowledge_boundaries: {
    id: "knowledge_boundaries",
    alias: "boundaries",
    description: "Negative knowledge & confidence calibration",
  },
  procedural_knowledge: {
    id: "procedural_knowledge",
    alias: "procedural",
    description: "Procedure storage, lesson extraction & tool memory",
  },
}

export class AtlasBenchmark implements Benchmark {
  name = "atlas"
  private questions: UnifiedQuestion[] = []
  private sessionsMap: Map<string, UnifiedSession[]> = new Map()

  async load(config?: BenchmarkConfig): Promise<void> {
    if (isWorkerRuntime()) {
      logger.info("Loading Atlas benchmark dataset from GitHub...")
      for (const name of SIMPLE_FILES) {
        const data = await this.fetchFile(`${GITHUB_BASE_URL}/simple_test_set/${name}.json`)
        this.processFile(data, name, "simple")
      }
      for (const name of COMPLEX_FILES) {
        const data = await this.fetchFile(`${GITHUB_BASE_URL}/complex_test_set/${name}.json`)
        this.processFile(data, name, "complex")
      }
      logger.info(`Loaded Atlas benchmark: ${this.questions.length} probes`)
      return
    }

    const dataDir = config?.dataPath || DEFAULT_DATA_DIR
    const fullDir = join(process.cwd(), dataDir)

    const simpleDir = join(fullDir, "simple")
    const complexDir = join(fullDir, "complex")

    if (!existsSync(simpleDir) || !existsSync(complexDir)) {
      logger.info("Downloading Atlas benchmark dataset from GitHub...")
      await this.downloadDataset(fullDir)
    }

    const simpleFiles = readdirSync(simpleDir).filter((f) => f.endsWith(".json"))
    const complexFiles = readdirSync(complexDir).filter((f) => f.endsWith(".json"))

    let totalProbes = 0
    for (const file of simpleFiles) {
      const data: AtlasBenchmarkFile = JSON.parse(readFileSync(join(simpleDir, file), "utf8"))
      this.processFile(data, file.replace(".json", ""), "simple")
      totalProbes += data.probes.length
    }
    for (const file of complexFiles) {
      const data: AtlasBenchmarkFile = JSON.parse(readFileSync(join(complexDir, file), "utf8"))
      this.processFile(data, file.replace(".json", ""), "complex")
      totalProbes += data.probes.length
    }

    logger.info(
      `Loaded Atlas benchmark: ${this.questions.length} probes from ${simpleFiles.length + complexFiles.length} files`
    )
  }

  private async downloadDataset(destDir: string): Promise<void> {
    const simpleDir = join(destDir, "simple")
    const complexDir = join(destDir, "complex")
    mkdirSync(simpleDir, { recursive: true })
    mkdirSync(complexDir, { recursive: true })

    let downloaded = 0
    const total = SIMPLE_FILES.length + COMPLEX_FILES.length

    for (const name of SIMPLE_FILES) {
      const url = `${GITHUB_BASE_URL}/simple_test_set/${name}.json`
      const dest = join(simpleDir, `${name}.json`)
      await this.downloadFile(url, dest)
      downloaded++
      if (downloaded % 10 === 0) {
        logger.info(`Downloaded ${downloaded}/${total} Atlas files...`)
      }
    }

    for (const name of COMPLEX_FILES) {
      const url = `${GITHUB_BASE_URL}/complex_test_set/${name}.json`
      const dest = join(complexDir, `${name}.json`)
      await this.downloadFile(url, dest)
      downloaded++
      if (downloaded % 10 === 0) {
        logger.info(`Downloaded ${downloaded}/${total} Atlas files...`)
      }
    }

    logger.success(`Downloaded ${downloaded} Atlas benchmark files`)
  }

  private async downloadFile(url: string, dest: string): Promise<void> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status}`)
    }
    const data = await response.text()
    writeFileSync(dest, data)
  }

  private async fetchFile(url: string): Promise<AtlasBenchmarkFile> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`)
    return (await response.json()) as AtlasBenchmarkFile
  }

  private processFile(data: AtlasBenchmarkFile, fileId: string, testSet: string): void {
    // Build sessions for this file
    const sessions: UnifiedSession[] = data.sessions.map((s) => {
      const messages: UnifiedMessage[] = s.turns.map((t) => ({
        role: t.speaker as "user" | "assistant",
        content: t.text,
      }))
      return {
        sessionId: `${fileId}-${s.id}`,
        messages,
        metadata: {
          timestamp: s.timestamp,
          fileId,
          testSet,
        },
      }
    })

    const sessionIds = sessions.map((s) => s.sessionId)

    // Convert probes to unified questions
    for (const probe of data.probes) {
      const questionId = `${fileId}-${probe.id}`

      this.questions.push({
        questionId,
        question: probe.question,
        questionType: probe.pillar,
        groundTruth: probe.gold_answer.text,
        haystackSessionIds: sessionIds,
        metadata: {
          subpillar: probe.subpillar,
          answerType: probe.answer_type,
          supportingItems: probe.gold_answer.supporting_items,
          fileId,
          testSet,
        },
      })

      this.sessionsMap.set(questionId, sessions)
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
    return ATLAS_QUESTION_TYPES
  }
}

export default AtlasBenchmark
