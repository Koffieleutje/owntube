import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter } from "@/server/trpc/root";
import { createTestDb } from "@/test/db";

describe("videoRouter", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("fetch not mocked for this test"))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INVIDIOUS_BASE_URL;
  });

  it("returns detail query payload", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";
    // Only the /api/v1/videos call is mocked; the optional storyboard follow-up
    // rejects and is swallowed, which is the normal path when it isn't needed.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          videoId: "dQw4w9WgXcQ",
          title: "Title",
          formatStreams: [
            {
              url: "https://inv.test/videoplayback?itag=18",
              qualityLabel: "360p",
              type: "video/mp4",
            },
          ],
          adaptiveFormats: [],
        }),
      ),
    );
    const caller = appRouter.createCaller({ db, userId: null });
    const detail = await caller.video.detail({ videoId: "dQw4w9WgXcQ" });
    expect(detail.title).toBe("Title");
    expect(detail.sourceUsed).toBe("invidious");
    sqlite.close();
  });

  it("returns comments query payload", async () => {
    const { db, sqlite } = createTestDb();
    process.env.INVIDIOUS_BASE_URL = "https://inv.test";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          videoId: "dQw4w9WgXcQ",
          comments: [
            {
              author: "Viewer",
              commentId: "x",
              content: "Hello",
              publishedText: "now",
            },
          ],
          commentCount: 1,
          continuation: null,
        }),
      ),
    );
    const caller = appRouter.createCaller({ db, userId: null });
    const comments = await caller.video.comments({
      videoId: "dQw4w9WgXcQ",
      sortBy: "top",
    });
    expect(comments.comments).toHaveLength(1);
    expect(comments.comments[0]?.text).toBe("Hello");
    sqlite.close();
  });
});
