import Constants from "expo-constants";
import { baseUrl } from "@/lib/config";

/** This build's version, from app.json (bumped per release). */
export const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
export const VERSION_CODE = Constants.expoConfig?.android?.versionCode ?? 0;
/** The commit it was built from, when the build passes EXPO_PUBLIC_BUILD_ID. */
export const BUILD_ID = process.env.EXPO_PUBLIC_BUILD_ID ?? null;

export type AvailableUpdate = {
  version: string;
  versionCode: number;
  /** Absolute download URL. */
  apkUrl: string;
  notes?: string;
};

/**
 * Asks the server for its newest published TV release (`/tv/update.json`),
 * returning it when it is newer than this build. A missing file, an old
 * server without the route, or a network error all mean "no update".
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  try {
    const response = await fetch(`${baseUrl()}/tv/update.json`);
    if (!response.ok) return null;
    const release = (await response.json()) as Partial<AvailableUpdate>;
    if (
      typeof release.versionCode !== "number" ||
      typeof release.apkUrl !== "string" ||
      release.versionCode <= VERSION_CODE
    ) {
      return null;
    }
    return {
      version: release.version ?? String(release.versionCode),
      versionCode: release.versionCode,
      apkUrl: new URL(release.apkUrl, baseUrl()).toString(),
      notes: release.notes,
    };
  } catch {
    return null;
  }
}
