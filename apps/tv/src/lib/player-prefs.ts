import * as SecureStore from "expo-secure-store";

/**
 * Device-local player choices that carry from one video to the next: the
 * caption language (like the web's `player-captions` storage) and the playback
 * speed. Per device rather than server settings, as on the web — a caption
 * habit on the living-room TV needn't follow you to a laptop.
 */
const KEY = "owntube.player-prefs";

/** Same steps as the web player (components/player/player-constants.ts). */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type PlayerPrefs = {
  /** Language code of the preferred captions, or null for off. */
  captionLanguage: string | null;
  playbackRate: number;
};

const DEFAULTS: PlayerPrefs = { captionLanguage: null, playbackRate: 1 };

// Read once per session and kept in memory, so the player can apply it
// synchronously as each video loads.
let cached: PlayerPrefs = DEFAULTS;
let loaded: Promise<PlayerPrefs> | null = null;

export function loadPlayerPrefs(): Promise<PlayerPrefs> {
  loaded ??= SecureStore.getItemAsync(KEY)
    .then((raw) => {
      const parsed = raw ? (JSON.parse(raw) as Partial<PlayerPrefs>) : {};
      cached = {
        captionLanguage:
          typeof parsed.captionLanguage === "string"
            ? parsed.captionLanguage
            : null,
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
