import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { APK_NAME, tvReleasesDir } from "@/server/tv/releases";

/** Serves a published TV APK (see /tv/update.json) for sideloading. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await params;
  if (!APK_NAME.test(file)) return new Response("not found", { status: 404 });
  const filePath = path.join(tvReleasesDir(), file);
  try {
    const info = await stat(filePath);
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(body, {
      headers: {
        "content-type": "application/vnd.android.package-archive",
        "content-length": String(info.size),
        "content-disposition": `attachment; filename="${file}"`,
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
