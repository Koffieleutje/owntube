# OwnTube ↔ Invidious boundary: phased plan

Status: proposed, 2026-07-30. Nothing here is done except the Phase 0 items marked
**done**.

## The question this answers

OwnTube has accumulated a lot of logic that reshapes what Invidious delivers —
manifests (HLS/DASH), subtitles, audio tracks, metadata. The instinct was that
this should be cleaned up by *moving that logic into Invidious* so OwnTube can
consume the right formats rather than alter them.

An audit of both codebases says the instinct is right but the volume is inverted:
**almost no logic should move; a handful of fields should.** The measured split:

| surface | lines | correct home |
|---|---|---|
| metadata inference / URL scraping | ~350–400 | upstream (it's *data*) |
| manifest generation (`hls/generate` 507 + `dash/generate` 310) | ~820 | OwnTube |
| playback policy (`pick-playback` 753 + `use-dash-playback` 623) | ~1,375 | OwnTube |
| proxy / transport resilience | ~600 | OwnTube |
| **dead Piped dual-source support** | **~810** | **delete** |

The largest single simplification available is not in the manifest area at all —
it is deleting Piped.

## Non-goals (deliberate, with reasons)

**Do not move manifest generation or playback policy into Invidious.** Three
independent reasons:

1. **The capability probe cannot move.** `pickDashVideoFamily()`
   (`use-dash-playback.ts:606-623`) runs `MediaSource.isTypeSupported` in the
   browser. Even if Invidious grew a `?video=vp9|av01|avc` filter, OwnTube still
   has to decide which to request — so one cohesive decision gets split across a
   service boundary, policy in tested TypeScript, mechanism in untested Crystal.
2. **A separate media origin forces a rewrite anyway.** Segments must resolve to
   OwnTube's own proxy; native `hlsUrl`/`dashUrl` segments are raw googlevideo
   URLs that 403 from another IP (`pick-playback.ts:688-694`). Any upstream-built
   manifest references *upstream's* proxy, so OwnTube rewrites it regardless —
   exactly what `/dvr` does today. "Consume rather than alter" is unreachable for
   manifests while the media-origin split exists.
3. **OwnTube is the gateway for three clients.** `apps/tv` and `apps/ios` consume
   OwnTube's `/dash` and `/hls`; neither talks to Invidious. Moving this logic
   upstream would make a shared third-party service host per-client policy for
   OwnTube's own front-ends.

**Do not replace Invidious with raw `/youtubei/v1`.** The companion exposes an
InnerTube proxy, so OwnTube *could* do its own extraction and drop Invidious
entirely. Don't: Invidious's actual value is community-maintained parsers for a
hostile, fast-moving target (two YouTube breakage hotfixes, #5818/#5819, this
month alone). Reimplementing search/channel/comment/trending parsing is a bad
trade for a single-user deployment.

**Do not carry local patches as fork-only commits.** See Phase 4.

---

## Phase 0 — Guardrails (do first; partially done)

Rationale: this audit found **three silent upstream regressions**, one of which
had been live for a week. Detection has to come before refactoring, or later
phases will be debugging blind.

- [x] **Consolidate the Invidious build.** Branch `nedworks/integration` in
      `/var/data/config/invidious-build` = `adfec764` (the commit the running
      image was built from) + the three local patches + a tracked
      `docker/Dockerfile.nedworks`. Pushed to `mdbraber/invidious`.
- [x] **Document the build recipe** in `/var/data/config/invidious/docker-compose.yml`,
      including why never to build from `/usr/local/src/invidious-build`.
- [x] **Guard the stale tree** with `DO-NOT-BUILD-FROM-HERE.md`.
- [ ] **Boundary canary.** A scheduled job asserting, against the live upstream:
      - `/api/v1/captions/<id>?label=…` returns a redirect (or usable VTT)
      - `adaptiveFormats` entries carry `init` + `index` byte ranges
      - trending items have non-zero `lengthSeconds`
      - a known video id still resolves with streams
      Each of these was broken at some point and found only by accident.
- [ ] **Record the contract.** `proxy.types.ts` is already the schema; add a short
      note per field that OwnTube *infers* rather than reads, so the inference
      surface is visible and shrinks measurably in Phase 3.

## Phase 1 — Delete Piped (biggest win, zero upstream risk)

`PIPED_BASE_URL=disabled` in the deployment. Cost of carrying it:

- 548 lines of dedicated files (`mappers/piped.ts` 365,
  `pick-playback-piped.test.ts` 152, `piped-related-items{,.test}` 31)
- **262 conditional references in live paths**: `channel.ts` 117, `shorts.ts` 59,
  `video.ts` 40, `search.ts` 33, `pick-playback.ts` 13
- ~8 `sourceUsed: z.enum(["piped","invidious","cache"])` unions in `proxy.types.ts`
- `isPipedLike` branches threaded through playback selection
- `pipedItemIsStrictShort`, Piped-specific `duration: -1` handling in
  `short-video.ts`

This dual-source abstraction is a major reason `channel.ts` is 1,345 lines.

**Blocking product decision:** Piped is a *user-facing* surface, not just an env
var — Settings exposes per-account upstream overrides (`settings-panel.tsx`,
`server/settings/profile.ts`), and `config.ts` models `envDisabled` +
`profileOverride` per upstream. Confirm Piped will never be used before deleting.

Steps:
1. Confirm the product decision; decide whether the Settings upstream-override UI
   stays (for multiple *Invidious* instances) or goes.
2. Delete the dedicated files and their tests.
3. Collapse `sourceUsed` to `["invidious","cache"]`; let types drive the rest.
4. Remove `isPipedLike` branches and the Piped arms of channel/shorts/video/search.
5. Keep `hasKnownPositiveDuration` — Phase 3 shows Invidious also emits unusable
   durations, so it is not Piped-specific.

Risk: low. Pure OwnTube change, entirely unit-testable, no shared service touched.
This is the opposite risk profile to moving logic upstream.

## Phase 2 — Talk to the companion directly, and internally

Today three paths coexist:

| path | used for | depends on |
|---|---|---|
| via Invidious 302 | `/api/v1/captions` | the fork patch + Invidious + Caddy |
| public direct | `/dash` DVR fallback, `/dvr`, captions fallback | public DNS + TLS + Caddy |
| internal direct `http://invidious-companion:8282` | **nothing yet** | Docker network only |

The Invidious hop is the one that silently died for a week, and it buys only a
`check=` signature that is currently unused (`verify_requests` defaults to
`false` and is not set in compose — verified: direct calls return 200 with no
auth).

**All server-side companion calls currently exit via the public URL and return
through Caddy, despite OwnTube sharing a Docker network with the companion.**
That was once necessary — the manifest embedded segment URLs the *browser* had to
reach. The `/dvr` indirection removed that constraint: the browser now only sees
`/dvr/<id>/<rep>/<sq>` on OwnTube's media origin, so the companion URLs need only
be reachable by OwnTube.

Steps:
1. Add `INVIDIOUS_COMPANION_INTERNAL_URL=http://invidious-companion:8282`; use it
   for every server-side fetch in `dvr-manifest.ts`, the `/dvr` segment fetch, and
   the captions fallback. Keep the public base only where a URL must reach the
   browser (after Phase 2 that is nowhere in the DVR path). Saves a TLS +
   reverse-proxy round trip **per segment** and removes public DNS/cert from the
   playback path.
2. **Invert the caption order** — companion first, Invidious as fallback. Removes
   the dependency on the fragile patch from the hot path and kills the 3–5 s cold
   penalty caused by Invidious's three retries.
3. Then consider enabling `SERVER_VERIFY_REQUESTS=true`. The companion is
   currently an unauthenticated YouTube proxy on a public path. Direct access
   survives: the shared key is already in the same compose file and `check=` is
   `base64url(AES-ECB("<timestamp>|<videoId>"))` — ~15 lines of Node crypto.
   Routing through Invidious cannot give you independent *and* authenticated.

Note this narrows Invidious's role but cannot remove it: the companion has no
search, channels, trending, comments, playlists or resolveurl. Current dependency
counts — `videos` 14, `channels` 10, `manifest` 8, `trending` 3, `search` 3,
`captions` 3, `resolveurl` 2, `comments` 2, `playlists` 1, `stats` 1.

## Phase 3 — Close data gaps upstream, then delete OwnTube's inference

Each item: upstream has the data, doesn't emit it, and OwnTube guesses. Land the
upstream change on `nedworks/integration` (and open the PR per Phase 4), then
delete the inference behind it.

1. **Audio tracks — highest value.** `lib/audio-track-label.ts` (257 lines)
   scrapes googlevideo query strings (`lang=`, `xtags=acont%3Doriginal%3Alang%3D…`,
   `audioTrackId=.fr.4`), and `mappers/invidious.ts:133-185` tries seven shapes,
   ending by guessing a track name from `qualityLabel`. Invidious reads
   `audioTrack.{id,audioIsDefault,displayName}` at `manifest.cr:71-74`;
   `video_json.cr:79-150` emits **zero** audioTrack fields. A ~5-line serialisation
   change deletes ~300 lines of the most fragile code in OwnTube. Today, an `xtags`
   format change breaks audio labelling silently.
2. **Trending/list serialiser is wrong, not just sparse.** Measured: 15/15 trending
   items report `lengthSeconds: 0` **and** `liveNow: false`, while
   `/api/v1/videos` reports `liveNow: true` for the same ids. Fix upstream.
3. **Shorts flag.** Because of (2), `short-video.ts` falls back to `#shorts` in the
   title. A reliable upstream flag removes the heuristic.
4. **Members-only / paid.** Currently guessed from the title
   (`mapper:47`, `titleSuggestsMembersOnlyOrSubscriberOnly`).
5. **`publishedAt`.** Four candidate fields plus
   `reconcilePublishedAtWithText`, which lets the human string arbitrate the
   numeric timestamp. Emit one trustworthy value.
6. **Channel `/videos` parse-error placeholders.** `channel.ts:371` falls back to
   regex-parsing the RSS feed. This is a reliability bug, not a shape gap — worth
   an upstream issue with a reproducer.
7. **Multi-shape pickers** (`pickViewCount`, `pickChannelSubscriberCount`,
   `readStreamHeightPx`, `readPositiveNumberField`) and duration scraped from
   `dur=` (`dash/generate.ts:56`) — clean up opportunistically once shapes are
   stable.

Measure success as lines of inference deleted, not lines added.

## Phase 4 — Upstream the bug fixes as real PRs

Fork-only patches are how the caption fix vanished. Un-forked upstream code is the
only kind a rebuild cannot lose, and each of these is generic.

- The four invidious-companion DVR fixes (absolute url_transformer, `X-Head-*`
  forwarding, `*.c.youtube.com` hosts, and the `noclen=1` empty-body bug). The
  `noclen` one likely explains silent live-stream stalls well beyond DVR. Clean
  patches already exist in `/usr/local/src/invidious-companion-dvrfix`; target
  iv-org/invidious-companion#249.
- **Missing `initialization` in the companion's DVR manifest.** OwnTube's
  `/dvr` rewrite is a workaround: YouTube live segments are self-initializing
  (`ftyp`+`moov` per segment), so the companion omits the attribute, and the DASH
  spec then resolves the init segment to the BaseURL — the manifest's own
  directory.
- Captions via `base_url` + `fmt=vtt` (`mdbraber/invidious-companion @
  fix/captions-use-base-url`, and the Invidious-side redirect on
  `nedworks/integration`).
- Invidious's mixed-codec DASH AdaptationSet — its own comment at
  `manifest.cr:16` admits the interop problem. Optionally propose including
  `video/webm` so upstream DASH is not capped at 1080p (`manifest.cr:63,104`
  hardcode `audio/mp4` / `video/mp4`).

Every merged PR is one fewer patch to rebase and one fewer thing to lose.

## Phase 5 — Restructure OwnTube's media routes

`app/invidious/[[...path]]/route.ts` is 601 lines — the largest route — doing five
unrelated jobs: thumbnails with a 5-step fallback chain, storyboards, channel
avatars, `videoplayback` byte-range chunking, and `.m3u8` rewriting plus asset
caching. It is named after an upstream while being a generic asset/media edge
proxy, and it compensates for yet another upstream defect (line 465: `local=true`
makes Invidious emit broken `:port` URLs and 403 the videoplayback hop).
`app/media/[[...parts]]/route.ts` (171 lines) already overlaps conceptually.

Split by concern, not by upstream:

- `/media/segment` — byte-range media
- `/media/image` — thumbnails, avatars, storyboards (fallback chain + cache)
- keep `/dash`, `/hls`, `/dvr`, `/captions`

The upstream becomes a config detail rather than a URL prefix — which is also what
turns any future companion-only path into a config change instead of a
client-visible URL migration across three apps. Sequence after Phase 1 so the
Piped arms are already gone, and mind that `/invidious/...` URLs are referenced by
`use-hls-vod-playback`, `use-dash-playback`, `hls-same-origin`,
`video-thumbnail-url`, `player-recovery`, `invidious-origin-context` and the TV/iOS
clients — needs a compatibility alias during rollout.

---

## Suggested order

1. Phase 0 canary — cheap, and every later phase depends on being able to see drift.
2. Phase 1 Piped removal — largest simplification, zero shared-service risk.
3. Phase 2 internal-direct + caption inversion — removes the known-fragile hop.
4. Phase 3 item 1 (audioTrack) — small upstream change, ~300 lines deleted.
5. Phase 4 PRs — ongoing, in parallel.
6. Phase 3 items 2–7, then Phase 5.

## Open items and honest gaps

- **The iOS/DVR path is unverified on iPad.** The test video (`7S6aQm1ZxkQ`)
  converted to VOD mid-session; a scan of 110 candidates found no fresh
  post-live-DVR video. `/dash`+`/dvr` are verified server-side only.
- **Not audited:** `server/recommendation/*` (`engine.ts` 715,
  `shorts-feed.ts` 692), `apps/ios`, and the full reach of the per-account
  override system. These could add Phase 3 items; they do not affect the
  non-goals, which rest on the probe/media-origin/three-clients arguments rather
  than on volume.
- **Verification asymmetry:** the captions redirect is directly testable; the
  `lockup`/`collab` Invidious patches are not, since no channel tried exercised
  those code paths. They are clean cherry-picks previously validated by hand.
- **Local-only images are a deliberate choice.** Durability therefore rests
  entirely on `nedworks/integration` staying pushed and `Dockerfile.nedworks`
  staying tracked. If images are ever pruned, every image must be rebuildable
  from the branch alone — keep it that way.
