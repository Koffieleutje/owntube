import type { VideoDetail } from "@/server/services/proxy.types";

type StreamRow = VideoDetail["videoSources"][number];

function heightFromQualityLabel(quality: string | undefined): number | null {
  if (!quality?.trim()) return null;
  const m = quality.match(/(\d{2,4})\s*p/i);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Best-effort height for one upstream stream row (metadata is often incomplete). */
export function streamRowMaxHeightPx(s: StreamRow): number | null {
  if (
    typeof s.height === "number" &&
    Number.isFinite(s.height) &&
    s.height > 0
  ) {
    return s.height;
  }
  return heightFromQualityLabel(s.quality);
}

/** Highest progressive rung advertised in `videoSources` (0 when unknown / none). */
export function playbackCatalogMaxHeightPx(detail: VideoDetail): number {
  let max = 0;
  for (const s of detail.videoSources) {
    if (!s.url) continue;
    const h = streamRowMaxHeightPx(s);
    if (h !== null && h > max) max = h;
  }
  return max;
}

function hasUsableAudioForSplit(detail: VideoDetail): boolean {
  return (detail.audioSources ?? []).some((a) => Boolean(a.url?.trim()));
}

/** True when split (video-only + audio) HD is available from upstream metadata. */
export function hasSplitHdCapability(detail: VideoDetail): boolean {
  if (!hasUsableAudioForSplit(detail)) return false;
  return detail.videoSources.some((s) => {
    if (!s.url || s.videoOnly !== true) return false;
    const h = streamRowMaxHeightPx(s);
    return h !== null && h > 360;
  });
}

/** Compare two upstream catalogs; higher max height wins (ties keep the incumbent). */
export type UpstreamPlaybackSource = VideoDetail["sourceUsed"];

export function pickRicherPlaybackDetail(
  current: VideoDetail,
  candidate: VideoDetail,
): VideoDetail {
  const currentScore = playbackCatalogMaxHeightPx(current);
  const candidateScore = playbackCatalogMaxHeightPx(candidate);
  if (candidateScore > currentScore) return candidate;
  if (candidateScore === currentScore && hasSplitHdCapability(candidate)) {
    return candidate;
  }
  return current;
}
