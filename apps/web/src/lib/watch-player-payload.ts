import {
  type ProxiedPlayableVariant,
  toProxiedOrDirectPlayback,
  toProxiedOrDirectPoster,
  toProxiedOrDirectVariants,
} from "@/lib/invidious-proxy";
import { buildWatchPlayback } from "@/lib/pick-playback";
import type { VideoDetail } from "@/server/services/proxy.types";

export type WatchPlayerPayload =
  | { mode: "hls"; src: string; dvr?: boolean }
  | { mode: "progressive"; variants: ProxiedPlayableVariant[] };

export function buildVideoPlayerPayloadFromDetail(
  detail: VideoDetail,
  appOrigin: string,
  requestHost: string,
  options?: {
    /** iOS Safari: prefer HLS/muxed — split video+audio stalls there. */
    avoidSplitAudioVideo?: boolean;
  },
): {
  payload: WatchPlayerPayload | null;
  poster?: string;
  onlyDashOrUnsupported: boolean;
} {
  const rawPlayback = buildWatchPlayback(detail, {
    shorts: true,
    avoidSplitAudioVideo: options?.avoidSplitAudioVideo,
  });
  const onlyDashOrUnsupported =
    rawPlayback.kind === "none" && rawPlayback.onlyDashOrUnsupported;
  if (rawPlayback.kind === "hls") {
    return {
      payload: {
        mode: "hls",
        src: toProxiedOrDirectPlayback(rawPlayback.url, appOrigin, requestHost),
        dvr: detail.isPostLiveDvr === true,
      },
      poster: toProxiedOrDirectPoster(
        detail.thumbnailUrl,
        appOrigin,
        requestHost,
      ),
      onlyDashOrUnsupported,
    };
  }
  if (rawPlayback.kind === "progressive") {
    const variants = toProxiedOrDirectVariants(
      rawPlayback.variants,
      appOrigin,
      requestHost,
    );
    return {
      payload: {
        mode: "progressive",
        variants,
      },
      poster: toProxiedOrDirectPoster(
        detail.thumbnailUrl,
        appOrigin,
        requestHost,
      ),
      onlyDashOrUnsupported,
    };
  }
  return {
    payload: null,
    poster: toProxiedOrDirectPoster(
      detail.thumbnailUrl,
      appOrigin,
      requestHost,
    ),
    onlyDashOrUnsupported,
  };
}
