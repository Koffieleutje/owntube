import { StyleSheet, Text, View } from "react-native";
import { CarouselFeed } from "@/components/CarouselFeed";
import type { Nav } from "@/lib/navigation";
import { trpcClient } from "@/lib/trpc";
import { useInfiniteFeed } from "@/lib/use-infinite-feed";
import { colors, fontSize, spacing } from "@/theme";

/**
 * One public YouTube playlist, reached from a channel's playlist row.
 *
 * Upstream returns a single page (`fetchYtPlaylist` — metadata plus the first
 * page of videos), so there is nothing to paginate: the loader resolves once
 * with `next: undefined` and `CarouselFeed` shelves the result like any feed.
 */
export function ChannelPlaylistScreen({
  playlistId,
  title,
  nav,
}: {
  playlistId: string;
  /** Known from the card that opened this, so the heading has no empty frame. */
  title?: string;
  nav: Nav;
}) {
  const feed = useInfiniteFeed<string>(
    () =>
      trpcClient.channel.ytPlaylist
        .query({ playlistId })
        .then((playlist) => ({ items: playlist.videos, next: undefined })),
    [playlistId],
    `channel.ytPlaylist:${playlistId}`,
  );

  const header = (
    <View style={styles.header}>
      <Text style={styles.kicker}>Playlist</Text>
      <Text style={styles.title} numberOfLines={2}>
        {title ?? "Playlist"}
      </Text>
    </View>
  );

  return (
    <CarouselFeed
      feed={feed}
      onSelect={(videoId) => nav.openVideo(videoId)}
      header={header}
      emptyText="This playlist has no videos."
    />
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs, paddingHorizontal: spacing.xs },
  kicker: {
    color: colors.mutedForeground,
    fontSize: fontSize.sm,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  title: {
    color: colors.foreground,
    fontSize: fontSize.xl,
    fontWeight: "800",
  },
});
