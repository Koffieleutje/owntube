import { describe, expect, it } from "vitest";
import { withoutBlockedChannels } from "@/server/settings/profile";

describe("withoutBlockedChannels", () => {
  const videos = [
    { videoId: "a", channelId: "UCkeep" },
    { videoId: "b", channelId: "UCblocked" },
    { videoId: "c", channelId: null },
  ];

  it("drops videos from blocked channels", () => {
    expect(
      withoutBlockedChannels(videos, {
        blockedRecommendationChannels: ["UCblocked"],
      }).map((v) => v.videoId),
    ).toEqual(["a", "c"]);
  });

  it("passes everything through without settings or blocks", () => {
    expect(withoutBlockedChannels(videos, null)).toBe(videos);
    expect(
      withoutBlockedChannels(videos, { blockedRecommendationChannels: [] }),
    ).toBe(videos);
  });
});
