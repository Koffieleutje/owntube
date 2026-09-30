import { useState } from "react";
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  channelInitial,
  formatSubscribersLabel,
  sizedAvatarUrl,
} from "@/lib/format";
import { colors, focus, fontSize, spacing } from "@/theme";

export type ChannelTileData = {
  channelId: string;
  name: string;
  avatarUrl?: string | null;
  subscriberCount?: number | null;
};

const TILE_WIDTH = 150;
const AVATAR = 96;

/**
 * A horizontal row of channels (round avatar, name, subscribers) — search
 * results and a channel's "Similar" tab. OK opens the channel.
 */
export function ChannelTiles({
  title,
  channels,
  onSelect,
  preferFirstFocus,
}: {
  title?: string;
  channels: ChannelTileData[];
  onSelect: (channelId: string) => void;
  preferFirstFocus?: boolean;
}) {
  return (
    <View style={styles.row}>
      {title ? <Text style={styles.heading}>{title}</Text> : null}
      <FlatList
        horizontal
        data={channels}
        keyExtractor={(c) => c.channelId}
        showsHorizontalScrollIndicator={false}
        removeClippedSubviews={false}
        contentContainerStyle={styles.list}
        renderItem={({ item, index }) => (
          <ChannelTile
            channel={item}
            onPress={() => onSelect(item.channelId)}
            hasTVPreferredFocus={preferFirstFocus && index === 0}
          />
        )}
      />
    </View>
  );
}

function ChannelTile({
  channel,
  onPress,
  hasTVPreferredFocus,
}: {
  channel: ChannelTileData;
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const subscribers = formatSubscribersLabel(
    channel.subscriberCount ?? undefined,
  );
  return (
    <Pressable
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      style={[styles.tile, focused && styles.tileFocused]}
    >
      {channel.avatarUrl ? (
        <Image
          source={{ uri: sizedAvatarUrl(channel.avatarUrl, AVATAR) }}
          style={styles.avatar}
          resizeMethod="resize"
        />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Text style={styles.initial}>{channelInitial(channel.name)}</Text>
        </View>
      )}
      <Text style={styles.name} numberOfLines={2}>
        {channel.name}
      </Text>
      {subscribers ? (
        <Text style={styles.subs} numberOfLines={1}>
          {subscribers}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm },
  heading: {
    color: colors.foreground,
    fontSize: fontSize.lg,
    fontWeight: "700",
  },
  list: { gap: spacing.md, paddingVertical: 6, paddingHorizontal: 3 },
  tile: {
    width: TILE_WIDTH,
    alignItems: "center",
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: 16,
    borderWidth: focus.borderWidth,
    borderColor: "transparent",
  },
  tileFocused: {
    borderColor: colors.ring,
    backgroundColor: colors.card,
    transform: [{ scale: focus.scale }],
  },
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    backgroundColor: colors.muted,
  },
  avatarFallback: { alignItems: "center", justifyContent: "center" },
  initial: {
    color: colors.foreground,
    fontSize: fontSize.xl,
    fontWeight: "800",
  },
  name: {
    color: colors.foreground,
    fontSize: fontSize.sm,
    fontWeight: "600",
    textAlign: "center",
  },
  subs: { color: colors.mutedForeground, fontSize: 12 },
});
