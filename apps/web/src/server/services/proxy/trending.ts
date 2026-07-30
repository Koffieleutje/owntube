import { stripRestrictedListVideos } from "@/lib/feed-exclude-restricted";
import { invidiousPortCollidesWithNextApp } from "@/lib/invidious-port-collision";
import { logger } from "@/lib/logger";
import type { AppDb } from "@/server/db/client";
import {
  readFreshCacheRow,
  readLatestCacheRow,
  registerInFlight,
  trendingCacheKey,
  writeCache,
} from "@/server/services/proxy/cache";
import { resolveProxyBaseCandidates } from "@/server/services/proxy/config";
import {
  recordUpstreamFailure,
  throwIfUpstreamFailed,
} from "@/server/services/proxy/errors";
import { fetchJson } from "@/server/services/proxy/http";
import { mapInvidiousItem } from "@/server/services/proxy/mappers/invidious";
import {
  liveUpstreamSource,
  normalizeBaseUrl,
} from "@/server/services/proxy/normalize";
import {
  cachedTrendingPayloadSchema,
  type TrendingInput,
  type TrendingVideosResult,
  trendingVideosResultSchema,
  type UnifiedVideo,
} from "@/server/services/proxy.types";
import { acquireUpstreamSlot } from "@/server/services/rate-limiter";

const inFlightTrending = new Map<string, Promise<TrendingVideosResult>>();

export function clearTrendingInFlight(): void {
  inFlightTrending.clear();
}

function readFreshTrendingCache(
  db: AppDb,
  key: string,
): TrendingVideosResult | null {
  const row = readFreshCacheRow(db, key);
  if (!row) return null;
  const raw = JSON.parse(row.payloadJson) as unknown;
  const parsed = cachedTrendingPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  logger.info("video_cache.hit", { cacheKey: key, kind: row.kind });
  return {
    videos: stripRestrictedListVideos(parsed.data.videos),
    sourceUsed: "cache",
    stale: false,
  };
}

function readStaleTrendingCache(
  db: AppDb,
  key: string,
): TrendingVideosResult | null {
  const row = readLatestCacheRow(db, key);
  if (!row) return null;
  const raw = JSON.parse(row.payloadJson) as unknown;
  const parsed = cachedTrendingPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  logger.warn("video_cache.stale_hit", { cacheKey: key, kind: row.kind });
  return {
    videos: stripRestrictedListVideos(parsed.data.videos),
    sourceUsed: "cache",
    stale: true,
    warning: "Upstream unavailable, serving stale cache.",
  };
}

export function buildInvidiousTrendingUrl(
  base: string,
  region: string,
  category?: string,
): string {
  const u = new URL("/api/v1/trending", `${normalizeBaseUrl(base)}/`);
  u.searchParams.set("region", region.toUpperCase());
  if (category) u.searchParams.set("type", category);
  return u.toString();
}

function parseInvidiousTrending(
  data: unknown,
  limit: number,
  invidiousBase: string,
): UnifiedVideo[] {
  if (!Array.isArray(data)) return [];
  const videos: UnifiedVideo[] = [];
  for (const item of data) {
    const m = mapInvidiousItem(item, invidiousBase);
    if (m) videos.push(m);
    if (videos.length >= limit) break;
  }
  return videos;
}

export async function fetchTrendingVideos(
  db: AppDb,
  input: TrendingInput,
): Promise<TrendingVideosResult> {
  const region = input.region.toUpperCase();
  const limit = Math.min(200, input.limit ?? 40);
  const key = trendingCacheKey({ region, limit, category: input.category });
  const fresh = readFreshTrendingCache(db, key);
  if (fresh) return fresh;
  const inFlight = inFlightTrending.get(key);
  if (inFlight) return inFlight;

  const task = (async (): Promise<TrendingVideosResult> => {
    const { invidiousBases } = resolveProxyBaseCandidates();
    const errors: string[] = [];

    let resolved: TrendingVideosResult | null = null;

    for (const invidiousBase of invidiousBases) {
      if (invidiousPortCollidesWithNextApp(invidiousBase)) {
        errors.push("invidious:port collision with Next.js");
        continue;
      } else {
        try {
          acquireUpstreamSlot();
          const json = await fetchJson(
            buildInvidiousTrendingUrl(invidiousBase, region, input.category),
            { emptyBodyAs: [], source: "invidious", baseUrl: invidiousBase },
          );
          const videos = parseInvidiousTrending(json, limit, invidiousBase);
          if (videos.length > 0) {
            resolved = trendingVideosResultSchema.parse({
              videos,
              sourceUsed: "invidious",
            });
          }
        } catch (e) {
          recordUpstreamFailure(e, "invidious", errors, invidiousBase);
        }
      }
      if (resolved && resolved.videos.length > 0) break;
    }

    if (!resolved || resolved.videos.length === 0) {
      const stale = readStaleTrendingCache(db, key);
      if (stale) return stale;
      throwIfUpstreamFailed(errors, "trending unavailable");
    }

    const cleaned = stripRestrictedListVideos(resolved.videos);
    const out: TrendingVideosResult = {
      ...resolved,
      videos: cleaned,
    };
    const store = {
      videos: out.videos,
      sourceUsed: liveUpstreamSource(out.sourceUsed),
    };
    writeCache(db, key, store.sourceUsed, store, "trending");
    return out;
  })();
  registerInFlight(inFlightTrending, key, task);

  // Serve-stale-and-revalidate: an expired row answers instantly while the
  // task above refreshes the cache in the background.
  const stale = readStaleTrendingCache(db, key);
  if (stale) return { ...stale, warning: undefined };
  return task;
}
