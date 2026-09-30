import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users } from "@/server/db/schema";
import { createTestDb } from "@/test/db";
import {
  ensureRssPass,
  feedToken,
  regenerateRssPass,
  sha256Hex,
} from "./rss-pass";

describe("feedToken", () => {
  it("is 32 lowercase hex characters derived from the password", () => {
    const t = feedToken("0123456789abcdef0123");
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(t).toBe(
      sha256Hex("owntube-feed-token:0123456789abcdef0123").slice(0, 32),
    );
  });
  it("changes when the password changes", () => {
    expect(feedToken("a".repeat(20))).not.toBe(feedToken("b".repeat(20)));
  });
});

describe("regenerateRssPass", () => {
  it("marks the feed publish state dirty so the new address publishes soon", () => {
    const { db, sqlite } = createTestDb();
    const ts = Math.floor(Date.now() / 1000);
    const user = db
      .insert(users)
      .values({
        email: "regen@example.com",
        passwordHash: "x",
        createdAt: ts,
        updatedAt: ts,
      })
      .returning({ id: users.id })
      .get();

    // First establish a password so we can observe a change on regenerate.
    const initial = ensureRssPass(db, user.id);
    db.run(sql`UPDATE feed_publish_state SET dirty_at = 0 WHERE id = 1`);

    const regenerated = regenerateRssPass(db, user.id);
    expect(regenerated).not.toBe(initial);

    const row = db.get<{ dirty_at: number }>(
      sql`SELECT dirty_at FROM feed_publish_state WHERE id = 1`,
    );
    expect(row?.dirty_at).toBeGreaterThan(0);

    sqlite.close();
  });
});
