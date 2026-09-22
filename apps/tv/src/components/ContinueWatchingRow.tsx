import type { UnifiedVideo } from "@web/server/services/proxy.types";
import { useMemo } from "react";
import { VideoRow } from "@/components/VideoRow";
import type { Nav } from "@/lib/navigation";
import { useScreenActive } from "@/lib/screen-active";
import { trpc } from "@/lib/trpc-react";
import { useInProgressIds } from "@/lib/watch-progress";

/** Recent history scanned for half-watched videos; the row shows at most this many. */
const HISTORY_SCAN = 60;
const ROW_LIMIT = 20;

/**
 * Videos started but not finished, newest first, each resuming where it was
 * left. Progress decides what belongs here; history.list only supplies the
 * titles, since the progress rows carry none.
 */
export function ContinueWatchingRow({ nav }: { nav: Nav }) {
  const inProgress = useInProgressIds();
  const history = trpc.history.list.useQuery(
    { page: 1, pageSize: HISTORY_SCAN, hideWatched: true },
    { retry: 1, subscribed: useScreenActive() },
  );

  const videos = useMemo(() => {
    const rows = new Map(
      (history.data ?? []).map((row) => [row.videoId, row] as const),
    );
    const out: UnifiedVideo[] = [];
    for (const videoId of inProgress) {
      const row = rows.get(videoId);
      if (!row) continue;
      out.push({
        videoId,
        title: row.videoTitle,
        thumbnailUrl: row.thumbnailUrl,
        channelName: row.channelName,
        channelAvatarUrl: row.channelAvatarUrl,
        durationSeconds: row.videoDurationSeconds || undefined,
      });
      if (out.length >= ROW_LIMIT) break;
    }
    return out;
  }, [history.data, inProgress]);

  if (videos.length === 0) return null;
  return (
    <VideoRow
      title="Continue watching"
      videos={videos}
      onSelect={(videoId) =>
        nav.openVideo(videoId, { context: { source: "feed", videos } })
      }
    />
  );
}
