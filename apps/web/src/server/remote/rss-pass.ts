import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { AppDb } from "@/server/db/client";
import { users } from "@/server/db/schema";

/**
 * Per-user credentials for the companion's RSS feeds. The username is the
 * account's full email (URL-encoded inside feed URLs); the password is
 * generated here and stored plaintext (the settings UI has to display it),
 * but only its SHA-256 ever leaves home — the publisher pushes hashes, the
 * companion stores hashes.
 */

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 20 hex chars: URL-safe, colon-free, no escaping needed in podcast apps. */
function generateRssPass(): string {
  return randomBytes(10).toString("hex");
}

/**
 * The secret path segment that unlocks a user's feeds without a password.
 * Derived from the RSS password so regenerating the password also rotates
 * the token; never store or transmit it separately from that derivation.
 */
export function feedToken(rssPass: string): string {
  return sha256Hex(`owntube-feed-token:${rssPass}`).slice(0, 32);
}

/** The user's RSS password, generated and persisted on first use. */
export function ensureRssPass(db: AppDb, userId: number): string {
  const row = db
    .select({ rssPass: users.rssPass })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (row?.rssPass) return row.rssPass;
  return regenerateRssPass(db, userId);
}

/**
 * Replace the password. `users` isn't watched by a dirty_at trigger (only
 * feed content is), so the new secret address wouldn't reach the feeds
 * server until the next interval publish (up to `intervalSec`) even though
 * the UI shows it immediately — stamp dirty_at directly so the in-app
 * publisher picks it up on its next tick (within `quietSec`).
 */
export function regenerateRssPass(db: AppDb, userId: number): string {
  const pass = generateRssPass();
  db.update(users)
    .set({ rssPass: pass, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(users.id, userId))
    .run();
  db.run(
    sql`UPDATE feed_publish_state SET dirty_at = unixepoch() WHERE id = 1`,
  );
  return pass;
}
