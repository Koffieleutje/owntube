import { useRef } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import {
  type ChannelPlaylist,
  PLAYLIST_CARD_WIDTH,
  PlaylistCard,
} from "@/components/PlaylistCard";
import { colors, fontSize, spacing } from "@/theme";

/**
 * A D-pad horizontally-scrollable row of a channel's playlists. Mirrors
 * `VideoRow` — same clipping and scroll-on-focus rules, for the same reasons.
 */
export function PlaylistRow({
  title,
  playlists,
  onSelect,
}: {
  title?: string;
  playlists: ChannelPlaylist[];
  onSelect: (playlist: ChannelPlaylist) => void;
}) {
  const listRef = useRef<FlatList<ChannelPlaylist>>(null);

  /**
   * TV focus can move to a card outside the viewport without the list
   * scrolling, so the card lands off screen. Drive the scroll from focus and
   * centre the focused card.
   */
  const revealIndex = (index: number) => {
    listRef.current?.scrollToIndex({
      index,
      animated: true,
      viewPosition: 0.5,
    });
  };

  return (
    <View style={styles.row}>
      {title ? <Text style={styles.heading}>{title}</Text> : null}
      <FlatList
        ref={listRef}
        horizontal
        data={playlists}
        keyExtractor={(playlist) => playlist.playlistId}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        // TV focus can only land on an attached view. With clipping on, the
        // card just off the viewport edge isn't focusable yet, so the first
        // D-pad press only scrolls it in and a second is needed to select.
        removeClippedSubviews={false}
        initialNumToRender={8}
        windowSize={9}
        ItemSeparatorComponent={Separator}
        renderItem={({ item, index }) => (
          <PlaylistCard
            playlist={item}
            onPress={onSelect}
            onFocusChange={(focused) => {
              if (focused) revealIndex(index);
            }}
          />
        )}
        onScrollToIndexFailed={() => {}}
        getItemLayout={(_, index) => ({
          length: PLAYLIST_CARD_WIDTH + spacing.md,
          offset: (PLAYLIST_CARD_WIDTH + spacing.md) * index,
          index,
        })}
      />
    </View>
  );
}

function Separator() {
  return <View style={{ width: spacing.md }} />;
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm, overflow: "visible" },
  listContent: {
    paddingVertical: 6,
    paddingHorizontal: 3,
  },
  heading: {
    color: colors.foreground,
    fontSize: fontSize.lg,
    fontWeight: "700",
  },
});
