import type { UnifiedVideo } from "@web/server/services/proxy.types";
import { memo, useCallback, useRef } from "react";
import {
  FlatList,
  type ListRenderItem,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { VIDEO_CARD_WIDTH, VideoCard } from "@/components/VideoCard";
import { colors, fontSize, spacing } from "@/theme";

type Props = {
  title?: string;
  videos: UnifiedVideo[];
  onSelect: (videoId: string) => void;
  /** Focus the first card of this row when the content area first gains focus. */
  preferFirstFocus?: boolean;
  /** Bubbles card focus so a parent can bring the row fully into view. */
  onCardFocusChange?: (focused: boolean) => void;
};

/**
 * A D-pad horizontally-scrollable row of video cards (optionally titled).
 * FlatList keeps long upstream feeds virtualized, and TV focus naturally scrolls
 * the row as the user moves right past the viewport edge.
 *
 * Memoized, with callbacks routed through refs so every card receives the same
 * function identities across renders — otherwise each parent render would
 * re-render every card in every row.
 */
export const VideoRow = memo(function VideoRow({
  title,
  videos,
  onSelect,
  preferFirstFocus,
  onCardFocusChange,
}: Props) {
  const listRef = useRef<FlatList<UnifiedVideo>>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCardFocusChangeRef = useRef(onCardFocusChange);
  onCardFocusChangeRef.current = onCardFocusChange;

  const handlePress = useCallback(
    (videoId: string) => onSelectRef.current(videoId),
    [],
  );

  /**
   * TV focus can move to a card outside the viewport without the list
   * scrolling, so the card lands off screen. Drive the scroll from focus and
   * centre the focused card.
   */
  const handleFocusChange = useCallback((focused: boolean, index: number) => {
    if (focused) {
      listRef.current?.scrollToIndex({
        index,
        animated: true,
        viewPosition: 0.5,
      });
    }
    onCardFocusChangeRef.current?.(focused);
  }, []);

  const renderItem = useCallback<ListRenderItem<UnifiedVideo>>(
    ({ item, index }) => (
      <VideoCard
        video={item}
        index={index}
        onPress={handlePress}
        hasTVPreferredFocus={preferFirstFocus && index === 0}
        onFocusChange={handleFocusChange}
      />
    ),
    [handlePress, handleFocusChange, preferFirstFocus],
  );

  return (
    <View style={styles.row}>
      {title ? <Text style={styles.heading}>{title}</Text> : null}
      <FlatList
        ref={listRef}
        horizontal
        data={videos}
        keyExtractor={keyExtractor}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        // TV focus can only land on an attached view. With clipping on, the
        // card just off the viewport edge isn't focusable yet, so the first
        // D-pad press only scrolls it in and a second is needed to select.
        removeClippedSubviews={false}
        initialNumToRender={8}
        windowSize={9}
        ItemSeparatorComponent={Separator}
        renderItem={renderItem}
        onScrollToIndexFailed={ignore}
        getItemLayout={getItemLayout}
      />
    </View>
  );
});

const ITEM_LENGTH = VIDEO_CARD_WIDTH + spacing.md;

function keyExtractor(video: UnifiedVideo) {
  return video.videoId;
}

function getItemLayout(_: unknown, index: number) {
  return { length: ITEM_LENGTH, offset: ITEM_LENGTH * index, index };
}

function ignore() {}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm, overflow: "visible" },
  listContent: {
    paddingVertical: 6,
    paddingHorizontal: 3,
  },
  separator: { width: spacing.md },
  heading: {
    color: colors.foreground,
    fontSize: fontSize.lg,
    fontWeight: "700",
  },
});
