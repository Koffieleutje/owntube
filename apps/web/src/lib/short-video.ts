import type { UnifiedVideo } from "@/server/services/proxy.types";

/** YouTube Shorts max length; keeps the vertical feed from filling with long uploads. */
export const MAX_SHORT_DURATION_SECONDS = 60;

/** Slightly looser cap for upstream discovery when metadata is sparse or a few seconds over 60. */
export const DISCOVERY_SHORT_MAX_DURATION_SECONDS = 90;

/** Upstreams sometimes send `0`/`-1` when length is unknown — treat as missing, not “zero seconds”. */
export function hasKnownPositiveDuration(
  seconds: number | undefined,
): seconds is number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
}

/**
 * Last-resort signal, and a poor one: "#shorts" in a title is an SEO convention,
 * not metadata. Measured against a live search, 4 of 20 results carried the tag
 * while running 8-27 minutes. Only consulted when neither the upstream flag nor
 * a duration is available.
 */
function titleHasShortsTag(title: string): boolean {
  return title.toLowerCase().includes("#shorts");
}

/**
 * Upstream said so outright (Invidious `isShort`). Preferred over every other
 * signal because the alternatives cannot actually distinguish a Short: YouTube
 * stopped reporting a real duration for them and Invidious substitutes an
 * approximate 60s, so length alone cannot separate a Short from a genuine
 * 60-second upload.
 */
function upstreamSaysShort(video: UnifiedVideo): boolean {
  return video.isShort === true;
}

export function isStrictShortVideo(video: UnifiedVideo): boolean {
  if (video.isLive || video.isUpcoming) return false;
  if (upstreamSaysShort(video)) return true;
  const d = video.durationSeconds;
  if (hasKnownPositiveDuration(d)) {
    return d <= MAX_SHORT_DURATION_SECONDS;
  }
  return titleHasShortsTag(video.title);
}

export function invidiousItemIsStrictShort(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const o = item as Record<string, unknown>;
  if (o.isShort === true) return true;
  if (o.type === "shortVideo") return true;
  const length =
    typeof o.lengthSeconds === "number" && Number.isFinite(o.lengthSeconds)
      ? o.lengthSeconds
      : undefined;
  if (hasKnownPositiveDuration(length)) {
    return length <= MAX_SHORT_DURATION_SECONDS;
  }
  const title = typeof o.title === "string" ? o.title : "";
  return titleHasShortsTag(title);
}

export function isDiscoveryShortVideo(video: UnifiedVideo): boolean {
  if (video.isLive || video.isUpcoming) return false;
  if (isStrictShortVideo(video)) return true;
  if (upstreamSaysShort(video)) return true;
  const d = video.durationSeconds;
  if (hasKnownPositiveDuration(d)) {
    return d <= DISCOVERY_SHORT_MAX_DURATION_SECONDS;
  }
  return titleHasShortsTag(video.title);
}

export function invidiousItemIsDiscoveryShort(item: unknown): boolean {
  if (invidiousItemIsStrictShort(item)) return true;
  if (!item || typeof item !== "object") return false;
  const o = item as Record<string, unknown>;
  if (o.isShort === true) return true;
  if (o.type === "shortVideo") return true;
  const length =
    typeof o.lengthSeconds === "number" && Number.isFinite(o.lengthSeconds)
      ? o.lengthSeconds
      : undefined;
  if (hasKnownPositiveDuration(length)) {
    return length <= DISCOVERY_SHORT_MAX_DURATION_SECONDS;
  }
  const title = typeof o.title === "string" ? o.title : "";
  return titleHasShortsTag(title);
}

/** Upstream discovery row: strict short, or discovery-length with an explicit signal. */
export function isUpstreamDiscoveryShort(video: UnifiedVideo): boolean {
  if (isStrictShortVideo(video)) return true;
  if (!isDiscoveryShortVideo(video)) return false;
  return upstreamSaysShort(video) || titleHasShortsTag(video.title);
}

/** Prefer strict shorts; fall back to tagged discovery only when the page has zero strict shorts. */
export function filterShortsFeedVideos(videos: UnifiedVideo[]): UnifiedVideo[] {
  const strict = videos.filter(isStrictShortVideo);
  if (strict.length > 0) return strict;
  const taggedDiscovery = videos.filter(isUpstreamDiscoveryShort);
  if (taggedDiscovery.length > 0) return taggedDiscovery;
  const discovery = videos.filter(isDiscoveryShortVideo);
  if (discovery.length > 0) return discovery;
  return [];
}
