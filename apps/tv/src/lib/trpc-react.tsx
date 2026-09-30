import {
  IsRestoringProvider,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  persistQueryClientRestore,
  persistQueryClientSave,
} from "@tanstack/react-query-persist-client";
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@web/server/trpc/root";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import {
  CACHE_BUSTER,
  PERSIST_MAX_AGE_MS,
  persister,
  queryClient,
} from "@/lib/query-client";
import { createLinks } from "@/lib/trpc-links";

/**
 * Mirrors apps/web/src/trpc/react.tsx so both clients use the same hooks API —
 * `trpc.<router>.<procedure>.useQuery()` means the same thing on either surface.
 */
export const trpc = createTRPCReact<AppRouter>();

/**
 * The cache on disk: restored once at launch, saved when the app goes to the
 * background (Home, another app, the TV to standby).
 *
 * PersistQueryClientProvider saved as the app ran instead: it snapshotted the
 * whole cache on every cache change and wrote it out every few seconds, and
 * both ran on the JS thread in the middle of D-pad scrolling. Saving on the
 * way out does none of that while the app is in use. If the app is killed in
 * the foreground, the next launch starts from the snapshot before, and a
 * missing or stale one only means fetching, as on a first launch.
 */
function usePersistedCache(): boolean {
  const [restoring, setRestoring] = useState(true);
  useEffect(() => {
    let cancelled = false;
    // A snapshot that is corrupt, older than maxAge, or from a different
    // buster is discarded rather than trusted.
    persistQueryClientRestore({
      queryClient,
      persister,
      maxAge: PERSIST_MAX_AGE_MS,
      buster: CACHE_BUSTER,
    })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "background") return;
      void persistQueryClientSave({
        queryClient,
        persister,
        buster: CACHE_BUSTER,
        dehydrateOptions: {
          // Never persist loading or errored queries — only settled data.
          shouldDehydrateQuery: (query) => query.state.status === "success",
        },
      }).catch(() => {});
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);
  return restoring;
}

export function TrpcProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => trpc.createClient({ links: createLinks() }));
  // While true, queries wait instead of fetching, so a revisited screen paints
  // from the snapshot rather than a spinner.
  const restoring = usePersistedCache();

  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <IsRestoringProvider value={restoring}>{children}</IsRestoringProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
