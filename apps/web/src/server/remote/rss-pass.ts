import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDb } from "@/server/db/client";
import { users } from "@/server/db/schema";

/**
 * Per-user credentials for the companion's RSS feeds. The username is the
 * account's email local part; the password is generated here and stored
 * plaintext (the settings UI has to display it), but only its SHA-256 ever
 * leaves home — the publisher pushes hashes, the companion stores hashes.
 */

export function rssUsername(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 20 hex chars: URL-safe, colon-free, no escaping needed in podcast apps. */
function generateRssPass(): string {
  return randomBytes(10).toString("hex");
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

/** Replace the password. The companion learns the new hash at the next publish. */
export function regenerateRssPass(db: AppDb, userId: number): string {
  const pass = generateRssPass();
  db.update(users)
    .set({ rssPass: pass, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(users.id, userId))
    .run();
  return pass;
}
