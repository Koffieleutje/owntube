import { z } from "zod";
import { protectedProcedure, router } from "@/server/trpc/init";
import {
  listTvs,
  looksLikeEmulator,
  pollTv,
  sendToTv,
} from "@/server/tv-remote";

const deviceIdSchema = z.string().min(8).max(64);

/** Play on TV — see server/tv-remote.ts. */
export const tvRemoteRouter = router({
  /** Called by the TV every few seconds while it is in the foreground. */
  poll: protectedProcedure
    .input(
      z.object({
        deviceId: deviceIdSchema,
        name: z.string().min(1).max(60),
        /** Sent by newer TV builds; older ones are judged by their name. */
        emulator: z.boolean().optional(),
      }),
    )
    .query(({ ctx, input }) => ({
      command: pollTv(
        ctx.userId,
        input.deviceId,
        input.name,
        Date.now(),
        input.emulator ?? looksLikeEmulator(input.name),
      ),
    })),

  /** The user's TVs that are on right now. */
  devices: protectedProcedure.query(({ ctx }) => listTvs(ctx.userId)),

  sendToDevice: protectedProcedure
    .input(
      z.object({
        deviceId: deviceIdSchema,
        videoId: z.string().min(5).max(64),
        startSeconds: z.number().int().min(0).max(86_400).optional(),
      }),
    )
    .mutation(({ ctx, input }) => ({
      ok: sendToTv(ctx.userId, input.deviceId, {
        videoId: input.videoId,
        startSeconds: input.startSeconds,
      }),
    })),
});
