import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { mediaCorsPreflight, withMediaCors } from "@/lib/media-cors";
import { normalizeUpstreamBaseUrl } from "@/lib/upstream-base-url";
import { companionInternalBase } from "@/server/services/companion";

function invidiousUpstreamBase(): string {
  return normalizeUpstreamBaseUrl(process.env.INVIDIOUS_BASE_URL);
}

/**
 * Captions on some Invidious instances are fetched from YouTube's `timedtext`
 * endpoint from the *server* IP, which Google intermittently blocks — returning
 * a "Sorry…" anti-bot HTML page with `HTTP 200` and `content-type: text/vtt`
 * (both misleading). A good response begins with the `WEBVTT` magic line, so we
 * validate the body rather than trusting the status/content-type. We also
 * require at least one cue timing (`-->`): the same block frequently yields a
 * header-only, cue-less VTT — a valid-but-useless "empty" track we'd rather
 * retry (then 404) than surface as a caption option that shows nothing.
 */
function looksLikeUsableVtt(body: string): boolean {
  const trimmed = body.trimStart();
  if (!trimmed.toUpperCase().startsWith("WEBVTT")) return false;
  return trimmed.includes("-->");
}

/**
 * Successful VTT is cached for a short TTL. Caption text is static for a given
 * video, and one good fetch lets us ride out the intermittent upstream block
 * for every subsequent viewer. Failures are never cached.
 */
const CAPTIONS_CACHE_TTL_MS = 5 * 60_000;
const captionsCache = new Map<string, { at: number; vtt: string }>();

const FETCH_ATTEMPTS = 3;

/**
 * Fetch a usable VTT from Invidious's `/api/v1/captions`, with a couple of quick
 * retries. Invidious owns the upstream routing (a caption-capable instance
 * redirects this to its companion, which fetches the track with a po_token and
 * isn't IP-blocked); OwnTube stays decoupled and just consumes the public API.
 */
async function fetchCaptionsVtt(upstream: URL): Promise<string | null> {
  for (let i = 0; i < FETCH_ATTEMPTS; i++) {
    try {
      const r = await fetchWithTimeout(upstream, {
        headers: { "user-agent": "OwnTube/0.1", accept: "text/vtt, */*" },
        cache: "no-store",
      });
      if (r.ok) {
        const body = await r.text();
        // A 200 may still be a Google "Sorry…" block page (or an empty,
        // cue-less transcript) masquerading as VTT; only accept a usable body.
        if (looksLikeUsableVtt(body)) return body;
      } else {
        await r.body?.cancel?.();
      }
    } catch {
      // network/timeout — fall through to backoff + retry
    }
    if (i < FETCH_ATTEMPTS - 1) {
      await new Promise((res) => setTimeout(res, 200 * (i + 1)));
    }
  }
  return null;
}

/**
 * Pick the companion's track matching what the player asked for. Its labels come
 * from the same YouTube caption list Invidious exposes, so an exact label match
 * is the norm; the looser matches only cover casing drift and `lang` callers
 * (`en` accepting `en-US`). Never guesses when nothing matches — a wrong-language
 * subtitle track is worse than none.
 */
function pickCompanionTrack(
  tracks: { label?: string; languageCode?: string; url?: string }[],
  label?: string,
  lang?: string,
): { url?: string } | undefined {
  if (label) {
    const exact = tracks.find((t) => t.label === label);
    if (exact) return exact;
    const ci = tracks.find(
      (t) => t.label?.toLowerCase() === label.toLowerCase(),
    );
    if (ci) return ci;
  }
  if (lang) {
    const exact = tracks.find((t) => t.languageCode === lang);
    if (exact) return exact;
    const base = lang.split("-")[0].toLowerCase();
    return tracks.find(
      (t) => t.languageCode?.split("-")[0].toLowerCase() === base,
    );
  }
  return undefined;
}

/**
 * Ask invidious-companion directly — the primary source. Invidious fetches
 * `timedtext` from its own IP, which Google intermittently blocks (see
 * `looksLikeUsableVtt`); the companion fetches with a po_token and isn't
 * blocked, so it holds tracks Invidious cannot return. Two hops: list the
 * tracks, then fetch the matching one's URL.
 */
