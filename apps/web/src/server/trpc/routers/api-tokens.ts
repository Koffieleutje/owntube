import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  API_TOKEN_SCOPE_KEYS,
  API_TOKEN_SCOPES,
  type ApiTokenScope,
  generateApiToken,
  hashApiToken,
  parseScopes,
} from "@/server/api-token";
import { apiTokens } from "@/server/db/schema";
import { protectedProcedure, router } from "@/server/trpc/init";

const scopeSchema = z.enum(
  API_TOKEN_SCOPE_KEYS as [ApiTokenScope, ...ApiTokenScope[]],
);

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Settings → API tokens. None of these procedures is in any scope, so an API
 * token can never mint or revoke tokens — only a signed-in session can.
 */
export const apiTokensRouter = router({
  scopes: protectedProcedure.query(() =>
    API_TOKEN_SCOPE_KEYS.map((key) => ({
      key,
      label: API_TOKEN_SCOPES[key].label,
      description: API_TOKEN_SCOPES[key].description,
    })),
  ),

  list: protectedProcedure.query(({ ctx }) =>
    ctx.db
      .select({
        id: apiTokens.id,
        label: apiTokens.label,
        scopes: apiTokens.scopes,
        createdAt: apiTokens.createdAt,
        lastUsedAt: apiTokens.lastUsedAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, ctx.userId), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
      .all()
      .map((row) => ({ ...row, scopes: parseScopes(row.scopes) })),
  ),

  /** Returns the token itself — the only time it is ever available. */
  create: protectedProcedure
    .input(
      z.object({
        label: z.string().trim().min(1).max(100),
        scopes: z.array(scopeSchema).min(1),
      }),
    )
    .mutation(({ ctx, input }) => {
      const token = generateApiToken();
      const scopes = [...new Set(input.scopes)];
      const row = ctx.db
        .insert(apiTokens)
        .values({
          userId: ctx.userId,
          label: input.label,
          tokenHash: hashApiToken(token),
          scopes: JSON.stringify(scopes),
          createdAt: nowUnix(),
        })
        .returning({ id: apiTokens.id })
        .get();
      return { id: row.id, token };
    }),

  revoke: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(({ ctx, input }) => {
      const res = ctx.db
        .update(apiTokens)
        .set({ revokedAt: nowUnix() })
        .where(
          and(
            eq(apiTokens.id, input.id),
            eq(apiTokens.userId, ctx.userId),
            isNull(apiTokens.revokedAt),
          ),
        )
        .run();
      if (res.changes === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such token." });
      }
      return { revoked: true };
    }),
});
