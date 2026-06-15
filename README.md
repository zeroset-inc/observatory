# Observatory

**An open evaluation framework for memory systems in AI agents.**

Memory is becoming core infrastructure for AI agents, yet there is no standard way to measure it. Observatory provides reproducible, multi-dimensional benchmarks for memory providers — and publishes all results to a public leaderboard.

**Leaderboard:** [observatory.trynebula.ai](https://observatory.trynebula.ai)

---

## Motivation

AI agents depend on memory to maintain context across sessions, recall user preferences, and reason over past interactions. Despite this, memory systems are evaluated through ad-hoc demos and vendor-specific claims — making it impossible to compare systems objectively.

Observatory addresses this by providing:

- **Standardized benchmarks** drawn from peer-reviewed research and cognitive science
- **A pluggable evaluation pipeline** that works with any memory provider exposing an API
- **LLM-as-judge scoring** with configurable judge models for transparent, reproducible evaluation
- **A public leaderboard** where every result can be independently verified

---

## Evaluation Dimensions

Observatory measures memory across six cognitive dimensions:

| Dimension | What it tests |
|-----------|---------------|
| **Single-hop recall** | Direct fact retrieval from conversation history |
| **Multi-hop reasoning** | Composing multiple memories to derive an answer |
| **Temporal reasoning** | Ordering events and reasoning about time |
| **Preference tracking** | Recalling stated preferences across sessions |
| **Knowledge updates** | Handling information that changes over time |
| **Adversarial queries** | Correctly abstaining when the answer is not in memory |

---

## Metrics

**Accuracy** — Binary correctness scored by an LLM judge against ground truth.

**Latency** — Per-phase timing (ingest, index, search, evaluate) with percentile breakdowns (p50, p95, p99).

**Retrieval quality** — Hit@K, Precision@K, Recall@K, F1@K, MRR, NDCG, and memory precision (relevant characters / total retrieved characters). Context size uses character length, not tokens, to remain model-neutral.

---

## Benchmarks

| Benchmark | Source | Focus |
|-----------|--------|-------|
| **Atlas** | [nebula-agi/atlas](https://github.com/nebula-agi/atlas) | Cognitive evaluation across 6 pillars: world modeling, declarative reasoning, temporal-episodic memory, preference learning, knowledge boundaries, and procedural knowledge |
| **LoCoMo** | [snap-research/locomo](https://github.com/snap-research/locomo) | Long-context memory over extended conversations |
| **LongMemEval** | [xiaowu0162/longmemeval](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) | Long-term memory evaluation across sessions |
| **BEAM** | [Mohammadta/BEAM](https://huggingface.co/datasets/Mohammadta/BEAM) | Long-term memory benchmark across 10 abilities |

All datasets auto-download on first use.

---

## Supported Providers

Any memory system with a retrieval API can be evaluated. Built-in integrations:

| Provider | Architecture |
|----------|-------------|
| [Mem0](https://mem0.ai) | Memory graph |
| [Nebula](https://trynebula.ai) | Hybrid retrieval |
| [Supermemory](https://supermemory.ai) | Vector retrieval |
| [Zep](https://getzep.com) | Graph-based memory |

See [src/providers/README.md](src/providers/README.md) for adding new providers.

---

## Pipeline

Each benchmark run executes a five-phase pipeline. Questions run concurrently with per-phase concurrency controls, and each phase checkpoints independently for fault tolerance.

```
INGEST  →  INDEX  →  SEARCH  →  EVALUATE  →  REPORT
```

1. **Ingest** — Load benchmark sessions into the memory provider
2. **Index** — Wait for the provider to finish indexing
3. **Search** — Query the provider and retrieve context
4. **Evaluate** — Score retrieved context against ground truth via LLM judge
5. **Report** — Aggregate accuracy, latency, and retrieval metrics

---

## Quick Start

```bash
bun install
cd ui && bun install
cd ..
bun run build
bun run db:migrate:local
bun dev
```

Add your API keys — at least one memory provider key and one LLM judge key.

- **Hosted** ([observatory.trynebula.ai](https://observatory.trynebula.ai)): Open **Settings** in the sidebar. Keys are encrypted per-user in Cloudflare D1 and persist across runs.
- **Self-hosted Worker**: copy `.env.example` to `.dev.vars` for local Wrangler development, or set production secrets with `wrangler secret put`:

```bash
cp .env.example .dev.vars
wrangler secret put OBSERVATORY_SECRET

# Memory providers (at least one)
MEM0_API_KEY=
NEBULA_API_KEY=
SUPERMEMORY_API_KEY=
ZEP_API_KEY=

# LLM judges (at least one)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=

# Browser allowlist for cross-origin UI requests
OBSERVATORY_ALLOWED_ORIGINS=http://localhost:3003
```

Deployments are owned by Cloudflare Workers now. Apply migrations with `bun run db:migrate:remote`, then deploy with `bun run deploy`.
Before the first deploy, create the D1 database with `wrangler d1 create observatory` and replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.toml` with the returned database ID.

The Worker entrypoint registers short background work with `ctx.waitUntil`, but full benchmark execution can exceed Worker post-response limits. Production-scale runs should be moved behind a durable runner, such as Cloudflare Queues plus Durable Objects or Workflows, so cancellation, retries, and progress are coordinated outside a single isolate.

If your UI runs on a different origin than the API, add that origin to `OBSERVATORY_ALLOWED_ORIGINS`. The server only sends `Access-Control-Allow-Origin` for allowlisted origins.

---

## Extending Observatory

| Component | Guide |
|-----------|-------|
| Add a provider | [src/providers/README.md](src/providers/README.md) |
| Add a benchmark | [src/benchmarks/README.md](src/benchmarks/README.md) |
| Add a judge | [src/judges/README.md](src/judges/README.md) |
| Project structure | [src/README.md](src/README.md) |

---

## Design Principles

**Transparency** — All benchmark code, datasets, and scoring methodology are open source.

**Reproducibility** — Every leaderboard result can be reproduced with the same configuration.

**Model neutrality** — No assumptions about tokenization or model providers.

**Architectural diversity** — Supports vector, graph, filesystem, hybrid, and custom memory architectures.

---

## Contributing

Contributions welcome — new benchmarks, provider integrations, scoring improvements, or bug reports. Open a pull request or issue.

---

## Maintainers

Built by the team at [Nebula](https://trynebula.ai).

## License

MIT
