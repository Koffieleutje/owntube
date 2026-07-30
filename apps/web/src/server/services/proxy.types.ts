import { z } from "zod";

/**
 * The OwnTube ↔ upstream contract.
 *
 * These schemas are the boundary: everything OwnTube shows comes through them.
 * Each field is tagged with where its value actually comes from, because the
 * point of Phase 3 (see docs/INVIDIOUS-BOUNDARY-PLAN.md) is to shrink one of
 * those categories and it cannot be shrunk if it is invisible.
 *
 *   [upstream]  Read from an Invidious field, more or less as-is. The good case.
 *   [derived]   Computed by OwnTube from upstream data — a selection from a list,
 *               a normalisation, a unit change. Deterministic, not a guess.
 *   [inferred]  OwnTube guessing where upstream gives no answer. **This is the
 *               surface to shrink.** Every entry here can break silently when
 *               YouTube changes shape, because nothing declares the guess wrong.
 *   [owntube]   OwnTube's own concept with no upstream equivalent. Not a gap.
 *
 * Field-existence claims below were checked against the Invidious source rather
 * than sampled — `grep 'json.field "<name>"' src/invidious/` — because a sample
 * proves presence but never absence.
 *
 * Phases 3.1-3.5 moved audio-track language/labels, trending `liveNow`, the
 * Shorts flag and `publishedAt` out of [inferred]. What remains there is mostly
 * the multi-shape pickers (Phase 3.7) and thumbnail URL construction.
 */

export const searchVideosInputSchema = z.object({
  q: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).optional(),
  continuation: z.string().max(4096).optional(),
  /** ISO 3166-1 alpha-2, passed through to Invidious search. */
  region: z.string().length(2).optional(),
});

export type SearchVideosInput = z.infer<typeof searchVideosInputSchema>;

/**
 * Why a personalized feed row was recommended. Only set for rows produced by
 * the recommendation engine; trending / search / channel rows leave it unset.
 */
export const recommendationReasonSchema = z.object({
  kind: z.enum(["subscription", "channel", "topic", "related", "trending"]),
  /** Channel the affinity comes from (for `kind: "subscription" | "channel"`). */
  channelName: z.string().optional(),
  /** Top matched taste terms (for `kind: "topic"`). */
  terms: z.array(z.string()).optional(),
});

export type RecommendationReason = z.infer<typeof recommendationReasonSchema>;

export const unifiedVideoSchema = z.object({
  /** [upstream] Invidious `videoId`. */
  videoId: z.string(),
  /** [upstream] Invidious `title`. */
  title: z.string(),
  /** [upstream] Invidious `authorId`. */
  channelId: z.string().optional(),
  /** [upstream] Invidious `author`. */
  channelName: z.string().optional(),
  /**
   * [derived] Best entry picked out of Invidious `authorThumbnails[]` by size.
   * The list is upstream's; the choice is ours.
   */
  channelAvatarUrl: z.string().optional(),
  /**
   * [inferred] Starts from Invidious `videoThumbnails[]` but is then *rewritten*
   * to a constructed `i.ytimg.com` URL for a higher resolution than upstream
   * offered (`preferHighResVideoThumbnailUrl`). That guesses a URL shape YouTube
   * has never promised, which is why the image route needs a 5-step fallback
   * chain. Not closable upstream — it is a deliberate quality trade.
   */
  thumbnailUrl: z.string().optional(),
  /**
   * [derived] Invidious `lengthSeconds`, suppressed for active livestreams so
   * cards do not render "0:00" (`normalizeDurationForLive`). Note upstream
   * *fabricates* this for Shorts — see `isShort`.
   */
  durationSeconds: z.number().optional(),
  /**
   * [inferred] `pickViewCount` tries `views`, `viewCount`, `view_count`. Only
   * `viewCount` exists (5 serialisation sites); the other two are emitted at
   * zero. Phase 3.7.
   */
  viewCount: z.number().optional(),
  /**
   * [upstream] Invidious `publishedText`, e.g. "3 days ago". Localised by the
   * instance, so OwnTube sends `hl` (see `proxy/http.ts`) — without it this
   * deployment answered in Arabic.
   */
  publishedText: z.string().optional(),
  /**
   * [upstream] Invidious `published`, falling back to `premiereTimestamp` for
   * scheduled premieres.
   *
   * Precise on `/api/v1/videos`; **coarse on list endpoints**, where Invidious
   * derives it from `publishedText` itself (`decode_date`). So every "1 month
   * ago" row shares one instant while true dates span four weeks — measured up
   * to 756h off. An upstream limitation, not an OwnTube guess: YouTube does not
   * put exact dates in list renderers.
   */
  publishedAt: z.number().optional(),
  /**
   * [upstream] Invidious `liveNow`. `pickLiveFlagsFromUpstream` still checks
   * `livestream` / `live` / `duration === -1` alongside it — dead Piped shapes
   * that outlived Phase 1. Phase 3.7.
   */
  isLive: z.boolean().optional(),
  /** [upstream] Invidious `isUpcoming`. */
  isUpcoming: z.boolean().optional(),
  /**
   * [upstream] Invidious `isShort` (added by the fork, Phase 3.3). It cannot be
   * inferred: YouTube stopped reporting a real duration for Shorts and the
   * parsers substitute an approximate 60s, so a genuine 60-second upload is
   * indistinguishable by length. Length and `#shorts`-in-title remain as
   * fallbacks only for payloads cached before this field existed.
   */
  isShort: z.boolean().optional(),
  /** [owntube] Why this row was recommended (personalized feed only). */
  recommendationReason: recommendationReasonSchema.optional(),
});

