const STORAGE_KEY = "owntube:playerMediaPrefs";

export type PlayerMediaPrefs = {
  volume: number;
  muted: boolean;
};

/** Default UI volume (before gain curve); lower than 1 avoids “too loud” on first play. */
const defaults: PlayerMediaPrefs = { volume: 0.48, muted: false };

export function readPlayerMediaPrefs(): PlayerMediaPrefs {
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const volume =
      typeof o.volume === "number" && Number.isFinite(o.volume)
        ? Math.min(1, Math.max(0, o.volume))
        : defaults.volume;
    const muted = typeof o.muted === "boolean" ? o.muted : defaults.muted;
    return { volume, muted };
  } catch {
    return defaults;
  }
}

export function writePlayerMediaPrefs(prefs: PlayerMediaPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        volume: Math.min(1, Math.max(0, prefs.volume)),
        muted: prefs.muted,
      }),
    );
  } catch {
    /* quota / private mode */
  }
}

/** Split (native) path only tracks volume in parent state; merge with stored muted. */
export function writePlayerVolumeOnly(volume: number): void {
  const cur = readPlayerMediaPrefs();
  writePlayerMediaPrefs({ ...cur, volume });
}

// Whether captions are on, stored explicitly so "off" is a remembered choice
// rather than merely the absence of a language. Which language they start in is
// the account's `captionLanguage` setting, resolved server-side. Default: off.
const CAPTIONS_ENABLED_KEY = "owntube:captionsEnabled";

export function readCaptionsEnabledPref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CAPTIONS_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeCaptionsEnabledPref(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(CAPTIONS_ENABLED_KEY, "1");
    else window.localStorage.setItem(CAPTIONS_ENABLED_KEY, "0");
  } catch {
    /* quota / private mode */
  }
}
