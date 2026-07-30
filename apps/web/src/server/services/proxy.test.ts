import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { videoCache } from "@/server/db/schema";
import { UpstreamUnavailableError } from "@/server/errors/upstream-unavailable";
import {
  fetchChannelPage,
  fetchRelatedVideos,
  fetchTrendingVideos,
  fetchVideoComments,
  fetchVideoDetail,
  searchVideos,
} from "@/server/services/proxy";
import { resetRateLimiterForTests } from "@/server/services/rate-limiter";
import { createTestDb } from "@/test/db";

describe("searchVideos", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("fetch not mocked for this test"))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INVIDIOUS_BASE_URL;
    delete process.env.PORT;
  });

  it("parses Invidious channel items from search", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            type: "channel",
            authorId: "UCinvchan",
            author: "Inv Channel",
            authorThumbnails: [
              { url: "https://example.com/ch.jpg", width: 88, quality: "" },
            ],
            subCount: 99_000,
          },
        ]),
      ),
    );

    const r = await searchVideos(db, { q: "chan", limit: 10 });
    expect(r.sourceUsed).toBe("invidious");
    expect(r.channels).toHaveLength(1);
    expect(r.channels?.[0]?.channelId).toBe("UCinvchan");
    expect(r.channels?.[0]?.name).toBe("Inv Channel");
    sqlite.close();
  });

  it("keeps videos marked premium or paid in unified lists", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            type: "video",
            videoId: "paidONLY00001",
            title: "Paid",
            paid: true,
            author: "A",
            authorId: "UCa",
            videoThumbnails: [{ url: "https://example.com/t.jpg" }],
            lengthSeconds: 5,
          },
          {
            type: "video",
            videoId: "abc12345678",
            title: "Ok",
            author: "B",
            authorId: "UCb",
            videoThumbnails: [{ url: "https://example.com/t2.jpg" }],
            lengthSeconds: 10,
          },
        ]),
      ),
    );

    // These used to be dropped. Filtering them out was measurably worse than
    // leaving them in: the same code path also matched ordinary public videos,
    // and a dropped row is invisible, so there was no way to tell. A paywalled
    // video now surfaces and the watch page shows YouTube's own reason for
    // refusing it (see upstream-video-unavailable).
    const r = await searchVideos(db, { q: "test", limit: 10 });
    expect(r.videos).toHaveLength(2);
    expect(r.videos.map((v) => v.videoId)).toContain("paidONLY00001");
    sqlite.close();
  });

  it("serves stale cache instantly while revalidating in the background", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            type: "video",
            videoId: "dQw4w9WgXcQ",
            title: "Cached",
            author: "A",
            authorId: "UCa",
            videoThumbnails: [{ url: "https://example.com/t.jpg" }],
            lengthSeconds: 5,
          },
        ]),
      ),
    );
    await searchVideos(db, { q: "cache-me", limit: 10 });
    db.update(videoCache).set({ expiresAt: 0 }).run();

    vi.mocked(fetch).mockRejectedValue(new Error("down"));
    const stale = await searchVideos(db, { q: "cache-me", limit: 10 });
    expect(stale.sourceUsed).toBe("cache");
    expect(stale.stale).toBe(true);
    // Serve-stale-first: the answer comes from cache before upstream is tried,
    // so there is no upstream-failure warning to surface.
    expect(stale.warning).toBeUndefined();
    sqlite.close();
  });

  it("maps Invidious liveNow on video detail", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "http://127.0.0.1:3001";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          videoId: "jfKfPfyJRdk",
          title: "Live stream",
          liveNow: true,
          lengthSeconds: 0,
          hlsUrl: "http://127.0.0.1:3001/api/manifest/hls/playlist/jfKfPfyJRdk",
          adaptiveFormats: [],
          formatStreams: [],
        }),
      ),
    );
    const detail = await fetchVideoDetail(db, { videoId: "jfKfPfyJRdk" });
    expect(detail.isLive).toBe(true);
    expect(detail.durationSeconds).toBeUndefined();
    sqlite.close();
  });

  it("throws UpstreamLiveUpcomingError for scheduled Invidious premiere", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "http://127.0.0.1:3001";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "This live event will begin in 56 minutes.",
        }),
        { status: 500 },
      ),
    );
    const { UpstreamLiveUpcomingError } = await import(
      "@/server/errors/upstream-live-upcoming"
    );
    await expect(
      fetchVideoDetail(db, { videoId: "upcomingLiveId1" }),
    ).rejects.toBeInstanceOf(UpstreamLiveUpcomingError);
    sqlite.close();
  });

  it("maps liveNow on Invidious search items", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "http://127.0.0.1:3001";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            type: "video",
            videoId: "liveVid12345",
            title: "24/7 Stream",
            author: "Channel",
            authorId: "UCx",
            liveNow: true,
            lengthSeconds: 0,
            videoThumbnails: [
              {
                quality: "medium",
                url: "/vi/liveVid12345/mqdefault.jpg",
                width: 320,
                height: 180,
              },
            ],
          },
        ]),
      ),
    );
    const result = await searchVideos(db, { q: "lofi live", limit: 5 });
    expect(result.videos[0]?.isLive).toBe(true);
    expect(result.videos[0]?.durationSeconds).toBeUndefined();
    sqlite.close();
  });

  it("fetchVideoDetail bypassDetailCache skips a fresh SQLite row", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "http://localhost:3001";

    let invCalls = 0;
    vi.mocked(fetch).mockImplementation((input) => {
      const u = String(input);
      if (u.includes("/api/v1/videos/dQw4w9WgXcQ") && !u.includes("/related")) {
        invCalls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              videoId: "dQw4w9WgXcQ",
              title: "Invidious",
              hlsUrl: `/api/manifest/hls/playlist/dQw4w9WgXcQ?c=${invCalls}`,
              storyboard: {
                level: 0,
                duration: 60,
                count: 1,
                columns: 1,
                rows: 1,
                interval: 60,
                storyboardWidth: 160,
                storyboardHeight: 90,
                width: 160,
                height: 90,
                images: ["/sb/0.jpg"],
              },
            }),
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    const d1 = await fetchVideoDetail(db, { videoId: "dQw4w9WgXcQ" });
    expect(d1.hlsUrl).toContain("c=1");
    // Detail + optional storyboard probe share the same Invidious videos endpoint.
    expect(invCalls).toBe(2);

    const d2 = await fetchVideoDetail(db, { videoId: "dQw4w9WgXcQ" });
    expect(d2.hlsUrl).toContain("c=1");
    expect(invCalls).toBe(2);

    const d3 = await fetchVideoDetail(
      db,
      { videoId: "dQw4w9WgXcQ" },
      { bypassDetailCache: true },
    );
    expect(d3.hlsUrl).toContain("c=3");
    expect(invCalls).toBe(4);

    sqlite.close();
  });

  it("returns related videos from the Invidious /related endpoint", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";

    vi.mocked(fetch).mockImplementation((input) => {
      const u = String(input);
      if (u.includes("inv.test") && u.includes("/related")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                type: "video",
                videoId: "abc12345678",
                title: "Related",
                author: "Creator",
              },
            ]),
          ),
        );
      }
      if (u.includes("inv.test") && u.includes("/api/v1/videos/dQw4w9WgXcQ")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              videoId: "dQw4w9WgXcQ",
              title: "Main",
              authorId: "UCchan",
              author: "Artist",
            }),
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    const related = await fetchRelatedVideos(db, { videoId: "dQw4w9WgXcQ" }, 5);
    expect(related.sourceUsed).toBe("invidious");
    expect(related.videos[0]?.videoId).toBe("abc12345678");
    sqlite.close();
  });

  it("treats Invidious 200 with empty body on /related as an empty list", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";

    vi.mocked(fetch).mockImplementation((input) => {
      const u = String(input);
      if (u.includes("/api/v1/videos/") && u.includes("/related")) {
        return Promise.resolve(new Response("", { status: 200 }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    const r = await fetchRelatedVideos(db, { videoId: "dQw4w9WgXcQ" }, 5);
    expect(r.videos).toEqual([]);
    expect(r.sourceUsed).toBe("invidious");
    sqlite.close();
  });

  it("resolves Invidious relative stream URLs and uses 127.0.0.1 instead of localhost", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "http://localhost:3001";

    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      expect(url).toContain("127.0.0.1");
      expect(url).toContain("/api/v1/videos/dQw4w9WgXcQ");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            videoId: "dQw4w9WgXcQ",
            title: "Invidious relative URLs",
            adaptiveFormats: [
              {
                url: "/api/v1/manifest/dash/id/dQw4w9WgXcQ",
                type: "video/mp4",
                qualityLabel: "720p",
              },
            ],
            hlsUrl: "/api/v1/manifest/hls/playlist/dQw4w9WgXcQ",
          }),
        ),
      );
    });

    const detail = await fetchVideoDetail(db, { videoId: "dQw4w9WgXcQ" });
    expect(detail.sourceUsed).toBe("invidious");
    expect(detail.hlsUrl).toBe(
      "http://127.0.0.1:3001/api/v1/manifest/hls/playlist/dQw4w9WgXcQ",
    );
    expect(detail.videoSources[0]?.url).toBe(
      "http://127.0.0.1:3001/api/v1/manifest/dash/id/dQw4w9WgXcQ",
    );
    sqlite.close();
  });

  it("repairs malformed Invidious absolute URLs missing hostname", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "http://192.168.1.11:3210";

    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/v1/videos/dQw4w9WgXcQ")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              videoId: "dQw4w9WgXcQ",
              title: "Malformed absolute URLs",
              dashUrl: "http://:3210/api/manifest/dash/id/dQw4w9WgXcQ",
              hlsUrl: "http://:3210/api/manifest/hls/playlist/dQw4w9WgXcQ",
              adaptiveFormats: [
                {
                  url: "http://:3210/videoplayback?id=abc",
                  type: "video/mp4",
                  qualityLabel: "720p",
                },
              ],
            }),
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const detail = await fetchVideoDetail(db, { videoId: "dQw4w9WgXcQ" });
    expect(detail.sourceUsed).toBe("invidious");
    expect(detail.dashUrl).toBe(
      "http://192.168.1.11:3210/api/manifest/dash/id/dQw4w9WgXcQ",
    );
    expect(detail.hlsUrl).toBe(
      "http://192.168.1.11:3210/api/manifest/hls/playlist/dQw4w9WgXcQ",
    );
    expect(detail.videoSources[0]?.url).toBe(
      "http://192.168.1.11:3210/videoplayback?id=abc",
    );
    sqlite.close();
  });

  it("rejects search when Invidious shares the same loopback port as Next", async () => {
    const { db, sqlite } = createTestDb();
    process.env.PORT = "3001";
    process.env.INVIDIOUS_BASE_URL = "http://127.0.0.1:3001";

    await expect(searchVideos(db, { q: "test", limit: 10 })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof UpstreamUnavailableError &&
        /same loopback port|server fetch would hit OwnTube/i.test(err.message),
    );

    sqlite.close();
  });
});

