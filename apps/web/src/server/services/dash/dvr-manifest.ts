/**
 * Post-Live-DVR playback support (an ended livestream YouTube hasn't converted
 * to VOD yet).
 *
 * Nothing can be synthesized locally for these — they expose no byte-range
 * indexed formats — but invidious-companion builds a SegmentTemplate manifest
 * via YouTube.js with deciphered, po_token'd segment URLs. Those URLs expire
 * (`expire` currently runs 6h out, but the `pot` po_token can die sooner), and
 * the manifest is `type="static"`, so dash.js never refreshes it: once a URL
 * goes stale mid-playback the segment 403s with no recovery.
 *
 * So the browser never sees an expiring URL. The manifest we serve points every
 * segment at a stable `/dvr/<videoId>/<repId>/<sq>` path on our own media
 * origin, and that route resolves the current upstream URL per request from a
 * short-lived cache of the companion manifest — re-fetching on a 403. Expiry
 * becomes invisible: a tab paused for hours resumes fine.
 */

import {
  companionInternalBase,
  toInternalCompanionUrl,
  withCompanionCheck,
} from "@/server/services/companion";

const COMPANION_MANIFEST_TTL_MS = 60_000;

type CachedManifest = { at: number; mpd: string };
const manifestCache = new Map<string, CachedManifest>();

/**
 * The companion intermittently fails to build a DVR manifest (it re-fetches the
 * player response with `overrideCache` every time, so a bad moment surfaces as
 * "no usable adaptive video + AAC audio streams"). Retry briefly rather than
 * failing a segment mid-playback.
 */
const MANIFEST_ATTEMPTS = 3;

async function fetchFreshCompanionManifest(
  videoId: string,
): Promise<string | null> {
  // Fetched internally; the manifest we ask for still uses `local=true` so its
  // segment URLs go through the companion proxy rather than googlevideo.
  const base = companionInternalBase();
  if (!base) return null;
  const url = withCompanionCheck(
    `${base}/companion/api/manifest/dash/id/${encodeURIComponent(videoId)}?local=true`,
    videoId,
  );
  for (let i = 0; i < MANIFEST_ATTEMPTS; i++) {
    try {
      const r = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const mpd = await r.text();
        if (mpd.includes("<MPD")) return mpd;
      } else {
        await r.body?.cancel?.();
      }
    } catch {
      // network/timeout — fall through to backoff and retry
    }
    if (i < MANIFEST_ATTEMPTS - 1) {
      await new Promise((res) => setTimeout(res, 200 * (i + 1)));
    }
  }
  return null;
}

/**
 * Fetch invidious-companion's own DASH manifest, with `local=true` so segment
 * URLs point at the companion proxy rather than googlevideo directly. Fetched
 * from the INTERNAL base: nothing in this manifest is handed to the browser —
 * `rewriteDvrManifestSegmentUrls` replaces every segment URL with a `/dvr/...`
 * path first — so only this server needs to reach it.
 *
 * Cached briefly so a play doesn't re-fetch it per segment. When a refresh fails
 * the previous copy is served anyway: it's past its TTL but its URLs stay valid
 * for hours, so a stale manifest beats failing the segment. `force` (the caller
 * saw a 403) is the exception — those URLs are known bad, so there's nothing to
 * fall back to and the caller should report a retryable error instead.
 */
export async function fetchCompanionDvrManifest(
  videoId: string,
  force = false,
): Promise<string | null> {
  const hit = manifestCache.get(videoId);
  if (!force && hit && Date.now() - hit.at < COMPANION_MANIFEST_TTL_MS) {
    return hit.mpd;
  }
  const mpd = await fetchFreshCompanionManifest(videoId);
  if (mpd) {
    manifestCache.set(videoId, { at: Date.now(), mpd });
    return mpd;
  }
  return force ? null : (hit?.mpd ?? null);
}

/** Drop the cached manifest so the next resolve re-fetches fresh URLs. */
export function invalidateDvrManifest(videoId: string): void {
  manifestCache.delete(videoId);
}

/** Representation ids are YouTube itags — keep the accepted shape tight. */
const REP_ID_RE = /^[\w.-]{1,16}$/;

function decodeXmlEntities(s: string): string {
  return (
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Ampersand last, so "&amp;lt;" doesn't become "<".
      .replace(/&amp;/g, "&")
  );
}

