import { describe, expect, it } from "vitest";
import {
  filterShortsFeedVideos,
  invidiousItemIsStrictShort,
  isDiscoveryShortVideo,
  isStrictShortVideo,
  MAX_SHORT_DURATION_SECONDS,
} from "@/lib/short-video";
import type { UnifiedVideo } from "@/server/services/proxy.types";

describe("isStrictShortVideo", () => {
  it("accepts short duration", () => {
    expect(
      isStrictShortVideo({
        videoId: "a",
        title: "clip",
        durationSeconds: 45,
      } as UnifiedVideo),
    ).toBe(true);
  });

  it("rejects long uploads", () => {
    expect(
      isStrictShortVideo({
        videoId: "b",
        title: "long",
        durationSeconds: MAX_SHORT_DURATION_SECONDS + 1,
      } as UnifiedVideo),
    ).toBe(false);
  });

  it("accepts #shorts in title when duration unknown", () => {
    expect(
      isStrictShortVideo({
        videoId: "c",
        title: "fun #shorts",
      } as UnifiedVideo),
    ).toBe(true);
  });

  it("accepts #shorts when Piped sends duration -1", () => {
    expect(
      isStrictShortVideo({
        videoId: "e",
        title: "clip #shorts",
        durationSeconds: -1,
      } as UnifiedVideo),
    ).toBe(true);
  });

  it("rejects long uploads even with Shorts in the title", () => {
    expect(
      isStrictShortVideo({
        videoId: "f",
        title: "200 secrets from YouTube Shorts",
        durationSeconds: 1222,
      } as UnifiedVideo),
    ).toBe(false);
  });
});

describe("isDiscoveryShortVideo", () => {
  it("accepts 75s clips when strict rejects", () => {
    const v = {
      videoId: "d",
      title: "clip",
      durationSeconds: 75,
    } as UnifiedVideo;
    expect(isStrictShortVideo(v)).toBe(false);
    expect(isDiscoveryShortVideo(v)).toBe(true);
  });
});

describe("filterShortsFeedVideos", () => {
  it("falls back to discovery when strict filter would empty the list", () => {
    const videos = filterShortsFeedVideos([
      { videoId: "a", title: "a", durationSeconds: 75 } as UnifiedVideo,
    ]);
    expect(videos).toHaveLength(1);
  });

  it("drops unknown-duration search hits without a #shorts tag", () => {
    const videos = filterShortsFeedVideos([
      {
        videoId: "b",
        title: "clip sans hashtag",
        durationSeconds: -1,
      } as UnifiedVideo,
    ]);
    expect(videos).toHaveLength(0);
  });

  it("keeps unknown-duration rows when they include #shorts", () => {
    const videos = filterShortsFeedVideos([
      {
        videoId: "c",
        title: "fun #shorts",
        durationSeconds: -1,
      } as UnifiedVideo,
    ]);
    expect(videos).toHaveLength(1);
  });
});

describe("upstream isShort", () => {
  it("is preferred over the fabricated 60s duration", () => {
    // YouTube stops reporting a real duration for Shorts, so Invidious
    // substitutes 60. That value alone cannot distinguish a Short from a
    // genuine 60-second upload — only the flag can.
    const short = {
      videoId: "a",
      title: "no tag in this title",
      durationSeconds: 60,
      isShort: true,
    } as UnifiedVideo;
    const notShort = {
      videoId: "b",
      title: "no tag in this title",
      durationSeconds: 60,
      isShort: false,
    } as UnifiedVideo;
    expect(isStrictShortVideo(short)).toBe(true);
    // Still true by the 60s rule — the flag adds certainty, it does not make
    // the length rule stricter, which would drop real Shorts on cached rows.
    expect(isStrictShortVideo(notShort)).toBe(true);
  });

  it("marks a Short whose title carries no #shorts tag", () => {
    expect(
      isStrictShortVideo({
        videoId: "a",
        title: "just a clip",
        isShort: true,
      } as UnifiedVideo),
    ).toBe(true);
  });

  it("does not treat an SEO-tagged long video as a Short", () => {
    // Measured against live search: 4 of 20 results carried "#shorts" while
    // running 8-27 minutes. The tag is a convention, not metadata.
    expect(
      isStrictShortVideo({
        videoId: "a",
        title: "Saito09 funny video #shorts",
        durationSeconds: 756,
      } as UnifiedVideo),
    ).toBe(false);
    expect(
      isDiscoveryShortVideo({
        videoId: "a",
        title: "Saito09 funny video #shorts",
        durationSeconds: 756,
      } as UnifiedVideo),
    ).toBe(false);
  });

  it("never calls a live or upcoming row a Short, even when flagged", () => {
    expect(
      isStrictShortVideo({
        videoId: "a",
        title: "stream",
        isShort: true,
        isLive: true,
      } as UnifiedVideo),
    ).toBe(false);
    expect(
      isStrictShortVideo({
        videoId: "a",
        title: "premiere",
        isShort: true,
        isUpcoming: true,
      } as UnifiedVideo),
    ).toBe(false);
  });

  it("reads the flag straight off a raw Invidious item", () => {
    expect(invidiousItemIsStrictShort({ isShort: true, title: "x" })).toBe(true);
    // Absent flag falls back to the existing length rule.
    expect(
      invidiousItemIsStrictShort({ lengthSeconds: 1076, title: "x #shorts" }),
    ).toBe(false);
  });
});
