import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  interactions,
  playlistItems,
  playlists,
  publishedFeeds,
  watchQueue,
} from "@/server/db/schema";
import { protectedProcedure, router } from "@/server/trpc/init";

/**
 * Remote-control surface for pocket-sessions: actions Pocket Casts playback
 * takes against the library. `archiveFromFeed` maps "this feed's episode was
 * archived in the app" onto the collection the feed was published from —
 * queue, saved, or a playlist — via the published_feeds slug ledger.
 * Subscription/tag/channel feeds have nothing to remove.
 */
export const remoteRouter = router({
  archiveFromFeed: protectedProcedure
    .input(
      z.object({
        videoId: z.string().min(5).max(64),
        /** The podcast title as the app knows it — the published feed title,
         * possibly carrying the render-time " (Video)" suffix. */
        feedTitle: z.string().min(1).max(300),
      }),
    )
    .mutation(({ ctx, input }) => {
      const title = input.feedTitle.replace(/\s*\(Video\)$/, "");
      const feed = ctx.db
        .select({ kind: publishedFeeds.kind, refId: publishedFeeds.refId })
        .from(publishedFeeds)
        .where(
          and(
            eq(publishedFeeds.userId, ctx.userId),
            eq(publishedFeeds.title, title),
          ),
        )
        .get();
      if (!feed) return { removed: null, reason: "unknown-feed" as const };

      switch (feed.kind) {
        case "queue": {
          const res = ctx.db
            .delete(watchQueue)
            .where(
              and(
                eq(watchQueue.userId, ctx.userId),
                eq(watchQueue.videoId, input.videoId),
              ),
            )
            .run();
          return { removed: res.changes > 0 ? ("queue" as const) : null };
        }
        case "saved": {
          const res = ctx.db
            .delete(interactions)
            .where(
              and(
                eq(interactions.userId, ctx.userId),
                eq(interactions.videoId, input.videoId),
                eq(interactions.type, "save"),
              ),
            )
            .run();
          return { removed: res.changes > 0 ? ("saved" as const) : null };
        }
        case "playlist": {
          const playlistId = Number.parseInt(feed.refId, 10);
          const owned = ctx.db
            .select({ id: playlists.id })
            .from(playlists)
            .where(
              and(
                eq(playlists.id, playlistId),
                eq(playlists.userId, ctx.userId),
              ),
            )
            .get();
          if (!owned) return { removed: null, reason: "unknown-feed" as const };
          const res = ctx.db
            .delete(playlistItems)
            .where(
              and(
                eq(playlistItems.playlistId, playlistId),
                eq(playlistItems.videoId, input.videoId),
              ),
            )
            .run();
          return { removed: res.changes > 0 ? ("playlist" as const) : null };
        }
        default:
          // Subscriptions/tag/channel feeds mirror uploads — nothing to remove.
          return { removed: null, reason: "not-removable" as const };
      }
    }),
});