function segmentPath(videoId: string, repId: string, sq: string): string {
  return `/dvr/${encodeURIComponent(videoId)}/${encodeURIComponent(repId)}/${sq}`;
}

/**
 * Repoint every `SegmentTemplate` at our own `/dvr/...` path, and give it an
 * explicit `initialization`.
 *
 * The initialization matters independently of expiry: YouTube's live/DVR
 * segments are each self-initializing (every one is `ftyp` + `moov` before its
 * `emsg`/`moof`/`mdat`), so the companion omits the attribute — but the DASH
 * spec reads an absent Initialization as "the init segment is at the BaseURL",
 * and with no `<BaseURL>` element that resolves to the manifest's own directory.
 * dash.js then requests `/dash/<id>/`, which Next 308-redirects, and a redirect
 * carries none of `withMediaCors`'s headers — so on the media origin Safari
 * blocks it as a disallowed cross-origin redirect and the video spins forever.
 * Segment 0 *is* a valid init segment, so name it explicitly.
 *
 * Paths are root-relative on purpose: dash.js resolves them against the
 * manifest's own URL, which is already on the media origin, so this needs no
 * knowledge of the public origin.
 */
export function rewriteDvrManifestSegmentUrls(
  mpd: string,
  videoId: string,
): string {
  return mpd.replace(
    /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g,
    (whole, attrs: string, inner: string) => {
      const repId = /\bid="([^"]+)"/.exec(attrs)?.[1];
      if (!repId || !REP_ID_RE.test(repId)) return whole;
      const rewritten = inner.replace(
        /<SegmentTemplate\b([^>]*)>/g,
        (tag: string, tagAttrs: string) => {
          if (!/\bmedia="/.test(tagAttrs)) return tag;
          const trimmed = tagAttrs.trimEnd();
          const selfClosing = trimmed.endsWith("/");
          const body = (selfClosing ? trimmed.slice(0, -1) : tagAttrs)
            // Replacement values contain `$Number$`; a function callback keeps
            // `$` from being read as a capture-group reference.
            .replace(
              /\bmedia="[^"]*"/,
              () => `media="${segmentPath(videoId, repId, "$Number$")}"`,
            )
            .replace(/\s*\binitialization="[^"]*"/, "");
          const init = segmentPath(videoId, repId, "0");
          return `<SegmentTemplate${body} initialization="${init}"${
            selfClosing ? "/" : ""
          }>`;
        },
      );
      return `<Representation${attrs}>${rewritten}</Representation>`;
    },
  );
}

/**
 * Why a segment couldn't be resolved. The distinction is what the caller turns
 * into a status code, and it matters: `no-manifest` is transient (the companion
 * was briefly unavailable) and must be reported as retryable, whereas answering
 * 404 would tell dash.js the segment does not exist and end playback.
 * `no-representation` really is a 404.
 */
export type DvrSegmentResolution =
  | { ok: true; url: string }
  | { ok: false; reason: "no-manifest" | "no-representation" };

/**
 * Current upstream URL for one segment, from the companion manifest's template
 * for that Representation. `force` skips the cache to pick up fresh tokens.
 */
export async function resolveDvrSegmentUrl(
  videoId: string,
  repId: string,
  sq: string,
  force = false,
): Promise<DvrSegmentResolution> {
  if (!REP_ID_RE.test(repId)) {
    return { ok: false, reason: "no-representation" };
  }
  const mpd = await fetchCompanionDvrManifest(videoId, force);
  if (!mpd) return { ok: false, reason: "no-manifest" };
  for (const m of mpd.matchAll(
    /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g,
  )) {
    if (/\bid="([^"]+)"/.exec(m[1])?.[1] !== repId) continue;
    const media = /<SegmentTemplate\b[^>]*\bmedia="([^"]*)"/.exec(m[2])?.[1];
    if (!media) return { ok: false, reason: "no-representation" };
    // The companion builds these from its own SERVER_BASE_URL, so they arrive
    // pointing at the public origin even though we fetched the manifest
    // internally. Only this server fetches them, so send it internally too.
    return {
      ok: true,
      url: toInternalCompanionUrl(
        decodeXmlEntities(media).replaceAll("$Number$", sq),
      ),
    };
  }
  return { ok: false, reason: "no-representation" };
}
