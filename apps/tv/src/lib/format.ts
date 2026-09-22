import { baseUrl } from "@/lib/config";
/** mm:ss / h:mm:ss for durations and playback time. */
export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

export function formatViews(count: number | undefined): string | null {
  if (count === undefined || !Number.isFinite(count)) return null;
  if (count >= 1_000_000) return `${Math.floor(count / 1_000_000)}M views`;
  if (count >= 1_000) return `${Math.floor(count / 1_000)}K views`;
  return `${Math.floor(count)} views`;
}

export function formatCompactCount(count: number | undefined): string | null {
  if (count === undefined || !Number.isFinite(count) || count < 0) return null;
  if (count >= 1_000_000) {
    const value = count / 1_000_000;
    return value >= 10
      ? `${Math.floor(value)}M`
      : `${value.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (count >= 1_000) {
    const value = count / 1_000;
    return value >= 10
      ? `${Math.floor(value)}K`
      : `${value.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(Math.floor(count));
}

export function formatSubscribersLabel(
  count: number | undefined,
): string | null {
  const compactCount = formatCompactCount(count);
  if (!compactCount) return null;
  return `${compactCount} subscriber${Math.floor(count ?? 0) === 1 ? "" : "s"}`;
}

export function formatThumbnailBadge({
  durationSeconds,
  isLive,
  isUpcoming,
}: {
  durationSeconds?: number;
  isLive?: boolean;
  isUpcoming?: boolean;
}): string | null {
  if (isUpcoming) return "Upcoming";
  if (isLive) return "LIVE";
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds)) {
    return null;
  }
  return formatTime(durationSeconds);
}

function formatRelativeFromNow(secondsSinceEpoch: number): string | null {
  if (!Number.isFinite(secondsSinceEpoch) || secondsSinceEpoch <= 0)
    return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, nowSeconds - Math.floor(secondsSinceEpoch));

  if (delta < 60) return "just now";
  if (delta < 3600) {
    const minutes = Math.floor(delta / 60);
    return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  }
  if (delta < 86_400) {
    const hours = Math.floor(delta / 3600);
    return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  }
  if (delta < 2_592_000) {
    const days = Math.floor(delta / 86_400);
    return `${days} day${days > 1 ? "s" : ""} ago`;
  }
  if (delta < 31_536_000) {
    const months = Math.floor(delta / 2_592_000);
    return `${months} month${months > 1 ? "s" : ""} ago`;
  }
  const years = Math.floor(delta / 31_536_000);
  return `${years} year${years > 1 ? "s" : ""} ago`;
}

export function formatPublishedLabel(
  publishedText: string | undefined,
  publishedAt?: number,
): string | null {
  if (typeof publishedAt === "number" && Number.isFinite(publishedAt)) {
    const timestampLabel = formatRelativeFromNow(publishedAt);
    if (timestampLabel) return timestampLabel;
  }
  const text = publishedText?.trim();
  if (!text) return null;

  const secondsMatch = /^(\d{9,13})s$/i.exec(text);
  if (secondsMatch) {
    let seconds = Number.parseInt(secondsMatch[1] ?? "", 10);
    if (seconds > 1_000_000_000_000) seconds = Math.floor(seconds / 1000);
    const unixLabel = formatRelativeFromNow(seconds);
    if (unixLabel) return unixLabel;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const milliseconds = Date.parse(text);
    if (Number.isFinite(milliseconds)) {
      const isoLabel = formatRelativeFromNow(Math.floor(milliseconds / 1000));
      if (isoLabel) return isoLabel;
    }
  }

  return text.length > 56 ? `${text.slice(0, 55)}...` : text;
}

export function channelInitial(name: string | undefined): string {
  const first = name?.trim().charAt(0);
  return first ? first.toUpperCase() : "o";
}

/** A YouTube video id: 11 characters. Playlist ids are longer and won't match. */
const VIDEO_ID = /^[\w-]{11}$/;
/** The id inside any `/vi/<id>/<file>` thumbnail path, whoever is serving it. */
const VI_PATH = /\/vi\/([\w-]{11})\//;

/**
 * The id to ask the instance for, or undefined when we can't tell. Prefer the
 * one inside the row's own thumbnail URL: a playlist row carries its cover
 * video there while `videoId` holds the *playlist* id, and asking the image
 * proxy for a playlist id is worse than showing nothing (see below).
 */
function thumbnailVideoId(video: {
  videoId: string;
  thumbnailUrl?: string;
}): string | undefined {
  const fromUrl = video.thumbnailUrl?.match(VI_PATH)?.[1];
  if (fromUrl) return fromUrl;
  return VIDEO_ID.test(video.videoId) ? video.videoId : undefined;
}

/**
 * A video's thumbnail, served by the instance's own image proxy.
 *
 * Three reasons not to hand the box an `i.ytimg.com` URL, even though the web
 * app treats that host as safe to load directly (isYoutubeAvatarCdn):
 *
 * 1. `/image` keeps a disk cache with serve-stale-and-revalidate, so a shelf
 *    of cards costs the instance one fetch, not one CDN round trip per card
 *    per box — measured here at 462ms cold against 22ms warm.
 * 2. It resolves a missing rung server-side, so the client needs no 404
 *    fallback chain of its own.
 * 3. A TV in the living room otherwise tells Google what is on screen. The
 *    browser can make that trade knowingly; an appliance can't.
 *
 * `mqdefault` is 320x180 — the same 16:9 framing as the card at ~16x less
 * memory than the 1280x720 `hqdefault` Android would otherwise decode and hold
 * per card, which is what makes a shelf stutter on a low-power box.
 *
 * Undefined when no usable video id is in reach; callers render a placeholder.
 * Never guess: `/image/vi/<unknown-id>/…` does not 404, it hangs (>30s).
 */
export function videoThumbnailUrl(video: {
  videoId: string;
  thumbnailUrl?: string;
}): string | undefined {
  const id = thumbnailVideoId(video);
  return id ? `${baseUrl()}/image/vi/${id}/mqdefault.jpg` : undefined;
}

/**
 * Stills for the full-width hero, sharpest first. The row's own thumbnail is
 * card-sized (blurry at 1080p), so try YouTube's larger stills by id, then
 * fall back to it: `maxresdefault` only exists for HD uploads and `hq720`
 * isn't universal either — both answer 404 when missing.
 */
export function heroThumbnailUrls(video: {
  videoId: string;
  thumbnailUrl?: string;
}): string[] {
  const id = thumbnailVideoId(video);
  if (!id) return [];
  // Still sharpest-first, but the proxy already substitutes the best rung it
  // can get, so this chain is now a belt to its braces rather than the only
  // thing standing between the hero and a 404.
  return [
    `${baseUrl()}/image/vi/${id}/maxresdefault.jpg`,
    `${baseUrl()}/image/vi/${id}/hq720.jpg`,
  ];
}

/**
 * Upstream comment text arrives as HTML (links for timestamps, entities).
 * The TV shows it as plain text: line breaks kept, tags dropped, entities
 * decoded.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
