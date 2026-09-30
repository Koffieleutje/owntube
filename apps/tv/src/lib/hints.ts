import * as SecureStore from "expo-secure-store";

/**
 * One-time coaching, kept on the device: nothing on a card says that holding
 * OK opens its menu, so the first few sessions say so once each, until the
 * menu has been opened for real.
 */
const KEY = "owntube.hints";

/** Sessions the long-press hint is shown in before it gives up. */
const LONG_PRESS_HINT_SESSIONS = 3;

type Hints = {
  longPressShown: number;
  longPressUsed: boolean;
};

const DEFAULTS: Hints = { longPressShown: 0, longPressUsed: false };

let cached: Hints = DEFAULTS;
let loaded: Promise<Hints> | null = null;
/** Once per app start, whatever the stored count says. */
let shownThisSession = false;

export function loadHints(): Promise<Hints> {
  loaded ??= SecureStore.getItemAsync(KEY)
    .then((raw) => {
      const parsed = raw ? (JSON.parse(raw) as Partial<Hints>) : {};
      cached = {
        longPressShown:
          typeof parsed.longPressShown === "number" ? parsed.longPressShown : 0,
        longPressUsed: parsed.longPressUsed === true,
      };
      return cached;
    })
    .catch(() => cached);
  return loaded;
}

function save(patch: Partial<Hints>): void {
  cached = { ...cached, ...patch };
  SecureStore.setItemAsync(KEY, JSON.stringify(cached)).catch(() => {});
}

/** Whether to show the long-press hint now; counts the showing. */
export function takeLongPressHint(): boolean {
  if (shownThisSession || cached.longPressUsed) return false;
  if (cached.longPressShown >= LONG_PRESS_HINT_SESSIONS) return false;
  shownThisSession = true;
  save({ longPressShown: cached.longPressShown + 1 });
  return true;
}

/** The menu was opened by a long press: no more hints. */
export function markLongPressUsed(): void {
  if (!cached.longPressUsed) save({ longPressUsed: true });
}
