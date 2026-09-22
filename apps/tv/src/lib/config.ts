import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

/**
 * The OwnTube server the TV talks to.
 *
 * Chosen on first run (ServerScreen) and stored in SecureStore; until then,
 * or on installs that predate the setting, the URL baked in at build time
 * (`EXPO_PUBLIC_OWNTUBE_URL`, else app.json `extra`) applies. On the Android
 * emulator the host machine is reachable at `10.0.2.2`.
 *
 * Read through `baseUrl()` at call time, never captured: changing the server
 * takes effect without a restart.
 */
const fromEnv = process.env.EXPO_PUBLIC_OWNTUBE_URL;
const fromExtra = (
  Constants.expoConfig?.extra as { owntubeUrl?: string } | undefined
)?.owntubeUrl;

/** The build's own server, offered as the default on the server screen. */
export const BUILT_IN_URL = (
  fromEnv ??
  fromExtra ??
  "http://10.0.2.2:3000"
).replace(/\/$/, "");

const KEY = "owntube.server-url";
let current = BUILT_IN_URL;

export function baseUrl(): string {
  return current;
}

export function trpcUrl(): string {
  return `${current}/api/trpc`;
}

/** The stored server, if one was ever chosen; applies it. */
export async function loadServerUrl(): Promise<string | null> {
  try {
    const stored = await SecureStore.getItemAsync(KEY);
    if (stored) current = stored;
    return stored;
  } catch {
    return null;
  }
}

export async function saveServerUrl(url: string): Promise<void> {
  current = url;
  await SecureStore.setItemAsync(KEY, url);
}

export async function forgetServerUrl(): Promise<void> {
  current = BUILT_IN_URL;
  await SecureStore.deleteItemAsync(KEY).catch(() => {});
}

/**
 * What the user typed, as an origin: adds https:// when no scheme is given
 * and drops any path, so "owntube.example.org/" and
 * "https://owntube.example.org/watch?v=x" both land on the site root.
 */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Whether an OwnTube server answers at `url`: its public `auth.session`
 * procedure returns tRPC JSON. Anything else — a proxy's empty 200, an HTML
 * error page — means it isn't one (or isn't reachable).
 */
export async function checkServer(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/trpc/auth.session`);
    if (!response.ok) return false;
    const body = (await response.json()) as { result?: unknown };
    return body.result !== undefined;
  } catch {
    return false;
  }
}
