import { and, eq, gt } from "drizzle-orm";
import type { AppDb } from "@/server/db/client";
import { watchHistory } from "@/server/db/schema";

/**
 * Re-report recent watch history to pocket-sessions — outage recovery for the
 * fire-and-forget playback webhook (pcs-notify.ts). PCS's ahead-only guard
 * drops everything it already knows, so running this every publish cycle is
 * cheap: only state PCS missed (a webhook lost to its downtime) applies.
 * Sequential on purpose; this is a background sweep, not a hot path.
 */
export async function reportRecentHistory(
  db: AppDb,
  opts: { sinceHours?: number; onLog?: (msg: string) => void } = {},
): Promise<{ reported: number; applied: number }> {
  const url = process.env.PCS_PLAYBACK_URL?.trim();
  const token = process.env.PCS_PLAYBACK_TOKEN?.trim();
  if (!url || !token) return { reported: 0, applied: 0 };

  const since = Math.floor(Date.now() / 1000) - (opts.sinceHours ?? 48) * 3600;
  const rows = db
    .select({
      videoId: watchHistory.videoId,
      positionSeconds: watchHistory.positionSeconds,
      completed: watchHistory.completed,
      videoDurationSeconds: watchHistory.videoDurationSeconds,
    })
    .from(watchHistory)
    .where(
      and(
        eq(watchHistory.isDeleted, 0),
        eq(watchHistory.isShort, 0),
        gt(watchHistory.startedAt, since),
      ),
    )
    .all();

  let applied = 0;
  for (const row of rows) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          enclosureContains: row.videoId,
          positionSeconds: Math.max(0, row.positionSeconds),
          completed: row.completed === 1,
          durationSeconds: row.videoDurationSeconds || undefined,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { applied?: boolean };
        if (body.applied) {
          applied++;
          opts.onLog?.(`report-history: applied ${row.videoId}`);
        }
      }
    } catch (error) {
      opts.onLog?.(
        `report-history: ${row.videoId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { reported: rows.length, applied };
}
