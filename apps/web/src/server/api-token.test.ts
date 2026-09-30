import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  apiTokenAllows,
  generateApiToken,
  hashApiToken,
  resolveApiToken,
} from "@/server/api-token";
import { apiTokens, users } from "@/server/db/schema";
import { appRouter } from "@/server/trpc/root";
import { createTestDb } from "@/test/db";

const { db, sqlite } = createTestDb();

vi.mock("@/server/auth", () => ({ auth: async () => null }));
vi.mock("@/server/db/client", () => ({ getDb: () => db }));

const ts = Math.floor(Date.now() / 1000);

function makeUser(email: string) {
  return db
    .insert(users)
    .values({ email, passwordHash: "x", createdAt: ts, updatedAt: ts })
    .returning({ id: users.id })
    .get();
}

const user = makeUser("tokens@example.com");
const other = makeUser("tokens-other@example.com");
const session = appRouter.createCaller({ db, userId: user.id });

afterAll(() => sqlite.close());

async function contextFor(bearer: string) {
  const { createTRPCContext } = await import("@/server/trpc/context");
  return createTRPCContext({
    req: new Request("http://localhost/api/trpc/x", {
      headers: { authorization: `Bearer ${bearer}` },
    }),
  });
}

describe("api tokens", () => {
  it("are random, prefixed, and stored only as a hash", async () => {
    expect(generateApiToken()).toMatch(/^ot_[A-Za-z0-9_-]{43}$/);
    expect(generateApiToken()).not.toBe(generateApiToken());

    const { id, token } = await session.apiTokens.create({
      label: "n8n mesh",
      scopes: ["playback"],
    });
    const row = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    expect(row?.tokenHash).toBe(hashApiToken(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const listed = await session.apiTokens.list();
    expect(listed).toEqual([
      expect.objectContaining({ id, label: "n8n mesh", scopes: ["playback"] }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it("resolve to their user and scopes until revoked", async () => {
    const { id, token } = await session.apiTokens.create({
      label: "resolve",
      scopes: ["playback"],
    });
    expect(resolveApiToken(db, token, ts)).toEqual({
      id,
      userId: user.id,
      scopes: ["playback"],
    });
    expect(resolveApiToken(db, "ot_unknown")).toBeNull();

    await session.apiTokens.revoke({ id });
    expect(resolveApiToken(db, token)).toBeNull();
    expect((await session.apiTokens.list()).map((t) => t.id)).not.toContain(id);
  });

  it("record last use, at most once a minute", async () => {
    const { id, token } = await session.apiTokens.create({
      label: "last-used",
      scopes: ["playback"],
    });
    const lastUsed = () =>
      db.select().from(apiTokens).where(eq(apiTokens.id, id)).get()?.lastUsedAt;
    resolveApiToken(db, token, 1000);
    expect(lastUsed()).toBe(1000);
    resolveApiToken(db, token, 1030);
    expect(lastUsed()).toBe(1000);
    resolveApiToken(db, token, 1060);
    expect(lastUsed()).toBe(1060);
  });

  it("can only be revoked by their owner", async () => {
    const { id, token } = await session.apiTokens.create({
      label: "mine",
      scopes: ["playback"],
    });
    const stranger = appRouter.createCaller({ db, userId: other.id });
    await expect(stranger.apiTokens.revoke({ id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(resolveApiToken(db, token)).not.toBeNull();
  });

  it("need at least one known scope", async () => {
    await expect(
      session.apiTokens.create({ label: "none", scopes: [] }),
    ).rejects.toThrow();
    await expect(
      // @ts-expect-error: not a scope
      session.apiTokens.create({ label: "bad", scopes: ["admin"] }),
    ).rejects.toThrow();
  });
});

describe("api token scopes", () => {
  it("map to an explicit procedure allowlist", () => {
    expect(apiTokenAllows(["playback"], "history.upsertEvent")).toBe(true);
    expect(apiTokenAllows(["playback"], "remote.archiveFromFeed")).toBe(true);
    expect(apiTokenAllows(["playback"], "history.list")).toBe(false);
    expect(apiTokenAllows([], "history.upsertEvent")).toBe(false);
  });

  it("gate protected procedures for token-authenticated calls", async () => {
    const { token } = await session.apiTokens.create({
      label: "scoped",
      scopes: ["playback"],
    });
    const caller = appRouter.createCaller(await contextFor(token));

    await expect(
      caller.history.upsertEvent({
        videoId: "dQw4w9WgXcQ",
        channelId: "UC1",
        positionSeconds: 190,
        videoDurationSeconds: 1002,
      }),
    ).resolves.toMatchObject({ updated: false });
    expect(
      (await session.history.progressAll()).find(
        (p) => p.videoId === "dQw4w9WgXcQ",
      )?.positionSeconds,
    ).toBe(190);

    await expect(caller.history.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.settings.get()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // A token can never mint or revoke tokens.
    await expect(
      caller.apiTokens.create({ label: "escalate", scopes: ["playback"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("leave revoked and unknown tokens unauthenticated", async () => {
    const { id, token } = await session.apiTokens.create({
      label: "revoked",
      scopes: ["playback"],
    });
    await session.apiTokens.revoke({ id });

    for (const bearer of [token, "ot_nope", "not-a-device-token"]) {
      const ctx = await contextFor(bearer);
      expect(ctx.userId).toBeNull();
      expect(ctx.apiToken).toBeUndefined();
      await expect(
        appRouter.createCaller(ctx).history.upsertEvent({
          videoId: "dQw4w9WgXcQ",
          channelId: "UC1",
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });
});
