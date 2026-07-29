import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { toMediaOriginUrl } from "@/lib/media-origin";
import type { AppDb } from "@/server/db/client";
import {
  channelMeta,
  channelTags,
  interactions,
  playlistItems,
  playlists,
  subscriptions,
  users,
  watchQueue,
} from "@/server/db/schema";
import { getChannelRssEntries } from "@/server/rss/cache";
import { fetchVideoDetail } from "@/server/services/proxy";
import { getUserProxyOverrides } from "@/server/settings/profile";

/**
 * Remote-control publisher: turns each user's local library (playlists, queue,
 * saved inbox) and subscription uploads into self-contained feed snapshots and
 * pushes them to the public companion (see `companion/`). The companion stores
 * and renders them as podcast RSS; every `<enclosure>` points back at the LAN
 * media origin (`/media/<id>.{m4a,mp4}`), so metadata is public-behind-basic-auth
 * while the media itself only streams on the LAN.
 *
 * Nothing here is opt-in: we publish everything. The companion replaces its full
 * set each cycle, so deleting a playlist / unsubscribing prunes the feed.
 */

export type FeedKind =
  | "playlist"
  | "queue"
  | "saved"
  | "subscriptions"
  | "tag"
  | "channel";

export type FeedItem = {
  videoId: string;
  title: string;
  description?: string;
  durationSeconds?: number;
  publishedAt?: number;
  thumbnailUrl?: string;
  channelName?: string;
  enclosureAudio: string;
  enclosureVideo: string;
};

export type FeedSnapshot = {
  kind: FeedKind;
  /** Readable, kind-namespaced on the companion (`/rss/<kind>/<slug>.*`). */
  slug: string;
  title: string;
  description?: string;
  link?: string;
  image?: string;
  updatedAt: number;
  items: FeedItem[];
};

export type PublishOptions = {
  /** Absolute origin used to build enclosure/link URLs (media host resolved from env). */
  appOrigin: string;
  /** Newest N uploads to keep per channel-based feed. */
  channelFeedLimit?: number;
  /** Newest N videos to keep in the merged subscriptions/tag feeds. */
  mergedFeedLimit?: number;
  /** Per-video detail lookups run this many at a time. */
  concurrency?: number;
  onLog?: (message: string) => void;
};

const DEFAULT_CHANNEL_LIMIT = 30;
const DEFAULT_MERGED_LIMIT = 50;
const DEFAULT_CONCURRENCY = 5;

function slugify(input: string, fallback: string): string {
  const s = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || fallback;
}

/** De-duplicate readable slugs within one kind by appending a suffix. */
function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  taken.add(slug);
  return slug;
}

function enclosures(
  videoId: string,
  appOrigin: string,
): { enclosureAudio: string; enclosureVideo: string } {
  return {
    enclosureAudio: toMediaOriginUrl(`/media/${videoId}.m4a`, appOrigin),
    enclosureVideo: toMediaOriginUrl(`/media/${videoId}.mp4`, appOrigin),
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await worker(items[i] as T, i);
      }
    },
  );
  await Promise.all(runners);
  return out;
}

/**
 * Enrich an explicit list of video ids (playlists/queue/saved) into feed items
 * via `fetchVideoDetail` — the same call `interactions.listSaved` uses — so we
 * get description, duration, published date and thumbnail. Falls back to the
 * stored title when a lookup fails (age-restricted/removed).
 */
async function enrichVideoItems(
  db: AppDb,
  userId: number,
  rows: { videoId: string; title?: string | null }[],
  appOrigin: string,
  concurrency: number,
): Promise<FeedItem[]> {
  const overrides = getUserProxyOverrides(db, userId);
  const items = await mapWithConcurrency(rows, concurrency, async (r) => {
    const enc = enclosures(r.videoId, appOrigin);
    try {
      const d = await fetchVideoDetail(db, { videoId: r.videoId }, overrides);
      return {
        videoId: r.videoId,
        title: d.title ?? r.title ?? r.videoId,
        description: d.description,
        durationSeconds: d.durationSeconds,
        publishedAt: d.publishedAt,
        thumbnailUrl: d.thumbnailUrl,
        channelName: d.channelName,
        ...enc,
      } satisfies FeedItem;
    } catch {
      return {
        videoId: r.videoId,
        title: r.title ?? r.videoId,
        ...enc,
      } satisfies FeedItem;
    }
  });
  return items;
}