export type UnifiedVideo = z.infer<typeof unifiedVideoSchema>;

export const unifiedChannelSchema = z.object({
  /** [upstream] Invidious `authorId` / `channelId`. */
  channelId: z.string(),
  /** [upstream] Invidious `author` / `name`. */
  name: z.string(),
  /** [derived] Picked from Invidious `authorThumbnails[]` / `channelThumbnails[]`. */
  avatarUrl: z.string().optional(),
  /**
   * [inferred] `pickChannelSubscriberCount` tries five numeric keys plus a text
   * parser. Only `subCount` exists (2 serialisation sites); `subscriberCount`,
   * `uploaderSubscriberCount`, `uploaderSubCount` and `authorSubCount` are all
   * emitted at zero. Phase 3.7.
   */
  subscriberCount: z.number().optional(),
  /** [upstream] Invidious `description`. */
  description: z.string().optional(),
});

export type UnifiedChannel = z.infer<typeof unifiedChannelSchema>;

export const searchVideosResultSchema = z.object({
  videos: z.array(unifiedVideoSchema),
  channels: z.array(unifiedChannelSchema).optional(),
  continuation: z.string().nullable().optional(),
  sourceUsed: z.enum(["invidious", "cache"]),
  warning: z.string().optional(),
  stale: z.boolean().optional(),
});

export const cachedSearchPayloadSchema = z.object({
  videos: z.array(unifiedVideoSchema),
  channels: z.array(unifiedChannelSchema).optional(),
  continuation: z.string().nullable().optional(),
  sourceUsed: z.enum(["invidious"]),
});

export type SearchVideosResult = z.infer<typeof searchVideosResultSchema>;

export const upstreamPlaybackSourceSchema = z.enum(["invidious"]);

export type UpstreamPlaybackSource = z.infer<
  typeof upstreamPlaybackSourceSchema
>;

export const videoDetailInputSchema = z.object({
  videoId: z.string().min(11).max(20),
  /** Force live playback catalog from this upstream when both are configured. */
  preferUpstream: upstreamPlaybackSourceSchema.optional(),
});

export type VideoDetailInput = z.infer<typeof videoDetailInputSchema>;

export const videoStoryboardSchema = z.object({
  templateUrl: z.string().url(),
  thumbWidth: z.number().int().positive(),
  thumbHeight: z.number().int().positive(),
  count: z.number().int().positive(),
  intervalMs: z.number().int().positive(),
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  storyboardCount: z.number().int().positive(),
});

export type VideoStoryboard = z.infer<typeof videoStoryboardSchema>;

