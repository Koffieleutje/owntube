import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { RateLimitExceededError } from "@/server/errors/rate-limit-exceeded";
import { UpstreamAgeRestrictedError } from "@/server/errors/upstream-age-restricted";
import { UpstreamLiveUpcomingError } from "@/server/errors/upstream-live-upcoming";
import { UpstreamUnavailableError } from "@/server/errors/upstream-unavailable";
import { UpstreamVideoUnavailableError } from "@/server/errors/upstream-video-unavailable";
import {
  fetchRelatedVideos,
  fetchVideoComments,
  fetchVideoDetail,
} from "@/server/services/proxy";
import {
  videoCommentsInputSchema,
  videoDetailInputSchema,
} from "@/server/services/proxy.types";
import {
  getUserSettings,
  withoutBlockedChannels,
} from "@/server/settings/profile";
import { publicProcedure, router } from "@/server/trpc/init";

const videoCommentsQuerySchema = videoCommentsInputSchema.extend({
  /** Set by `useInfiniteQuery` from `getNextPageParam`. */
  cursor: z.string().max(16384).nullish(),
});

export const videoRouter = router({
  detail: publicProcedure
    .input(videoDetailInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await fetchVideoDetail(ctx.db, input);
      } catch (e) {
        if (e instanceof UpstreamAgeRestrictedError) {
          throw new TRPCError({
            code: "UNPROCESSABLE_CONTENT",
            message: e.message,
          });
        }
        if (e instanceof UpstreamLiveUpcomingError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: e.message,
            cause: e,
          });
        }
        if (e instanceof UpstreamVideoUnavailableError) {
          throw new TRPCError({ code: "NOT_FOUND", message: e.message });
        }
        if (e instanceof UpstreamUnavailableError) {
          throw new TRPCError({ code: "BAD_GATEWAY", message: e.message });
        }
        if (e instanceof RateLimitExceededError) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: e.message,
          });
        }
        throw e;
      }
    }),
  related: publicProcedure
    .input(videoDetailInputSchema)
    .query(async ({ ctx, input }) => {
      const result = await fetchRelatedVideos(ctx.db, input, 20);
      if (!ctx.userId) return result;
      return {
        ...result,
        videos: withoutBlockedChannels(
          result.videos,
          getUserSettings(ctx.db, ctx.userId),
        ),
      };
    }),
  comments: publicProcedure
    .input(videoCommentsQuerySchema)
    .query(async ({ ctx, input }) => {
      const { cursor, continuation, videoId, sortBy } = input;
      try {
        return await fetchVideoComments(
          ctx.db,
          {
            videoId,
            sortBy,
            continuation: continuation ?? cursor ?? undefined,
          },
          { cacheOnly: ctx.prefetchCacheOnly },
        );
      } catch (e) {
        if (e instanceof UpstreamLiveUpcomingError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: e.message,
            cause: e,
          });
        }
        if (e instanceof UpstreamVideoUnavailableError) {
          throw new TRPCError({ code: "NOT_FOUND", message: e.message });
        }
        if (e instanceof UpstreamUnavailableError) {
          throw new TRPCError({ code: "BAD_GATEWAY", message: e.message });
        }
        if (e instanceof RateLimitExceededError) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: e.message,
          });
        }
        throw e;
      }
    }),
});
