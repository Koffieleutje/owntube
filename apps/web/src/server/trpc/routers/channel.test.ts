import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRssInFlight, refreshChannelRss } from "@/server/rss/cache";
import { fetchChannelPage } from "@/server/services/proxy";
import type { UnifiedVideo } from "@/server/services/proxy.types";
import { appRouter } from "@/server/trpc/root";
import { createTestDb } from "@/test/db";

vi.mock("@/server/services/proxy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/proxy")>()),
  fetchChannelPage: vi.fn(),
}));

const CHANNEL = "UCabcdefghijklmnopqrstuv";
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function video(
  over: Partial<UnifiedVideo> & { videoId: string },
): UnifiedVideo {
  return { title: over.videoId, channelId: CHANNEL, ...over };
}

/** The channel's uploads RSS: its two newest public videos. */
const RSS = `<?xml version="1.0"?><feed>
  <entry><yt:videoId>newerVideo1</yt:videoId><title>a</title>
    <published>2026-09-29T00:00:00Z</published>
    <media:group><media:community><media:statistics views="1000"/></media:community></media:group></entry>
  <entry><yt:videoId>newerVideo2</yt:videoId><title>b</title>
    <published>2026-09-20T00:00:00Z</published>
    <media:group><media:community><media:statistics views="2000"/></media:community></media:group></entry>
</feed>`;

describe("channel.page", () => {
  beforeEach(() => clearRssInFlight());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(fetchChannelPage).mockReset();
  });

  it("corrects rows from the RSS but keeps the listing's order", async () => {
    const { db, sqlite } = createTestDb();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(RSS, { status: 200 })),
    );
    await refreshChannelRss(db, CHANNEL);

    // Newest first, as YouTube lists a channel. The third row is months old
    // but came back "just now" with 0 views — the listing's failure mode —
    // and is too old for the RSS to correct.
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(fetchChannelPage).mockResolvedValue({
      channelId: CHANNEL,
      videos: [
        video({ videoId: "newerVideo1", viewCount: 0, publishedAt: nowSec }),
        video({ videoId: "newerVideo2", viewCount: 1500 }),
        video({ videoId: "oldBroken01", viewCount: 0, publishedAt: nowSec }),
        video({
          videoId: "oldFine0001",
          publishedAt: at("2026-04-01T00:00:00Z"),
        }),
      ],
      continuation: null,
      sourceUsed: "invidious",
      stale: false,
    });

    const caller = appRouter.createCaller({ db, userId: null });
    const page = await caller.channel.page({ channelId: CHANNEL });

    // Order untouched: the broken row stays where YouTube put it, instead of
    // being sorted to the top by its bogus date.
    expect(page.videos.map((v) => v.videoId)).toEqual([
      "newerVideo1",
      "newerVideo2",
      "oldBroken01",
      "oldFine0001",
    ]);
    // Rows the RSS covers are corrected; a real listing count is kept.
    expect(page.videos[0]?.viewCount).toBe(1000);
    expect(page.videos[0]?.publishedAt).toBe(at("2026-09-29T00:00:00Z"));
    expect(page.videos[1]?.viewCount).toBe(1500);
    sqlite.close();
  });
});
