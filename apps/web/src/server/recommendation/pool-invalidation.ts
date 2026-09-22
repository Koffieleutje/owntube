/**
 * Invalidation generations for an in-memory pool cache with in-flight builds.
 *
 * Clearing the cache (after a like, block, subscription change…) drops the
 * cached and in-flight entries, but a build that was already running still
 * resolves later. Without a guard its `.then` writes the pre-invalidation pool
 * back into the cache, undoing the change until the TTL runs out, and its
 * `.finally` can delete the in-flight entry of a newer build under the same key.
 */
export function createPoolInvalidation() {
  let globalGeneration = 0;
  const userGenerations = new Map<number, number>();

  function isUserId(userId: number | null | undefined): userId is number {
    return typeof userId === "number" && Number.isFinite(userId) && userId > 0;
  }

  function userGeneration(userId: number | null): number {
    return isUserId(userId) ? (userGenerations.get(userId) ?? 0) : 0;
  }

  return {
    /** Mark every pool (no valid id) or one user's pools as outdated. */
    invalidate(userId?: number): void {
      if (!isUserId(userId)) {
        globalGeneration++;
        return;
      }
      userGenerations.set(userId, userGeneration(userId) + 1);
    },

    /**
     * Take before starting a build; the returned check is true while no
     * invalidation affecting `userId` has happened since.
     */
    snapshot(userId: number | null): () => boolean {
      const global = globalGeneration;
      const user = userGeneration(userId);
      return () =>
        global === globalGeneration && user === userGeneration(userId);
    },
  };
}

/**
 * Registers `task` as the in-flight build for `key` and settles it into
 * `cache` — unless the pools were invalidated while it ran, in which case the
 * result still answers its own callers but is not cached.
 */
export function settlePoolBuild<T>(
  task: Promise<T>,
  key: string,
  cache: Map<string, T>,
  inFlight: Map<string, Promise<T>>,
  stillCurrent: () => boolean,
): Promise<T> {
  inFlight.set(key, task);
  return task
    .then((entry) => {
      if (stillCurrent()) cache.set(key, entry);
      return entry;
    })
    .finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key);
    });
}
