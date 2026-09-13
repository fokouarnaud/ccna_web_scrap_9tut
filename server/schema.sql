-- CCNA review app database schema.
-- Applied idempotently on every startup via CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  section TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('qa', 'generic')),
  intro TEXT,
  text TEXT,
  images TEXT NOT NULL DEFAULT '[]', -- JSON array, generic pages
  scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_url TEXT NOT NULL REFERENCES pages(url) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  text TEXT NOT NULL,
  choices TEXT NOT NULL DEFAULT '[]',  -- JSON [{letter, text}]
  answer TEXT NOT NULL DEFAULT '[]',   -- JSON ["A","B"]
  multi_answer INTEGER NOT NULL DEFAULT 0,
  explanation TEXT,
  reference TEXT,
  images TEXT NOT NULL DEFAULT '[]',   -- JSON array of image URLs
  UNIQUE (page_url, number)
);

CREATE INDEX IF NOT EXISTS idx_questions_page ON questions(page_url);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- question_key = "<page_url>::<question number>", matching the id scheme
-- already used by the frontend. Kept as a plain string (not a FK to
-- questions.id) so re-imports/re-scrapes never orphan a user's progress.
CREATE TABLE IF NOT EXISTS progress_seen (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, question_key)
);

CREATE TABLE IF NOT EXISTS progress_flagged (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  flagged_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, question_key)
);

CREATE TABLE IF NOT EXISTS quiz_stats (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS exam_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  label TEXT,
  mode TEXT,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  time_limit_seconds INTEGER NOT NULL,
  timed_out INTEGER NOT NULL DEFAULT 0,
  is_difficult_review INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_exam_history_user ON exam_history(user_id);

CREATE TABLE IF NOT EXISTS exam_question_results (
  exam_id INTEGER NOT NULL REFERENCES exam_history(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  given_letters TEXT NOT NULL DEFAULT '[]',
  time_seconds REAL NOT NULL DEFAULT 0,
  is_correct INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (exam_id, question_key)
);
