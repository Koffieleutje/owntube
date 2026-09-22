import { describe, expect, it } from "vitest";
import {
  createPoolInvalidation,
  settlePoolBuild,
} from "@/server/recommendation/pool-invalidation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("pool invalidation", () => {
  it("does not cache a build that was invalidated while it ran", async () => {
    const invalidation = createPoolInvalidation();
    const cache = new Map<string, string>();
    const inFlight = new Map<string, Promise<string>>();
    const build = deferred<string>();

    const settled = settlePoolBuild(
      build.promise,
      "7|US",
      cache,
      inFlight,
      invalidation.snapshot(7),
    );
    invalidation.invalidate(7); // e.g. the user blocked a channel
    build.resolve("pre-block pool");

    expect(await settled).toBe("pre-block pool");
    expect(cache.has("7|US")).toBe(false);
  });

  it("caches when only another user was invalidated", async () => {
    const invalidation = createPoolInvalidation();
    const cache = new Map<string, string>();
    const inFlight = new Map<string, Promise<string>>();
    const settled = settlePoolBuild(
      Promise.resolve("pool"),
      "7|US",
      cache,
      inFlight,
      invalidation.snapshot(7),
    );
    invalidation.invalidate(8);
    await settled;
    expect(cache.get("7|US")).toBe("pool");
    expect(inFlight.size).toBe(0);
  });

  it("a global invalidation outdates every user", () => {
    const invalidation = createPoolInvalidation();
    const forUser = invalidation.snapshot(7);
    const anonymous = invalidation.snapshot(null);
    invalidation.invalidate();
    expect(forUser()).toBe(false);
    expect(anonymous()).toBe(false);
  });

  it("an orphaned build leaves a newer in-flight build registered", async () => {
    const invalidation = createPoolInvalidation();
    const cache = new Map<string, string>();
    const inFlight = new Map<string, Promise<string>>();
    const old = deferred<string>();
    const oldSettled = settlePoolBuild(
      old.promise,
      "7|US",
      cache,
      inFlight,
      invalidation.snapshot(7),
    );
    invalidation.invalidate(7);
    inFlight.delete("7|US");
    const fresh = deferred<string>();
    settlePoolBuild(
      fresh.promise,
      "7|US",
      cache,
      inFlight,
      invalidation.snapshot(7),
    );

    old.resolve("old");
    await oldSettled;
    expect(inFlight.get("7|US")).toBe(fresh.promise);
  });
});
