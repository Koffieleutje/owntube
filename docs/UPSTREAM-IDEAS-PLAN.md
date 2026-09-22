# Ideas from upstream (JasonBeucher/owntube) worth adopting

Status: **plan only.** Written 2026-09-22 from a review of the two upstream
commits since our fork point `3c8865b`:

- `c2d69e5` feat: add friend sharing and expand the TV experience (102 files)
- `f5d09cc` perf(home): accélérer le chargement du flux d'accueil

Neither commit merges: `git apply --check` fails on most files, our TV app
plays through server DASH (upstream still uses HLS / muxed / split A+V), and
our settings, proxy boundary and home feed were reworked. So everything here
is a port by hand, or just an idea.

## Already done

The bug fixes and small perf changes from that review, one commit each:

| commit | what |
|---|---|
| `a4c7171` | settings: partial updates no longer reset omitted settings (Zod 4 `.default().optional()`; upstream fixed only the themes) |
| `fde961d` | auth: a rejected sign-in shows "Invalid credentials." instead of redirecting (`lib/sign-in-result.ts`) |
| `e28df27` | "Don't recommend this channel" also filters `video.related` and the watch sidebar |
| `e9dd3d2` | no `settings.get` from logged-out pages (mini-player / SponsorBlock sync, swipe layer, Shorts) |
| `472dccc` | e2e smoke suite fixed for the current shell; 4/4 against owntube-dev |
| `09f6c3b` | Shorts shelf goes through the shelf path, never blocks on a thin or expired cache; warmer warms the key the shelf reads |
| `9fcc0aa` | recommendation pools: an in-flight rebuild can no longer undo an invalidation (like / block) |
| `b9ffe15` | no viewport prefetch on video card links |
| `9c5e355` | home stream: expired row answers while it recomputes (our alternative to upstream's persistent pool + polling) |
| TV phase 3 work | TV watch progress: position saved on leaving, real watched time, `channelName` (upstream `use-watch-progress.ts`, as `record-watch-progress.ts`) |

## TV ideas

Mapped onto `TV-PARITY-PLAN.md`. Upstream file paths are under `apps/tv/src/`
on `upstream/main` (`git show upstream/main:apps/tv/src/…`).

| idea | upstream source | our phase | state |
|---|---|---|---|
| Keep visited screens mounted (focus + scroll survive Back; player stays mounted under a channel page, paused via an `active` prop) | `components/Shell.tsx` (`ScreenLayer`, `TVFocusGuideView`) | 3 | **done** — `Shell.tsx` layers + `lib/screen-active.tsx`; Shorts and Settings still mount only while shown |
| Recent searches + suggestion chips | `lib/recent-searches.ts`, `screens/SearchScreen.tsx` | 3 | **done** (phase 3, `61a2d66`) |
| Server URL set on the device, no rebuild | `lib/config.ts` (placeholder origin rewritten in a `fetch` wrapper, URL in SecureStore) | 4 | **done** (phase 4, `9c9dadf`) |
| Hero thumbnail fallback maxres → hq720 → hq on `onError` | `lib/hero-thumbnail-url.ts`, `components/HomeHero.tsx` | 3 | **done** — `heroThumbnailUrls` in `lib/format.ts` |
| Retry button on every error state | `lib/use-infinite-feed.ts`, screens | 3 | **done** — `InfiniteFeed.retry` + Retry on `CarouselFeed`'s error state |
| Dim watched cards | `components/VideoCard.tsx` | 3 | **done** — finished cards' thumbnails at 45% until focused |
| Channel Videos / Shorts tabs + Subscribe | `screens/ChannelScreen.tsx` | 3 | covered by our phase 3 channel tabs |
| Library: Saved + Liked + playlists on one screen | `screens/LibraryScreen.tsx` | 3 | Saved **done** (phase 3); Liked still needs `interactions.list` (see web below) |
| Shorts pager (D-pad up/down, `markSeen`, prefetch next) | `screens/ShortsScreen.tsx` | 6 | **done** (phase 6, `bd11f86`: DASH pager + `markSeen`) |
| Read-only top comments under the player | `components/player-comments.tsx` | 6 | **done** (phase 6: `DetailsPanel` description + comments tabs) |

**Skip** upstream's player internals: `playback-options.ts`,
`player-quality-menu`, `player-progress-bar`, `player-up-next`,
`player-actions`, `use-resume-progress` / `history.resumePositions`. Ours
(phase 1–2, `MenuPanel`, `UpNext`, `history.progressAll`) are supersets built
on server DASH.

## Web / server ideas

| idea | upstream source | effort | notes |
|---|---|---|---|
| Friends + video sharing (friendships, share to friends, inbox, unseen badge, read receipts) | `routers/friends.ts`, `components/friends/*`, migration `0007_friends.sql` | medium (~1.2k lines) | **Product call** — only useful with several users on the instance. Renumber to our next migration (`0021_…`; upstream's `0007` clashes with our `0007_watch_queue`). Card-menu and watch-page hooks need adapting (`app/watch/page.tsx`, reworked `video-card-actions-menu`). |
| Split-stream audio without clicks: pause audio while seeking, hard-align only while paused, soft rate nudges while playing | `lib/companion-audio-sync.ts`, `player/split-block.tsx`, `player/player-adapters.ts` | small (sync lib) / medium (split-block) | Only matters for the progressive fallback; DASH/SABR is primary. Borrow the approach, don't copy — our split-block diverged. |
| `interactions.list` + denormalized titles on interactions and playlist items | migration `0009_interaction_playlist_titles.sql`, `routers/interactions.ts`, `routers/playlists.ts` | small | Needed for a TV Liked list. We already have `interactions.title` (0008); add `channel_name` there and `video_title` / `channel_name` on `playlist_items` under our own names. |
| Warmer refreshes channel pages it touches (`bypassChannelCache: true`) | `scripts/warm-cache.ts` | one line | Trade-off: ~96 channel fetches every 20 min instead of every 45–60. Less needed now that the home stream serves stale while recomputing. |
| Chapters parsed server-side into `video.detail` | `services/proxy/normalize.ts` | small | Low value: web and TV already parse chapters client-side (`lib/video-chapters.ts`). |

**Skip:** Aurora theme and branding refresh (cosmetic, `globals.css`
diverged), onboarding and settings-panel redesigns (heavy conflicts),
Piped caption mapper (we're Invidious-only), landing page, `.codex` hooks,
the accidentally committed `logs/recommendation-debug.ndjson`.

## Found along the way (not from upstream)

- **Blocks / dislikes vs the materialized home row** — done: the
  `home-feed:v1:*` row is never invalidated server-side (the client patches
  its own cache), so a reload could still show a channel blocked or a video
  disliked / "not interested" since the row was written. `getHomeStream` now
  filters cached rows against the current exclusions on every read, rather
  than invalidating (which would make most loads block on a recompute again,
  since likes and watches clear the pools constantly).
- **`subscriptions.mergedFeedInfinite` output type** — done (`dd4e356`).