async function fetchCaptionsVttFromCompanion(
  videoId: string,
  label?: string,
  lang?: string,
): Promise<string | null> {
  const base = companionInternalBase();
  if (!base) return null;
  try {
    const listUrl = new URL(
      `companion/api/v1/captions/${encodeURIComponent(videoId)}`,
      `${base}/`,
    );
    const listRes = await fetchWithTimeout(listUrl, {
      headers: { "user-agent": "OwnTube/0.1", accept: "application/json" },
      cache: "no-store",
    });
    if (!listRes.ok) {
      await listRes.body?.cancel?.();
      return null;
    }
    const listed = (await listRes.json()) as {
      captions?: { label?: string; languageCode?: string; url?: string }[];
    };
    const track = pickCompanionTrack(listed.captions ?? [], label, lang);
    if (!track?.url) return null;
    // The listed URL is a path that already carries the companion's base_path.
    const vttRes = await fetchWithTimeout(new URL(track.url, `${base}/`), {
      headers: { "user-agent": "OwnTube/0.1", accept: "text/vtt, */*" },
      cache: "no-store",
    });
    if (!vttRes.ok) {
      await vttRes.body?.cancel?.();
      return null;
    }
    const body = await vttRes.text();
    return looksLikeUsableVtt(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Subtitle proxy: `/captions/{videoId}?label=…` (or `?lang=…`), on the media
 * origin (see media-origin.ts). Fetches the WebVTT track from
 * invidious-companion, falls back to Invidious, rejects the intermittent Google
 * block page either way, caches good results, and serves `text/vtt` with CORS so
 * a `<track crossorigin>` can attach it. Returns 404 (not garbage) when
 * unavailable from both.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ videoId?: string }> },
): Promise<Response> {
  return withMediaCors(await handleGET(request, context));
}

export function OPTIONS(): Response {
  return mediaCorsPreflight();
}

async function handleGET(
  request: Request,
  context: { params: Promise<{ videoId?: string }> },
) {
  const inv = invidiousUpstreamBase();
  if (!inv) {
    return new Response("INVIDIOUS_BASE_URL is not configured", {
      status: 503,
    });
  }

  const { videoId } = await context.params;
  if (!videoId) return new Response("missing videoId", { status: 400 });

  const query = new URL(request.url).searchParams;
  const label = query.get("label") ?? undefined;
  const lang = query.get("lang") ?? undefined;
  if (!label && !lang) {
    return new Response("missing label or lang", { status: 400 });
  }

  const cacheKey = `${videoId}\x00${label ?? ""}\x00${lang ?? ""}`;
  const hit = captionsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CAPTIONS_CACHE_TTL_MS) {
    return vttResponse(hit.vtt);
  }

  // Companion first. It is the source that actually works: it fetches the track
  // with a po_token, so it is not subject to the Google timedtext IP block that
  // makes Invidious's own fetch fail intermittently. Going here first also skips
  // the Invidious retry/backoff below, which cost 3-5s on every affected track,
  // and removes the fork-patched Invidious redirect from the hot path — that
  // patch has been silently lost by a rebuild before.
  //
  // Invidious stays as the fallback: it is still correct when it works, and this
  // keeps captions alive if the companion is the thing that's down.
  const upstream = new URL(
    `api/v1/captions/${encodeURIComponent(videoId)}`,
    `${inv}/`,
  );
  if (label) upstream.searchParams.set("label", label);
  if (lang) upstream.searchParams.set("lang", lang);

  const vtt =
    (await fetchCaptionsVttFromCompanion(videoId, label, lang)) ??
    (await fetchCaptionsVtt(upstream));
  if (vtt === null) {
    return new Response("captions unavailable", { status: 404 });
  }

  captionsCache.set(cacheKey, { at: Date.now(), vtt });
  return vttResponse(vtt);
}

function vttResponse(vtt: string): Response {
  return new Response(vtt, {
    status: 200,
    headers: {
      "content-type": "text/vtt; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
