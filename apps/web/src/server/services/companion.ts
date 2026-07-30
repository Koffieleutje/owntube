/**
 * Where to reach invidious-companion.
 *
 * There are two answers, and picking the wrong one is a real bug either way:
 *
 *  - **public** (`INVIDIOUS_PUBLIC_BASE_URL` + `/companion`) is required for any
 *    URL that ends up in a document the *browser* will fetch. A manifest handed
 *    to dash.js full of `invidious-companion:8282` URLs is useless.
 *  - **internal** (`INVIDIOUS_COMPANION_INTERNAL_URL`, the Docker service
 *    address) is right for anything *this server* fetches. It skips a TLS
 *    handshake and a reverse-proxy hop, and keeps playback working even if the
 *    public hostname or its certificate is unavailable.
 *
 * Server-side fetches used to go out via the public base because DVR manifests
 * embedded companion URLs the browser had to reach. The `/dvr` indirection
 * removed that constraint: the browser now only ever sees `/dvr/...` paths on
 * our own media origin, so the companion URLs inside are ours alone to fetch.
 *
 * Internal is optional — with the env var unset everything falls back to the
 * public base, which is exactly the previous behaviour.
 */

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Public origin carrying the companion under `/companion`; "" when unset. */
export function companionPublicBase(): string {
  return trimTrailingSlashes(process.env.INVIDIOUS_PUBLIC_BASE_URL ?? "");
}

/**
 * Origin this server should fetch the companion from. Falls back to the public
 * base so an unset env var changes nothing.
 */
export function companionInternalBase(): string {
  const internal = trimTrailingSlashes(
    process.env.INVIDIOUS_COMPANION_INTERNAL_URL ?? "",
  );
  return internal || companionPublicBase();
}

/**
 * Rewrite a companion URL that points at the public origin so this server
 * fetches it internally instead. The companion's own manifests embed absolute
 * public URLs (it builds them from its `SERVER_BASE_URL`), so segment URLs
 * arrive public even when we asked for the manifest internally.
 *
 * Only rewrites an exact public-base prefix; anything else is returned
 * unchanged, so a googlevideo URL or an already-internal one passes through.
 */
export function toInternalCompanionUrl(url: string): string {
  const publicBase = companionPublicBase();
  const internalBase = companionInternalBase();
  if (!publicBase || !internalBase || publicBase === internalBase) return url;
  if (!url.startsWith(`${publicBase}/`)) return url;
  return internalBase + url.slice(publicBase.length);
}
