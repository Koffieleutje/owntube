import { mediaCorsPreflight, withMediaCors } from "@/lib/media-cors";
import {
  handleUpstreamMediaRequest,
  IMAGE_PROXY_PREFIX,
} from "@/server/media/upstream-proxy";

/**
 * Thumbnails, channel avatars and storyboards, served from the disk asset cache
 * (serve-stale-and-revalidate) with the thumbnail 404-fallback chain behind it.
 *
 * Shares a handler with `/stream` because the classification is by *subpath*,
 * not by route: `assetKindForSubpath` decides whether a request is a cacheable
 * image. The split exists so the two concerns have separate, honestly-named
 * entry points and can diverge (different cache headers, different limits)
 * without another URL migration.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ rest?: string[] }> },
) {
  const { rest } = await context.params;
  return withMediaCors(
    await handleUpstreamMediaRequest(request, {
      segments: rest,
      prefix: IMAGE_PROXY_PREFIX,
    }),
  );
}

export function OPTIONS(): Response {
  return mediaCorsPreflight();
}
