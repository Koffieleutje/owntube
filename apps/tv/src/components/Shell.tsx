import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, BackHandler, Linking, StyleSheet, View } from "react-native";
import {
  EXPANDED_WIDTH,
  RAIL_WIDTH,
  type Section,
  Sidebar,
} from "@/components/Sidebar";
import type { Nav } from "@/lib/navigation";
import { loadSidebarPrefs } from "@/lib/sidebar-prefs";
import { useResumeLookup, useWatchProgressRefresh } from "@/lib/watch-progress";
import { ChannelScreen } from "@/screens/ChannelScreen";
import { HistoryScreen } from "@/screens/HistoryScreen";
import { HomeScreen } from "@/screens/HomeScreen";
import { PlaylistsScreen } from "@/screens/PlaylistsScreen";
import { QueueScreen } from "@/screens/QueueScreen";
import { RecommendedScreen } from "@/screens/RecommendedScreen";
import { SearchScreen } from "@/screens/SearchScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { SubscriptionsScreen } from "@/screens/SubscriptionsScreen";
import { WatchScreen } from "@/screens/WatchScreen";
import { colors, spacing } from "@/theme";

/**
 * 10-foot app shell: a left nav over section screens, plus a small route stack
 * for watch/channel overlays. No navigation library — a section is the base and
 * watch/channel push onto a stack that remote Back pops (exits at the root).
 */
type Route =
  | { name: "watch"; videoId: string; resumeSeconds?: number }
  | { name: "channel"; channelId: string };

const SIDEBAR_ANIM_MS = 140;

export function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [section, setSection] = useState<Section>("home");
  const [stack, setStack] = useState<Route[]>([]);
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);
  const [sections, setSections] = useState<Section[] | undefined>(undefined);
  /**
   * The rail overlays the screen, so an expanded rail used to cover the content
   * beside it — most visibly the Subscriptions channel list. Shift the content
   * by the same amount instead, so both stay fully visible.
   */
  // Two values, because one cannot be driven by both drivers at once. The
  // rail's width is a layout prop and has to stay on the JS driver, but that
  // view is eight rows — cheap to relayout. The content is the whole screen
  // (every feed and its cards), so it moves with a transform instead: no
  // layout pass, and the animation runs on the UI thread. Same duration keeps
  // them visually locked together.
  const railWidth = useRef(new Animated.Value(RAIL_WIDTH)).current;
  const contentShift = useRef(new Animated.Value(0)).current;
  const onSidebarExpanded = useCallback(
    (expanded: boolean) => {
      // One value drives both the rail's width and the content's inset, so
      // they can never be mid-animation at different widths.
      Animated.parallel([
        Animated.timing(railWidth, {
          toValue: expanded ? EXPANDED_WIDTH : RAIL_WIDTH,
          duration: SIDEBAR_ANIM_MS,
          useNativeDriver: false,
        }),
        Animated.timing(contentShift, {
          toValue: expanded ? EXPANDED_WIDTH - RAIL_WIDTH : 0,
          duration: SIDEBAR_ANIM_MS,
          useNativeDriver: true,
        }),
      ]).start();
    },
    [railWidth, contentShift],
  );

  useEffect(() => {
    loadSidebarPrefs().then((prefs) => setSections(prefs.order));
  }, []);
  const top = stack[stack.length - 1];

  const lookupResume = useResumeLookup();
  const refreshProgress = useWatchProgressRefresh();

  const nav: Nav = useMemo(
    () => ({
      // Callers that know a position (History) pass one; everything else
      // resumes from the stored watch position, like the web app.
      openVideo: (videoId, resumeSeconds) =>
        setStack((s) => [
          ...s,
          {
            name: "watch",
            videoId,
            resumeSeconds: resumeSeconds ?? lookupResume(videoId),
          },
        ]),
      openChannel: (channelId) =>
        setStack((s) => [...s, { name: "channel", channelId }]),
    }),
    [lookupResume],
  );

  /**
   * Choosing a section has to drop any watch/channel overlay: the overlay wins
   * over `section` when rendering, so without this the sidebar appears dead
   * while a channel page is open.
   */
  const selectSection = useCallback(
    (next: Section) => {
      setSection(next);
      setStack([]);
      refreshProgress();
    },
    [refreshProgress],
  );

  const pop = useCallback(() => {
    setStack((s) => s.slice(0, -1));
    refreshProgress();
  }, [refreshProgress]);

  /**
   * System voice search arrives as `owntube://search?q=…` — MainActivity
   * rewrites Android's ACTION_SEARCH into that URL (see plugins/with-tv-search)
   * because React Native surfaces deep links but not intent extras.
   */
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      const match = /^owntube:\/\/search\?q=(.*)$/.exec(url);
      if (!match) return;
      setSearchQuery(decodeURIComponent(match[1] ?? ""));
      setSection("search");
      setStack([]);
    };
    Linking.getInitialURL()
      .then(handle)
      .catch(() => {});
    const sub = Linking.addEventListener("url", (event) => handle(event.url));
    return () => sub.remove();
  }, []);

  /**
   * Back unwinds one step at a time, innermost first. Screens that hold their
   * own transient state (the player's controls, the subscriptions tag submenu)
   * register their own handler and consume the press before this runs — React
   * Native invokes handlers in reverse registration order, so a mounted screen
   * is always asked first.
   *
   * Here that leaves: overlay (watch/channel) → section → Home → exit. Leaving
   * from a section via Home rather than straight out means Back is never one
   * press away from quitting except at the top level.
   */
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (stack.length > 0) {
        pop();
        return true;
      }
      if (section !== "home") {
        setSection("home");
        return true;
      }
      BackHandler.exitApp();
      return true;
    });
    return () => sub.remove();
  }, [stack.length, pop, section]);

  if (top?.name === "watch") {
    return (
      <WatchScreen
        videoId={top.videoId}
        resumeSeconds={top.resumeSeconds}
        onOpenVideo={nav.openVideo}
        onOpenChannel={nav.openChannel}
        onBack={pop}
      />
    );
  }
  const body =
    top?.name === "channel" ? (
      <ChannelScreen channelId={top.channelId} nav={nav} />
    ) : section === "home" ? (
      <HomeScreen nav={nav} />
    ) : section === "search" ? (
      <SearchScreen
        nav={nav}
        initialQuery={searchQuery}
        onQueryChange={setSearchQuery}
      />
    ) : section === "recommended" ? (
      <RecommendedScreen nav={nav} />
    ) : section === "subscriptions" ? (
      <SubscriptionsScreen nav={nav} />
    ) : section === "settings" ? (
      <SettingsScreen onSidebarChange={setSections} onSignOut={onSignOut} />
    ) : section === "playlists" ? (
      <PlaylistsScreen nav={nav} />
    ) : section === "queue" ? (
      <QueueScreen nav={nav} />
    ) : (
      <HistoryScreen nav={nav} />
    );

  // Content reserves the collapsed rail as a left margin; the sidebar overlays
  // the content (absolute) and expands rightward over it when focused.
  return (
    <View style={styles.shell}>
      <Animated.View
        style={[styles.content, { transform: [{ translateX: contentShift }] }]}
      >
        {body}
      </Animated.View>
      <Sidebar
        active={section}
        onSelect={selectSection}
        sections={sections}
        onExpandedChange={onSidebarExpanded}
        width={railWidth}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.background },
  content: {
    flex: 1,
    // Static now that the expansion is a transform; the rail never overlaps.
    marginLeft: RAIL_WIDTH,
    paddingVertical: spacing.screen,
    paddingRight: spacing.screen,
    paddingLeft: spacing.lg,
  },
});
