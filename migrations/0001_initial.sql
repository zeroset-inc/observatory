CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  nebula_user_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_nebula_user_id
ON profiles(nebula_user_id)
WHERE nebula_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key_name TEXT NOT NULL CHECK (key_name IN ('supermemory', 'mem0', 'zep', 'nebula', 'openai', 'anthropic', 'google')),
  encrypted_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, key_name)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  user_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  data_source_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'initializing' CHECK (status IN ('initializing', 'running', 'completed', 'failed', 'interrupted')),
  active_status TEXT CHECK (active_status IN ('running', 'stopping')),
  provider TEXT NOT NULL,
  benchmark TEXT NOT NULL,
  judge TEXT NOT NULL,
  "limit" INTEGER,
  sampling TEXT,
  target_question_ids TEXT,
  concurrency TEXT,
  search_effort TEXT,
  total_questions INTEGER NOT NULL DEFAULT 0,
  ingested_count INTEGER NOT NULL DEFAULT 0,
  indexed_count INTEGER NOT NULL DEFAULT 0,
  searched_count INTEGER NOT NULL DEFAULT 0,
  evaluated_count INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  active_execution_token TEXT,
  active_lease_expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_active ON runs(active_status) WHERE active_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_active_lease ON runs(active_lease_expires_at) WHERE active_status IS NOT NULL;

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  container_tag TEXT NOT NULL,
  question TEXT NOT NULL,
  ground_truth TEXT NOT NULL,
  question_type TEXT NOT NULL,
  question_date TEXT,
  sessions TEXT,
  phase_ingest TEXT NOT NULL DEFAULT '{"status":"pending","completedSessions":[]}',
  phase_indexing TEXT NOT NULL DEFAULT '{"status":"pending"}',
  phase_search TEXT NOT NULL DEFAULT '{"status":"pending"}',
  phase_answer TEXT NOT NULL DEFAULT '{"status":"pending"}',
  phase_evaluate TEXT NOT NULL DEFAULT '{"status":"pending"}',
  UNIQUE(run_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_questions_run ON questions(run_id);
CREATE INDEX IF NOT EXISTS idx_questions_type ON questions(question_type);

CREATE TABLE IF NOT EXISTS search_results (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  results TEXT NOT NULL DEFAULT '[]',
  metadata TEXT,
  UNIQUE(run_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_search_results_run ON search_results(run_id);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  report_data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  benchmark TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  accuracy REAL NOT NULL,
  total_questions INTEGER NOT NULL,
  correct_count INTEGER NOT NULL,
  by_question_type TEXT NOT NULL,
  retrieval TEXT,
  latency_stats TEXT,
  evaluations TEXT,
  provider_code TEXT NOT NULL,
  prompts_used TEXT,
  judge_model TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  notes TEXT,
  UNIQUE(user_id, provider, benchmark, version)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_accuracy ON leaderboard_entries(accuracy DESC);

CREATE TABLE IF NOT EXISTS comparisons (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  benchmark TEXT NOT NULL,
  judge TEXT NOT NULL,
  sampling TEXT,
  target_question_ids TEXT NOT NULL DEFAULT '[]',
  runs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  active_status TEXT CHECK (active_status IN ('running', 'stopping')),
  active_lease_expires_at TEXT,
  active_lease_token TEXT
);
CREATE INDEX IF NOT EXISTS idx_comparisons_active ON comparisons(active_status) WHERE active_status IS NOT NULL;

CREATE TABLE IF NOT EXISTS runner_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('run.start', 'compare.execute')),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'executing', 'completed', 'failed', 'cancelled')),
  execution_token TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_expires_at TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  claim_token TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_jobs_token ON runner_jobs(execution_token);
CREATE INDEX IF NOT EXISTS idx_runner_jobs_target ON runner_jobs(kind, target_id);
CREATE INDEX IF NOT EXISTS idx_runner_jobs_status ON runner_jobs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_runner_jobs_target_status_created ON runner_jobs(kind, target_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS runner_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'run.bootstrap',
    'run.ingest_question',
    'run.index_question',
    'run.search_question',
    'run.evaluate_question',
    'run.generate_report',
    'run.finalize',
    'compare.bootstrap',
    'compare.aggregate',
    'leaderboard.publish'
  )),
  target_type TEXT NOT NULL CHECK (target_type IN ('run', 'comparison')),
  target_id TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  compare_id TEXT REFERENCES comparisons(id) ON DELETE CASCADE,
  question_id TEXT,
  phase TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'executing', 'completed', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  claim_token TEXT,
  lease_expires_at TEXT,
  idempotency_key TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  payload_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_runner_tasks_job ON runner_tasks(job_id);
CREATE INDEX IF NOT EXISTS idx_runner_tasks_claim ON runner_tasks(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_runner_tasks_target ON runner_tasks(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_runner_tasks_run_phase ON runner_tasks(run_id, phase, status);
CREATE INDEX IF NOT EXISTS idx_runner_tasks_run_execution_status
ON runner_tasks(run_id, status, job_id)
WHERE run_id IS NOT NULL AND status IN ('queued', 'executing');
CREATE INDEX IF NOT EXISTS idx_runner_tasks_compare_execution_status
ON runner_tasks(compare_id, status, job_id)
WHERE compare_id IS NOT NULL AND status IN ('queued', 'executing');

CREATE TABLE IF NOT EXISTS run_phase_progress (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('ingest', 'indexing', 'search', 'evaluate')),
  total INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (run_id, phase)
);
CREATE INDEX IF NOT EXISTS idx_run_phase_progress_run_phase ON run_phase_progress(run_id, phase);
