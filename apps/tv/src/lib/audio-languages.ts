/**
 * Audio-language detection for multi-audio (auto-dubbed) videos.
 *
 * The upstream marks language tracks only inside the stream URL's `xtags`
 * parameter (`acont=original:lang=nl-NL`, `acont=dubbed-auto:lang=en-US`), so
 * languages are recovered from `detail.audioSources[].url`. Regex-based on
 * purpose: Hermes ships no full WHATWG URL implementation.
 */

export type AudioLanguageOption = {
  /** BCP-47-ish tag as the server's /dash `lang` filter expects it. */
  lang: string;
  label: string;
  isOriginal: boolean;
};

function xtagsOf(url: string): { lang: string | null; acont: string | null } {
  const m = url.match(/[?&]xtags=([^&#]+)/i);
  if (!m?.[1]) return { lang: null, acont: null };
  let decoded = m[1];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep raw; the patterns below tolerate either form
  }
  const lang = decoded.match(
    /(?:^|:)lang=([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)/,
  )?.[1];
  const acont = decoded.match(/(?:^|:)acont=([A-Za-z-]+)/)?.[1];
  return { lang: lang ?? null, acont: acont ?? null };
}

/** Hermes has no Intl.DisplayNames; cover the common dub languages, then guard-try. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  nl: "Dutch",
  de: "German",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  it: "Italian",
  pl: "Polish",
  tr: "Turkish",
  ru: "Russian",
  uk: "Ukrainian",
  ar: "Arabic",
  hi: "Hindi",
  id: "Indonesian",
  ja: "Japanese",
  ko: "Korean",
  th: "Thai",
  vi: "Vietnamese",
  zh: "Chinese",
};

function languageName(lang: string): string {
  const primary = lang.split("-")[0]?.toLowerCase() ?? lang;
  const mapped = LANGUAGE_NAMES[primary];
  if (mapped) return mapped;
  try {
    const DisplayNames = (
      Intl as unknown as {
        DisplayNames?: new (
          locales: string[],
          options: { type: string },
        ) => { of(code: string): string | undefined };
      }
    ).DisplayNames;
    if (DisplayNames) {
      const name = new DisplayNames(["en"], { type: "language" }).of(primary);
      if (name && name !== primary) return name;
    }
  } catch {
    // fall through to the raw tag
  }
  return lang.toUpperCase();
}

/**
 * Distinct audio languages of a video, ORIGINAL FIRST (matching the server
 * manifest's default track). Empty unless there are at least two, so callers
 * can use the length directly to decide whether to offer a chooser.
 */
export function audioLanguageOptions(
  audioSources: ReadonlyArray<{ url?: string | null }>,
): AudioLanguageOption[] {
  const byLang = new Map<string, { lang: string; isOriginal: boolean }>();
  for (const source of audioSources) {
    if (!source.url) continue;
    const { lang, acont } = xtagsOf(source.url);
    if (!lang) continue;
    const key = lang.toLowerCase();
    const isOriginal = acont === "original";
    const prev = byLang.get(key);
    if (!prev) byLang.set(key, { lang, isOriginal });
    else if (isOriginal) prev.isOriginal = true;
  }
  const list = Array.from(byLang.values());
  if (list.length < 2) return [];
  list.sort((a, b) => (a.isOriginal ? 0 : 1) - (b.isOriginal ? 0 : 1));
  return list.map(({ lang, isOriginal }) => ({
    lang,
    isOriginal,
    label: isOriginal ? `${languageName(lang)} (Original)` : languageName(lang),
  }));
}

/** Bonus for {@link audioLanguageOptions}-aware pickers: is this URL the original track? */
export function urlLooksLikeOriginalAudio(url: string): boolean {
  return xtagsOf(url).acont === "original";
}
