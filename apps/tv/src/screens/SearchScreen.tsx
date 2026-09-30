import { Feather } from "@expo/vector-icons";
import type { UnifiedVideo } from "@web/server/services/proxy.types";
import {
  ExpoSpeechRecognitionModule,
  isRecognitionAvailable,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { CarouselFeed } from "@/components/CarouselFeed";
import { type ChannelTileData, ChannelTiles } from "@/components/ChannelTiles";
import { FocusButton } from "@/components/FocusButton";
import { FocusableTextInput } from "@/components/focusable-text-input";
import type { Nav } from "@/lib/navigation";
import { loadRecentSearches, rememberSearch } from "@/lib/recent-searches";
import { trpcClient } from "@/lib/trpc";
import { trpc } from "@/lib/trpc-react";
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

  // Channels come with the first page only.
  const [channels, setChannels] = useState<ChannelTileData[]>([]);
  const feed = useInfiniteFeed<string>(
    (continuation) =>
      query
        ? trpcClient.search.videos
            .query({ q: query, continuation })
            .then((r) => {
              if (!continuation) {
                setChannels(
                  [...(r.channels ?? [])]
                    .sort(
                      (a, b) =>
                        (b.subscriberCount ?? 0) - (a.subscriberCount ?? 0),
                    )
                    .map((c) => ({
                      channelId: c.channelId,
                      name: c.name,
                      avatarUrl: c.avatarUrl,
                      subscriberCount: c.subscriberCount,
                    })),
                );
              }
              return { items: r.videos, next: r.continuation ?? undefined };
            })
        : Promise.resolve({ items: [], next: undefined }),
    [query],
  );
  useEffect(() => {
    if (!query) setChannels([]);
  }, [query]);

  // Sorted on the client, as the web's search page does.
  const [sort, setSort] = useState<SearchSort>("relevance");
  const sortedVideos = useMemo(
    () => sortVideos(feed.videos, sort),
    [feed.videos, sort],
  );

  // Suggestions follow what's typed (or dictated), a beat after it settles.
  const [suggestFor, setSuggestFor] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSuggestFor(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const suggestions = trpc.search.suggestions.useQuery(
    { q: suggestFor },
    { enabled: suggestFor.length > 1 && suggestFor !== query },
  );

  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    loadRecentSearches().then(setRecent);
  }, []);

  const search = (q: string) => {
    const trimmed = q.trim();
    setVoiceError(null);
    setText(trimmed);
    setQuery(trimmed);
    setSort("relevance");
    if (trimmed) setRecent((r) => rememberSearch(r, trimmed));
  };

  const searchRef = useRef(search);
  searchRef.current = search;
  // A new voice search from the system (see Shell) runs as if typed.
  useEffect(() => {
    if (initialQuery !== undefined) searchRef.current(initialQuery);
  }, [initialQuery]);

  const submit = () => search(text);

  // Under the bar: suggestions while typing, else recent searches when idle.
  const chipWords =
    text.trim() && text.trim() !== query
      ? (suggestions.data?.suggestions ?? []).slice(0, 8)
      : !query
        ? recent
        : [];
  const chipsLabel = text.trim() && text.trim() !== query ? null : "Recent";

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
          onChangeText={(value) => {
            setVoiceError(null);
            setText(value);
          }}
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
      {chipWords.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {chipsLabel ? (
            <Text style={styles.chipsLabel}>{chipsLabel}</Text>
          ) : null}
          {chipWords.map((word) => (
            <FocusButton
              key={word}
              label={word}
              onPress={() => search(word)}
              style={styles.chip}
            />
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.results}>
        <CarouselFeed
          feed={feed}
          videos={sortedVideos}
          onSelect={(videoId, videos) =>
            nav.openVideo(videoId, { context: { source: "feed", videos } })
          }
          header={
            query ? (
              <View style={styles.resultsHeader}>
                <View style={styles.chipsRow}>
                  {SORTS.map(({ key, label }) => (
                    <FocusButton
                      key={key}
                      label={label}
                      variant={sort === key ? "primary" : "ghost"}
                      onPress={() => setSort(key)}
                      style={styles.chip}
                    />
                  ))}
                </View>
                {channels.length > 0 ? (
                  <ChannelTiles
                    title="Channels"
                    channels={channels}
                    onSelect={nav.openChannel}
                  />
                ) : null}
              </View>
            ) : undefined
          }
          emptyText={
            voiceError ??
            (query ? "No results." : "Press Speak, or type and press Search.")
          }
        />
      </View>
    </View>
  );
}

type SearchSort = "relevance" | "newest" | "views";

const SORTS: { key: SearchSort; label: string }[] = [
  { key: "relevance", label: "Relevance" },
  { key: "newest", label: "Newest" },
  { key: "views", label: "Most viewed" },
];

/** The web search page's client-side sorts (app/search/page.tsx). */
function sortVideos(videos: UnifiedVideo[], sort: SearchSort): UnifiedVideo[] {
  if (sort === "relevance") return videos;
  const by =
    sort === "newest"
      ? (v: UnifiedVideo) => v.publishedAt ?? 0
      : (v: UnifiedVideo) => v.viewCount ?? 0;
  return [...videos].sort((a, b) => by(b) - by(a));
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: spacing.lg },
  chips: { gap: spacing.sm, alignItems: "center", paddingVertical: 4 },
  chipsRow: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  chip: { minHeight: 40, paddingHorizontal: spacing.md },
  chipsLabel: { color: colors.mutedForeground, fontSize: fontSize.sm },
  resultsHeader: { gap: spacing.lg },
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
    backgroundColor: colors.surfaceStrongSolid,
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
  // Opaque: the mic button is focused while it listens, so this fill sits
  // under the focus glow. See colors.surfaceStrongSolid.
  listening: { backgroundColor: colors.brandSoftSolid },
  searchButton: { width: 156 },
  results: { flex: 1 },
});
