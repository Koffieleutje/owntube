import { mediaCorsPreflight, withMediaCors } from "@/lib/media-cors";
import { getDb } from "@/server/db/client";
import {
  DASH_VIDEO_FAMILIES,
  type DashVideoFamily,
  generateMpd,
} from "@/server/services/dash/generate";
import { fetchVideoDetail } from "@/server/services/proxy";
import { getUserProxyOverrides } from "@/server/settings/profile";
import { createCaller } from "@/server/trpc/caller";

/**
 * Give every `SegmentTemplate` an explicit `initialization`, pointing at its own
 * segment 0.
 *
 * YouTube's live/DVR segments are each self-initializing — every one begins
 * `ftyp` + `moov` before its `emsg`/`moof`/`mdat` — so there is no separate init
 * segment and the companion's manifest rightly omits the attribute. But the DASH
 * spec says an absent `Initialization` means the init segment is at the BaseURL,
 * and with no `<BaseURL>` element that resolves to the manifest's own directory.
 * dash.js duly requests `/dash/<id>/`, which Next 308-redirects (redirects carry
 * none of `withMediaCors`'s headers) — so on the separate media origin Safari
 * blocks it as a disallowed cross-origin redirect and the video spins forever.
 *
 * Segment 0 *is* a valid initialization segment, so naming it explicitly gives
 * dash.js real `ftyp`+`moov` and stops it probing the directory. Segment 0 gets
 * fetched twice (once as init, once as media); MSE coalesces the duplicate
 * timestamps, and it's one segment of overhead.
 */
function withExplicitInitSegments(mpd: string): string {
  return mpd.replace(/<SegmentTemplate([^>]*)>/g, (whole, attrs: string) => {
    if (/\binitialization\s*=/.test(attrs)) return whole;
    const media = /\bmedia="([^"]*)"/.exec(attrs);
    if (!media || !media[1].includes("$Number$")) return whole;
    const init = media[1].replace(/\$Number\$/g, "0");
    // Preserve a self-closing tag as self-closing.
    const trimmed = attrs.trimEnd();
    const selfClosing = trimmed.endsWith("/");
    const body = selfClosing ? trimmed.slice(0, -1).trimEnd() : attrs;
    return `<SegmentTemplate${body} initialization="${init}"${selfClosing ? "/" : ""}>`;
  });
}

/**
 * Fetch invidious-companion's own DASH manifest for a video, with `local=true`
 * so segment URLs point at the companion proxy (CORS-open) rather than
 * googlevideo directly (which the browser can't fetch). Returns null when the
 * companion can't build one either — the caller then reports the original
 * failure. Built from the PUBLIC base because the segment URLs inside must be
 * reachable by the browser, not just by this server.
 */
async function companionDashManifest(videoId: string): Promise<string | null> {
  const base = (process.env.INVIDIOUS_PUBLIC_BASE_URL ?? "").replace(
    /\/+$/,
    "",
  );
  if (!base) return null;
  try {
    const r = await fetch(
      `${base}/companion/api/manifest/dash/id/${encodeURIComponent(videoId)}?local=true`,
      { cache: "no-store", signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    const body = await r.text();
    return body.includes("<MPD") ? withExplicitInitSegments(body) : null;
  } catch {
    return null;
  }
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
    const detail = await fetchVideoDetail(
      db,
      { videoId },
      getUserProxyOverrides(db, null),
    );
    if (!detail.channelId) return;
    await caller.history.upsertEvent({
      videoId,
      channelId: detail.channelId,
      videoTitle: detail.title,
      videoDurationSeconds: detail.durationSeconds,
    });
  } catch {
    // Unauthenticated callers and upstream hiccups both land here.
  }
}

const MPD_CONTENT_TYPE = "application/dash+xml";
const VIDEO_ID_RE = /^[\w-]{6,20}$/;

/**
 * Serves a synthesized VOD DASH manifest (see `dash/generate.ts`):
 *   /dash/<videoId>/manifest.mpd?video=vp9|av01|avc
 * The video codec family is picked client-side via MSE `isTypeSupported`
 * probes; VP9/AV1 unlock the >1080p rungs the AVC-only HLS path cannot carry.
 * Representations resolve to the same-origin `/invidious/videoplayback` proxy.
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
  const [videoId, file] = parts ?? [];
  if (!videoId || !VIDEO_ID_RE.test(videoId) || file !== "manifest.mpd") {
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
