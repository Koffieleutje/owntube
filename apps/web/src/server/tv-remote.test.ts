import { beforeEach, describe, expect, it } from "vitest";
import { listTvs, pollTv, sendToTv } from "@/server/tv-remote";

describe("tv remote", () => {
  beforeEach(() => {
    globalThis.__owntubeTvRemoteStore = undefined;
  });

  it("lists a TV once it polls, per user", () => {
    pollTv(1, "tv-living-room", "Living room", 1_000);
    expect(listTvs(1, 2_000)).toEqual([
      { deviceId: "tv-living-room", name: "Living room" },
    ]);
    expect(listTvs(2, 2_000)).toEqual([]);
  });

  it("delivers a sent video on the next poll, once", () => {
    pollTv(1, "tv-living-room", "Living room", 1_000);
    expect(
      sendToTv(
        1,
        "tv-living-room",
        { videoId: "dQw4w9WgXcQ", startSeconds: 42 },
        1_500,
      ),
    ).toBe(true);
    expect(pollTv(1, "tv-living-room", "Living room", 2_000)).toMatchObject({
      videoId: "dQw4w9WgXcQ",
      startSeconds: 42,
    });
    expect(pollTv(1, "tv-living-room", "Living room", 3_000)).toBeNull();
  });

  it("forgets a TV that stopped polling", () => {
    pollTv(1, "tv-living-room", "Living room", 1_000);
    expect(listTvs(1, 60_000)).toEqual([]);
    expect(
      sendToTv(1, "tv-living-room", { videoId: "dQw4w9WgXcQ" }, 60_000),
    ).toBe(false);
  });

  it("drops a video sent to a TV that then went away", () => {
    pollTv(1, "tv", "TV", 0);
    sendToTv(1, "tv", { videoId: "dQw4w9WgXcQ" }, 1_000);
    // Switched off before collecting it; turned on again much later.
    expect(pollTv(1, "tv", "TV", 120_000)).toBeNull();
  });
});
