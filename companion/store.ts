/**
 * SQLite store for published feed snapshots and the per-user credentials that
 * unlock them. One feed row per (owner, kind, slug); the JSON column holds the
 * whole snapshot the publisher pushed. `replaceAll` mirrors the publisher's
 * full-set semantics: after a publish the store contains exactly the feeds and
 * users in that payload — anything absent (deleted playlist, dropped
 * subscription, removed account) is pruned.
 *
 * Credentials arrive and are stored as SHA-256 hex digests; the plaintext
 * password never leaves the home OwnTube.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { FeedSnapshot } from "./render.ts";

export type FeedRow = {
  owner: string;
  kind: string;
  slug: string;
  title: string;
  updatedAt: number;
  feed: FeedSnapshot;
};

export type UserCredential = {
  username: string;
  /** SHA-256 hex of the user's RSS password. */
  passSha256: string;
};

export class FeedStore {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "companion.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS feeds (
        owner TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner, kind, slug)
      );
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        pass_sha256 TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.migrateOwnerColumn();
  }

  /**
   * A pre-per-user database has a feeds table keyed (kind, slug) with no owner.
   * Rebuild with the new key; the orphaned owner='' rows are unreachable (no
   * matching credential) and vanish at the first publish.
   */
  private migrateOwnerColumn(): void {
    const cols = this.db.prepare("PRAGMA table_info(feeds)").all() as {
      name: string;
    }[];
    if (cols.some((c) => c.name === "owner")) return;
    this.db.exec(
      `ALTER TABLE feeds RENAME TO feeds_old;
      CREATE TABLE feeds (
        owner TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner, kind, slug)
      );
      INSERT INTO feeds (owner, kind, slug, title, json, updated_at)
        SELECT '', kind, slug, title, json, updated_at FROM feeds_old;
      DROP TABLE feeds_old`,
    );
  }

  /** Replace the entire published set (feeds and users), atomically. */
  replaceAll(
    feeds: FeedSnapshot[],
    users: UserCredential[],
  ): { upserted: number } {
    const keep = new Set(feeds.map((f) => `${f.owner}:${f.kind}:${f.slug}`));
    const upsert = this.db.prepare(
      `INSERT INTO feeds (owner, kind, slug, title, json, updated_at)
       VALUES (@owner, @kind, @slug, @title, @json, @updatedAt)
       ON CONFLICT(owner, kind, slug) DO UPDATE SET
         title = excluded.title, json = excluded.json, updated_at = excluded.updated_at`,
    );
    const upsertUser = this.db.prepare(
      `INSERT INTO users (username, pass_sha256, updated_at)
       VALUES (@username, @passSha256, unixepoch())
       ON CONFLICT(username) DO UPDATE SET
         pass_sha256 = excluded.pass_sha256, updated_at = excluded.updated_at`,
    );
    const tx = this.db.transaction(
      (rows: FeedSnapshot[], creds: UserCredential[]) => {
        for (const f of rows) {
          upsert.run({
            owner: f.owner,
            kind: f.kind,
            slug: f.slug,
            title: f.title,
            json: JSON.stringify(f),
            updatedAt: f.updatedAt,
          });
        }
        const existing = this.db
          .prepare("SELECT owner, kind, slug FROM feeds")
          .all() as { owner: string; kind: string; slug: string }[];
        const del = this.db.prepare(
          "DELETE FROM feeds WHERE owner = ? AND kind = ? AND slug = ?",
        );
        for (const row of existing) {
          if (!keep.has(`${row.owner}:${row.kind}:${row.slug}`)) {
            del.run(row.owner, row.kind, row.slug);
          }
        }
        for (const c of creds) upsertUser.run(c);
        const usernames = new Set(creds.map((c) => c.username));
        const existingUsers = this.db
          .prepare("SELECT username FROM users")
          .all() as { username: string }[];
        const delUser = this.db.prepare("DELETE FROM users WHERE username = ?");
        for (const u of existingUsers) {
          if (!usernames.has(u.username)) delUser.run(u.username);
        }
      },
    );
    tx(feeds, users);
    return { upserted: feeds.length };
  }

  getUser(username: string): UserCredential | null {
    const row = this.db
      .prepare("SELECT username, pass_sha256 FROM users WHERE username = ?")
      .get(username) as { username: string; pass_sha256: string } | undefined;
    return row ? { username: row.username, passSha256: row.pass_sha256 } : null;
  }

  get(owner: string, kind: string, slug: string): FeedSnapshot | null {
    const row = this.db
      .prepare(
        "SELECT json FROM feeds WHERE owner = ? AND kind = ? AND slug = ?",
      )
      .get(owner, kind, slug) as { json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.json) as FeedSnapshot;
    } catch {
      return null;
    }
  }

  list(owner: string): FeedRow[] {
    const rows = this.db
      .prepare(
        "SELECT owner, kind, slug, title, json, updated_at FROM feeds WHERE owner = ? ORDER BY kind, title",
      )
      .all(owner) as {
      owner: string;
      kind: string;
      slug: string;
      title: string;
      json: string;
      updated_at: number;
    }[];
    return rows.map((r) => ({
      owner: r.owner,
      kind: r.kind,
      slug: r.slug,
      title: r.title,
      updatedAt: r.updated_at,
      feed: JSON.parse(r.json) as FeedSnapshot,
    }));
  }
}
