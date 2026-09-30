CREATE TABLE IF NOT EXISTS anon_shorts_seen (
  anon_id text NOT NULL,
  video_id text NOT NULL,
  seen_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS anon_shorts_seen_anon_video_uidx
  ON anon_shorts_seen (anon_id, video_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS anon_shorts_seen_seen_idx
  ON anon_shorts_seen (seen_at);
