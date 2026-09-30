import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { colors, focus, fontSize, radius, spacing } from "@/theme";

/**
 * The search field pinned above Home's rows, as on the YouTube TV client: it
 * looks like the Search page's bar but only opens that page, so the keyboard
 * and the microphone stay where the results are. One press Up from the hero
 * and OK reaches search without a trip to the rail.
 */
export function SearchBar({
  onPress,
  onFocusChange,
}: {
  onPress: () => void;
  /** Lets the page scroll the bar back into view when it takes focus. */
  onFocusChange?: (focused: boolean) => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      onFocus={() => {
        setFocused(true);
        onFocusChange?.(true);
      }}
      onBlur={() => {
        setFocused(false);
        onFocusChange?.(false);
      }}
      onPress={onPress}
      style={[styles.bar, focused && styles.barFocused]}
    >
      <Feather
        name="search"
        size={22}
        color={focused ? colors.foreground : colors.mutedForeground}
      />
      <Text
        style={[styles.placeholder, focused && styles.placeholderFocused]}
        numberOfLines={1}
      >
        Search videos and channels
      </Text>
      <Feather name="mic" size={20} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.shell,
    backgroundColor: colors.surface,
    borderWidth: focus.borderWidth,
    borderColor: colors.surfaceBorder,
  },
  // The same ring the Search page's own bar draws (see FocusableTextInput).
  barFocused: {
    borderColor: colors.ring,
    backgroundColor: colors.surfaceStrongSolid,
    shadowColor: colors.brand,
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  placeholder: {
    flex: 1,
    color: colors.mutedForeground,
    fontSize: fontSize.md,
  },
  placeholderFocused: { color: colors.foreground },
});
