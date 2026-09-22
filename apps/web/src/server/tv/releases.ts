import path from "node:path";

/**
 * Where TV app releases live: `update.json` plus the APKs it points at.
 * Outside the image, next to the database by default, so publishing a TV
 * release is copying two files rather than redeploying the web app.
 */
export function tvReleasesDir(): string {
  return (
    process.env.OWNTUBE_TV_RELEASES_DIR ??
    path.join(process.cwd(), "data", "tv-releases")
  );
}

/** APK names the download route will serve; anything else is a 404. */
export const APK_NAME = /^[A-Za-z0-9._-]+\.apk$/;
