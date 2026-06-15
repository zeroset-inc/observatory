export default function MethodologyPage() {
  return (
    <div className="max-w-3xl mx-auto py-8 stagger-fade-in">
      {/* Header */}
      <header className="mb-16">
        <p className="text-xs uppercase tracking-[0.2em] text-accent mb-4">Methodology</p>
        <h1 className="text-3xl font-display font-medium text-text-primary tracking-tight mb-6">
          Measuring what matters in memory systems
        </h1>
        <p className="text-lg text-text-secondary leading-relaxed">
          Observatory is an open evaluation framework for AI memory layers.
          We believe rigorous, reproducible measurement is the foundation of progress.
          Every benchmark run, scoring decision, and latency measurement described here is
          implemented in{" "}
          <a
            href="https://github.com/zeroset-inc/observatory"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            open source code
          </a>
          .
        </p>
      </header>

      {/* --- Benchmarks --- */}
      <section className="mb-16">
        <h2 className="text-xs uppercase tracking-[0.2em] text-text-muted mb-6">Datasets</h2>

        <div className="space-y-10">
          <div>
            <h3 className="text-xl font-display font-medium text-text-primary mb-2">Atlas</h3>
            <p className="text-text-secondary leading-relaxed">
              Cognitive-based benchmarking for agentic memory systems from{" "}
              <a
                href="https://github.com/zeroset-inc/atlas"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Zeroset Research
              </a>
              . Evaluates six cognitive pillars — world modeling, declarative reasoning,
              temporal-episodic recall, preference learning, knowledge boundaries, and
              procedural knowledge — across 100 synthetically generated scenarios spanning
              simple and complex multi-session conversations.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-display font-medium text-text-primary mb-2">BEAM</h3>
            <p className="text-text-secondary leading-relaxed">
              Benchmarking long-term memory in LLMs from{" "}
              <a
                href="https://github.com/mohammadtavakoli78/BEAM"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Tavakoli et al.
              </a>
              . Evaluates ten memory abilities — abstention, contradiction resolution,
              event ordering, information extraction, instruction following, knowledge update,
              multi-session reasoning, preference following, summarization, and temporal
              reasoning — across 100K-token multi-turn conversations.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-display font-medium text-text-primary mb-2">LoCoMo</h3>
            <p className="text-text-secondary leading-relaxed">
              Long Conversation Memory from Snap Research. Multi-session dialogues with five
              question categories — single-hop recall, multi-hop reasoning, temporal ordering,
              world knowledge, and adversarial queries that should be unanswerable from the
              conversation alone.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-display font-medium text-text-primary mb-2">LongMemEval</h3>
            <p className="text-text-secondary leading-relaxed">
              Evaluates long-term memory across six dimensions: single-session user facts,
              single-session assistant facts, preferences, multi-session reasoning,
              temporal reasoning, and knowledge update tracking. Conversations span months
              of simulated interaction.
            </p>
          </div>
        </div>
      </section>

      {/* --- Pipeline --- */}
      <section className="mb-16 border-t border-border pt-16">
        <h2 className="text-xs uppercase tracking-[0.2em] text-text-muted mb-6">Evaluation Pipeline</h2>

        <p className="text-text-secondary leading-relaxed mb-8">
          Every question passes through a four-phase pipeline. Each phase is independently
          timed and checkpointed, enabling fine-grained performance analysis and run resumability.
        </p>

        <div className="grid grid-cols-4 gap-px bg-border rounded-lg overflow-hidden">
          {[
            { phase: "Ingest", desc: "Store conversation data into the memory layer" },
            { phase: "Index", desc: "Process and organize memories for retrieval" },
            { phase: "Search", desc: "Retrieve relevant context for the question" },
            { phase: "Evaluate", desc: "LLM judge scores the retrieved answer" },
          ].map((item) => (
            <div key={item.phase} className="bg-bg-surface/80 p-4">
              <div className="text-sm font-medium text-text-primary mb-1">{item.phase}</div>
              <div className="text-xs text-text-muted leading-relaxed">{item.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* --- Scoring --- */}
      <section className="mb-16 border-t border-border pt-16">
        <h2 className="text-xs uppercase tracking-[0.2em] text-text-muted mb-6">Scoring</h2>

        <p className="text-text-secondary leading-relaxed mb-6">
          A configurable LLM judge receives three inputs: the original question,
          the expected answer, and the context retrieved by the memory system under test.
          The judge returns a binary verdict — correct or incorrect — along with a
          natural language explanation. Accuracy is computed as the ratio of correct
          answers, both overall and per question type.
        </p>

        <p className="text-text-secondary leading-relaxed">
          The judge model is recorded with every run. Providers can be compared fairly
          only when evaluated by the same judge on the same benchmark.
        </p>
      </section>

      {/* --- Latency --- */}
      <section className="mb-16 border-t border-border pt-16">
        <h2 className="text-xs uppercase tracking-[0.2em] text-text-muted mb-6">Latency</h2>

        <p className="text-text-secondary leading-relaxed">
          For each pipeline phase we report full percentile distributions — min, max,
          mean, median, p95, p99, and standard deviation — across all questions in the
          run. This captures both typical performance and tail latency behavior that
          averages alone would hide.
        </p>
      </section>

      {/* --- Retrieval Efficiency --- */}
      <section className="mb-16 border-t border-border pt-16">
        <h2 className="text-xs uppercase tracking-[0.2em] text-text-muted mb-6">Retrieval Efficiency</h2>

        <p className="text-text-secondary leading-relaxed mb-8">
          Rather than traditional information retrieval metrics that assume ranked-list
          architectures, Observatory measures retrieval efficiency with architecture-agnostic
          metrics that work across vector, graph, filesystem, and hybrid memory systems.
        </p>

        <div className="space-y-4">
          {[
            { metric: "Memory Precision", desc: "What fraction of retrieved context was actually relevant? Measured by character count." },
            { metric: "Context Size", desc: "Total characters of retrieved context. A proxy for efficiency — less is better when accuracy is equal." },
          ].map((item) => (
            <div key={item.metric} className="flex items-baseline gap-4">
              <span className="text-sm font-mono text-text-primary w-40 flex-shrink-0">
                {item.metric}
              </span>
              <span className="text-sm text-text-secondary">{item.desc}</span>
            </div>
          ))}
        </div>
      </section>

      {/* --- Reproducibility --- */}
      <section className="mb-16 border-t border-border pt-16">
        <h2 className="text-xs uppercase tracking-[0.2em] text-text-muted mb-6">Reproducibility</h2>

        <div className="space-y-6">
          <p className="text-text-secondary leading-relaxed">
            Datasets are downloaded from their official sources — LoCoMo and Atlas from GitHub,
            LongMemEval and BEAM from HuggingFace. The evaluation pipeline processes
            questions through a deterministic sequence with consistent parameters.
            Results are checkpointed at each phase.
          </p>

          <p className="text-text-secondary leading-relaxed">
            Every leaderboard entry captures the provider's integration code alongside
            its results. Anyone can inspect exactly how a memory system was configured,
            what prompts were used, and how it was queried — then reproduce the run
            themselves.
          </p>
        </div>
      </section>

      {/* --- CTA --- */}
      <section className="border border-border rounded-lg p-8 text-center">
        <p className="text-text-secondary mb-4">
          Observatory is open to all memory system providers.
        </p>
        <a
          href="https://github.com/zeroset-inc/observatory"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent/90 transition-colors"
        >
          View on GitHub
        </a>
      </section>
    </div>
  )
}
