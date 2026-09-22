import { mediaCorsPreflight, withMediaCors } from "@/lib/media-cors";
import { getDb } from "@/server/db/client";
import {
  fetchCompanionDvrManifest,
  rewriteDvrManifestSegmentUrls,
} from "@/server/services/dash/dvr-manifest";
import {
  DASH_VIDEO_FAMILIES,
  type DashVideoFamily,
  generateMpd,
} from "@/server/services/dash/generate";
import {
  buildLiveManifest,
  companionLiveSegmentUrl,
  fetchCompanionLiveManifest,
  initSegmentFromSelfInitializing,
  LIVE_INIT_PATH,
  newestLiveSegmentPath,
} from "@/server/services/dash/live-manifest";
import { fetchVideoDetail } from "@/server/services/proxy";
import { createCaller } from "@/server/trpc/caller";

/**
 * invidious-companion's DASH manifest for a Post-Live-DVR video, with its
 * expiring segment URLs swapped for stable `/dvr/...` paths this server resolves
 * per request (see `dvr-manifest.ts`). Returns null when the companion can't
 * build one either — the caller then reports the original failure.
 */
async function companionDashManifest(videoId: string): Promise<string | null> {
  const mpd = await fetchCompanionDvrManifest(videoId);
  if (!mpd) return null;
  return rewriteDvrManifestSegmentUrls(mpd, videoId);
}

/**
 * Requesting a manifest is a play, so the server records it rather than
 * trusting a client to report one. Clients that authenticate (the TV sends a
 * device-token Bearer header) get the watch written here; the position they
 * later reach still has to come from the player, since nothing about a manifest
 * fetch reveals a playhead.
 *
 * Best-effort throughout: a failure here must never stop the manifest.
 */
async function recordPlay(request: Request, videoId: string): Promise<void> {
  try {
    const caller = await createCaller(request);
    const db = getDb();
    // channelId is required by the history event; the detail is already cached
    // from the same upstream fetch the manifest used.
    const detail = await fetchVideoDetail(db, { videoId });
    if (!detail.channelId) return;
    await caller.history.upsertEvent({
      videoId,
      channelId: detail.channelId,
      channelName: detail.channelName,
      videoTitle: detail.title,
      videoDurationSeconds: detail.durationSeconds,
    });
  } catch {
    // Unauthenticated callers and upstream hiccups both land here.
  }
}

const MPD_CONTENT_TYPE = "application/dash+xml";
const VIDEO_ID_RE = /^[\w-]{6,20}$/;
/** Index of a BaseURL in the companion's live manifest. */
const LIVE_REP_RE = /^\d{1,3}$/;
/** What YouTube's live SegmentURLs look like: `sq/<n>/lmt/<n>`. */
const LIVE_SEGMENT_PATH_RE = /^[\w-]+(\/[\w.-]+)*$/;
/** One 5s 1080p60 segment is ~4MB from the companion on the same host. */
const LIVE_SEGMENT_TIMEOUT_MS = 30_000;

/**
 * A live broadcast's manifest: `/dash/<videoId>/live.mpd`. YouTube's own
 * dynamic manifest via invidious-companion, trimmed, with segments pointed at
 * `/dash/<videoId>/live/...` below (see `live-manifest.ts`). dash.js re-fetches
 * it every `minimumUpdatePeriod`, so it is never cached and never records a
 * play.
 */
async function serveLiveManifest(videoId: string): Promise<Response> {
  const mpd = await buildLiveManifest(videoId);
  if (!mpd) {
    // Retryable: dash.js keeps polling a dynamic manifest through failures.
    return new Response("live manifest unavailable", { status: 502 });
  }
  return new Response(mpd, {
    headers: {
      "content-type": MPD_CONTENT_TYPE,
      "cache-control": "no-store",
    },
  });
}

/**
 * A live stream's codec configuration doesn't change mid-broadcast, so one
 * init segment per representation is fetched once and reused.
 */
const LIVE_INIT_TTL_MS = 10 * 60_000;
const liveInitCache = new Map<
  string,
  { at: number; bytes: Uint8Array<ArrayBuffer> }
>();

/**
 * `/dash/<videoId>/live/<rep>/init`: the `ftyp`+`moov` of that
 * representation's newest segment. YouTube's live segments are
 * self-initializing, so the manifest names no init segment of its own.
 */
async function serveLiveInit(videoId: string, rep: string): Promise<Response> {
  const key = `${videoId}/${rep}`;
  const now = Date.now();
  const hit = liveInitCache.get(key);
  let bytes = hit && now - hit.at <= LIVE_INIT_TTL_MS ? hit.bytes : undefined;
  if (!bytes) {
    const mpd = await fetchCompanionLiveManifest(videoId);
    const path = mpd ? newestLiveSegmentPath(mpd, rep) : null;
    const url = path ? companionLiveSegmentUrl(videoId, rep, path) : null;
    if (!url) return new Response("live init unavailable", { status: 502 });
    let segment: Uint8Array;
    try {
      const r = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(LIVE_SEGMENT_TIMEOUT_MS),
      });
      if (!r.ok) {
        await r.body?.cancel?.();
        return new Response(`live init upstream ${r.status}`, { status: 502 });
      }
      segment = new Uint8Array(await r.arrayBuffer());
    } catch {
      return new Response("live init fetch failed", { status: 502 });
    }
    const init = initSegmentFromSelfInitializing(segment);
    if (!init) return new Response("live init has no moov", { status: 502 });
    bytes = init;
    for (const [k, v] of liveInitCache) {
      if (now - v.at > LIVE_INIT_TTL_MS) liveInitCache.delete(k);
    }
    liveInitCache.set(key, { at: now, bytes });
  }
  return new Response(bytes, {
    headers: {
      "content-type": "video/mp4",
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
    },
  });
}

