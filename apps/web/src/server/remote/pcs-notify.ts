import { logger } from "@/lib/logger";

/**
 * Report playback state to a pocket-sessions server so listening progress
 * flows back into Pocket Casts (the reverse of the PCS→OwnTube hook). PCS
 * matches the videoId against episode enclosure URLs and applies its own
 * ahead-only guard, so echoes of events that originated in Pocket Casts are
 * dropped there — this side just reports every history write.
 *
 * Fire-and-forget on purpose: playback tracking must never block or fail on
 * the reporting path. Unset env = feature off.
 */
export function notifyPcsPlayback(input: {
  videoId: string;
  positionSeconds: number;
  completed: boolean;
  durationSeconds?: number;
}): void {
  const url = process.env.PCS_PLAYBACK_URL?.trim();
  const token = process.env.PCS_PLAYBACK_TOKEN?.trim();
  if (!url || !token) return;
  void fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      enclosureContains: input.videoId,
      positionSeconds: Math.max(0, Math.floor(input.positionSeconds)),
      completed: input.completed,
      durationSeconds: input.durationSeconds
        ? Math.floor(input.durationSeconds)
        : undefined,
    }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (!res.ok) {
        logger.debug("pcs playback report rejected", {
          status: res.status,
          videoId: input.videoId,
        });
      }
    })
    .catch((error: unknown) => {
      logger.debug("pcs playback report failed", {
        err: error instanceof Error ? error.message : String(error),
      });
    });
}
