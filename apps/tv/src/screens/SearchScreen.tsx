import { Feather } from "@expo/vector-icons";
import {
  ExpoSpeechRecognitionModule,
  isRecognitionAvailable,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { CarouselFeed } from "@/components/CarouselFeed";
import { FocusButton } from "@/components/FocusButton";
import { FocusableTextInput } from "@/components/focusable-text-input";
import type { Nav } from "@/lib/navigation";
import { trpcClient } from "@/lib/trpc";
import { useInfiniteFeed } from "@/lib/use-infinite-feed";
import { colors, focus, fontSize, radius, spacing } from "@/theme";

/**
 * Full-text search. Typing on a TV keyboard is slow, so voice is the primary
 * input: the mic runs Android's recogniser and searches as soon as it settles.
 */
export function SearchScreen({
  nav,
  initialQuery,
}: {
  nav: Nav;
  /** Set when the system hands us a voice search (see plugins/with-tv-search). */
  initialQuery?: string;
}) {
  const [text, setText] = useState(initialQuery ?? "");
  const [query, setQuery] = useState(initialQuery ?? "");
  const [inputFocused, setInputFocused] = useState(false);
  const [listening, setListening] = useState(false);
  // Not every TV ships a recogniser — this box has none — so the in-app mic
  // hides rather than offering a control that can only fail.
  const [micAvailable] = useState(() => {
    try {
      return isRecognitionAvailable();
    } catch {
      return false;
    }
  });
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // Show words as they are recognised, and search once the final result lands.
  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results[0]?.transcript ?? "";
    if (!transcript) return;
    setText(transcript);
    if (event.isFinal) setQuery(transcript.trim());
  });
  useSpeechRecognitionEvent("end", () => setListening(false));
  useSpeechRecognitionEvent("error", (event) => {
    setListening(false);
    setVoiceError(event.message || "Voice search unavailable");
  });

  const startListening = async () => {
    setVoiceError(null);
    const permission =
      await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setVoiceError("Microphone permission denied");
      return;
    }
    setText("");
    setListening(true);
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: true,
      continuous: false,
    });
  };

  const toggleListening = () => {
    if (listening) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    void startListening();
  };

  const feed = useInfiniteFeed<string>(
    (continuation) =>
      query
        ? trpcClient.search.videos
            .query({ q: query, continuation })
            .then((r) => ({
              items: r.videos,
              next: r.continuation ?? undefined,
            }))
        : Promise.resolve({ items: [], next: undefined }),
    [query],
  );

  useEffect(() => {
    if (initialQuery === undefined) return;
    setText(initialQuery);
    setQuery(initialQuery);
  }, [initialQuery]);

  const submit = () => setQuery(text.trim());

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.searchSurface,
          inputFocused && styles.searchSurfaceFocused,
        ]}
      >
        <Feather name="search" size={28} color={colors.mutedForeground} />
        {/* A bare TextInput can't take D-pad focus on Android (ReactEditText
            refuses focus it didn't request), so moving right from the sidebar
            went nowhere. The wrapper gives it a focusable surface. */}
        <FocusableTextInput
          containerStyle={styles.inputSurface}
          inputStyle={styles.input}
          placeholder="Search"
          autoCapitalize="none"
          autoCorrect={false}
          value={text}
          onChangeText={setText}
          onFocusChange={setInputFocused}
          onSubmitEditing={submit}
          returnKeyType="search"
          hasTVPreferredFocus
        />
        {micAvailable ? (
          <FocusButton
            label={listening ? "Listening..." : "Speak"}
            onPress={toggleListening}
            style={listening ? styles.listening : undefined}
          />
        ) : null}
        <FocusButton
          label="Search"
          variant="primary"
          onPress={submit}
          style={styles.searchButton}
        />
      </View>
      <View style={styles.results}>
        <CarouselFeed
          feed={feed}
          onSelect={(videoId) => nav.openVideo(videoId)}
          emptyText={
            voiceError ??
            (query ? "No results." : "Press Speak, or type and press Search.")
          }
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: spacing.lg },
  searchSurface: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 72,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    borderRadius: radius.shell,
    backgroundColor: colors.surface,
    borderWidth: focus.borderWidth,
    borderColor: colors.surfaceBorder,
  },
  searchSurfaceFocused: {
    borderColor: colors.ring,
    backgroundColor: colors.surfaceStrong,
    shadowColor: colors.brand,
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  // The bar draws the focus ring, so the wrapper's own surface stays invisible.
  inputSurface: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    shadowOpacity: 0,
    elevation: 0,
  },
  input: {
    color: colors.foreground,
    fontSize: fontSize.lg,
    paddingVertical: spacing.md,
  },
  listening: { backgroundColor: colors.brandSoft },
  searchButton: { width: 156 },
  results: { flex: 1 },
});
