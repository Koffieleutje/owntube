import type { UnifiedVideo } from "@web/server/services/proxy.types";
import {
  type ComponentRef,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Animated,
  BackHandler,
  Linking,
  type StyleProp,
  StyleSheet,
  TVFocusGuideView,
  View,
  type ViewStyle,
} from "react-native";
import { CardMenuProvider } from "@/components/CardMenu";
import {
  EXPANDED_WIDTH,
  RAIL_WIDTH,
  type Section,
  Sidebar,
} from "@/components/Sidebar";
import { parseDeepLink } from "@/lib/deep-links";
import { useLongSelectDispatcher } from "@/lib/long-press";
import type { Nav, OpenVideoOptions, PlayContext } from "@/lib/navigation";
import { ScreenActiveProvider } from "@/lib/screen-active";
import { loadSidebarPrefs } from "@/lib/sidebar-prefs";
import { trpcClient } from "@/lib/trpc";
import { useTvRemoteReceiver } from "@/lib/tv-remote";
import { useResumeLookup, useWatchProgressRefresh } from "@/lib/watch-progress";
import { ChannelScreen } from "@/screens/ChannelScreen";
import { HistoryScreen } from "@/screens/HistoryScreen";
import { HomeScreen } from "@/screens/HomeScreen";
import { PlaylistsScreen } from "@/screens/PlaylistsScreen";
import { QueueScreen } from "@/screens/QueueScreen";
import { RecommendedScreen } from "@/screens/RecommendedScreen";
import { SavedScreen } from "@/screens/SavedScreen";
import { SearchScreen } from "@/screens/SearchScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { ShortsScreen } from "@/screens/ShortsScreen";
import { SubscriptionsScreen } from "@/screens/SubscriptionsScreen";
import { TrendingScreen } from "@/screens/TrendingScreen";
import { WatchScreen } from "@/screens/WatchScreen";
import { colors, spacing } from "@/theme";

/**
 * 10-foot app shell: a left nav over section screens, plus a small route stack
 * for watch/channel overlays. No navigation library — a section is the base and
 * watch/channel push onto a stack that remote Back pops (exits at the root).
 *
 * Visited screens stay **mounted**; only the one in front is shown. Unmounting
 * on every navigation reset the scroll position, the loaded pages and the
 * focused card each time you came back from a video or a channel. Likewise the
 * player stays mounted (paused) under a channel page opened from it, so Back
 * returns to the same frame instead of reloading the video.
 */
type Route =
  | {
      name: "watch";
      key: string;
      videoId: string;
      resumeSeconds?: number;
      context?: PlayContext;
    }
  | { name: "channel"; key: string; channelId: string };

let routeSequence = 0;
const nextRouteKey = () => `route-${++routeSequence}`;

/**
 * Sections kept mounted once visited. Shorts plays video and Settings grabs
 * the remote for its sidebar editor, so those two mount only while shown.
 */
const KEPT_SECTIONS: ReadonlySet<Section> = new Set<Section>([
  "home",
  "search",
  "recommended",
  "saved",
  "trending",
  "subscriptions",
  "playlists",
  "queue",
  "history",
]);

