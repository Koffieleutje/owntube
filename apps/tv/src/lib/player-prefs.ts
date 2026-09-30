import * as SecureStore from "expo-secure-store";

/**
 * Device-local player choices that carry from one video to the next: whether
 * captions are on (like the web's `owntube:captionsEnabled`) and the playback
 * speed. Which language captions start in is the account's `captionLanguage`
 * setting, as on the web; a pick in the player only lasts for that video.
 */
const KEY = "owntube.player-prefs";

/** Same steps as the web player (components/player/player-constants.ts). */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type PlayerPrefs = {
  captionsEnabled: boolean;
  playbackRate: number;
};

const DEFAULTS: PlayerPrefs = { captionsEnabled: false, playbackRate: 1 };

// Read once per session and kept in memory, so the player can apply it
// synchronously as each video loads.
let cached: PlayerPrefs = DEFAULTS;
let loaded: Promise<PlayerPrefs> | null = null;

export function loadPlayerPrefs(): Promise<PlayerPrefs> {
  loaded ??= SecureStore.getItemAsync(KEY)
    .then((raw) => {
      const parsed = raw
        ? (JSON.parse(raw) as Partial<PlayerPrefs> & {
            /** Before captionsEnabled: a language meant on. */
            captionLanguage?: string | null;
          })
        : {};
      cached = {
        captionsEnabled:
          typeof parsed.captionsEnabled === "boolean"
            ? parsed.captionsEnabled
            : typeof parsed.captionLanguage === "string",
        playbackRate: (PLAYBACK_RATES as readonly number[]).includes(
          parsed.playbackRate ?? 1,
        )
          ? (parsed.playbackRate ?? 1)
          : 1,
      };
      return cached;
    })
    .catch(() => cached);
  return loaded;
}

export function playerPrefs(): PlayerPrefs {
  return cached;
}

export function savePlayerPrefs(patch: Partial<PlayerPrefs>): void {
  cached = { ...cached, ...patch };
  SecureStore.setItemAsync(KEY, JSON.stringify(cached)).catch(() => {});
}

export function formatRate(rate: number): string {
  return rate === 1 ? "Normal" : `${rate}×`;
}
