import { clearToken } from "@/lib/auth-token";

/**
 * One place that decides the stored device token is no longer usable.
 *
 * The token is a 30-day JWT with no refresh (see `server/device-token.ts`), and
 * the app used to treat "a token exists in the keystore" as signed in forever.
 * When it expired every protected call started failing with "Authentication
 * required" while the app stayed on a shell that had no way back to login — and
 * the one Sign out button lived on a screen that refuses to render when its own
 * query fails. The only escape was wiping app data.
 */
type Listener = () => void;

let listener: Listener | null = null;
/** Latched so a batch of failing queries hands back to login exactly once. */
let expired = false;

/** Register the handler and re-arm the latch (call on sign-in). */
export function armSessionExpiry(onExpired: Listener): void {
  listener = onExpired;
  expired = false;
}

export function disarmSessionExpiry(): void {
  listener = null;
}

/** Drop the dead token and hand control back to the login screen. */
export async function signalSessionExpired(): Promise<void> {
  if (expired) return;
  expired = true;
  await clearToken();
  listener?.();
}
