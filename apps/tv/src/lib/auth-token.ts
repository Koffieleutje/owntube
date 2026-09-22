import * as SecureStore from "expo-secure-store";

// Device JWT from pairing or `auth.deviceLogin`, sent as `Authorization:
// Bearer <token>`. Stored in the OS keystore (expo-secure-store).
//
// Profiles ("Who's watching"): a TV can hold several paired accounts. The
// active one's token lives under TOKEN_KEY — where the single token always
// lived, so installs from before profiles simply have one profile. Every
// profile's token also sits under its own key (SecureStore values are capped
// at ~2KB, too small for several JWEs in one), indexed by PROFILES_KEY.
const TOKEN_KEY = "owntube.device-token";
const PROFILES_KEY = "owntube.profiles";
const profileTokenKey = (id: string) => `owntube.profile.${id}`;

export type Profile = { id: string; label: string };

export function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

async function readIndex(): Promise<Profile[]> {
  try {
    const raw = await SecureStore.getItemAsync(PROFILES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (p): p is Profile =>
            typeof p?.id === "string" && typeof p?.label === "string",
        )
      : [];
  } catch {
    return [];
  }
}

async function writeIndex(profiles: Profile[]): Promise<void> {
  await SecureStore.setItemAsync(PROFILES_KEY, JSON.stringify(profiles));
}

function newId(): string {
  return Array.from({ length: 12 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");
}

/** Which profile the active token belongs to. */
async function activeProfileId(): Promise<string | null> {
  const token = await getToken();
  if (!token) return null;
  for (const profile of await readIndex()) {
    if (
      (await SecureStore.getItemAsync(profileTokenKey(profile.id))) === token
    ) {
      return profile.id;
    }
  }
  return null;
}

/**
 * Every signed-in profile. A token from before profiles existed becomes the
 * first one here.
 */
export async function listProfiles(): Promise<Profile[]> {
  const token = await getToken();
  let profiles = await readIndex();
  if (token && !(await activeProfileId())) {
    const id = newId();
    await SecureStore.setItemAsync(profileTokenKey(id), token);
    profiles = [...profiles, { id, label: "Profile" }];
    await writeIndex(profiles);
  }
  return profiles;
}

export async function getActiveProfile(): Promise<Profile | null> {
  const id = await activeProfileId();
  return (await readIndex()).find((p) => p.id === id) ?? null;
}

/** Signing in (pairing, password): adds a profile and makes it active. */
export async function setToken(token: string): Promise<void> {
  await listProfiles(); // adopt a legacy token before replacing it
  const id = newId();
  await SecureStore.setItemAsync(profileTokenKey(id), token);
  await writeIndex([...(await readIndex()), { id, label: "Profile" }]);
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function switchProfile(id: string): Promise<boolean> {
  const token = await SecureStore.getItemAsync(profileTokenKey(id));
  if (!token) return false;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  return true;
}

/** Names the active profile (its account's email), once it is known. */
export async function labelActiveProfile(label: string): Promise<void> {
  const id = await activeProfileId();
  if (!id) return;
  const profiles = await readIndex();
  if (profiles.find((p) => p.id === id)?.label === label) return;
  await writeIndex(profiles.map((p) => (p.id === id ? { ...p, label } : p)));
}

/** Leaves the active profile (and only it); others stay signed in. */
export async function clearToken(): Promise<void> {
  const id = await activeProfileId();
  if (id) {
    await SecureStore.deleteItemAsync(profileTokenKey(id)).catch(() => {});
    await writeIndex((await readIndex()).filter((p) => p.id !== id));
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/** Every profile out — a server change, where none of them apply. */
export async function clearAllProfiles(): Promise<void> {
  for (const profile of await readIndex()) {
    await SecureStore.deleteItemAsync(profileTokenKey(profile.id)).catch(
      () => {},
    );
  }
  await SecureStore.deleteItemAsync(PROFILES_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(TOKEN_KEY);
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
