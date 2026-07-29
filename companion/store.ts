/**
 * SQLite store for published feed snapshots. One row per (kind, slug); the JSON
 * column holds the whole snapshot the publisher pushed. `replaceAll` mirrors the
 * publisher's full-set semantics: after a publish the store contains exactly the
 * feeds in that payload — anything absent (deleted playlist, dropped
 * subscription) is pruned.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { FeedSnapshot } from "./render.ts";

export type FeedRow = {
  kind: string;
  slug: string;
  title: string;
  updatedAt: number;
  feed: FeedSnapshot;
};

export class FeedStore {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "companion.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS feeds (
        kind TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, slug)
      )`,
    );
  }

  /** Replace the entire published set with the given feeds, atomically. */
  replaceAll(feeds: FeedSnapshot[]): { upserted: number } {
    const keep = new Set(feeds.map((f) => `${f.kind}:${f.slug}`));
    const upsert = this.db.prepare(
      `INSERT INTO feeds (kind, slug, title, json, updated_at)
       VALUES (@kind, @slug, @title, @json, @updatedAt)
       ON CONFLICT(kind, slug) DO UPDATE SET
         title = excluded.title, json = excluded.json, updated_at = excluded.updated_at`,
    );
    const tx = this.db.transaction((rows: FeedSnapshot[]) => {
      for (const f of rows) {
        upsert.run({
          kind: f.kind,
          slug: f.slug,
          title: f.title,
          json: JSON.stringify(f),
          updatedAt: f.updatedAt,
        });
      }
      const existing = this.db
        .prepare("SELECT kind, slug FROM feeds")
        .all() as { kind: string; slug: string }[];
      const del = this.db.prepare("DELETE FROM feeds WHERE kind = ? AND slug = ?");
      for (const row of existing) {
        if (!keep.has(`${row.kind}:${row.slug}`)) del.run(row.kind, row.slug);
      }
    });
    tx(feeds);
    return { upserted: feeds.length };
  }

  get(kind: string, slug: string): FeedSnapshot | null {
    const row = this.db
      .prepare("SELECT json FROM feeds WHERE kind = ? AND slug = ?")
      .get(kind, slug) as { json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.json) as FeedSnapshot;
    } catch {
      return null;
    }
  }

  list(): FeedRow[] {
    const rows = this.db
      .prepare("SELECT kind, slug, title, json, updated_at FROM feeds ORDER BY kind, title")
      .all() as {
      kind: string;
      slug: string;
      title: string;
      json: string;
      updated_at: number;
    }[];
    return rows.map((r) => ({
      kind: r.kind,
      slug: r.slug,
      title: r.title,
      updatedAt: r.updated_at,
      feed: JSON.parse(r.json) as FeedSnapshot,
    }));
  }
}
