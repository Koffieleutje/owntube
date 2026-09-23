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
/** Between the hold being recognised and the key coming back up. */
let holding = false;
/** Whether this hold actually ran a target — a hold with none clicks as usual. */
let fired = false;
let suppressUntil = 0;

/** The click ending a hold lands within this of the key coming back up. */
const SUPPRESS_MS = 400;

/** Called on focus with the element's long-press action; on blur with null. */
export function setLongPressTarget(
  action: (() => void) | null,
  owner?: () => void,
) {
  if (action) target = action;
  else if (!owner || target === owner) target = null;
}

/**
 * Whether the click that ends a hold may still arrive. Unlike
 * `takeSuppressedPress` this doesn't consume anything, for a view that appeared
 * *because* of the hold (a menu the long press opened) and so can never
 * legitimately be acting on the press that ends it.
 */
export function isSuppressedPress(): boolean {
  return holding || Date.now() <= suppressUntil;
}

/** True (once) when this press is the release of a long press — ignore it. */
export function takeSuppressedPress(): boolean {
  // Still held down, so a click now can only be this hold's release.
  if (holding) return true;
  if (Date.now() > suppressUntil) return false;
  suppressUntil = 0;
  return true;
}

/** Mount once, above everything that registers targets. */
export function useLongSelectDispatcher() {
  useTVEventHandler((event) => {
    // A plain select is a short press, which proves no hold is in progress —
    // it clears a `holding` left behind by a hold whose release never arrived.
    if (event.eventType === "select") {
      holding = false;
      return;
    }
    if (event.eventType !== "longSelect") return;
    // Fires once on the hold (key down) and again on release.
    if (Number(event.eventKeyAction) === 1) {
      holding = false;
      // The window has to start here, at the release. Started at the hold, it
      // covered a fixed span of the press itself, so holding past it let the
      // release click through and the card opened while its menu was up.
      if (fired) suppressUntil = Date.now() + SUPPRESS_MS;
      fired = false;
      return;
    }
    if (!target) return;
    holding = true;
    fired = true;
    target();
  });
}