/** Merge several channels' cached uploads RSS into one newest-first item list. */
async function mergedChannelItems(
  db: AppDb,
  channelIds: string[],
  appOrigin: string,
  limit: number,
): Promise<FeedItem[]> {
  const perChannel = await Promise.all(
    channelIds.map((c) => getChannelRssEntries(db, c).catch(() => [])),
  );
  const seen = new Set<string>();
  const merged = perChannel
    .flat()
    .filter((e) => (seen.has(e.videoId) ? false : seen.add(e.videoId)))
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    .slice(0, limit);
  return merged.map((e) => ({
    videoId: e.videoId,
    title: e.title,
    publishedAt: e.publishedAt,
    thumbnailUrl: e.thumbnailUrl,
    channelName: e.channelName,
    ...enclosures(e.videoId, appOrigin),
  }));
}

function readChannelNames(
  db: AppDb,
  channelIds: string[],
): Map<string, { name: string; avatarUrl?: string }> {
  const out = new Map<string, { name: string; avatarUrl?: string }>();
  if (channelIds.length === 0) return out;
  const rows = db
    .select({
      channelId: channelMeta.channelId,
      channelName: channelMeta.channelName,
      avatarUrl: channelMeta.avatarUrl,
    })
    .from(channelMeta)
    .where(inArray(channelMeta.channelId, channelIds))
    .all();
  for (const r of rows) {
    out.set(r.channelId, {
      name: r.channelName,
      avatarUrl: r.avatarUrl ?? undefined,
    });
  }
  return out;
}

async function buildFeedsForUser(
  db: AppDb,
  userId: number,
  prefix: string,
  opts: Required<Omit<PublishOptions, "onLog">> & {
    onLog?: PublishOptions["onLog"];
  },
): Promise<FeedSnapshot[]> {
  const { appOrigin, channelFeedLimit, mergedFeedLimit, concurrency } = opts;
  const now = Math.floor(Date.now() / 1000);
  const feeds: FeedSnapshot[] = [];
  const slugsByKind = new Map<FeedKind, Set<string>>();
  const takenFor = (kind: FeedKind): Set<string> => {
    let s = slugsByKind.get(kind);
    if (!s) {
      s = new Set<string>();
      slugsByKind.set(kind, s);
    }
    return s;
  };
  const p = (slug: string): string => (prefix ? `${prefix}-${slug}` : slug);

  // --- Playlists (all) ---
  const playlistRows = db
    .select()
    .from(playlists)
    .where(eq(playlists.userId, userId))
    .all();
  for (const pl of playlistRows) {
    const itemRows = db
      .select({ videoId: playlistItems.videoId })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, pl.id))
      .orderBy(asc(playlistItems.position), asc(playlistItems.addedAt))
      .all();
    if (itemRows.length === 0) continue;
    const items = await enrichVideoItems(
      db,
      userId,
      itemRows,
      appOrigin,
      concurrency,
    );
    feeds.push({
      kind: "playlist",
      slug: p(
        uniqueSlug(slugify(pl.name, `playlist-${pl.id}`), takenFor("playlist")),
      ),
      title: pl.name,
      description: pl.description ?? undefined,
      link: `${appOrigin}/playlist?list=${pl.id}`,
      image: items[0]?.thumbnailUrl,
      updatedAt: pl.updatedAt ?? now,
      items,
    });
  }

  // --- Queue ---
  const queueRows = db
    .select({ videoId: watchQueue.videoId, title: watchQueue.title })
    .from(watchQueue)
    .where(eq(watchQueue.userId, userId))
    .orderBy(asc(watchQueue.position))
    .all();
  if (queueRows.length > 0) {
    const items = await enrichVideoItems(
      db,
      userId,
      queueRows,
      appOrigin,
      concurrency,
    );
    feeds.push({
      kind: "queue",
      slug: p("queue"),
      title: "Queue",
      description: "OwnTube watch queue",
      link: `${appOrigin}/`,
      image: items[0]?.thumbnailUrl,
      updatedAt: now,
      items,
    });
  }

  // --- Saved inbox ---
  const savedRows = db
    .select({ videoId: interactions.videoId, title: interactions.title })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), eq(interactions.type, "save")))
    .orderBy(desc(interactions.createdAt))
    .all();
  if (savedRows.length > 0) {
    const items = await enrichVideoItems(
      db,
      userId,
      savedRows,
      appOrigin,
      concurrency,
    );
    feeds.push({
      kind: "saved",
      slug: p("saved"),
      title: "Saved",
      description: "OwnTube saved videos",
      link: `${appOrigin}/`,
      image: items[0]?.thumbnailUrl,
      updatedAt: now,
      items,
    });
  }

  // --- Subscription-derived channel feeds (subscribed channels only) ---
  const subRows = db
    .select({ channelId: subscriptions.channelId })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .all();
  const subChannelIds = [...new Set(subRows.map((r) => r.channelId))];
  const names = readChannelNames(db, subChannelIds);

  // All subscriptions merged.
  if (subChannelIds.length > 0) {
    const items = await mergedChannelItems(
      db,
      subChannelIds,
      appOrigin,
      mergedFeedLimit,
    );
    feeds.push({
      kind: "subscriptions",
      slug: p("subscriptions"),
      title: "Subscriptions",
      description: "Latest uploads from all subscribed channels",
      link: `${appOrigin}/subscriptions`,
      image: items[0]?.thumbnailUrl,
      updatedAt: now,
      items,
    });
  }

  // Per channel tag — restricted to subscribed channels.
  const tagRows = db
    .select({ tag: channelTags.tag, channelId: channelTags.channelId })
    .from(channelTags)
    .where(eq(channelTags.userId, userId))
    .all();
  const byTag = new Map<string, string[]>();
  for (const r of tagRows) {
    if (!subChannelIds.includes(r.channelId)) continue;
    const arr = byTag.get(r.tag) ?? [];
    arr.push(r.channelId);
    byTag.set(r.tag, arr);
  }
  for (const [tag, channelIds] of byTag) {
    const items = await mergedChannelItems(
      db,
      channelIds,
      appOrigin,
      mergedFeedLimit,
    );
    if (items.length === 0) continue;
    feeds.push({
      kind: "tag",
      slug: p(uniqueSlug(slugify(tag, "tag"), takenFor("tag"))),
      title: `#${tag}`,
      description: `Latest uploads from channels tagged "${tag}"`,
      link: `${appOrigin}/subscriptions`,
      image: items[0]?.thumbnailUrl,
      updatedAt: now,
      items,
    });
  }

  // Per channel.
  for (const channelId of subChannelIds) {
    const items = await mergedChannelItems(
      db,
      [channelId],
      appOrigin,
      channelFeedLimit,
    );
    if (items.length === 0) continue;
    const meta = names.get(channelId);
    const title = meta?.name ?? items[0]?.channelName ?? channelId;
    feeds.push({
      kind: "channel",
      slug: p(uniqueSlug(slugify(title, channelId), takenFor("channel"))),
      title,
      description: `Latest uploads from ${title}`,
      link: `${appOrigin}/channel/${channelId}`,
      image: meta?.avatarUrl ?? items[0]?.thumbnailUrl,
      updatedAt: now,
      items,
    });
  }

  return feeds;
}

