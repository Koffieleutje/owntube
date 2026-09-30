CREATE TABLE IF NOT EXISTS api_tokens (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE cascade,
  label text NOT NULL,
  token_hash text NOT NULL,
  scopes text NOT NULL,
  created_at integer NOT NULL,
  last_used_at integer,
  revoked_at integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_hash_uidx ON api_tokens (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens (user_id);
