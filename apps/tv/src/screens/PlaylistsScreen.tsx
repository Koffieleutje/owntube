import type { UnifiedVideo } from "@web/server/services/proxy.types";
import { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { type CardMenuExtras, useCardMenu } from "@/components/CardMenu";
import { CarouselFeed } from "@/components/CarouselFeed";
import { FocusButton } from "@/components/FocusButton";
import { errorMessage } from "@/lib/error-message";
import type { Nav, PlayContext } from "@/lib/navigation";
import { playAllStart } from "@/lib/play-all";
import { queryClient } from "@/lib/query-client";
import { moveId } from "@/lib/reorder";
import { trpcClient } from "@/lib/trpc";
import { trpc } from "@/lib/trpc-react";
import { useInfiniteFeed } from "@/lib/use-infinite-feed";
import { useProgressLookup } from "@/lib/watch-progress";
import { colors, fontSize, spacing } from "@/theme";

const PANE_WIDTH = 220;

type Playlist = { id: number; name: string };

/**
 * Playlists beside their contents, mirroring the Subscriptions layout so the
 * two behave the same: selection follows focus, and the videos pane never
 * steals focus back mid-scroll.
 *
 * Browse-only for now — creating and reordering playlists is far easier on the
 * web, and a TV remote is the wrong tool for it.
 */
export function PlaylistsScreen({ nav }: { nav: Nav }) {
  const [selected, setSelected] = useState<number | null>(null);
  // Cached and shared like every other read; revisiting shows the last list
  // immediately instead of refetching.
  const list = trpc.playlists.list.useQuery();
  const playlists: Playlist[] = useMemo(
    () => (list.data ?? []).map((r) => ({ id: r.id, name: r.name })),
    [list.data],
  );
  const error = list.error ? errorMessage(list.error) : null;

  useEffect(() => {
    setSelected((prev) => prev ?? playlists[0]?.id ?? null);
  }, [playlists]);

  const feed = useInfiniteFeed<never>(
    () =>
      selected === null
        ? Promise.resolve({ items: [], next: undefined })
        : trpcClient.playlists.itemsDetailed
            .query({ playlistId: selected })
            .then((rows) => ({
              items: rows.map((row) => ({
                videoId: row.videoId,
                title: row.videoTitle,
                thumbnailUrl: row.thumbnailUrl,
                channelName: row.channelName ?? undefined,
              })),
              next: undefined,
            })),
    [selected],
    selected === null ? undefined : `playlists.itemsDetailed:${selected}`,
  );

  const heading = playlists.find((p) => p.id === selected)?.name ?? "Playlists";
  const progress = useProgressLookup();
  const play = (videoId: string, videos: UnifiedVideo[]) => {
    const context: PlayContext = { source: "playlist", label: heading, videos };
    nav.openVideo(videoId, { context });
  };
  const first = playAllStart(feed.videos, progress);

  const { notify } = useCardMenu();
  const menuExtras: CardMenuExtras = (video) => {
    if (selected === null) return [];
    const playlistId = selected;
    const refresh = () =>
      queryClient.invalidateQueries({
        queryKey: ["feed", `playlists.itemsDetailed:${playlistId}`],
      });
    const ids = feed.videos.map((v) => v.videoId);
    const move = (delta: -1 | 1) => {
      const next = moveId(ids, video.videoId, delta);
      if (!next) return;
      trpcClient.playlists.reorderItems
        .mutate({ playlistId, videoIds: next })
        .then(refresh)
        .catch(() => notify("Couldn't reorder the playlist"));
    };
    return [
      {
        key: "remove",
        label: `Remove from ${heading}`,
        onPress: () => {
          trpcClient.playlists.removeItem
            .mutate({ playlistId, videoId: video.videoId })
            .then(() => {
              notify(`Removed from ${heading}`);
              return refresh();
            })
            .catch(() => notify("Couldn't update the playlist"));
        },
      },
      { key: "up", label: "Move up", onPress: () => move(-1) },
      { key: "down", label: "Move down", onPress: () => move(1) },
    ];
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Playlists</Text>
      <View style={styles.columns}>
        <View style={styles.pane}>
          <FlatList
            data={playlists}
            keyExtractor={(item) => String(item.id)}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={false}
            renderItem={({ item }) => (
              <FocusButton
                label={item.name}
                onPress={() => setSelected(item.id)}
                onFocusChange={(focused) => {
                  if (focused) setSelected(item.id);
                }}
                style={[
                  styles.row,
                  selected === item.id ? styles.rowActive : undefined,
                ]}
              />
            )}
            ListEmptyComponent={
              <Text style={styles.muted}>
                {error ?? "No playlists yet — create one on the web."}
              </Text>
            }
          />
        </View>
        <View style={styles.feed}>
          <CarouselFeed
            feed={feed}
            onSelect={play}
            menuExtras={menuExtras}
            header={
              <View style={styles.feedHeader}>
                <Text style={styles.heading}>{heading}</Text>
                {first ? (
                  <FocusButton
                    label="Play all"
                    variant="primary"
                    onPress={() => play(first.videoId, feed.videos)}
                  />
                ) : null}
              </View>
            }
            emptyText="This playlist is empty."
            preferFirstRowFocus={false}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  title: {
    color: colors.foreground,
    fontSize: fontSize.xxl,
    fontWeight: "700",
    marginBottom: spacing.lg,
  },
  columns: { flex: 1, flexDirection: "row" },
  pane: {
    width: PANE_WIDTH,
    paddingRight: spacing.lg,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  feed: { flex: 1, paddingLeft: spacing.xl },
  feedHeader: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  heading: {
    color: colors.mutedForeground,
    fontSize: fontSize.lg,
    fontWeight: "600",
  },
  row: { marginBottom: spacing.xs },
  rowActive: { backgroundColor: colors.brandSoft },
  muted: { color: colors.mutedForeground, fontSize: fontSize.sm },
});
