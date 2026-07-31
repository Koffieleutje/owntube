/**
 * The feeds pusher. Builds every user's feed snapshots (playlists, queue,
 * saved, subscription/tag/channel uploads) and POSTs them to the public feeds
 * server. Run one-shot via `pnpm push:feeds`; the deploy container loops it on
 * an interval (see docker-compose `owntube-feeds-pusher`).
 *
 * It lives here as the pusher's entrypoint, but deliberately still imports the
 * web app's server modules: building a snapshot means reading the app's SQLite
 * database through its own schema and reusing its feed/RSS logic. Reimplementing
 * that here would be a second source of truth for what a feed contains.
 *
 * DB bootstrap mirrors `apps/web/scripts/warm-cache.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { runSqlMigrations } from "@/server/db/run-migrations";
import * as schema from "@/server/db/schema";
import { publishFeeds } from "@/server/remote/publish";
import { reportRecentHistory } from "@/server/remote/report-history";

const defaultPath = path.join(process.cwd(), "data", "owntube.db");
const dbPath = process.env.DATABASE_PATH ?? defaultPath;

const target = process.env.OWNTUBE_PUBLISH_TARGET?.trim() ?? "";
const secret = process.env.OWNTUBE_PUBLISH_SECRET?.trim() ?? "";
// Origin used to build enclosure/link URLs. Enclosures are further rewritten to
// NEXT_PUBLIC_MEDIA_BASE_URL by toMediaOriginUrl, so this is mainly the app link.
const appOrigin =
  process.env.OWNTUBE_APP_URL?.trim() ||
  process.env.APP_URL?.trim() ||
  process.env.AUTH_URL?.trim() ||
  "http://localhost:3000";

function logLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  if (!target || !secret) {
    process.stderr.write(
      "push-feeds: OWNTUBE_PUBLISH_TARGET and OWNTUBE_PUBLISH_SECRET are required\n",
    );
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  runSqlMigrations(
    sqlite,
    path.join(process.cwd(), "src/server/db/migrations"),
  );

  try {
    const { feedCount, itemCount } = await publishFeeds(db, {
      target,
      secret,
      appOrigin,
      onLog: logLine,
    });
    logLine(
      `publish-feeds: pushed ${feedCount} feed(s), ${itemCount} item(s) → ${target}`,
    );
    // Reconciliation sweep: re-offer recent watch state to pocket-sessions.
    // Its ahead-only guard drops everything it already knows, so a PCS
    // outage heals within one push cycle and steady state costs nothing.
    const { reported, applied } = await reportRecentHistory(db, {
      onLog: logLine,
    });
    logLine(`report-history: ${reported} re-offered, ${applied} applied`);
  } finally {
    sqlite.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`publish-feeds failed: ${message}\n`);
  process.exitCode = 1;
});
