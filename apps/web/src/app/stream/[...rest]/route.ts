import { mediaCorsPreflight, withMediaCors } from "@/lib/media-cors";
import {
  handleUpstreamMediaRequest,
  STREAM_PROXY_PREFIX,
} from "@/server/media/upstream-proxy";

/**
 * Byte-range media and HLS manifests, served same-origin with the media origin
 * (see `media-origin.ts`) so the browser and hls.js are not blocked by CORS.
 * Playlists are text-rewritten so absolute segment URLs land here too.
 *
 * Named for what it does rather than where the bytes come from — the upstream is
 * a config detail. Replaces `/invidious/…`, which is kept as an alias while
 * cached manifests still reference it (Phase 5).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ rest?: string[] }> },
) {
  const { rest } = await context.params;
  return withMediaCors(
    await handleUpstreamMediaRequest(request, {
      segments: rest,
      prefix: STREAM_PROXY_PREFIX,
    }),
  );
}

export function OPTIONS(): Response {
  return mediaCorsPreflight();
}
