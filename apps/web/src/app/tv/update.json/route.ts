import { readFile } from "node:fs/promises";
import path from "node:path";
import { tvReleasesDir } from "@/server/tv/releases";

/**
 * The TV app's update check: the newest release's metadata, as published in
 * `<tv releases dir>/update.json` — `{ version, versionCode, apkUrl, notes? }`,
 * with `apkUrl` usually `/tv/download/<file>.apk`. 404 when nothing is
 * published, which the TV reads as "no update".
 */
export async function GET(): Promise<Response> {
  try {
    const raw = await readFile(
      path.join(tvReleasesDir(), "update.json"),
      "utf8",
    );
    const release = JSON.parse(raw) as unknown;
    return Response.json(release, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return new Response("no TV release published", { status: 404 });
  }
}