export function Shell({
  onSignOut,
  onChangeServer,
  onSwitchProfile,
}: {
  onSignOut: () => void;
  onChangeServer: () => void;
  onSwitchProfile: () => void;
}) {
  useLongSelectDispatcher();
  const [section, setSection] = useState<Section>("home");
  /** Kept sections visited so far, in first-visit order. */
  const [visited, setVisited] = useState<Section[]>(["home"]);
  useEffect(() => {
    if (!KEPT_SECTIONS.has(section)) return;
    setVisited((v) => (v.includes(section) ? v : [...v, section]));
  }, [section]);
  const [stack, setStack] = useState<Route[]>([]);
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);
  /** The short the Shorts section opens at (from a Shorts row), if any. */
  const [shortsStart, setShortsStart] = useState<UnifiedVideo | undefined>(
    undefined,
  );
  const [sections, setSections] = useState<Section[] | undefined>(undefined);
  /**
   * The rail overlays the screen, so an expanded rail used to cover the content
   * beside it — most visibly the Subscriptions channel list. Shift the content
   * by the same amount instead, so both stay fully visible.
   */
  const contentInset = useRef(new Animated.Value(RAIL_WIDTH)).current;
  const onSidebarExpanded = useCallback(
    (expanded: boolean) => {
      // One value drives both the rail's width and the content's inset, so
      // they can never be at different widths. It jumps rather than animates:
      // a margin can't run on the native driver, and tweening it relaid out
      // the whole screen (every mounted shelf and card) on each frame, which
      // stalled the JS thread and made the D-pad feel sticky at the rail.
      contentInset.setValue(expanded ? EXPANDED_WIDTH : RAIL_WIDTH);
    },
    [contentInset],
  );

  useEffect(() => {
    loadSidebarPrefs().then((prefs) => setSections(prefs.order));
  }, []);
  const top = stack[stack.length - 1];

  const lookupResume = useResumeLookup();
  const refreshProgress = useWatchProgressRefresh();

  // Callers that know a position (History) pass one; everything else
  // resumes from the stored watch position, like the web app.
  const watchRoute = useCallback(
    (videoId: string, options?: OpenVideoOptions): Route => ({
      name: "watch",
      key: nextRouteKey(),
      videoId,
      resumeSeconds: options?.resumeSeconds ?? lookupResume(videoId),
      context: options?.context,
    }),
    [lookupResume],
  );

  /**
   * Next/previous within a play context swaps the video in place, so Back
   * still returns to wherever playback started rather than stepping back
   * through every video watched since.
   */
  const replaceVideo = useCallback(
    (videoId: string, options?: OpenVideoOptions) => {
      setStack((s) => [...s.slice(0, -1), watchRoute(videoId, options)]);
    },
    [watchRoute],
  );

  const nav: Nav = useMemo(
    () => ({
      openVideo: (videoId, options) =>
        setStack((s) => [...s, watchRoute(videoId, options)]),
      openChannel: (channelId) =>
        setStack((s) => [
          ...s,
          { name: "channel", key: nextRouteKey(), channelId },
        ]),
      openShorts: (start) => {
        setShortsStart(start);
        setSection("shorts");
        setStack([]);
      },
    }),
    [watchRoute],
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
   * A video arriving from outside (a deep link, Play on TV) replaces the one
   * playing, or opens over whatever is on screen.
   */
  const topRef = useRef(top);
  topRef.current = top;
  const playFromOutside = useCallback(
    (videoId: string, resumeSeconds?: number) => {
      if (topRef.current?.name === "watch") {
        replaceVideo(videoId, { resumeSeconds });
      } else {
        nav.openVideo(videoId, { resumeSeconds });
      }
    },
    [nav, replaceVideo],
  );
  useTvRemoteReceiver(playFromOutside);

  /**
   * Deep links: owntube:// URLs (the Android TV home screen's Watch Next row,
   * system voice search — MainActivity rewrites ACTION_SEARCH into
   * `owntube://search?q=…`, see plugins/with-tv-search) and the YouTube URLs
   * the "Open with" chooser hands over. See lib/deep-links.
   */
  const handleLinkRef = useRef<(url: string | null) => void>(() => {});
  handleLinkRef.current = (url: string | null) => {
    const link = url ? parseDeepLink(url) : null;
    if (!link) return;
    switch (link.kind) {
      case "search":
        setSearchQuery(link.query);
        setSection("search");
        setStack([]);
        return;
      case "watch":
        playFromOutside(link.videoId, link.startSeconds);
        return;
      case "channel":
        nav.openChannel(link.channelId);
        return;
      case "playlist":
        trpcClient.channel.ytPlaylist
          .query({ playlistId: link.playlistId })
          .then((playlist) => {
            const first = playlist.videos[0];
            if (!first) return;
            nav.openVideo(first.videoId, {
              context: {
                source: "playlist",
                label: playlist.title,
                videos: playlist.videos,
              },
            });
          })
          .catch(() => {});
        return;
    }
  };
  // Once: the launch URL must not be handled again on a re-render.
  useEffect(() => {
    const handle = (url: string | null) => handleLinkRef.current(url);
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
  //
  // Registered once, reading state through refs: re-registering on every stack
  // change made this the newest handler — after the watch screen's own, which
  // registers as it mounts — so Back skipped the player's dismiss-controls step.
  const backStateRef = useRef({ depth: stack.length, section, pop });
  backStateRef.current = { depth: stack.length, section, pop };
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      const { depth, section, pop } = backStateRef.current;
      if (depth > 0) {
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
  }, []);

  // Only the newest watch route keeps a player; an older one (under a channel
  // that opened another video) remounts when Back reaches it again.
  let playerRoute: Extract<Route, { name: "watch" }> | undefined;
  let channelRoute: Extract<Route, { name: "channel" }> | undefined;
  for (const route of stack) {
    if (route.name === "watch") playerRoute = route;
    else channelRoute = route;
  }
  const watchActive = top?.name === "watch";
  // A player survives under a channel page only if it was on screen when the
  // page opened; a route uncovered by Back (its player already gone) loads
  // again when it reaches the front, not hidden behind the page.
  const shownPlayerKey = useRef<string | undefined>(undefined);
  if (watchActive) shownPlayerKey.current = playerRoute?.key;
  const keptPlayer =
    playerRoute && playerRoute.key === shownPlayerKey.current
      ? playerRoute
      : undefined;
  /** A channel page covers the sections, even under a player opened from it. */
  const channelShown = channelRoute !== undefined;

  const renderSection = (key: Section): ReactNode => {
    switch (key) {
      case "home":
        return <HomeScreen nav={nav} />;
      case "search":
        return <SearchScreen nav={nav} initialQuery={searchQuery} />;
      case "recommended":
        return <RecommendedScreen nav={nav} />;
      case "saved":
        return <SavedScreen nav={nav} />;
      case "trending":
        return <TrendingScreen nav={nav} />;
      case "shorts":
        return (
          <ShortsScreen
            key={shortsStart?.videoId ?? "shorts"}
            startVideo={shortsStart}
          />
        );
      case "subscriptions":
        return <SubscriptionsScreen nav={nav} />;
      case "settings":
        return (
          <SettingsScreen
            onSidebarChange={setSections}
            onSignOut={onSignOut}
            onChangeServer={onChangeServer}
            onSwitchProfile={onSwitchProfile}
          />
        );
      case "playlists":
        return <PlaylistsScreen nav={nav} />;
      case "queue":
        return <QueueScreen nav={nav} />;
      default:
        return <HistoryScreen nav={nav} />;
    }
  };

  // A section that isn't kept mounts only while it is the one in front, so
  // Shorts' player stops as soon as anything covers it. A kept section joins
  // the layers on this render already, before the effect records the visit.
  const sectionMounted = KEPT_SECTIONS.has(section) || stack.length === 0;
  const sectionLayers =
    sectionMounted && !visited.includes(section)
      ? [...visited, section]
      : visited;

  // Content reserves the collapsed rail as a left margin; the sidebar overlays
  // the content (absolute) and expands rightward over it when focused.
  return (
    <View style={styles.shell}>
      {/* Stays laid out under the player: hiding it would re-lay out every
          shelf and lose their scroll offsets. Blocking focus is enough — the
          player covers it opaquely. */}
      <TVFocusGuideView autoFocus focusable={!watchActive} style={styles.base}>
        <CardMenuProvider nav={nav}>
          <View style={styles.base}>
            <Animated.View
              style={[styles.content, { marginLeft: contentInset }]}
            >
              {sectionLayers.map((key) => {
                const visible = key === section && !channelShown;
                return (
                  <ScreenLayer
                    key={key}
                    visible={visible}
                    focused={visible && !watchActive}
                  >
                    {renderSection(key)}
                  </ScreenLayer>
                );
              })}
              {stack.map((route) => {
                if (route.name !== "channel") return null;
                const visible = route.key === channelRoute?.key;
                return (
                  <ScreenLayer
                    key={route.key}
                    visible={visible}
                    focused={visible && !watchActive}
                  >
                    <ChannelScreen channelId={route.channelId} nav={nav} />
                  </ScreenLayer>
                );
              })}
            </Animated.View>
            <Sidebar
              active={section}
              onSelect={selectSection}
              sections={sections}
              onExpandedChange={onSidebarExpanded}
              width={contentInset}
            />
          </View>
        </CardMenuProvider>
      </TVFocusGuideView>

      {keptPlayer ? (
        <ScreenLayer
          visible={watchActive}
          focused={watchActive}
          style={styles.watchLayer}
        >
          {/* Keyed per route so each video gets a fresh player and state: its
              predecessor's unmount records that video's progress. */}
          <WatchScreen
            key={keptPlayer.key}
            videoId={keptPlayer.videoId}
            resumeSeconds={keptPlayer.resumeSeconds}
            context={keptPlayer.context}
            active={watchActive}
            onOpenVideo={nav.openVideo}
            onReplaceVideo={replaceVideo}
            onOpenChannel={nav.openChannel}
            onBack={pop}
          />
        </ScreenLayer>
      ) : null}
    </View>
  );
}

/**
 * One screen kept mounted in the background. Hidden layers are
 * `display: none`, which also keeps them out of D-pad focus search. The focus
 * guide's `autoFocus` remembers the view last focused inside it; asking it to
 * take focus when the layer comes back to the front hands focus straight back
 * to that card — the focus memory, with no bookkeeping of our own.
 */
function ScreenLayer({
  visible,
  focused,
  style,
  children,
}: {
  /** Laid out and drawn. */
  visible: boolean;
  /** In front and allowed to hold focus; reclaims it when this turns true. */
  focused: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const guideRef = useRef<ComponentRef<typeof TVFocusGuideView>>(null);

  // Showing a layer again doesn't move Android's focus by itself. A tick
  // later, once the native display change has landed, the guide redirects to
  // the child the user last had focused. Not on first show: screens pick their
  // own starting focus (hasTVPreferredFocus), as they did before layers.
  const shownBefore = useRef(false);
  useEffect(() => {
    if (!focused) return;
    if (!shownBefore.current) {
      shownBefore.current = true;
      return;
    }
    const timer = setTimeout(() => guideRef.current?.requestTVFocus?.(), 0);
    return () => clearTimeout(timer);
  }, [focused]);

  // Visibility goes on the wrapper, never the guide: re-applying the guide's
  // props clears its remembered child, which is the whole point of it.
  return (
    <View style={[style ?? styles.layer, !visible && styles.hidden]}>
      <TVFocusGuideView ref={guideRef} autoFocus style={styles.layer}>
        <ScreenActiveProvider active={focused}>{children}</ScreenActiveProvider>
      </TVFocusGuideView>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.background },
  base: { flex: 1 },
  layer: { flex: 1 },
  hidden: { display: "none" },
  // The player covers the sidebar too, so it sits above the base.
  watchLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    backgroundColor: "#000",
  },
  content: {
    flex: 1,
    paddingVertical: spacing.screen,
    paddingRight: spacing.screen,
    paddingLeft: spacing.lg,
  },
});
