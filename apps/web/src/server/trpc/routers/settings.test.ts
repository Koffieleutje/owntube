import { afterEach, describe, expect, it } from "vitest";
import { users } from "@/server/db/schema";
import { appRouter } from "@/server/trpc/root";
import { createTestDb } from "@/test/db";

describe("settingsRouter", () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  it("updates and reads user settings", async () => {
    const { db, sqlite } = createTestDb();
    const ts = Math.floor(Date.now() / 1000);
    const user = db
      .insert(users)
      .values({
        email: "settings@example.com",
        passwordHash: "x",
        createdAt: ts,
        updatedAt: ts,
      })
      .returning({ id: users.id })
      .get();

    const caller = appRouter.createCaller({ db, userId: user.id });
    const initial = await caller.settings.get();
    expect(initial.visualTheme).toBe("default");

    const updated = await caller.settings.update({
      theme: "dark",
      visualTheme: "terminal",
    });
    expect(updated.theme).toBe("dark");
    expect(updated.visualTheme).toBe("terminal");

    const fetched = await caller.settings.get();
    expect(fetched.theme).toBe("dark");
    expect(fetched.visualTheme).toBe("terminal");

    const cleared = await caller.settings.clearCaches();
    expect(cleared.ok).toBe(true);
    expect(typeof cleared.clearedRows).toBe("number");

    sqlite.close();
  });

  it("reports the server-configured upstream, not a per-account one", async () => {
    process.env = {
      ...env,
      INVIDIOUS_BASE_URL: "https://one.example, https://two.example",
    };
    const { db, sqlite } = createTestDb();
    const ts = Math.floor(Date.now() / 1000);
    const user = db
      .insert(users)
      .values({
        email: "instances@example.com",
        passwordHash: "x",
        createdAt: ts,
        updatedAt: ts,
      })
      .returning({ id: users.id })
      .get();

    const caller = appRouter.createCaller({ db, userId: user.id });
    const fetched = await caller.settings.get();
    // INVIDIOUS_BASE_URL may list several instances to fail over between; the
    // account has no say in it any more.
    expect(fetched.instanceSources.invidious.urls).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
    expect(fetched.instanceSources.invidious.effectiveUrl).toBe(
      "https://one.example",
    );
    expect(fetched.instanceSources.invidious.envDisabled).toBe(false);

    sqlite.close();
  });
});
