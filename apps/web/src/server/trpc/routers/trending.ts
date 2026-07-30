import { TRPCError } from "@trpc/server";
import { RateLimitExceededError } from "@/server/errors/rate-limit-exceeded";
import { UpstreamUnavailableError } from "@/server/errors/upstream-unavailable";
import { fetchTrendingVideos } from "@/server/services/proxy";
import { trendingInputSchema } from "@/server/services/proxy.types";
import { publicProcedure, router } from "@/server/trpc/init";

export const trendingRouter = router({
  list: publicProcedure
    .input(trendingInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await fetchTrendingVideos(ctx.db, input);
      } catch (e) {
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
