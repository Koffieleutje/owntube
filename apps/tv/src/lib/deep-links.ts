/**
 * What a URL handed to the app points at. Covers the app's own scheme and the
 * YouTube URLs the "Open with" chooser sends (the same shapes the web
 * middleware maps onto OwnTube's routes):
 *
 *   owntube://watch?v=<id>&t=<s>   owntube://channel/<id>   owntube://search?q=…
 *   youtube.com/watch?v=<id>&t=1m30s   youtu.be/<id>?t=90
 *   youtube.com/shorts|live|embed|v/<id>   youtube.com/playlist?list=<id>
 *   youtube.com/channel/<UC…>   youtube.com/@handle   youtube.com/c|user/<name>
 */
export type DeepLink =
  | { kind: "watch"; videoId: string; startSeconds?: number }
  | { kind: "channel"; channelId: string }
  | { kind: "playlist"; playlistId: string }
  | { kind: "search"; query: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;
const VIDEO_PREFIXES = new Set(["shorts", "live", "embed", "v"]);
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

/** "90", "90s", "1m30s", "1h2m3s" → seconds. */
export function parseStartTime(raw: string | null): number | undefined {
  if (!raw) return undefined;
  if (/^\d+s?$/.test(raw)) return Number.parseInt(raw, 10);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!match || !match[0]) return undefined;
  const [, h = "0", m = "0", s = "0"] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function watch(videoId: string | null, t: string | null): DeepLink | null {
  if (!videoId || !VIDEO_ID.test(videoId)) return null;
  return { kind: "watch", videoId, startSeconds: parseStartTime(t) };
}

export function parseDeepLink(raw: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const params = url.searchParams;
  const t = params.get("t") ?? params.get("start");

  if (url.protocol === "owntube:") {
    // owntube://watch?v=… parses with "watch" as the host.
    const [first, ...rest] = [url.host, ...url.pathname.split("/")].filter(
      Boolean,
    );
    if (first === "watch") return watch(params.get("v"), t);
    if (first === "channel" && rest[0]) {
      return { kind: "channel", channelId: decodeURIComponent(rest[0]) };
    }
    if (first === "search") {
      return { kind: "search", query: params.get("q") ?? "" };
    }
    return null;
  }

  const host = url.host.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  const [first, second] = segments;

  if (host === "youtu.be") return watch(first ?? null, t);
  if (!YOUTUBE_HOSTS.has(host)) return null;

  if (first === "watch") return watch(params.get("v"), t);
  if (first && second && VIDEO_PREFIXES.has(first)) return watch(second, t);
  if (first === "playlist" && params.get("list")) {
    return { kind: "playlist", playlistId: params.get("list") as string };
  }
  if (first === "channel" && second) {
    return { kind: "channel", channelId: second };
  }
  if (first?.startsWith("@") && first.length > 1) {
    return { kind: "channel", channelId: first };
  }
  if ((first === "c" || first === "user") && second) {
    return { kind: "channel", channelId: second };
  }
  if (first === "results" && params.get("search_query")) {
    return { kind: "search", query: params.get("search_query") as string };
  }
  return null;
}
