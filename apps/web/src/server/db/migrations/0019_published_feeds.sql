CREATE TABLE IF NOT EXISTS published_feeds (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  ref_id text NOT NULL,
  slug text NOT NULL,
  title text NOT NULL,
  updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS published_feeds_user_kind_ref_uidx
  ON published_feeds (user_id, kind, ref_id);
