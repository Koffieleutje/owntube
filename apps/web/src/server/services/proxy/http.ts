import { upstreamGetText } from "@/server/services/upstream-get";
import {
  recordUpstreamFailure as recordInstanceFailure,
  recordUpstreamSuccess,
} from "@/server/services/upstream-health";

export const FETCH_TIMEOUT_MS = 20_000;

/**
 * Language for Invidious' human-readable strings (`publishedText`, view-count
 * text). Without it this deployment was answering in **Arabic** — "1 السنة منذ"
 * rather than "1 year ago" — on every list endpoint, and those strings are shown
 * to the user (comments, the upcoming-live panel, taste onboarding).
 *
 * Invidious picks a locale per request and no `default_locale` is configured, so
 * asking explicitly is the fix that does not depend on instance configuration —
 * which matters because `INVIDIOUS_BASE_URL` may list several instances.
 */
const UPSTREAM_LOCALE = process.env.INVIDIOUS_LOCALE ?? "en-US";

/**
 * Add `hl` to Invidious API requests. Scoped to `/api/v1/` paths so nothing else
 * routed through this helper is touched, and it never overrides an `hl` a caller
 * set deliberately.
 */
function withUpstreamLocale(url: string): string {
  if (!UPSTREAM_LOCALE) return url;
  try {
    const u = new URL(url);
    if (!u.pathname.startsWith("/api/v1/")) return url;
    if (u.searchParams.has("hl")) return url;
    u.searchParams.set("hl", UPSTREAM_LOCALE);
    return u.toString();
  } catch {
    // Not an absolute URL; leave it alone rather than guess.
    return url;
  }
}

type FetchJsonOptions = {
  /**
   * Some upstreams (notably Invidious `/api/v1/videos/{id}/related`) return 2xx with a
   * completely empty body instead of `[]` when there are no related items.
   */
  emptyBodyAs?: unknown;
  source?: "invidious";
  baseUrl?: string;
};

export async function fetchJson(
  url: string,
  options?: FetchJsonOptions,
): Promise<unknown> {
  const startedAt = Date.now();
  try {
    const { status, ok, text } = await upstreamGetText(
      withUpstreamLocale(url),
      FETCH_TIMEOUT_MS,
    );
    const trimmed = text.trim();
    if (!ok) {
      const hint = trimmed.slice(0, 240);
      throw new Error(
        hint ? `HTTP ${status}: ${hint}` : `HTTP ${status} (empty body)`,
      );
    }
    if (!trimmed) {
      if (options?.emptyBodyAs !== undefined) {
        if (options.source && options.baseUrl) {
          recordUpstreamSuccess(
            options.source,
            options.baseUrl,
            Date.now() - startedAt,
          );
        }
        return options.emptyBodyAs;
      }
      throw new Error(
        `HTTP ${status} with empty body (expected JSON from upstream)`,
      );
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (options?.source && options.baseUrl) {
        recordUpstreamSuccess(
          options.source,
          options.baseUrl,
          Date.now() - startedAt,
        );
      }
      return parsed;
    } catch (e) {
      const isHtml = trimmed.startsWith("<");
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        isHtml
          ? `Invalid JSON (upstream returned HTML — base URL may be the web UI, not the API; use the Piped backend URL or set PIPED_BASE_URL=disabled): ${msg}; start: ${trimmed.slice(0, 120)}`
          : `Invalid JSON: ${msg}; start: ${trimmed.slice(0, 120)}`,
      );
    }
  } catch (error) {
    if (options?.source && options.baseUrl) {
      recordInstanceFailure(
        options.source,
        options.baseUrl,
        error,
        Date.now() - startedAt,
      );
    }
    throw error;
  }
}
