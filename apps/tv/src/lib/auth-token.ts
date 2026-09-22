import * as SecureStore from "expo-secure-store";

// Device JWT from `auth.deviceLogin`, sent as `Authorization: Bearer <token>`.
// Stored in the OS keystore (expo-secure-store). JWEs stay well under the
// platform's ~2KB value limit, so no chunking is needed.
const TOKEN_KEY = "owntube.device-token";

export function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export function setToken(token: string): Promise<void> {
  return SecureStore.setItemAsync(TOKEN_KEY, token);
}

export function clearToken(): Promise<void> {
  return SecureStore.deleteItemAsync(TOKEN_KEY);
}

type Listener = () => void;
const sessionExpiredListeners = new Set<Listener>();

/**
 * The server stopped accepting the stored token (it expired, or was signed with
 * a rotated secret). Nothing else tells the app — it only knows a token is
 * stored — so without this the shell stays up with every request failing and
 * no way back to sign-in.
 */
export function onSessionExpired(listener: Listener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

export async function expireSession(): Promise<void> {
  // Only a token we actually sent can have expired; with none stored this is
  // an ordinary signed-out request (e.g. a wrong password on the login screen).
  if (!(await getToken())) return;
  await clearToken();
  for (const listener of sessionExpiredListeners) listener();
}
