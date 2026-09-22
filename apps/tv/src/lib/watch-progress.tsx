import { useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@web/server/trpc/root";
import type { MutableRefObject, ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc-react";

/**
 * Watch positions for every video, shared by thumbnails and by "open video"
 * so a card can show progress and playback can resume where it left off.
 *
 * One query backs all of them, indexed once into a Map and handed down by
 * context. Cards used to subscribe to the query individually and linearly
 * scan the rows, which cost one react-query observer and one O(rows) search
 * per card on every render — noticeable on a TV box with a few hundred cards
 * mounted. The web reaches the same result through a page-level context.
 */

/** Below this the bar is noise; above it the video counts as finished. */
const MIN_FRACTION = 0.01;
const COMPLETE_FRACTION = 0.97;
/** Don't resume from the first few seconds — starting over is what's wanted. */
const MIN_RESUME_SECONDS = 5;

export type WatchProgress = { fraction: number; completed: boolean };

type ProgressRow =
  inferRouterOutputs<AppRouter>["history"]["progressAll"][number];
type ProgressMap = Map<string, ProgressRow>;

const EMPTY: ProgressMap = new Map();
const ProgressContext = createContext<ProgressMap>(EMPTY);
/**
 * The same map behind a stable ref, for callers that only look progress up on
 * demand (opening a video) and so shouldn't re-render when it changes.
 */
const ProgressRefContext = createContext<MutableRefObject<ProgressMap>>({
  current: EMPTY,
});

export function WatchProgressProvider({ children }: { children: ReactNode }) {
  const query = trpc.history.progressAll.useQuery(undefined, {
    // Progress is decoration; a failure shouldn't retry aggressively.
    retry: 1,
  });
  const rows = query.data;
  const byId = useMemo(() => {
    if (!rows) return EMPTY;
    const map: ProgressMap = new Map();
    // Rows come newest first; keep the first per video, as a find() would.
    for (const row of rows) {
      if (!map.has(row.videoId)) map.set(row.videoId, row);
    }
    return map;
  }, [rows]);
  const ref = useRef(byId);
  ref.current = byId;
  return (
    <ProgressRefContext.Provider value={ref}>
      <ProgressContext.Provider value={byId}>
        {children}
      </ProgressContext.Provider>
    </ProgressRefContext.Provider>
  );
}

/** Progress for one video, or null when there is nothing worth drawing. */
export function useWatchProgress(videoId: string): WatchProgress | null {
  const row = useContext(ProgressContext).get(videoId);
  if (!row) return null;
  if (row.completed) return { fraction: 1, completed: true };
  const duration = row.videoDurationSeconds;
  if (!duration || duration <= 0) return null;
  const fraction = row.positionSeconds / duration;
  if (fraction < MIN_FRACTION) return null;
  return { fraction: Math.min(fraction, 1), completed: false };
}

/**
 * Seconds to resume from, or undefined to start at the beginning — which is
 * what a finished (or barely started) video should do.
 *
 * The returned function is stable (it reads the latest rows through a ref), so
 * callers can build navigation callbacks that never change identity and don't
 * re-render whole screens when progress refreshes.
 */
export function useResumeLookup(): (videoId: string) => number | undefined {
  const ref = useContext(ProgressRefContext);
  return useCallback(
    (videoId: string) => {
      const row = ref.current.get(videoId);
      if (!row || row.completed) return undefined;
      const duration = row.videoDurationSeconds;
      if (duration && row.positionSeconds / duration > COMPLETE_FRACTION) {
        return undefined;
      }
      return row.positionSeconds > MIN_RESUME_SECONDS
        ? row.positionSeconds
        : undefined;
    },
    [ref],
  );
}

/** Leaving the player writes new progress; pull it so the bars update. */
export function useWatchProgressRefresh(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: [["history", "progressAll"]],
    });
  }, [queryClient]);
}