describe("fetchChannelPage", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("fetch not mocked for this test"))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.INVIDIOUS_BASE_URL;
  });

  it("loads Invidious channel uploads via RSS when /videos returns parse errors", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";

    vi.mocked(fetch).mockImplementation((input) => {
      const u = String(input);
      if (u.includes("inv.test/api/v1/channels/UCchan")) {
        if (u.includes("/videos")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                videos: [
                  {
                    type: "parse-error",
                    errorMessage: "Missing hash key",
                  },
                ],
              }),
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              authorId: "UCchan",
              author: "Artist",
            }),
          ),
        );
      }
      if (u.includes("inv.test/feed/channel/UCchan")) {
        return Promise.resolve(
          new Response(
            `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <yt:videoId>abcdefghijk</yt:videoId>
    <title>From RSS feed</title>
    <published>2026-05-23T12:00:00+00:00</published>
    <media:thumbnail url="https://inv.test/vi/abcdefghijk/mqdefault.jpg"/>
  </entry>
</feed>`,
            { headers: { "Content-Type": "application/atom+xml" } },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    const page = await fetchChannelPage(db, { channelId: "UCchan" });
    expect(page.sourceUsed).toBe("invidious");
    expect(page.videos).toHaveLength(1);
    expect(page.videos[0]?.title).toBe("From RSS feed");
    sqlite.close();
  });

  it("merges Invidious channel streams into the videos tab", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";

    vi.mocked(fetch).mockImplementation((input) => {
      const u = String(input);
      if (u.includes("inv.test/api/v1/channels/UCchan")) {
        if (u.includes("/streams")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                videos: [
                  {
                    type: "livestream",
                    videoId: "livestream1",
                    title: "Live stream",
                    authorId: "UCchan",
                    author: "Artist",
                    liveNow: true,
                  },
                ],
              }),
            ),
          );
        }
        if (u.includes("/videos")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                videos: [
                  {
                    type: "video",
                    videoId: "uploadvid01",
                    title: "Upload",
                    authorId: "UCchan",
                    author: "Artist",
                  },
                ],
              }),
            ),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              authorId: "UCchan",
              author: "Artist",
            }),
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    const page = await fetchChannelPage(db, { channelId: "UCchan" });
    expect(page.sourceUsed).toBe("invidious");
    expect(page.videos.map((v) => v.videoId)).toContain("livestream1");
    expect(page.videos.find((v) => v.videoId === "livestream1")?.isLive).toBe(
      true,
    );
    sqlite.close();
  });
});

