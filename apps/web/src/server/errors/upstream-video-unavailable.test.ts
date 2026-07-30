import { describe, expect, it } from "vitest";
import { isVideoUnavailableUpstreamMessage } from "@/server/errors/upstream-video-unavailable";

describe("isVideoUnavailableUpstreamMessage", () => {
  it("recognises YouTube's paywall refusals", () => {
    // Verbatim shapes YouTube puts in playabilityStatus.reason / subreason,
    // which Invidious relays unchanged. Before these were listed, each fell
    // through to the generic "Invidious is unavailable, check instance health"
    // message — blaming the instance for a per-video refusal.
    for (const message of [
      'invidious:{"error":"Join this channel to get access to members-only content like this video, and other exclusive perks."}',
      "invidious:This video is available to this channel's members on level: Tier 2 (or any higher level). Join this channel to get access to members-only content and other exclusive perks.",
      'invidious:{"error":"This video requires payment to watch."}',
    ]) {
      expect(isVideoUnavailableUpstreamMessage(message), message).toBe(true);
    }
  });

  it("still recognises the existing definitive refusals", () => {
    for (const message of [
      'invidious:{"error":"Video unavailable"}',
      "invidious:The uploader has not made this video available in your country",
      'invidious:{"error":"This video is private"}',
    ]) {
      expect(isVideoUnavailableUpstreamMessage(message), message).toBe(true);
    }
  });

  it("does not fire on ordinary videos that merely mention membership", () => {
    // These are real titles measured from live search results. A feed filter
    // matching the bare phrase dropped every one of them as members-only.
    for (const message of [
      "invidious:Drake - Members Only (Audio) ft. PARTYNEXTDOOR",
      "invidious:Members Only Videos are a HUGE Problem on YouTube",
      "invidious:How to Enable Subscribers Only Mode for Comments",
      "invidious:XXXTENTACION - Members Only VOL 1 (Full Album)",
    ]) {
      expect(isVideoUnavailableUpstreamMessage(message), message).toBe(false);
    }
  });

  it("leaves transient failures on the generic path", () => {
    for (const message of [
      "invidious:HTTP 502: bad gateway",
      "invidious:rate limit",
      "invidious:fetch failed",
    ]) {
      expect(isVideoUnavailableUpstreamMessage(message), message).toBe(false);
    }
  });
});
