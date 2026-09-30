import { invidiousPortCollidesWithNextApp } from "@/lib/invidious-port-collision";
import type { AppDb } from "@/server/db/client";
import {
  readFreshCacheRow,
  readRecentCacheRow,
  registerInFlight,
  writeCache,
} from "@/server/services/proxy/cache";
import { resolveProxyBaseCandidates } from "@/server/services/proxy/config";
import {
  recordUpstreamFailure,
  throwIfUpstreamFailed,
} from "@/server/services/proxy/errors";
import { fetchJson } from "@/server/services/proxy/http";
import {
  channelIdFromPath,
  liveUpstreamSource,
  normalizeBaseUrl,
  resolveInvidiousThumbnail,
} from "@/server/services/proxy/normalize";
import {
  type UnifiedComment,
  unifiedCommentSchema,
  type VideoCommentsInput,
  type VideoCommentsResult,
  videoCommentsResultSchema,
} from "@/server/services/proxy.types";
import { acquireUpstreamSlot } from "@/server/services/rate-limiter";

/**
 * Thrown by a cache-only comments read (SSR prefetch) when nothing is cached,
 * so the prefetch fails instead of seeding the query with empty data — the
 * client then fetches on mount as usual.
 */
export class CommentsCacheMissError extends Error {
  constructor() {
    super("comments cache-only miss");
    this.name = "CommentsCacheMissError";
  }
}

function buildInvidiousCommentsUrl(
  base: string,
  videoId: string,
  sortBy: "top" | "new",
  continuation?: string,
): string {
  const u = new URL(
    `/api/v1/comments/${encodeURIComponent(videoId)}`,
    `${normalizeBaseUrl(base)}/`,
  );
  u.searchParams.set("sort_by", sortBy);
  u.searchParams.set("source", "youtube");
  if (continuation) u.searchParams.set("continuation", continuation);
  return u.toString();
}

function mapInvidiousComment(
  raw: unknown,
  invidiousBase: string,
): UnifiedComment | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const commentId = typeof o.commentId === "string" ? o.commentId.trim() : "";
  const author = typeof o.author === "string" ? o.author.trim() : "";
  const contentHtml =
    typeof o.contentHtml === "string" ? o.contentHtml.trim() : "";
  const content = typeof o.content === "string" ? o.content.trim() : "";
  const text = contentHtml || content;
  if (!commentId || !author || !text) return null;
  const authorId =
    typeof o.authorId === "string" && o.authorId.trim().length > 0
      ? o.authorId.trim()
      : channelIdFromPath(
          typeof o.authorUrl === "string" ? o.authorUrl : undefined,
        );
  const likeCount =
    typeof o.likeCount === "number" && Number.isFinite(o.likeCount)
      ? Math.max(0, Math.floor(o.likeCount))
      : undefined;
  const replies =
    o.replies && typeof o.replies === "object"
      ? (o.replies as Record<string, unknown>)
      : undefined;
  const replyCount =
    replies &&
    typeof replies.replyCount === "number" &&
    Number.isFinite(replies.replyCount)
      ? Math.max(0, Math.floor(replies.replyCount))
      : undefined;
  const parsed = unifiedCommentSchema.safeParse({
    commentId,
    author,
    authorId,
    text,
    publishedText:
      typeof o.publishedText === "string" ? o.publishedText : undefined,
    authorAvatarUrl: resolveInvidiousThumbnail(
      o.authorThumbnails,
      invidiousBase,
    ),
    likeCount,
    isPinned: o.isPinned === true,
    isHearted: Boolean(o.creatorHeart),
    replyCount,
  });
  if (!parsed.success) return null;
  return parsed.data;
}

function mapInvidiousComments(
  data: unknown,
  invidiousBase: string,
  videoId: string,
): VideoCommentsResult | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const comments: UnifiedComment[] = [];
  if (Array.isArray(o.comments)) {
    for (const raw of o.comments) {
      const mapped = mapInvidiousComment(raw, invidiousBase);
      if (mapped) comments.push(mapped);
    }
  }
  const continuation =
    typeof o.continuation === "string" && o.continuation.trim().length > 0
      ? o.continuation.trim()
      : null;
  const commentCount =
    typeof o.commentCount === "number" && Number.isFinite(o.commentCount)
      ? Math.max(0, Math.floor(o.commentCount))
      : undefined;
  const parsed = videoCommentsResultSchema.safeParse({
    videoId:
      typeof o.videoId === "string" && o.videoId.trim().length > 0
        ? o.videoId.trim()
        : videoId,
    comments,
    continuation,
    commentCount,
    sourceUsed: "invidious",
  });
  if (!parsed.success) return null;
  return parsed.data;
}