describe("fetchTrendingVideos", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("fetch not mocked for this test"))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.INVIDIOUS_BASE_URL;
  });

  it("returns trending videos from Invidious", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            type: "video",
            videoId: "abc12345678",
            title: "Trending one",
            author: "Creator",
            lengthSeconds: 120,
          },
        ]),
      ),
    );
    const res = await fetchTrendingVideos(db, { region: "US", limit: 10 });
    expect(res.sourceUsed).toBe("invidious");
    expect(res.videos.map((v) => v.videoId)).toEqual(["abc12345678"]);
    sqlite.close();
  });

  it("throws when the only upstream is throttled", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";
    vi.mocked(fetch).mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );
    await expect(
      fetchTrendingVideos(db, { region: "US", limit: 10 }),
    ).rejects.toThrow();
    sqlite.close();
  });
});

describe("fetchVideoComments", () => {
  beforeEach(() => {
    resetRateLimiterForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("fetch not mocked for this test"))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INVIDIOUS_BASE_URL;
  });

  it("keeps Invidious contentHtml for timestamp anchor parsing", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          videoId: "cHocYnA_JVY",
          comments: [
            {
              author: "Viewer",
              authorId: "UCx",
              commentId: "iv-ts",
              content: "fallback plain",
              contentHtml:
                '<a href="https://www.youtube.com/watch?v=cHocYnA_JVY&amp;t=102">1:42</a> Jim: NO',
              publishedText: "1 hour ago",
              likeCount: 1,
              authorThumbnails: [],
            },
          ],
        }),
      ),
    );

    const r = await fetchVideoComments(db, {
      videoId: "cHocYnA_JVY",
      sortBy: "top",
    });
    expect(r.comments[0]?.text).toContain(
      'href="https://www.youtube.com/watch?v=cHocYnA_JVY&amp;t=102"',
    );
    expect(r.comments[0]?.text).toContain("1:42");
    sqlite.close();
  });
});
