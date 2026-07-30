import { mediaCorsPreflight, withMediaCors } from "@/lib/media-cors";
import {
  handleUpstreamMediaRequest,
  LEGACY_PROXY_PREFIX,
} from "@/server/media/upstream-proxy";

/**
 * Legacy alias for `/stream` and `/image`.
 *
 * This prefix was named after an upstream while serving a generic asset/media
 * proxy, and it is referenced by manifests OwnTube has already handed out.
 * Stream payloads are cached for at most 3 hours (`STREAMS_DETAIL_CACHE_TTL_MAX_SEC`),
 * and googlevideo URLs expire on a similar horizon, so nothing generated before
 * a deploy outlives that window.
 *
 * Delete this route — and the prefix handling in `upstream-proxy.ts` — once a
 * deploy has been live longer than that. Phase 5 in
 * docs/INVIDIOUS-BOUNDARY-PLAN.md tracks it.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const { path } = await context.params;
  return withMediaCors(
    await handleUpstreamMediaRequest(request, {
      segments: path,
      prefix: LEGACY_PROXY_PREFIX,
    }),
  );
}

export function OPTIONS(): Response {
  return mediaCorsPreflight();
}