const inFlightComments = new Map<string, Promise<VideoCommentsResult>>();

export function clearCommentsInFlight(): void {
  inFlightComments.clear();
}

function commentsCacheKey(videoId: string, sortBy: string): string {
  return `comments:v1:${videoId}:${sortBy}`;
}

function readCommentsCacheRow(
  row: { payloadJson: string } | undefined,
): VideoCommentsResult | null {
  if (!row) return null;
  const parsed = videoCommentsResultSchema.safeParse(
    JSON.parse(row.payloadJson) as unknown,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * First comment pages (no continuation) are cached in `video_cache` with
 * serve-stale-and-revalidate semantics, so the cache warmer can pre-fetch the
 * likely-next videos and the watch page's slowest interactive call becomes a
 * local read. Continuation pages stay live — they're an explicit "load more".
 */
export async function fetchVideoComments(
  db: AppDb,
  input: VideoCommentsInput,
  opts?: { cacheOnly?: boolean },
): Promise<VideoCommentsResult> {
  const continuationRequested = Boolean(input.continuation?.trim());
  if (continuationRequested) {
    if (opts?.cacheOnly) throw new CommentsCacheMissError();
    return fetchVideoCommentsLive(input);
  }

  const key = commentsCacheKey(input.videoId, input.sortBy);
  const fresh = readCommentsCacheRow(readFreshCacheRow(db, key));
  if (fresh) return fresh;

  // Cache-only (SSR prefetch): never block the watch page on an upstream
  // comments fetch. Serve stale if we have any; otherwise signal a miss so the
  // prefetch doesn't seed the query with empty (or long-outdated) data — the
  // client fetches on mount exactly as before.
  if (opts?.cacheOnly) {
    const stale = readCommentsCacheRow(readRecentCacheRow(db, key));
    if (stale) return stale;
    throw new CommentsCacheMissError();
  }

  const inFlight = inFlightComments.get(key);
  if (inFlight) return inFlight;
  const task = (async () => {
    const live = await fetchVideoCommentsLive(input);
    writeCache(db, key, liveUpstreamSource(live.sourceUsed), live, "comments");
    return live;
  })();
  registerInFlight(inFlightComments, key, task);

  const stale = readCommentsCacheRow(readRecentCacheRow(db, key));
  if (stale) return stale;
  return task;
}

/** Invidious answered but failed server-side (e.g. a comment parser crash). */
const INVIDIOUS_SERVER_ERROR = /^invidious:HTTP 5\d\d\b/;

async function fetchVideoCommentsLive(
  input: VideoCommentsInput,
): Promise<VideoCommentsResult> {
  const continuation = input.continuation?.trim() || undefined;
  const { resolved, errors } = await fetchInvidiousComments(
    input.videoId,
    input.sortBy,
    continuation,
  );
  if (resolved) return resolved;

  // Invidious's "top" parser breaks on some videos whose sort="top" page
  // includes non-comment items (it 500s with `Missing hash key:
  // "commentRenderer"`), while sort="new" still parses. Fall back only when
  // Invidious itself returned a 5xx — rate limits and network failures would
  // fail the second request just the same.
  if (
    input.sortBy === "top" &&
    !continuation &&
    errors.some((e) => INVIDIOUS_SERVER_ERROR.test(e))
  ) {
    const fallback = await fetchInvidiousComments(input.videoId, "new");
    if (fallback.resolved) {
      return {
        ...fallback.resolved,
        warning: "Top comments are unavailable; showing newest first.",
      };
    }
    errors.push(...fallback.errors);
  }

  throwIfUpstreamFailed(errors, "comments unavailable");
}

async function fetchInvidiousComments(
  videoId: string,
  sortBy: "top" | "new",
  continuation?: string,
): Promise<{ resolved: VideoCommentsResult | null; errors: string[] }> {
  const { invidiousBases } = resolveProxyBaseCandidates();
  const errors: string[] = [];

  let resolved: VideoCommentsResult | null = null;
  for (const invidiousBase of invidiousBases) {
    if (invidiousPortCollidesWithNextApp(invidiousBase)) {
      errors.push(
        "invidious:INVIDIOUS_BASE_URL port conflicts with Next.js PORT (server would call itself).",
      );
      continue;
    }
    try {
      acquireUpstreamSlot();
      const json = await fetchJson(
        buildInvidiousCommentsUrl(invidiousBase, videoId, sortBy, continuation),
        { source: "invidious", baseUrl: invidiousBase },
      );
      resolved = mapInvidiousComments(json, invidiousBase, videoId);
      break;
    } catch (error) {
      recordUpstreamFailure(error, "invidious", errors, invidiousBase);
    }
  }

  return { resolved, errors };
}
