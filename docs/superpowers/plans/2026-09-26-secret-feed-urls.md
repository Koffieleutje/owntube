# Secret Feed Addresses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user's podcast feeds are also served at unguessable addresses without a password, so Pocket Casts subscribes to them at the WebSub hub and gets pushed updates.

**Architecture:** The app derives a per-user secret from the RSS password it already has (`feedToken`) and pushes it with each publish alongside the password hash. The feeds server stores it and serves `/rss/<token>/<kind>/<slug>.<audio|video>.xml` (plus an index page and OPML at `/rss/<token>/` and `/rss/<token>/opml.xml`) without Basic Auth, with a plain self link and the hub link. Hub announcements use those plain addresses. Password-protected addresses keep working unchanged.

**Tech Stack:** Node 22, TypeScript via `tsx`, `better-sqlite3`, `node:test` (feeds server); Next.js + tRPC + drizzle + vitest (web app).

**Spec:** Decided in conversation on 2026-09-26 after a live test: Pocket Casts subscribed at our hub (`websub.nedworks.org`) for an unprotected test feed at an unguessable address, received a pushed update, but never subscribes for Basic-Auth feeds. This plan's "Design decisions" section is the authority.

## Design decisions

1. **Token = `sha256Hex("owntube-feed-token:" + rssPass).slice(0, 32)`** (32 lowercase hex characters, 128 bits of hash over an 80-bit random password). Computed in the app only; the plaintext password still never leaves home. Regenerating the RSS password changes the token, which invalidates old secret addresses at the next publish.
2. **The publisher pushes it** as an optional `feedToken` field on each user credential. The feeds server accepts credentials without it (older app builds) and simply serves no secret addresses for that user.
3. **Secret routes are unauthenticated and come before the Basic-Auth block.** Lookup is by exact token; unknown tokens get 404 (not 401 — nothing to log in to).
4. **Self link on secret feeds is the plain secret address** (built from `PUBLIC_URL` when set, otherwise the request's origin). The hub link is added when the hub is configured, as today.
5. **Announcements use secret addresses only.** Feeds whose owner has no token are not announced (Pocket Casts never subscribes to the protected addresses anyway).
6. **Protected routes stay as they are** (same self link and hub link behaviour), so existing podcast-app subscriptions keep working through polling.
7. **The app shows secret addresses**: "Copy RSS URL" returns secret addresses; the settings section shows the secret queue addresses and a link to the secret index page. The username/password stay visible, labelled as the login for older subscriptions.

## Global Constraints

- Node `>=22 <23` for feeds/server; always run with `export PATH=~/.nvm/versions/node/v22.14.0/bin:$PATH`.
- Token format everywhere: `/^[0-9a-f]{32}$/`.
- Secret feed path: `/rss/<token>/<encodeURIComponent(kind)>/<encodeURIComponent(slug)>.<audio|video>.xml`; index `/rss/<token>/`; OPML `/rss/<token>/opml.xml`.
- Never log a full token: log only its first 6 characters followed by `…` (same style as the existing `/public/` log line).
- Secret RSS responses: `cache-control: private, max-age=300` (same as protected RSS).
- Match surrounding style: feeds server tests are `node:test` + `assert/strict` files run with `tsx`; web tests are vitest next to the source.

## Review Focus

1. **A token of the wrong shape or an unknown token** (`/rss/ABC/queue/queue.audio.xml`, uppercase hex, 31 chars, a real token of another user) — must never serve another user's feed; unknown → 404.
2. **Path collision** — the protected route `/rss/<kind>/<slug>.<variant>.xml` must keep working; a kind or slug that happens to be 32 hex characters must not be misrouted (secret paths have exactly one more segment).
3. **Password regeneration** — after the app pushes a new token, the old secret address must stop working (the store replaces the user's token).
4. **Old app builds** — a publish without `feedToken` must still be accepted, and must clear no other user's token.
5. **Token leakage** — tokens must not appear in logs (only the 6-char prefix) and the protected feeds' HTML index/OPML must not start linking secret addresses (only the secret index does).

---

### Task 1: Feeds server — store the token and look users up by it

**Files:**
- Modify: `feeds/server/store.ts` (`UserCredential`, users table, `replaceAll`, new `getUserByToken`, new `tokenFor`)
- Modify: `feeds/server/store.test.ts`

**Interfaces:**
- Produces:
  - `type UserCredential = { username: string; passSha256: string; feedToken?: string }`
  - users table gains nullable column `feed_token TEXT`; add it with `ALTER TABLE users ADD COLUMN feed_token TEXT` when `PRAGMA table_info(users)` lacks it (same pattern as the existing `migrateOwnerColumn`), plus `CREATE UNIQUE INDEX IF NOT EXISTS users_feed_token ON users(feed_token) WHERE feed_token IS NOT NULL`.
  - `replaceAll` writes `feed_token = @feedToken` (null when absent) in the users upsert (both INSERT and ON CONFLICT UPDATE).
  - `getUserByToken(token: string): UserCredential | null` — exact match; returns null for anything not matching `/^[0-9a-f]{32}$/` without querying.
  - `tokenFor(username: string): string | null`.

- [ ] **Step 1: Write the failing tests** (append to `feeds/server/store.test.ts`):

```ts
test("feed tokens are stored with the credentials and looked up exactly", () => {
  const { store } = freshStore();
  const tokA = "a".repeat(32);
  store.replaceAll(
    [snap("alice", "queue", "queue")],
    [
      { username: "alice", passSha256: "a".repeat(64), feedToken: tokA },
      { username: "bob", passSha256: "b".repeat(64) },
    ],
  );
  assert.equal(store.getUserByToken(tokA)?.username, "alice");
  assert.equal(store.tokenFor("alice"), tokA);
  assert.equal(store.tokenFor("bob"), null);
  assert.equal(store.getUserByToken("A".repeat(32)), null);
  assert.equal(store.getUserByToken("a".repeat(31)), null);
  assert.equal(store.getUserByToken("b".repeat(32)), null);
});

test("a new token replaces the old one; a publish without tokens clears them", () => {
  const { store } = freshStore();
  const users = (feedToken?: string) => [
    { username: "alice", passSha256: "a".repeat(64), feedToken },
  ];
  store.replaceAll([], users("1".repeat(32)));
  store.replaceAll([], users("2".repeat(32)));
  assert.equal(store.getUserByToken("1".repeat(32)), null);
  assert.equal(store.getUserByToken("2".repeat(32))?.username, "alice");
  store.replaceAll([], users(undefined));
  assert.equal(store.tokenFor("alice"), null);
});

test("an existing users table without feed_token is migrated in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feeds-server-store-"));
  const db = new Database(path.join(dir, "feeds.db"));
  db.exec(
    "CREATE TABLE users (username TEXT PRIMARY KEY, pass_sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO users VALUES ('alice', '" +
      "a".repeat(64) +
      "', 1)",
  );
  db.close();
  const store = new FeedStore(dir);
  assert.equal(store.getUser("alice")?.passSha256, "a".repeat(64));
  assert.equal(store.tokenFor("alice"), null);
});
```

- [ ] **Step 2:** `cd feeds/server && npx tsx store.test.ts` → FAIL (`getUserByToken is not a function`).
- [ ] **Step 3:** Implement per the Interfaces block.
- [ ] **Step 4:** `npm test` → all pass; `npx tsc -p .` clean.
- [ ] **Step 5:** Commit `Feeds server: store each user's feed token`.

---

### Task 2: Feeds server — secret routes, index and OPML

**Files:**
- Create: `feeds/server/secret-urls.ts`, `feeds/server/secret-urls.test.ts`
- Modify: `feeds/server/server.ts` (accept `feedToken`, secret routes, index/OPML renderers take a URL builder), `feeds/server/package.json` (test script adds `tsx secret-urls.test.ts`), `feeds/server/Dockerfile` (COPY `secret-urls.ts`), `feeds/server/README.md` (document secret addresses)

**Interfaces:**
- Consumes: `store.getUserByToken`, `store.tokenFor` (Task 1).
- Produces (`secret-urls.ts`):
  - `TOKEN_RE = /^[0-9a-f]{32}$/`
  - `secretFeedPath(token: string, kind: string, slug: string, variant: "audio" | "video"): string` → `/rss/${token}/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}.${variant}.xml`
  - `parseSecretPath(pathname: string): { token: string; kind: string; slug: string; variant: "audio"|"video" } | { token: string; page: "index" | "opml" } | null` — matches `/^\/rss\/([0-9a-f]{32})\/([^/]+)\/(.+)\.(audio|video)\.xml$/`, `/^\/rss\/([0-9a-f]{32})\/$/` (index), `/^\/rss\/([0-9a-f]{32})\/opml\.xml$/` (opml); decodes kind/slug with `decodeURIComponent` (return null if that throws).
  - `redactToken(token: string): string` → first 6 chars + `…`.

- [ ] **Step 1: Write the failing tests** (`feeds/server/secret-urls.test.ts`):

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSecretPath, redactToken, secretFeedPath } from "./secret-urls.ts";

const T = "0123456789abcdef0123456789abcdef";

test("secret feed paths round-trip", () => {
  const p = secretFeedPath(T, "playlist", "tech talks", "video");
  assert.equal(p, `/rss/${T}/playlist/tech%20talks.video.xml`);
  assert.deepEqual(parseSecretPath(p), { token: T, kind: "playlist", slug: "tech talks", variant: "video" });
});

test("index and opml pages", () => {
  assert.deepEqual(parseSecretPath(`/rss/${T}/`), { token: T, page: "index" });
  assert.deepEqual(parseSecretPath(`/rss/${T}/opml.xml`), { token: T, page: "opml" });
});

test("protected paths and malformed tokens are not secret paths", () => {
  assert.equal(parseSecretPath("/rss/queue/queue.audio.xml"), null);
  assert.equal(parseSecretPath(`/rss/${T.toUpperCase()}/queue/queue.audio.xml`), null);
  assert.equal(parseSecretPath(`/rss/${T.slice(1)}/queue/queue.audio.xml`), null);
  assert.equal(parseSecretPath(`/rss/${T}`), null);
  assert.equal(parseSecretPath(`/rss/${T}/queue/%E0%A4%A.audio.xml`), null);
  // a 32-hex slug on the protected route stays protected (3 segments, not 4)
  assert.equal(parseSecretPath(`/rss/queue/${T}.audio.xml`), null);
});

test("redactToken keeps only a short prefix", () => {
  assert.equal(redactToken(T), "012345…");
});
```

- [ ] **Step 2:** run → FAIL (module missing). **Step 3:** implement `secret-urls.ts`.
- [ ] **Step 4: Wire `server.ts`:**
  - `isUserCredential`: also accept an optional `feedToken` that must match `TOKEN_RE` when present (reject the payload otherwise).
  - Before the Basic-Auth block (after the `/public/` route), for GET/HEAD: `const secret = parseSecretPath(pathname)`; if non-null: log `rss ${method} /rss/${redactToken(secret.token)}/… secret owner=<owner or "unknown"> ip=… ua=…` (never the full token or full path); look up `store.getUserByToken(secret.token)` → 404 `not found` if null; then:
    - feed: `store.get(owner, kind, slug)` → 404 if missing; self = `${hub?.publicUrl ?? originOf(req)}${secretFeedPath(token, kind, slug, variant)}` where `originOf` is the existing proto/host logic from `selfUrl`/`renderOpml` (extract a small helper, reuse it in both); `sendXml(res, renderRss(feed, variant, { selfUrl: self, hubUrl: hub ? HUB_URL : undefined }))`.
    - index: `renderIndexHtml(owner, (k, s, v) => secretFeedPath(token, k, s, v), \`/rss/${token}/opml.xml\`)`.
    - opml: `renderOpml(req, owner, (k, s, v) => secretFeedPath(token, k, s, v))`.
  - Change `renderIndexHtml(owner, urlFor, opmlHref)` and `renderOpml(req, owner, urlFor)` to take the URL builder; the protected routes pass the existing `feedUrl` and `"/opml.xml"`, so protected pages are unchanged.
- [ ] **Step 5: Smoke test locally** (write a snapshot + credential with a token via `POST /publish`, then curl the secret feed, index, opml, an unknown token → 404, and the protected feed with Basic Auth → still 200). Put the commands and output in the report.
- [ ] **Step 6:** `npm test` (all files incl. the new one) and `npx tsc -p .` → clean. Update README (secret addresses, token derivation, protected addresses still work). Commit `Feeds server: serve feeds at secret addresses without a password`.

---

### Task 3: Feeds server — announce secret addresses to the hub

**Files:**
- Modify: `feeds/server/notify-hub.ts`, `feeds/server/notify-hub.test.ts`, `feeds/server/server.ts` (call site)

**Interfaces:**
- Consumes: `secretFeedPath` (Task 2), `store.tokenFor` (Task 1).
- Produces:
  - `hubTopicUrls(publicUrl: string, feed: FeedKey, token: string): string[]` → `[`${origin}${secretFeedPath(token, kind, slug, "audio")}`, …video]` where origin is `new URL(publicUrl).origin`.
  - `notifyHub(config: HubConfig, feeds: FeedKey[], tokenFor: (owner: string) => string | null, fetchImpl?: typeof fetch): Promise<void>` — skips feeds whose owner has no token; keeps the 100-URL chunking; sends nothing if no URLs remain.
  - `feedTopicUrl` stays (protected self links still use it).
  - server.ts: `notifyHub(hub, changed, (o) => store.tokenFor(o))`.

- [ ] **Step 1: Update the tests** in `notify-hub.test.ts`: every existing `hubTopicUrls`/`notifyHub` call gains the token argument / `tokenFor` function; expectations become secret URLs, e.g. `https://owntube.example/rss/<T>/queue/queue.audio.xml`; add a test: two changed feeds, owners `alice` (token) and `bob` (no token) → one POST whose `hub.url` list has only alice's 2 URLs; and a test that only token-less owners → no POST at all. Keep the 60-feed chunking test (all with tokens).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npm test`, `npx tsc -p .` clean. Update the module doc comment (announcements are plain secret addresses; the hub fetches them without credentials).
- [ ] **Step 5:** Commit `Feeds server: announce secret addresses to the WebSub hub`.

---

### Task 4: Web app — derive, publish and show the secret addresses

**Files:**
- Modify: `apps/web/src/server/remote/rss-pass.ts` (add `feedToken`), `apps/web/src/server/remote/publish.ts` (`FeedOwnerCredential.feedToken`, push it), `apps/web/src/server/trpc/routers/settings.ts` (`rssFeeds` adds `feedsUrl` and `queueUrls`; `rssFeedUrl` returns secret addresses), `apps/web/src/components/settings/rss-feeds-section.tsx`
- Create: `apps/web/src/server/remote/rss-pass.test.ts`

**Interfaces:**
- Produces:
  - `feedToken(rssPass: string): string` = `sha256Hex("owntube-feed-token:" + rssPass).slice(0, 32)`.
  - `FeedOwnerCredential = { username; passSha256; feedToken }`; `buildAllFeeds` pushes `feedToken: feedToken(pass)` using the same `ensureRssPass` value as the hash (call `ensureRssPass` once per user).
  - `settings.rssFeeds` returns `{ username, pass, companionUrl, feedsUrl: string | null, queueUrls: { audio: string; video: string } | null }` — `feedsUrl = ${base}/rss/${token}/`, queue URLs `${base}/rss/${token}/queue/queue.{audio,video}.xml` (base = OWNTUBE_PUBLISH_TARGET without trailing slash; null when unset).
  - `settings.rssFeedUrl` returns `${base}/rss/${token}/${encodeURIComponent(kind)}/${encodeURIComponent(slug)}.{audio,video}.xml` (no credentials in the URL any more).
  - The settings section shows the queue addresses from `queueUrls` and links "All feeds (channels, playlists, saved)" to `feedsUrl`; keeps the username/password row, relabelled "Login for older subscriptions"; updates the explanatory copy: the addresses are private links — anyone with one can read that feed; regenerating the password changes them. Regenerate confirm text stays.

- [ ] **Step 1: Failing test** `rss-pass.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { feedToken, sha256Hex } from "./rss-pass";

describe("feedToken", () => {
  it("is 32 lowercase hex characters derived from the password", () => {
    const t = feedToken("0123456789abcdef0123");
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(t).toBe(sha256Hex("owntube-feed-token:0123456789abcdef0123").slice(0, 32));
  });
  it("changes when the password changes", () => {
    expect(feedToken("a".repeat(20))).not.toBe(feedToken("b".repeat(20)));
  });
});
```

- [ ] **Step 2:** `pnpm --filter web exec vitest run src/server/remote/rss-pass.test.ts` → FAIL. **Step 3:** implement all of the Interfaces block.
- [ ] **Step 4:** If a test file for the settings router or `buildAllFeeds` already exists, extend it to assert the new URL shapes / credential field; otherwise note in the report that these are covered by the end-to-end check in Task 5.
- [ ] **Step 5:** `pnpm --filter web test`, `pnpm --filter web typecheck`, biome on changed files → clean. Commit `Web: publish and show secret feed addresses`.

---

### Task 5: Deploy and move Pocket Casts to the secret addresses

Production — the user has authorised deployment for this session.

- [ ] **Step 1:** Merge to `main`, push. Deploy the feeds server to spiff first (rsync `feeds/server/` excluding node_modules/data/.env/package-lock.json; `docker compose up -d --build`) — it accepts publishes with or without tokens.
- [ ] **Step 2:** On naggon: `git -C /usr/local/src/owntube pull`, then `cd /var/data/config/owntube && docker compose -f docker-compose.yml up -d --build`. Mark feeds dirty (update `feed_publish_state.dirty_at`) to force a publish; check the log for `feed publisher: pushed …`.
- [ ] **Step 3:** Verify: fetch the secret queue address (token from the app's settings API or computed from the stored RSS password on naggon — never print the full token in logs/chat), expect 200 with the plain self link and the hub link; an altered token → 404.
- [ ] **Step 4:** Give the user the secret queue addresses to add in Pocket Casts (replacing the password-protected ones), then watch the hub log for `subscribe confirmed` for the `/rss/<token>/…` topics and, after the next queue change, a `delivered` line.