export const streamSourceSchema = z.object({
  url: z.string().url(),
  mimeType: z.string().optional(),
  quality: z.string().optional(),
  /**
   * [inferred] `readPositiveNumberField(stream, ["bitrate", "averageBitrate"])`.
   * Phase 3.7 — confirm which of the two Invidious actually emits.
   */
  bitrate: z.number().finite().nonnegative().optional(),
  /** [inferred] `readPositiveNumberField(stream, ["fps", "frameRate"])`. Phase 3.7. */
  fps: z.number().positive().optional(),
  /**
   * [inferred] `readStreamHeightPx` — reads `height`, else parses it out of
   * `size` ("1920x1080") or `resolution` ("1080p"). Phase 3.7.
   */
  height: z.number().finite().nonnegative().optional(),
  /**
   * BCP-47 language tag of this audio track, read from Invidious
   * `adaptiveFormats[].audioTrack.id` with YouTube's track discriminator
   * stripped ("en-US.4" → "en-US"). Read from upstream, not inferred. Absent on
   * single-audio videos, which never carry an `audioTrack`.
   */
  language: z.string().optional(),
  /**
   * Invidious `audioTrack.displayName`, e.g. "English (US) original". Always
   * English, so it is a fallback for labelling rather than the label itself —
   * `language` drives the localised name.
   */
  audioTrackDisplayName: z.string().optional(),
  /**
   * Invidious `audioTrack.audioIsDefault`: true for the video's original
   * (undubbed) audio. Replaces guessing at `acont=original` inside the stream
   * URL's `xtags` parameter.
   */
  audioIsOriginal: z.boolean().optional(),
  /**
   * [derived] True when this URL is video-only (adaptive) and must not be used
   * alone in a single &lt;video src&gt; — no muxed audio. Follows from which
   * upstream list the stream came out of, not from a field.
   */
  videoOnly: z.boolean().optional(),
  /**
   * [derived] True when upstream provided this adaptive stream's init/index byte ranges,
   * i.e. it can back a synthesized byte-range DASH/HLS manifest. Some videos
   * (incomplete Invidious extraction) return adaptive streams without them —
   * `/dash` and `/hls` 502 for those, so playback must fall back to the native
   * `hlsUrl` instead. Absent on legacy cached payloads (pre-dating this field).
   */
  indexed: z.boolean().optional(),
});

/** [upstream] A subtitle/caption track from Invidious `captions[]`. */
export const captionTrackSchema = z.object({
  /** Human label, e.g. "English" or "English (auto-generated)". */
  label: z.string(),
  /** BCP-47 language code, e.g. "en" or "de-DE". */
  languageCode: z.string(),
});

export type CaptionTrack = z.infer<typeof captionTrackSchema>;

export const videoDetailSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  channelId: z.string().optional(),
  channelName: z.string().optional(),
  channelAvatarUrl: z.string().optional(),
  channelSubscriberCount: z.number().optional(),
  /**
   * [upstream] Invidious `recommendedVideos` on the detail payload, or a
   * separate `/related` fetch. (The old note here referred to Piped, deleted in
   * Phase 1.)
   */
  relatedVideos: z.array(unifiedVideoSchema).optional(),
  storyboard: videoStoryboardSchema.optional(),
  thumbnailUrl: z.string().optional(),
  durationSeconds: z.number().int().optional(),
  viewCount: z.number().optional(),
  publishedText: z.string().optional(),
  /**
   * [upstream] Invidious `published`. Precise here, unlike the list endpoints —
   * the detail payload carries a real date from the player microformat.
   */
  publishedAt: z.number().optional(),
  /** [upstream] Invidious `liveNow`. */
  isLive: z.boolean().optional(),
  /**
   * [upstream] Invidious `isPostLiveDvr`. Ended livestream YouTube hasn't
   * converted to VOD yet: no byte-range formats, so playback goes via `/dvr`.
   */
  isPostLiveDvr: z.boolean().optional(),
  isUpcoming: z.boolean().optional(),
  hlsUrl: z.string().url().optional(),
  dashUrl: z.string().url().optional(),
  audioSources: z.array(streamSourceSchema),
  videoSources: z.array(streamSourceSchema),
  /** Subtitle/caption tracks (Invidious `captions[]`); empty/absent when none. */
  captions: z.array(captionTrackSchema).optional(),
  sourceUsed: z.enum(["invidious", "cache"]),
  /**
   * [derived] Origin that upstream media URLs resolve to, used to validate
   * same-origin media proxy targets. (Was Piped's `proxyUrl`; since Phase 1 it
   * is derived from the Invidious base URL.)
   */
  mediaProxyBase: z.string().url().optional(),
  warning: z.string().optional(),
  stale: z.boolean().optional(),
});

export type VideoDetail = z.infer<typeof videoDetailSchema>;

export const relatedVideosResultSchema = z.object({
  videos: z.array(unifiedVideoSchema),
  sourceUsed: z.enum(["invidious", "cache"]),
  warning: z.string().optional(),
  stale: z.boolean().optional(),
});

export type RelatedVideosResult = z.infer<typeof relatedVideosResultSchema>;

export const commentSortSchema = z.enum(["top", "new"]);

export type CommentSort = z.infer<typeof commentSortSchema>;

export const unifiedCommentSchema = z.object({
  commentId: z.string(),
  author: z.string(),
  authorId: z.string().optional(),
  text: z.string(),
  publishedText: z.string().optional(),
  authorAvatarUrl: z.string().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  isPinned: z.boolean().optional(),
  isHearted: z.boolean().optional(),
  isVerified: z.boolean().optional(),
  replyCount: z.number().int().nonnegative().optional(),
});

