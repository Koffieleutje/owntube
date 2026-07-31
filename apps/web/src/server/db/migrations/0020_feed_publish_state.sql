CREATE TABLE IF NOT EXISTS feed_publish_state (
  id integer PRIMARY KEY CHECK (id = 1),
  dirty_at integer NOT NULL DEFAULT 0,
  published_at integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT OR IGNORE INTO feed_publish_state (id, dirty_at, published_at) VALUES (1, 0, 0);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_queue_ins AFTER INSERT ON watch_queue
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_queue_del AFTER DELETE ON watch_queue
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_queue_upd AFTER UPDATE ON watch_queue
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_plitem_ins AFTER INSERT ON playlist_items
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_plitem_del AFTER DELETE ON playlist_items
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_plitem_upd AFTER UPDATE ON playlist_items
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_playlist_ins AFTER INSERT ON playlists
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_playlist_del AFTER DELETE ON playlists
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_playlist_upd AFTER UPDATE ON playlists
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_saved_ins AFTER INSERT ON interactions
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_saved_del AFTER DELETE ON interactions
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_sub_ins AFTER INSERT ON subscriptions
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_sub_del AFTER DELETE ON subscriptions
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_chtag_ins AFTER INSERT ON channel_tags
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS feed_dirty_chtag_del AFTER DELETE ON channel_tags
BEGIN UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1; END;
