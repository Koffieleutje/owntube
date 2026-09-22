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

/**
 * A video's thumbnail, falling back to YouTube's own still by id when the row
 * carries none (history rows, for one, leave it to the client — as on the web).
 */
export function videoThumbnailUrl(video: {
  videoId: string;
  thumbnailUrl?: string;
}): string {
  return (
    video.thumbnailUrl ??
    `https://i.ytimg.com/vi/${encodeURIComponent(video.videoId)}/hqdefault.jpg`
  );
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
  const id = encodeURIComponent(video.videoId);
  const urls = [
    `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/hq720.jpg`,
    videoThumbnailUrl(video),
  ];
  return urls.filter((url, index) => urls.indexOf(url) === index);
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