export type UnifiedComment = z.infer<typeof unifiedCommentSchema>;

export const videoCommentsInputSchema = z.object({
  videoId: z.string().min(11).max(20),
  sortBy: commentSortSchema.default("top"),
  continuation: z.string().max(16384).optional(),
});

export type VideoCommentsInput = z.infer<typeof videoCommentsInputSchema>;

export const videoCommentsResultSchema = z.object({
  videoId: z.string(),
  comments: z.array(unifiedCommentSchema),
  disabled: z.boolean().optional(),
  continuation: z.string().nullable().optional(),
  commentCount: z.number().int().nonnegative().optional(),
  sourceUsed: z.enum(["invidious"]),
  warning: z.string().optional(),
});

export type VideoCommentsResult = z.infer<typeof videoCommentsResultSchema>;

/** [upstream] Invidious `type` on `/api/v1/trending`. */
export const trendingVideoCategorySchema = z
  .enum(["music", "gaming", "movies"])
  .optional();

export const trendingInputSchema = z.object({
  region: z.string().length(2).default("US"),
  limit: z.number().int().min(1).max(60).optional(),
  category: trendingVideoCategorySchema,
});

export type TrendingInput = z.infer<typeof trendingInputSchema>;

export const trendingVideosResultSchema = z.object({
  videos: z.array(unifiedVideoSchema),
  sourceUsed: z.enum(["invidious", "cache"]),
  warning: z.string().optional(),
  stale: z.boolean().optional(),
});

export type TrendingVideosResult = z.infer<typeof trendingVideosResultSchema>;

export const shortsFeedPurposeSchema = z.enum(["feed", "shelf"]);

export type ShortsFeedPurpose = z.infer<typeof shortsFeedPurposeSchema>;

export const shortsFeedInputSchema = z.object({
  region: z.string().length(2).default("US"),
  limit: z.number().int().min(1).max(40).optional(),
  /** `shelf` = home teaser: one upstream page max, no pool rebuild on cache miss. */
  purpose: shortsFeedPurposeSchema.optional(),
  continuation: z.string().max(4096).optional(),
  /** Session scroll-past ids from the client (merged with watch history on the server). */
  excludeVideoIds: z.array(z.string().min(5).max(64)).max(200).optional(),
  /** Override regional viral queries (taste-based discovery). */
  discoveryQueries: z.array(z.string().min(1).max(128)).max(8).optional(),
});

export type ShortsFeedInput = z.infer<typeof shortsFeedInputSchema>;

export const shortsFeedResultSchema = z.object({
  videos: z.array(unifiedVideoSchema),
  continuation: z.string().nullable().optional(),
  sourceUsed: z.enum(["invidious", "cache"]),
  warning: z.string().optional(),
  stale: z.boolean().optional(),
});

export type ShortsFeedResult = z.infer<typeof shortsFeedResultSchema>;

export const cachedShortsFeedPayloadSchema = z.object({
  videos: z.array(unifiedVideoSchema),
  continuation: z.string().nullable().optional(),
  sourceUsed: z.enum(["invidious"]),
});

export const cachedTrendingPayloadSchema = z.object({
  videos: z.array(unifiedVideoSchema),
  sourceUsed: z.enum(["invidious"]),
});

export const channelTabSchema = z.enum(["videos", "shorts"]);

export type ChannelTab = z.infer<typeof channelTabSchema>;

export const channelPageInputSchema = z.object({
  channelId: z.string().min(3).max(128),
  tab: channelTabSchema.optional(),
  continuation: z.string().max(16384).optional(),
});

export type ChannelPageInput = z.infer<typeof channelPageInputSchema>;

export const channelPageResultSchema = z.object({
  channelId: z.string(),
  /** Absent on continuation-only pages (load more). */
  name: z.string().optional(),
  description: z.string().optional(),
  avatarUrl: z.string().optional(),
  bannerUrl: z.string().optional(),
  subscriberCount: z.number().optional(),
  videos: z.array(unifiedVideoSchema),
  continuation: z.string().nullable().optional(),
  sourceUsed: z.enum(["invidious", "cache"]),
  warning: z.string().optional(),
  stale: z.boolean().optional(),
});

export type ChannelPageResult = z.infer<typeof channelPageResultSchema>;

export const cachedChannelPayloadSchema = z.object({
  channelId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  avatarUrl: z.string().optional(),
  bannerUrl: z.string().optional(),
  subscriberCount: z.number().optional(),
  videos: z.array(unifiedVideoSchema),
  continuation: z.string().nullable().optional(),
  sourceUsed: z.enum(["invidious"]),
});
