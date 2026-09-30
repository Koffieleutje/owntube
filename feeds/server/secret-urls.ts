/**
 * Secret feed addresses: a per-user token unlocks that user's feeds without a
 * password (see server.ts's `/rss/<token>/...` routes). Pure path helpers,
 * no I/O — kept separate so hub announcements (a later task) can build the
 * same paths without importing the whole server.
 */

/** A feed token is a 32-char lowercase hex string. */
export const TOKEN_RE = /^[0-9a-f]{32}$/;

export type Variant = "audio" | "video";

export type SecretFeedTarget = {
  token: string;
  kind: string;
  slug: string;
  variant: Variant;
};

export type SecretPageTarget = {
  token: string;
  page: "index" | "opml";
};

/** `/rss/<token>/<kind>/<slug>.<variant>.xml`, kind and slug percent-encoded. */
export function secretFeedPath(
  token: string,
  kind: string,
  slug: string,
  variant: Variant,
): string {
  return `/rss/${token}/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}.${variant}.xml`;
}

/**
 * Parse a request path as a secret address: a feed, the per-user index, or
 * its OPML. Returns null for anything else, including a malformed token (so
 * the protected `/rss/<kind>/<slug>...` routes are never mistaken for these).
 */
export function parseSecretPath(
  pathname: string,
): SecretFeedTarget | SecretPageTarget | null {
  const feed = pathname.match(
    /^\/rss\/([0-9a-f]{32})\/([^/]+)\/(.+)\.(audio|video)\.xml$/,
  );
  if (feed) {
    const [, token, kind, slug, variant] = feed;
    try {
      return {
        token,
        kind: decodeURIComponent(kind),
        slug: decodeURIComponent(slug),
        variant: variant as Variant,
      };
    } catch {
      return null;
    }
  }
  const index = pathname.match(/^\/rss\/([0-9a-f]{32})\/$/);
  if (index) return { token: index[1], page: "index" };
  const opml = pathname.match(/^\/rss\/([0-9a-f]{32})\/opml\.xml$/);
  if (opml) return { token: opml[1], page: "opml" };
  return null;
}

/** Safe-to-log form of a token: never the full value. */
export function redactToken(token: string): string {
  return `${token.slice(0, 6)}…`;
}

/**
 * Safe-to-log form of a request path: redacts a leading 32-hex token segment
 * (`/rss/<token>` or `/rss/<token>/...`), leaving everything else — including
 * a path that merely *looks* like `/rss/<something>` without a real token —
 * unchanged. Guards against a full token reaching the logs via a path that
 * isn't a recognized secret address (e.g. a malformed one that falls through
 * to another route's own logging).
 */
export function redactPath(pathname: string): string {
  return pathname.replace(
    /^\/rss\/([0-9a-f]{32})(?=\/|$)/,
    (_, token: string) => `/rss/${redactToken(token)}`,
  );
}
