import { useTVEventHandler } from "react-native";

/**
 * Long-press OK on Android TV.
 *
 * react-native-tvos reports a held select key only as a `longSelect` TV event
 * (see ReactAndroidHWInputDeviceHelper); Pressable's onLongPress never fires
 * for it, and the key-up that ends the hold still clicks the focused view. So:
 * whatever holds focus registers what its long press does, one handler (in the
 * Shell) runs that on `longSelect`, and the click that follows is swallowed.
 */
let target: (() => void) | null = null;
let suppressUntil = 0;

/** Suppression window: the release that ends a hold follows within this. */
const SUPPRESS_MS = 1500;

/** Called on focus with the element's long-press action; on blur with null. */
export function setLongPressTarget(
  action: (() => void) | null,
  owner?: () => void,
) {
  if (action) target = action;
  else if (!owner || target === owner) target = null;
}

/** True (once) when this press is the release of a long press — ignore it. */
export function takeSuppressedPress(): boolean {
  if (Date.now() > suppressUntil) return false;
  suppressUntil = 0;
  return true;
}

/** Mount once, above everything that registers targets. */
export function useLongSelectDispatcher() {
  useTVEventHandler((event) => {
    if (event.eventType !== "longSelect") return;
    // Fires once on the hold (key down) and again on release; act on the hold.
    if (Number(event.eventKeyAction) === 1) return;
    if (!target) return;
    suppressUntil = Date.now() + SUPPRESS_MS;
    target();
  });
}
