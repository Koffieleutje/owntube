import { requireOptionalNativeModule } from "expo-modules-core";

type WatchNextItem = {
  videoId: string;
  title: string;
  channelName?: string;
  posterUrl?: string;
  positionMs: number;
  durationMs: number;
};

type WatchNextNative = {
  upsert: (item: WatchNextItem) => Promise<boolean>;
  remove: (videoId: string) => Promise<boolean>;
};

// Absent in builds without the native side (and off Android): a no-op.
const native = requireOptionalNativeModule<WatchNextNative>("WatchNext");

/** Puts (or refreshes) a video in the home screen's Continue watching row. */
export function upsertWatchNext(item: WatchNextItem): void {
  native?.upsert(item).catch(() => {});
}

/** Takes a video out of the row, e.g. once it has been watched. */
export function removeWatchNext(videoId: string): void {
  native?.remove(videoId).catch(() => {});
}
