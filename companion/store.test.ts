import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { FeedSnapshot } from "./render.ts";
import { FeedStore } from "./store.ts";

function snap(owner: string, kind: string, slug: string): FeedSnapshot {
  return {
    kind,
    owner,
    slug,
    title: `${owner}'s ${slug}`,
    updatedAt: 1_700_000_000,
    items: [],
  };
}

function freshStore(): { store: FeedStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-store-"));
  return { store: new FeedStore(dir), dir };
}

test("feeds are scoped per owner; same slug can exist twice", () => {
  const { store } = freshStore();
  store.replaceAll(
    [snap("alice", "queue", "queue"), snap("bob", "queue", "queue")],
    [
      { username: "alice", passSha256: "a".repeat(64) },
      { username: "bob", passSha256: "b".repeat(64) },
    ],
  );
  assert.equal(store.get("alice", "queue", "queue")?.title, "alice's queue");
  assert.equal(store.get("bob", "queue", "queue")?.title, "bob's queue");
  assert.equal(store.get("carol", "queue", "queue"), null);
  assert.equal(store.list("alice").length, 1);
});

test("replaceAll prunes feeds and users absent from the payload", () => {
  const { store } = freshStore();
  store.replaceAll(
    [snap("alice", "queue", "queue"), snap("alice", "playlist", "tech")],
    [{ username: "alice", passSha256: "a".repeat(64) }],
  );
  store.replaceAll(
    [snap("alice", "queue", "queue")],
    [{ username: "alice", passSha256: "c".repeat(64) }],
  );
  assert.equal(store.get("alice", "playlist", "tech"), null);
  assert.equal(store.getUser("alice")?.passSha256, "c".repeat(64));

  store.replaceAll([], []);
  assert.equal(store.list("alice").length, 0);
  assert.equal(store.getUser("alice"), null);
});

test("legacy ownerless table is migrated and orphans pruned on publish", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-store-"));
  {
    // Simulate a pre-per-user database.
    const db = new Database(path.join(dir, "companion.db"));
    db.exec(
      `CREATE TABLE feeds (
        kind TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
        json TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, slug)
      )`,
    );
    db.prepare(
      "INSERT INTO feeds (kind, slug, title, json, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("queue", "queue", "Queue", "{}", 1);
    db.close();
  }
  const store = new FeedStore(dir);
  // Legacy row survives the migration under owner '' (unreachable via auth)…
  assert.equal(store.list("").length, 1);
  // …and the first publish prunes it.
  store.replaceAll(
    [snap("alice", "queue", "queue")],
    [{ username: "alice", passSha256: "a".repeat(64) }],
  );
  assert.equal(store.list("").length, 0);
  assert.equal(store.list("alice").length, 1);
});
