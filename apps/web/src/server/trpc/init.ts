import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { UpstreamLiveUpcomingError } from "@/server/errors/upstream-live-upcoming";
import type { TRPCContext } from "@/server/trpc/context";

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // An upcoming stream's start time, so a client (the TV) can say when it
    // begins rather than only that it can't play yet.
    const cause = error.cause;
    return cause instanceof UpstreamLiveUpcomingError
      ? {
          ...shape,
          data: {
            ...shape.data,
            premiereTimestamp: cause.premiereTimestamp ?? null,
          },
        }
      : shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required.",
    });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
