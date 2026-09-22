import * as SecureStore from "expo-secure-store";
import type { Section } from "@/components/Sidebar";

/**
 * Which sidebar sections show, and in what order. Device-local rather than a
 * server setting: the web app has no sidebar to share prefs with, and the
 * useful arrangement differs per TV. Stored alongside the auth token in
 * expo-secure-store — the payload is far under the platform's ~2KB limit.
 */
const KEY = "owntube.sidebar-prefs";

/** Every section the shell can render, in shipped order. */
export const ALL_SECTIONS: Section[] = [
  "home",
  "search",
  "queue",
  "subscriptions",
  "recommended",
  "trending",
  "shorts",
  "saved",
  "playlists",
  "history",
  "settings",
];

export type SidebarPrefs = {
  /** Ordered; sections absent from this list are hidden. */
  order: Section[];
};

export const DEFAULT_PREFS: SidebarPrefs = { order: ALL_SECTIONS };

/**
 * Every section the stored prefs have been offered. A section added since
 * (Saved and Trending, for one) is shown once, before Settings, rather than
 * being taken for one the user hid; after that, hiding it sticks.
 */
function withNewSections(order: Section[], known: unknown): Section[] {
  const knownSet = new Set(
    Array.isArray(known) ? known.filter((k) => typeof k === "string") : [],
  );
  // Prefs saved before `known` existed had seen exactly these.
  if (!Array.isArray(known)) {
    for (const s of LEGACY_SECTIONS) knownSet.add(s);
  }
  const added = ALL_SECTIONS.filter(
    (s) => !knownSet.has(s) && !order.includes(s),
  );
  if (added.length === 0) return order;
  const settings = order.indexOf("settings");
  const at = settings >= 0 ? settings : order.length;
  return [...order.slice(0, at), ...added, ...order.slice(at)];
}

/** The sections that existed before `known` was stored. */
const LEGACY_SECTIONS: Section[] = [
  "home",
  "search",
  "queue",
  "subscriptions",
  "recommended",
  "playlists",
  "history",
  "settings",
];

/** Drops unknown sections so a removed feature can't strand the sidebar. */
function sanitize(order: unknown): SidebarPrefs {
  if (!Array.isArray(order)) return DEFAULT_PREFS;
  const seen = new Set<string>();
  const cleaned: Section[] = [];
  for (const value of order) {
    if (typeof value !== "string") continue;
    if (!(ALL_SECTIONS as string[]).includes(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    cleaned.push(value as Section);
  }
  // Settings must stay reachable, or the prefs can't be repaired on-device.
  if (!cleaned.includes("settings")) cleaned.push("settings");
  return { order: cleaned };
}

export async function loadSidebarPrefs(): Promise<SidebarPrefs> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return DEFAULT_PREFS;
    const stored = JSON.parse(raw);
    const prefs = sanitize(stored?.order);
    return { order: withNewSections(prefs.order, stored?.known) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function saveSidebarPrefs(prefs: SidebarPrefs): Promise<void> {
  try {
    await SecureStore.setItemAsync(
      KEY,
      JSON.stringify({ ...sanitize(prefs.order), known: ALL_SECTIONS }),
    );
  } catch {
    // Prefs are a convenience; a storage failure shouldn't surface as an error.
  }
}