/**
 * One live segment: `/dash/<videoId>/live/<rep>/sq/<n>/lmt/<n>`, streamed from
 * the companion, which fetches the IP-locked googlevideo URL it holds for
 * `<rep>`. The companion only holds those while it has the manifest cached, so
 * a 404 (it restarted, or evicted it) re-fetches the manifest and retries once.
 */
async function serveLiveSegment(
  request: Request,
  videoId: string,
  rep: string | undefined,
  tail: string[],
): Promise<Response> {
  const path = tail.join("/");
  if (
    !rep ||
    !LIVE_REP_RE.test(rep) ||
    !LIVE_SEGMENT_PATH_RE.test(path) ||
    tail.includes("..")
  ) {
    return new Response("not found", { status: 404 });
  }
  if (path === LIVE_INIT_PATH) return serveLiveInit(videoId, rep);
  const fetchSegment = () => {
    const url = companionLiveSegmentUrl(videoId, rep, path);
    if (!url) return null;
    return fetch(url, {
      cache: "no-store",
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(LIVE_SEGMENT_TIMEOUT_MS),
      ]),
    });
  };

  let upstream: Response | null;
  try {
    upstream = await fetchSegment();
    if (upstream?.status === 404) {
      await upstream.body?.cancel?.();
      await fetchCompanionLiveManifest(videoId, true);
      upstream = await fetchSegment();
    }
  } catch {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return new Response("live segment fetch failed", { status: 502 });
  }
  if (!upstream) {
    return new Response("companion not configured", { status: 503 });
  }
  if (!upstream.ok) {
    await upstream.body?.cancel?.();
    return new Response(`live segment upstream ${upstream.status}`, {
      status: 502,
    });
  }

  // Buffered, like /dvr: live segments carry no length upstream (`noclen`),
  // and a complete, well-framed response is what MSE appends cleanly.
  let body: ArrayBuffer;
  try {
    body = await upstream.arrayBuffer();
  } catch {
    return new Response("live segment read failed", { status: 502 });
  }
  return new Response(body, {
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-length": String(body.byteLength),
      "cache-control": "no-store",
    },
  });
}

/**
 * Serves a synthesized VOD DASH manifest (see `dash/generate.ts`):
 *   /dash/<videoId>/manifest.mpd?video=vp9|av01|avc
 * The video codec family is picked client-side via MSE `isTypeSupported`
 * probes; VP9/AV1 unlock the >1080p rungs the AVC-only HLS path cannot carry.
 * Representations resolve to the same-origin `/invidious/videoplayback` proxy.
 *
 * Live broadcasts use `/dash/<videoId>/live.mpd` and its `/live/...` segments
 * instead (see `serveLiveManifest`).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ parts?: string[] }> },
): Promise<Response> {
  return withMediaCors(await handleGET(request, context));
}

export function OPTIONS(): Response {
  return mediaCorsPreflight();
}

async function handleGET(
  request: Request,
  context: { params: Promise<{ parts?: string[] }> },
): Promise<Response> {
  const { parts } = await context.params;
  const [videoId, file, ...rest] = parts ?? [];
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return new Response("not found", { status: 404 });
  }
  if (file === "live.mpd" && rest.length === 0) {
    return serveLiveManifest(videoId);
  }
  if (file === "live") {
    const [rep, ...tail] = rest;
    return serveLiveSegment(request, videoId, rep, tail);
  }
  if (file !== "manifest.mpd" || rest.length > 0) {
    return new Response("not found", { status: 404 });
  }
  const params = new URL(request.url).searchParams;
  const raw = params.get("video") ?? "avc";
  const family = DASH_VIDEO_FAMILIES.includes(raw as DashVideoFamily)
    ? (raw as DashVideoFamily)
    : "avc";
  // Optional audio-language filter (TV language chooser — see generateMpd).
  const langRaw = params.get("lang");
  const audioLang =
    langRaw && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(langRaw)
      ? langRaw
      : null;

  // Fire and forget: the manifest response shouldn't wait on history.
  void recordPlay(request, videoId);

  try {
    const body = await generateMpd(videoId, family, audioLang);
    return new Response(body, {
      headers: {
        "content-type": MPD_CONTENT_TYPE,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    // Post-Live-DVR (an ended livestream YouTube hasn't converted to VOD yet)
    // exposes no byte-range-indexed formats, so we can't synthesize an MPD.
    // invidious-companion can, though — it builds a SegmentTemplate manifest
    // via YouTube.js with deciphered, po_token'd segment URLs. Proxy that
    // instead of failing. Its segments are companion URLs carrying
    // `access-control-allow-origin: *`, so dash.js can fetch them directly.
    const companion = await companionDashManifest(videoId);
    if (companion) {
      return new Response(companion, {
        headers: {
          "content-type": MPD_CONTENT_TYPE,
          "cache-control": "no-store",
        },
      });
    }
    return new Response(`dash generation failed: ${(e as Error).message}`, {
      status: 502,
    });
  }
}