/** Build every feed snapshot for every user in the database. */
export async function buildAllFeeds(
  db: AppDb,
  options: PublishOptions,
): Promise<FeedSnapshot[]> {
  const opts = {
    appOrigin: options.appOrigin,
    channelFeedLimit: options.channelFeedLimit ?? DEFAULT_CHANNEL_LIMIT,
    mergedFeedLimit: options.mergedFeedLimit ?? DEFAULT_MERGED_LIMIT,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    onLog: options.onLog,
  };
  const userRows = db
    .select({ id: users.id, email: users.email })
    .from(users)
    .all();
  const multiUser = userRows.length > 1;
  const all: FeedSnapshot[] = [];
  for (const u of userRows) {
    const prefix = multiUser
      ? slugify(u.email?.split("@")[0] ?? `user-${u.id}`, `user-${u.id}`)
      : "";
    const feeds = await buildFeedsForUser(db, u.id, prefix, opts);
    opts.onLog?.(`publish: user ${u.id} — ${feeds.length} feed(s)`);
    all.push(...feeds);
  }
  return all;
}

/** Build all feeds and POST them to the companion. */
export async function publishFeeds(
  db: AppDb,
  options: PublishOptions & { target: string; secret: string },
): Promise<{ feedCount: number; itemCount: number }> {
  const feeds = await buildAllFeeds(db, options);
  const itemCount = feeds.reduce((n, f) => n + f.items.length, 0);
  const url = `${options.target.replace(/\/+$/, "")}/publish`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.secret}`,
    },
    body: JSON.stringify({ feeds }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`companion ${res.status}: ${body.slice(0, 200)}`);
  }
  return { feedCount: feeds.length, itemCount };
}
