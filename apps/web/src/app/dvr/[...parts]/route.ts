import { mediaCorsPreflight, withMediaCors } from "@/lib/media-cors";
import {
  invalidateDvrManifest,
  resolveDvrSegmentUrl,
} from "@/server/services/dash/dvr-manifest";

const VIDEO_ID_RE = /^[\w-]{6,20}$/;
const REP_ID_RE = /^[\w.-]{1,16}$/;
const SQ_RE = /^\d{1,7}$/;

/**
 * Post-Live-DVR segment proxy: `/dvr/<videoId>/<repId>/<sq>`.
 *
 * The manifest we serve for DVR (see `dvr-manifest.ts`) points every segment
 * here instead of at invidious-companion's expiring, po_token'd URLs, so the
 * browser only ever holds stable paths. Each request resolves the *current*
 * upstream URL from a 60s-cached copy of the companion manifest.
 *
 * On a 403 the cached manifest is dropped and the segment retried once against
 * a freshly fetched one — the token had gone stale. That is the whole point of
 * the indirection: dash.js treats the manifest as `type="static"` and never
 * refreshes it, so without this a stale token ends playback (a tab left paused
 * past `expire` is the easy way to hit it).
 *
 * Bytes are streamed rather than redirected to: a cross-origin redirect would
 * have to pass CORS on the redirect itself, and Range makes these non-simple
 * requests — the same class of failure that made dash.js's BaseURL probe fail.
 * VOD segments already flow through our own proxy, so this is consistent.
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

/** Pass Range through so dash.js's byte-range requests still work. */
function upstreamHeaders(request: Request): HeadersInit {
  const headers: Record<string, string> = {
    "user-agent": "OwnTube/0.1",
    accept: "*/*",
  };
  const range = request.headers.get("range");
  if (range) headers.range = range;
  return headers;
}

/**
 * A stalled upstream must not pin this request forever. One DVR segment is a
 * few seconds of media (~80KB audio, up to ~1.1MB video) coming from the
 * companion on the same host, so a whole-request budget is safe here — unlike a
 * long-lived stream, where aborting on total elapsed time would cut a healthy
 * transfer.
 */
const SEGMENT_TIMEOUT_MS = 30_000;

/**
 * Copy the headers a media response needs, dropping upstream CORS (withMediaCors
 * sets our own) and hop-by-hop framing.
 *
 * Content-Length is set from the buffered body rather than copied: live/DVR
 * segments carry `noclen=1` and arrive with no length at all, so computing it
 * gives the client a complete, well-framed response.
 */
function passthroughHeaders(upstream: Response, byteLength: number): Headers {
  const out = new Headers();
  for (const name of ["content-type", "content-range", "cache-control"]) {
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  out.set("content-length", String(byteLength));
  if (!out.has("cache-control")) out.set("cache-control", "no-store");
  return out;
}

async function handleGET(
  request: Request,
  context: { params: Promise<{ parts?: string[] }> },
): Promise<Response> {
  const { parts } = await context.params;
  const [videoId, repId, sq] = parts ?? [];
  if (
    !videoId ||
    !VIDEO_ID_RE.test(videoId) ||
    !repId ||
    !REP_ID_RE.test(repId) ||
    !sq ||
    !SQ_RE.test(sq)
  ) {
    return new Response("not found", { status: 404 });
  }

  const fetchSegment = (url: string) =>
    fetch(url, {
      headers: upstreamHeaders(request),
      cache: "no-store",
      signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS),
    });

  const resolved = await resolveDvrSegmentUrl(videoId, repId, sq);
  if (!resolved.ok) {
    // 404 only when the representation genuinely isn't in the manifest. A
    // momentarily unavailable companion must read as retryable — a 404 would
    // tell dash.js the segment doesn't exist and end playback.
    return resolved.reason === "no-representation"
      ? new Response("no such dvr segment", { status: 404 })
      : new Response("dvr manifest unavailable", { status: 503 });
  }
  let url = resolved.url;

  let upstream: Response;
  try {
    upstream = await fetchSegment(url);
  } catch {
    return new Response("dvr segment fetch failed", { status: 502 });
  }

  // Stale po_token: re-fetch the manifest and retry this segment once.
  if (upstream.status === 403) {
    await upstream.body?.cancel?.();
    invalidateDvrManifest(videoId);
    const retry = await resolveDvrSegmentUrl(videoId, repId, sq, true);
    if (retry.ok) url = retry.url;
    try {
      upstream = await fetchSegment(url);
    } catch {
      return new Response("dvr segment fetch failed", { status: 502 });
    }
  }

  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel?.();
    return new Response(`dvr segment upstream ${upstream.status}`, {
      status: upstream.status === 404 ? 404 : 502,
    });
  }

  let body: ArrayBuffer;
  try {
    body = await upstream.arrayBuffer();
  } catch {
    return new Response("dvr segment read failed", { status: 502 });
  }

  return new Response(body, {
    status: upstream.status,
    headers: passthroughHeaders(upstream, body.byteLength),
  });
}
