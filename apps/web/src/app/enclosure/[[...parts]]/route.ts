import { mediaCorsPreflight, withMediaCors } from "@/lib/media-cors";
import { resolveInvidiousAbsoluteMediaUrl } from "@/server/services/proxy/normalize";

/**
 * Stable, single-file media endpoint used as the RSS `<enclosure>` target for
 * the remote-control publisher (see `server/remote/publish.ts`). A podcast /
 * RSS client fetches `/enclosure/<videoId>.m4a` (audio) or `.mp4` (progressive
 * video); this route resolves the *current* stream for that id and 302s to the
 * same-origin `/stream/videoplayback` proxy, which already forwards Range,
 * emits 206, retries, and asks Invidious to proxy googlevideo (`local=true`) so
 * the bytes are server-fetchable — the raw googlevideo URLs are IP-locked to
 * the client and 403 when proxied from our IP.
 *
 * Stream URLs are signed and expire (~6h), so we never bake one into a feed:
 * the enclosure points here and we re-resolve on every play. Hence `no-store`.
 */
const VIDEO_ID_RE = /^[\w-]{6,20}$/;
const INVIDIOUS_TIMEOUT_MS = 20_000;

type InvidiousFormat = {
  url?: string;
  type?: string;
  bitrate?: number | string;
  qualityLabel?: string;
  quality?: string;
};

function invidiousBase(): string {
  return process.env.INVIDIOUS_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
}

function bitrateOf(f: InvidiousFormat): number {
  const n = typeof f.bitrate === "string" ? Number(f.bitrate) : f.bitrate;
  return Number.isFinite(n) ? (n as number) : 0;
}

/** Fetch the video's streams with `local=true` so the URLs are Invidious-proxied. */
async function fetchLocalFormats(
  videoId: string,
  signal: AbortSignal,
): Promise<{
  formatStreams: InvidiousFormat[];
  adaptiveFormats: InvidiousFormat[];
}> {
  const inv = invidiousBase();
  if (!inv) throw new Error("INVIDIOUS_BASE_URL not configured");
  const local =
    process.env.INVIDIOUS_USE_LOCAL !== "false" ? "?local=true" : "";
  const r = await fetch(
    `${inv}/api/v1/videos/${encodeURIComponent(videoId)}${local}`,
    { signal, cache: "no-store" },
  );
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  const j = (await r.json()) as {
    formatStreams?: InvidiousFormat[];
    adaptiveFormats?: InvidiousFormat[];
  };
  return {
    formatStreams: Array.isArray(j.formatStreams) ? j.formatStreams : [],
    adaptiveFormats: Array.isArray(j.adaptiveFormats) ? j.adaptiveFormats : [],
  };
}

/** Best AAC/m4a audio stream (itag 140-family), highest bitrate first. */
function pickAudio(adaptive: InvidiousFormat[]): InvidiousFormat | null {
  const candidates = adaptive.filter(
    (f) => f.url && (f.type ?? "").toLowerCase().startsWith("audio/mp4"),
  );
  candidates.sort((a, b) => bitrateOf(b) - bitrateOf(a));
  return candidates[0] ?? null;
}

/** Best progressive muxed MP4 (legacy itag 18/22), highest quality first. */
function pickMuxed(formatStreams: InvidiousFormat[]): InvidiousFormat | null {
  const candidates = formatStreams.filter(
    (f) => f.url && (f.type ?? "").toLowerCase().startsWith("video/mp4"),
  );
  const heightOf = (f: InvidiousFormat): number => {
    const m = (f.qualityLabel ?? f.quality ?? "").match(/(\d{2,4})\s*p/i);
    return m?.[1] ? Number.parseInt(m[1], 10) : 0;
  };
  candidates.sort(
    (a, b) => heightOf(b) - heightOf(a) || bitrateOf(b) - bitrateOf(a),
  );
  return candidates[0] ?? null;
}

/**
 * Rewrite an upstream stream URL to our same-origin `/stream` proxy path.
 * Relative (`local=true`) URLs are resolved against the Invidious base first.
 * A relative `Location` keeps the redirect on whichever origin served this
 * route (the media origin), which also proxies `/stream`.
 */
function toProxyPath(streamUrl: string): string | null {
  const abs = resolveInvidiousAbsoluteMediaUrl(streamUrl, invidiousBase());
  if (!abs) return null;
  try {
    const u = new URL(abs);
    return `/stream${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ parts?: string[] }> },
): Promise<Response> {
  return withMediaCors(await handleGET(request, context));
}

export async function HEAD(
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
  const name = parts?.[0] ?? "";
  const dot = name.lastIndexOf(".");
  const videoId = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (
    !videoId ||
    !VIDEO_ID_RE.test(videoId) ||
    (ext !== "m4a" && ext !== "mp4")
  ) {
    return new Response("not found", { status: 404 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INVIDIOUS_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  request.signal.addEventListener("abort", onAbort);
  try {
    const { formatStreams, adaptiveFormats } = await fetchLocalFormats(
      videoId,
      controller.signal,
    );
    // `.mp4` prefers a progressive muxed stream; if none exists (modern uploads
    // often drop itag 18/22), fall back to audio-only so the enclosure never 404s.
    const chosen =
      ext === "mp4"
        ? (pickMuxed(formatStreams) ?? pickAudio(adaptiveFormats))
        : pickAudio(adaptiveFormats);
    const target = chosen?.url ? toProxyPath(chosen.url) : null;
    if (!target) {
      return new Response("no stream", { status: 404 });
    }
    return new Response(null, {
      status: 302,
      headers: { location: target, "cache-control": "no-store" },
    });
  } catch (error: unknown) {
    if (controller.signal.aborted) return new Response(null, { status: 499 });
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`media resolve failed: ${message}`, { status: 502 });
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onAbort);
  }
}
