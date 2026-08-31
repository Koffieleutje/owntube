import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { VIDEO_CARD_WIDTH } from "@/components/VideoCard";
import { colors, focus, fontSize, radius, spacing } from "@/theme";

// Matches VideoCard exactly, so a playlist row and a video row line up.
const COVER_WIDTH = 264;
const COVER_HEIGHT = 148;

export type ChannelPlaylist = {
  playlistId: string;
  title: string;
  videoCount: number | null;
};

/**
 * A channel's playlist as a card sized like a video card.
 *
 * No artwork on purpose. Invidious hands back the playlist's cover as a raw
 * `i.ytimg.com/pl_c/…` URL, and unlike `/vi/…` it will not proxy that path
 * (verified: 404). Rendering it directly would make the TV box talk to Google,
 * which is exactly what routing thumbnails through the instance avoids. A
 * drawn cover keeps the row honest until the server can serve that image.
 */
export function PlaylistCard({
  playlist,
  onPress,
  hasTVPreferredFocus,
  onFocusChange,
}: {
  playlist: ChannelPlaylist;
  onPress: (playlist: ChannelPlaylist) => void;
  hasTVPreferredFocus?: boolean;
  /** Lets a parent react to focus, e.g. to scroll the card into view. */
  onFocusChange?: (focused: boolean) => void;
}) {
  const [focused, setFocused] = useState(false);
  const count =
    playlist.videoCount === null
      ? null
      : `${playlist.videoCount} ${playlist.videoCount === 1 ? "video" : "videos"}`;

  return (
    <Pressable
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={() => {
        setFocused(true);
        onFocusChange?.(true);
      }}
      onBlur={() => {
        setFocused(false);
        onFocusChange?.(false);
      }}
      onPress={() => onPress(playlist)}
      style={[styles.card, focused && styles.cardFocused]}
    >
      <View style={[styles.cover, focused && styles.coverFocused]}>
        {/* Two offset slabs behind the face read as a stack of videos. */}
        <View style={[styles.slab, styles.slabBack]} pointerEvents="none" />
        <View style={[styles.slab, styles.slabMid]} pointerEvents="none" />
        <View style={styles.coverFace}>
          <Feather
            name={focused ? "play" : "list"}
            size={30}
            color={focused ? colors.primaryForeground : colors.mutedForeground}
          />
          {count ? <Text style={styles.coverCount}>{count}</Text> : null}
        </View>
      </View>
      <Text
        style={[styles.title, focused && styles.titleFocused]}
        numberOfLines={2}
      >
        {playlist.title}
      </Text>
    </Pressable>
  );
}

export const PLAYLIST_CARD_WIDTH = VIDEO_CARD_WIDTH;

const styles = StyleSheet.create({
  card: {
    width: VIDEO_CARD_WIDTH,
    padding: 8,
    borderRadius: radius.card,
    borderWidth: focus.borderWidth,
    borderColor: "transparent",
    backgroundColor: "transparent",
  },
  cardFocused: {
    backgroundColor: colors.card,
    borderColor: colors.ring,
    shadowColor: colors.brand,
    shadowOpacity: focus.shadowOpacity,
    shadowRadius: focus.shadowRadius,
    shadowOffset: focus.shadowOffset,
    elevation: focus.elevation,
    transform: [{ scale: focus.scale }],
  },
  cover: {
    width: COVER_WIDTH,
    height: COVER_HEIGHT,
    justifyContent: "flex-end",
  },
  coverFocused: {},
  slab: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 10,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    backgroundColor: colors.muted,
  },
  slabBack: { top: 0, marginHorizontal: 22 },
  slabMid: { top: 7, marginHorizontal: 11 },
  coverFace: {
    height: COVER_HEIGHT - 14,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    backgroundColor: colors.surface,
  },
  coverCount: {
    color: colors.mutedForeground,
    fontSize: fontSize.sm,
    fontWeight: "600",
  },
  title: {
    color: colors.foreground,
    fontSize: fontSize.sm,
    fontWeight: "600",
    lineHeight: 18,
    marginTop: spacing.sm,
  },
  titleFocused: { color: colors.primary },
});
