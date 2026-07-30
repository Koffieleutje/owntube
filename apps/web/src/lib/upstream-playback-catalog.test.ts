import { describe, expect, it } from "vitest";
import {
  hasSplitHdCapability,
  pickRicherPlaybackDetail,
  playbackCatalogMaxHeightPx,
} from "@/lib/upstream-playback-catalog";
import type { VideoDetail } from "@/server/services/proxy.types";

function detail(over: Partial<VideoDetail>): VideoDetail {
  return {
    videoId: "x",
    title: "t",
    audioSources: [],
    videoSources: [],
    sourceUsed: "invidious",
    ...over,
  };
}

describe("upstream-playback-catalog", () => {
  it("reads the max height from the richest video row", () => {
    const d = detail({
      videoSources: [
        { url: "http://x/v360", quality: "360p", height: 360 },
        {
          url: "http://x/v1080",
          quality: "1080p",
          videoOnly: true,
          height: 1080,
        },
      ],
    });
    expect(playbackCatalogMaxHeightPx(d)).toBe(1080);
  });

  it("falls back to the quality label when height metadata is missing", () => {
    const d = detail({
      videoSources: [{ url: "http://x/v720", quality: "720p" }],
    });
    expect(playbackCatalogMaxHeightPx(d)).toBe(720);
  });

  it("reports split HD capability only with a video-only HD row plus audio", () => {
    const withAudio = detail({
      audioSources: [{ url: "http://x/aud", quality: "medium" }],
      videoSources: [
        {
          url: "http://x/v1080",
          quality: "1080p",
          videoOnly: true,
          height: 1080,
        },
      ],
    });
    expect(hasSplitHdCapability(withAudio)).toBe(true);

    // Same ladder, no audio track to pair it with.
    const noAudio = detail({
      videoSources: [
        {
          url: "http://x/v1080",
          quality: "1080p",
          videoOnly: true,
          height: 1080,
        },
      ],
    });
    expect(hasSplitHdCapability(noAudio)).toBe(false);
  });

  it("prefers the catalog advertising higher rungs", () => {
    const low = detail({
      videoSources: [{ url: "http://x/v360", quality: "360p", height: 360 }],
    });
    const high = detail({
      audioSources: [{ url: "http://x/aud", quality: "medium" }],
      videoSources: [
        {
          url: "http://x/v1080",
          quality: "1080p",
          videoOnly: true,
          height: 1080,
        },
      ],
    });
    expect(pickRicherPlaybackDetail(low, high)).toBe(high);
    expect(pickRicherPlaybackDetail(high, low)).toBe(high);
  });

  it("on an equal ladder switches only when the candidate can do split HD", () => {
    const muxedOnly = detail({
      videoSources: [{ url: "http://x/v1080", quality: "1080p", height: 1080 }],
    });
    const splitCapable = detail({
      audioSources: [{ url: "http://x/aud", quality: "medium" }],
      videoSources: [
        {
          url: "http://x/v1080",
          quality: "1080p",
          videoOnly: true,
          height: 1080,
        },
      ],
    });
    // Same max height, but the candidate can pair video-only 1080p with audio.
    expect(pickRicherPlaybackDetail(muxedOnly, splitCapable)).toBe(
      splitCapable,
    );
    // Same height and no split-HD gain — keep the incumbent rather than churn.
    expect(pickRicherPlaybackDetail(splitCapable, muxedOnly)).toBe(
      splitCapable,
    );
  });
});
