import { describe, expect, it } from "vitest";
import { subscriptions, users } from "@/server/db/schema";
import {
  buildAllFeeds,
  createVideoFactsResolver,
} from "@/server/remote/publish";
import {
  channelCacheKey,
  detailCacheKey,
  writeCache,
} from "@/server/services/proxy/cache";
import { createTestDb } from "@/test/db";

const CHANNEL = "UCabcdefghijklmnopqrstuv";

function rssEntry(videoId: string, publishedAt: number) {
  return {
    videoId,
    title: `Video ${videoId}`,
    channelId: CHANNEL,
    channelName: "Chan",
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    publishedAt,
  };
}

describe("createVideoFactsResolver", () => {
  it("prefers the channel page cache, then a cached detail, then one live lookup per video", async () => {
    const { db } = createTestDb();
    writeCache(
      db,
      channelCacheKey({ channelId: CHANNEL }),
      "invidious",
      { videos: [{ videoId: "fromPage", durationSeconds: 600 }] },
      "channel",
    );
    writeCache(
      db,
      detailCacheKey({ videoId: "fromDetail" }),
      "invidious",
      { videoId: "fromDetail", durationSeconds: 45, isShort: true },
      "streams",
    );
    const fetched: string[] = [];
    const factsOf = createVideoFactsResolver(db, {
      liveLookups: 1,
      fetchDetail: async (videoId) => {
        fetched.push(videoId);
        return { durationSeconds: 300 };
      },
    });

    expect(await factsOf(CHANNEL, "fromPage")).toEqual({
      durationSeconds: 600,
    });
    expect(await factsOf(CHANNEL, "fromDetail")).toEqual({
      durationSeconds: 45,
      isShort: true,
    });
    expect(await factsOf(CHANNEL, "live")).toEqual({ durationSeconds: 300 });
    expect(await factsOf(CHANNEL, "live")).toEqual({ durationSeconds: 300 });
    // Budget spent: the next unknown video goes out without a duration.
    expect(await factsOf(CHANNEL, "overBudget")).toEqual({});
    expect(fetched).toEqual(["live"]);
  });

  it("treats a failed live lookup as unknown", async () => {
    const { db } = createTestDb();
    const factsOf = createVideoFactsResolver(db, {
      fetchDetail: async () => {
        throw new Error("region blocked");
      },
    });
    expect(await factsOf(CHANNEL, "blocked")).toEqual({});
  });
});

describe("buildAllFeeds channel items", () => {
  it("carries durations and leaves out Shorts", async () => {
    const { db } = createTestDb();
    const user = db
      .insert(users)
      .values({
        email: "a@example.com",
        passwordHash: "x",
        createdAt: 0,
        updatedAt: 0,
      })
      .returning()
      .get();
    db.insert(subscriptions)
      .values({ userId: user.id, channelId: CHANNEL, subscribedAt: 0 })
      .run();
    writeCache(
      db,
      `rss:v1:${CHANNEL}`,
      "youtube",
      {
        entries: [
          rssEntry("shortInWindow", 1_100),
          rssEntry("longInWindow", 1_000),
          rssEntry("shortBeforeWindow", 500),
          rssEntry("longBeforeWindow", 400),
        ],
      },
      "rss",
    );
    writeCache(
      db,
      `rss-uulf:v1:${CHANNEL}`,
      "youtube",
      {
        ids: ["longInWindow"],
        oldestPublishedAt: 900,
        newestPublishedAt: 1_000,
      },
      "rss",
    );
    writeCache(
      db,
      channelCacheKey({ channelId: CHANNEL }),
      "invidious",
      {
        videos: [
          { videoId: "longInWindow", durationSeconds: 600 },
          { videoId: "shortBeforeWindow", durationSeconds: 45 },
        ],
      },
      "channel",
    );
    writeCache(
      db,
      detailCacheKey({ videoId: "longBeforeWindow" }),
      "invidious",
      { videoId: "longBeforeWindow", durationSeconds: 1_200 },
      "streams",
    );

    const { feeds } = await buildAllFeeds(db, { appOrigin: "http://x" });
    for (const kind of ["channel", "subscriptions"]) {
      const feed = feeds.find((f) => f.kind === kind);
      expect(feed?.items.map((i) => [i.videoId, i.durationSeconds])).toEqual([
        ["longInWindow", 600],
        ["longBeforeWindow", 1_200],
      ]);
    }
  });
});
