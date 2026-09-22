import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { LOGO_WORDMARK } from "@/assets";
import { FocusButton } from "@/components/FocusButton";
import { listProfiles, type Profile, switchProfile } from "@/lib/auth-token";
import { colors, fontSize, radius, spacing } from "@/theme";

/**
 * "Who's watching": the TV's signed-in profiles (one paired account each).
 * Shown at start when there is more than one, and from Settings → Switch
 * profile. "Add profile" pairs another account without signing any out.
 */
export function ProfilesScreen({
  onChosen,
  onAdd,
}: {
  onChosen: () => void;
  onAdd: () => void;
}) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);

  useEffect(() => {
    listProfiles().then(setProfiles);
  }, []);

  const choose = async (id: string) => {
    if (await switchProfile(id)) onChosen();
  };

  return (
    <View style={styles.container}>
      <View style={styles.panel}>
        <Image
          source={LOGO_WORDMARK}
          style={styles.wordmark}
          resizeMode="contain"
        />
        <Text style={styles.heading}>Who's watching?</Text>
        <View style={styles.list}>
          {(profiles ?? []).map((profile, index) => (
            <FocusButton
              key={profile.id}
              label={profile.label}
              variant="primary"
              hasTVPreferredFocus={index === 0}
              onPress={() => void choose(profile.id)}
            />
          ))}
          <FocusButton label="Add profile" onPress={onAdd} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
  },
  panel: {
    width: 520,
    gap: spacing.lg,
    padding: spacing.xl,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.surfaceBorder,
    backgroundColor: colors.cardElevated,
  },
  wordmark: { width: 210, height: 46, alignSelf: "center" },
  heading: {
    color: colors.foreground,
    fontSize: fontSize.xl,
    fontWeight: "700",
    textAlign: "center",
  },
  list: { gap: spacing.sm },
});
