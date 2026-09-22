import * as SecureStore from "expo-secure-store";

/** The last few searches, newest first — per device, like the web's history. */
const KEY = "owntube.recent-searches";
const MAX = 10;

export async function loadRecentSearches(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((q): q is string => typeof q === "string").slice(0, MAX)
      : [];
  } catch {
    return [];
  }
}

/** Moves `query` to the front and returns the new list. */
export function rememberSearch(recent: string[], query: string): string[] {
  const next = [
    query,
    ...recent.filter((q) => q.toLowerCase() !== query.toLowerCase()),
  ].slice(0, MAX);
  SecureStore.setItemAsync(KEY, JSON.stringify(next)).catch(() => {});
  return next;
}
