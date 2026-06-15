PRAGMA foreign_keys=off;

CREATE TABLE IF NOT EXISTS profiles_nebula_auth (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  nebula_user_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO profiles_nebula_auth (
  id,
  display_name,
  email,
  avatar_url,
  nebula_user_id,
  created_at,
  updated_at
)
SELECT
  id,
  display_name,
  email,
  avatar_url,
  nebula_user_id,
  created_at,
  updated_at
FROM profiles;

DROP TABLE profiles;
ALTER TABLE profiles_nebula_auth RENAME TO profiles;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_nebula_user_id
ON profiles(nebula_user_id)
WHERE nebula_user_id IS NOT NULL;

DROP TABLE IF EXISTS auth_sessions;
DROP TABLE IF EXISTS auth_users;

PRAGMA foreign_keys=on;
