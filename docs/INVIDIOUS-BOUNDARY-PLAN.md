# OwnTube ↔ Invidious boundary: phased plan

Status: **Phases 0-2 and 3.1-3.5 shipped; 3.6-3.7, 4 and 5 outstanding.** Last
updated 2026-07-30.

| phase | state | commits |
|---|---|---|
| 0 — guardrails | **done** | `ee1f49e`, `25c43b6` + the Invidious fork work below |
| 1a — delete Piped | **done** | `06231e7` (+212 / −3,207, 45 files) |
| 1b(a) — collapse `sourceUsed` unions | **done** | `590a02e` |
| 1b(b) — remove per-account overrides | **done** | `fd9ac84` (+293 / −945, 47 files) |
| 2 — companion direct + internal | **done** | `ad8504f`, `6c2c9e3` |
| 3.1 — `audioTrack` upstream | **done** | `71fa2f4`, `8181c80` + Invidious `94911a03` |
| 3.2 — trending `liveNow` | **done** | `5ec55a1` + Invidious `02099ffe` |
| 3.3 — Shorts flag | **done** | `e5c9d36`, `70d449f` + Invidious `57b16ba9` |
| 3.4 — members-only | **done (deleted, not closed)** | `0596008`, `daf0050` |
| 3.5 — `publishedAt` | **done** | `9bb0cec`, `d7ff553` |
| 3.6-3.7 — remaining data gaps | **not started** | — |
| 4 — maintain the fork | ongoing | — |
| 5 — restructure media routes | **stages 1-2 done, 3 pending** | `def1e99`, `721c46c` |

Every shipped phase was verified the same way: tsc diffed against an 8-error
baseline (all pre-existing missing local packages), the full vitest suite, biome
diffed against a stashed baseline, then built, deployed and smoke-tested.
Test count went 450 → 463 across the work.

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

**Running a patched fork indefinitely is an accepted, deliberate choice** (decided
2026-07-30). Upstreaming is opportunistic, not a prerequisite — see Phase 4. What
is *not* optional is verifiable provenance: the running image must be provably
built from the integration branch (Phase 0).

---

## Phase 0 — Guardrails — **DONE**

Rationale: this audit found **three silent upstream regressions**, one of which
had been live for a week. Detection has to come before refactoring, or later
phases will be debugging blind.

- [x] **One tree, one branch.** `nedworks/integration` in
      `/var/data/config/invidious-build` = **upstream + our patches, kept in step
      by rebase** — not cherry-picks onto a pinned base, and not several
      branches. Pushed to `mdbraber/invidious`. Inspect the patch set with
      `git log origin/master..nedworks/integration`.
- [x] **Rebased onto current upstream** (`9d1291a0`). The delta from our previous
      base `adfec764` was CI/CHANGELOG/release-script only — **zero `src/`
      changes** — so getting in step cost nothing behaviourally, and the four
      patches reapplied byte-identically (verified by md5 of the patch diff).
- [x] **Scripted the whole loop:** `invidious-build/nedworks-rebuild.sh` rebases,
      counts the patch set before/after and **aborts if it dropped**, builds with
      `Dockerfile.nedworks --build-arg release=1`, deploys, asserts
      `/api/v1/stats` reports `branch: nedworks/integration`, and pushes the
      branch. Takes an optional upstream commit to rebase onto (preferred when
      adopting a single hotfix) and `--no-deploy`.
- [x] **Document it** in `/var/data/config/invidious/docker-compose.yml`, pointing
      at the script rather than duplicating the command.
- [x] **Guard the stale tree** with `DO-NOT-BUILD-FROM-HERE.md`.
- [x] **Provenance canary — the single highest-value guard.** Assert that
      `/api/v1/stats` reports `software.branch === "nedworks/integration"`, and
      optionally that `software.version` matches the branch tip. Invidious embeds
      the git branch and commit at build time, so this catches *any* image built
      from the wrong tree — every lost patch at once, not one symptom at a time.
      Against the July 23 regression it would have fired the same day:

      | | branch | version |
      |---|---|---|
      | patches lost (2026-07-23) | `master` | `2026.07.23-adfec76` |
      | patches present (2026-07-30) | `nedworks/integration` | `2026.07.30-ccb82dce` |

      Because a long-lived patched fork is the accepted strategy, this assertion
      *is* the strategy's safety net. Add it before anything else.

      **No longer runs on a schedule** (see the behaviour canary below).
      `nedworks-rebuild.sh` still asserts it at deploy time, so the rebuild path
      is covered; drift *after* a deploy is not.
- [~] **Behaviour canary — built, then switched off by choice (2026-07-30).** The
      checks all exist in `apps/web/scripts/check-upstream.ts` and pass; what is
      gone is the *schedule*. Run with `pnpm check:upstream`. See "The canary is
      deliberately off" under Open items — do not re-enable without asking.
      Asserts, against the live upstream:
      - `/api/v1/captions/<id>?label=…` returns a redirect (or usable VTT)
      - `adaptiveFormats` entries carry `init` + `index` byte ranges
      - trending items have non-zero `lengthSeconds`
      - a known video id still resolves with streams
      - `adaptiveFormats[].audioTrack` is present on a multi-language video
        (added with Phase 3.1, which deleted the fallback that hid its absence)
      Each of these was broken at some point and found only by accident. This
      catches upstream *behaviour* drift, which the provenance check cannot see.
- [x] **Record the contract** — **DONE**. `proxy.types.ts` now tags every field
      with where its value comes from, using four categories:
      `[upstream]` (read from an Invidious field), `[derived]` (computed
      deterministically — a selection from a list, a normalisation),
      `[inferred]` (**the surface to shrink** — OwnTube guessing where upstream
      gives no answer, and the only category that can break silently), and
      `[owntube]` (our own concept, not a gap).

      Existence claims were checked against the Invidious source, not sampled:
      `grep 'json.field "<name>"' src/invidious/`. That immediately turned up
      Phase 3.7's shopping list — `pickViewCount` tries `views`, `viewCount`,
      `view_count` and only `viewCount` exists (5 sites, other two zero);
      `pickChannelSubscriberCount` tries five numeric keys and only `subCount`
      exists (2 sites, other four zero).

      What is left in `[inferred]` after 3.1-3.5: the multi-shape pickers
      (`viewCount`, `subscriberCount`, `bitrate`, `fps`, `height` — all Phase
      3.7) and `thumbnailUrl`, which is a deliberate quality trade rather than a
      gap: it rewrites upstream's URL into a constructed `i.ytimg.com` one for
      higher resolution, which is why the image route carries a 5-step fallback.
      Also removed four stale Piped references left behind by Phase 1.

## Phase 1 — Delete Piped — **DONE** (`06231e7`, `590a02e`, `fd9ac84`)

**Outcome: ~4,450 lines deleted.** Split into three commits because a single
39-file blob proved unreviewable and unrecoverable when a step went wrong.

What differed from the plan below:
- The plan said "keep per-account instance overrides". That was reversed once it
  was confirmed Invidious is configured once in compose with no user settings, so
  1b(b) removed them entirely — including the Settings editor and onboarding
  field. The read-only display and health check remain, and multi-instance
  failover still works via a multi-URL `INVIDIOUS_BASE_URL`.
- `?upstream=piped` was removed end to end, including the `tryLiveUpstreamFallback`
  that reloaded the page onto the other upstream.
- `pipedBaseUrl*` had survived in `appSettingsSchema` — 1a only cleaned the tRPC
  schema. 1b(b) got the rest.
- `sourceUsed: "piped"` turned out to be used in `shorts-feed.ts` as a *sentinel
  for locally personalized results*, which was mislabelling regardless; now
  `"invidious"`.
- 12 split-path tests broke on fixture conversion because the only route to the
  progressive/split builder for a detail *with* adaptive streams was the Piped
  branch. That builder is still live for adaptive streams **without** byte-range
  indexes, so those tests now use a `noIndexBase()` fixture that reaches it the
  way production does.

**Method note, learned the hard way (two failed attempts):** removing whole named
functions with brace matching and letting tsc enumerate the fallout is safe —
it fails loudly. Regex over *signatures* fails silently into something that still
parses (it produced `opts.?.invidiousBaseUrls`, `const = opts.overrides;` and a
dangling `opts.`). Signature edits must be whole-line deletions or hand edits,
verified with tsc after each file.

<details><summary>Original plan (kept for the reasoning)</summary>


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

</details>

## Phase 2 — Companion direct + internal — **DONE** (`ad8504f`, `6c2c9e3`)

Shipped:
- `server/services/companion.ts` — public base for browser-facing URLs, internal
  (`INVIDIOUS_COMPANION_INTERNAL_URL`, default `http://invidious-companion:8282`)
  for server-side fetches, plus `toInternalCompanionUrl` for rewriting the public
  segment URLs the companion embeds from its own `SERVER_BASE_URL`.
- Captions inverted to **companion-first**, Invidious as fallback: 0.14-0.58s
  where the affected tracks previously took 3-5s cold, and the fork-patched
  Invidious redirect is out of the hot path.
- `check=` signing (`companionCheckParam`), matching Invidious'
  `invidious_companion_encrypt` exactly, and **`SERVER_VERIFY_REQUESTS=true` is
  now on** — the companion is no longer an unauthenticated YouTube proxy.
  Verified three ways: unsigned → 400 "No check ID.", bogus → 400 "ID incorrect.",
  signed → 200. `/videoplayback` stays ungated by design.

Correction to the original claim below: the latency win is ~2ms (5ms internal vs
7ms public, median of 8 warm alternating requests), not "a TLS round trip per
segment" — keep-alive amortises the handshake. The real benefit is that
server-side playback no longer depends on public DNS, a valid certificate, or
Caddy being up.

<details><summary>Original plan (kept for the reasoning)</summary>


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

</details>

## Phase 3 — Close data gaps upstream, then delete OwnTube's inference

Each item: upstream has the data, doesn't emit it, and OwnTube guesses. Land the
upstream change on `nedworks/integration` (and open the PR per Phase 4), then
delete the inference behind it.

### 3.1 — Audio tracks — **DONE** (`71fa2f4`, `8181c80`; Invidious `94911a03`)

The upstream patch is 17 lines in `video_json.cr` (5 of data, the rest comment),
emitting `adaptiveFormats[].audioTrack.{id,displayName,audioIsDefault}` — the
same three fields `manifest.cr:71-74` already read to build its own DASH
manifest. Deployed image reports `2026.07.30-94911a03`, branch
`nedworks/integration`, 6 patches carried.

Verified against a real 24-language video (`0e3GPea1Tyg`): 24 distinct track ids,
all named, exactly one flagged original, end to end through `video.detail` on the
deployed stack. Single-audio videos carry no `audioTrack` at all, which is
correct rather than a gap — there is no second track to distinguish — so no
fallback was kept.

`8181c80` adds an `audioTracks` canary check, because with the scraping deleted
`audioTrack` is the *only* source of audio-language data, so losing it (dropped
patch, or YouTube withdrawing the field) would otherwise be silent. It passed
("24 distinct audio tracks, all named, 1 flagged original").

**The canary has since been disabled at the owner's request — see "The canary is
deliberately off" below.** The check remains in `scripts/check-upstream.ts` and
runs on demand via `pnpm check:upstream`; it simply is not scheduled.

**Correction to the estimate below — it was wrong by more than an order of
magnitude.** The claim was "~5 lines upstream deletes ~300 lines of the most
fragile code". Measured: ~96 lines of genuine inference deleted
(`languageFromGoogleVideoUrl` 33, `inferLanguageFromTrackId` 16, the `xtags`
branch of `streamLooksLikeOriginalAudio` ~14, the mapper's six fallback shapes
~33), against ~73 lines added for correct localised labelling — **net −23 lines
of production code**, −73 including tests.

The error was treating all 257 lines of `audio-track-label.ts` as inference. Most
of it is *presentation* — `Intl.DisplayNames` lookups, label composition — which
belongs in OwnTube and had to stay: upstream `displayName` is always English,
while these labels are localised. Only the URL parsing was inference. Phase 3's
"measure success as lines of inference deleted" is the right metric; the
line-count *forecast* for this item was not.

The value delivered is real but is not line count:
- **No silent failure mode.** The deleted code guessed at undocumented
  googlevideo query strings; what replaces it reads a field upstream already
  parses, guarded by a canary.
- **Two bugs fixed, both found by feeding real upstream data through the
  existing labeller** rather than by reading it:
  1. Audio rows were keyed on the *primary* language subtag, so `zh-Hans` and
     `zh-Hant` collapsed into one "Chinese" row and one of the two dubs was
     **unreachable in the picker**. Now keyed on the full tag, and named
     "Simplified Chinese" / "Traditional Chinese". Pre-existing — the old
     `xtags` path also reduced to `zh`.
  2. Appending upstream `displayName` unconditionally produced "English (English
     (US) original)" and "Chinese (Chinese (Simplified))" as soon as the fields
     arrived, and *already* produced "French (French [131k])" for DASH manifest
     labels. It is now appended only when its words add something the resolved
     language name does not, so "Commentary" survives and restatements don't.
- **`qualityLabel` guessing is gone.** The old last-resort branch invented a
  track *name* from a quality string, so a track could be labelled "medium".

Worth noting for 3.2-3.7: the general lesson is that closing a data gap is not
purely subtractive. Inference deleted, presentation kept, and the *new* data will
expose whatever the old guesses were papering over — budget for that rather than
for a pure deletion.

<details><summary>Original estimate (kept for the reasoning, and because it was wrong)</summary>

1. **Audio tracks — highest value.** `lib/audio-track-label.ts` (257 lines)
   scrapes googlevideo query strings (`lang=`, `xtags=acont%3Doriginal%3Alang%3D…`,
   `audioTrackId=.fr.4`), and `mappers/invidious.ts:133-185` tries seven shapes,
   ending by guessing a track name from `qualityLabel`. Invidious reads
   `audioTrack.{id,audioIsDefault,displayName}` at `manifest.cr:71-74`;
   `video_json.cr:79-150` emits **zero** audioTrack fields. A ~5-line serialisation
   change deletes ~300 lines of the most fragile code in OwnTube. Today, an `xtags`
   format change breaks audio labelling silently.

</details>

### 3.2 — Trending `liveNow` — **DONE** (`5ec55a1`; Invidious `02099ffe`)

**The item as written below was misdiagnosed. Both halves of it were wrong.**

It claimed the trending *list serialiser* drops `lengthSeconds`. It does not.
Measured across list endpoints on the running fork:

| endpoint | items with a duration | `liveNow` correct |
|---|---|---|
| channel videos | 60/60 | yes |
| search | 18/20 | yes (2 live, both flagged) |
| popular | 29/40 | yes |
| **trending** | 1/15 | **no — 14/15 wrong** |

Durations are emitted fine everywhere, and the single non-live trending item
reported the same `1260` in the list as in the detail endpoint. The serialiser
was never dropping them.

Two separate things had been conflated:

1. **Trending *is* the livestreams feed now.** `fetch_trending` browses
   `UC4R8DWoMoI7CAwX8_LjQHig` with a livestreams param, because "Youtube removed
   the aggregated trending page" (iv-org/invidious#5397). So trending is almost
   entirely live streams, for which `lengthSeconds: 0` is **correct**. The
   canary's `listDuration` check demanded a duration from a majority of *all*
   items, so it failed permanently for something that was never a bug — and that
   permanent red is what made the duration claim look confirmed.
2. **The real defect is `liveNow`,** and it is in the *extractor*, not the
   serialiser. `VideoRendererParser` set the LiveNow badge only from
   `videoRenderer.badges`. Pulling the raw InnerTube payload shows `badges` is
   `null` on these items and the live marker has moved to
   `thumbnailOverlays[].thumbnailOverlayTimeStatusRenderer.style == "LIVE"`,
   which Invidious never read. Every item therefore serialised
   `liveNow: false` while `/api/v1/videos` said `true` for the same id.

The fix reads that overlay as a second source for the badge. `length_seconds`
deliberately gets no equivalent change: the overlay text is `"LIVE"`, which
`decode_length_seconds` already reduces to 0 — correct for a stream.

Verified against a captured pre-fix baseline: **8/8 sampled trending items
mismatched before, 0/15 after**. No false positives or negatives introduced
elsewhere — channel videos, search and popular all unchanged, durations intact.

`5ec55a1` rewrites the canary check accordingly: `listLiveFlag` (list vs detail
agreement on a sample) and `listDuration` (non-live items only, SKIPping when
every sampled item is live). `UPSTREAM_CHECK_KNOWN_FAILING` now defaults to
**empty** — there is no acknowledged upstream failure left.

**Method note worth carrying into 3.3-3.7.** This was found by refusing to take
the plan's own measurement on trust and re-measuring across *several* endpoints
instead of one. A single endpoint could not distinguish "the serialiser is
broken" from "this feed is legitimately all live". And the JSON path for the fix
came from fetching the raw InnerTube payload rather than guessing at field names
— worth doing whenever a parser change is involved, since a wrong guess here
compiles and silently does nothing.

<details><summary>Original item (kept because it was wrong)</summary>

2. **Trending/list serialiser is wrong, not just sparse.** Measured: 15/15 trending
   items report `lengthSeconds: 0` **and** `liveNow: false`, while
   `/api/v1/videos` reports `liveNow: true` for the same ids. Fix upstream.
</details>

### 3.3 — Shorts flag — **DONE** (`e5c9d36`, `70d449f`; Invidious `57b16ba9`)

Same shape as 3.1 and 3.2: upstream knew and discarded it. **Three** parsers did:

- `ShortsLockupViewModelParser` and `ReelItemRendererParser` only ever run on a
  shorts renderer, so everything they emit is a Short *by construction*.
- `VideoRendererParser` reads a thumbnail overlay whose text is the literal
  `"SHORTS"` in place of a duration — and its own TODO asked for this fix:
  "Add some sort of metadata for the type of video (normal, live, premiere,
  shorts)".

All three emitted `VideoBadges::None`. Added a `Shorts` badge (appended to the
`@[Flags]` enum, not inserted — reordering would change the meaning of a stored
badge set), set it in all three, and serialised it as `isShort`.

**Why neither existing signal could work.** This is the part that makes the field
necessary rather than merely convenient:

- **Duration is fabricated.** YouTube stopped reporting a real duration for
  Shorts, so the parsers substitute an approximate 60s. Measured: all 48 items on
  a channel's Shorts tab report exactly `60`. A genuine 60-second upload is
  therefore indistinguishable by length, and no threshold tuning fixes it.
- **The `#shorts` title tag is SEO, not metadata.** Measured on a live search:
  4 of 20 results carried the tag while running 8-27 minutes.

Verified against a captured baseline — channel Shorts tab **0/48 → 48/48**
flagged; the SEO-tagged long videos (356s, 756s) correctly `isShort: false`; and
the channel *videos* tab 0/60, i.e. no false positives. Canary `shortsFlag` added
(`70d449f`) asserting all shorts-tab items are flagged, deliberately not
satisfied by duration since that is the signal being replaced.

OwnTube consults `isShort` first but **keeps** the length and title rules as
fallbacks rather than deleting them — unlike 3.1, where the fallback went. Two
reasons: cached payloads predating the field, and the fact that the length rule
is not made stricter when the flag is present, which would drop real Shorts from
those cached rows.

### 3.4 — Members-only — **DONE by deletion** (`0596008`, `daf0050`)

**The only phase so far whose answer was "remove the feature", not "add a
field".** The plan assumed upstream had a members-only signal that OwnTube was
guessing at. Measurement said the guess was not merely inaccurate — it was
guessing at something that never arrives.

| corpus | heuristic fires |
|---|---|
| 745 titles: channel tabs, neutral searches, trending, popular | **0 (0.00%)** |
| 585 titles incl. targeted "members only"-style searches | 39, **all publicly watchable** |

Those 39 were songs (`Drake - Members Only (Audio)`,
`XXXTENTACION - Members Only VOL 1`), tutorials (`How to Enable Subscribers Only
Mode for Comments`), news and commentary (`Members Only Videos are a HUGE Problem
on YouTube`). `stripRestrictedListVideos` **dropped** each one.

It could not have worked: members-only content is not served to signed-out
clients at all — six channels' video tabs carry no `BADGE_STYLE_TYPE_MEMBERS_ONLY`
and expose no Membership tab to an anonymous browse — and Invidious is always
signed out. True-positive rate zero, false-positive rate not zero, and **a
dropped row is invisible**, so nothing could surface the error.

Removed: the title heuristic, `stripRestrictedListVideos` (12 call sites),
`isUpstreamMembersOrPaidOnly` with its seven speculative key names, and the
default-**on** setting "Hide members-only / subscribers-only videos in feeds".
−255/+49 lines.

In its place, `0596008` makes the failure legible instead of silent: paywall
refusals now match `VIDEO_UNAVAILABLE_SIGNATURES`, so the watch page shows
YouTube's own reason ("Join this channel to get access to members-only
content…") rather than "Invidious is unavailable. Check instance health" — which
blamed the instance for something no instance can fix. Signatures are specific
(`members-only content`, not `members only`) precisely so they don't repeat the
mistake; tests pin all four real titles above as non-matching.

**The lesson for 3.5-3.7.** Before closing a data gap, check the gap is real. The
plan listed this as "upstream has the data, doesn't emit it, OwnTube guesses" —
the first clause was false. A filter that *hides* things deserves more suspicion
than one that labels them, because its false positives are unobservable by
construction: measure what it removes, not just what it keeps.

### 3.5 — `publishedAt` — **DONE** (`9bb0cec`, `d7ff553`)

Two defects, and they were entangled: fixing the visible one alone would have
activated the invisible one.

**Two of the four candidate fields do not exist.** The chain tried `published`,
`publishedAt`, `timestamp`, `premiereTimestamp`. Proven from Invidious' source
rather than a corpus: `published` is emitted at 6 serialisation sites,
`premiereTimestamp` at 2, and `publishedAt` / `timestamp` at **zero** — Piped
shapes that outlived Piped. Over 455 live rows, `published` was present on all
455 and the other two on none. `premiereTimestamp` is **kept**: premieres have no
`published` yet, and no upcoming video could be found to test against, so it is
not something to delete on a hunch.

**`reconcilePublishedAtWithText` degraded good data.** It overrode the numeric
timestamp whenever a relative string ("3 months ago") disagreed by more than two
hours, on the theory that some instances send a bad timestamp. But prose is
coarse by nature, so disagreement is the normal case, not a symptom:

| over 455 live rows | |
|---|---|
| median gap, exact timestamp vs text estimate | **24 hours** |
| maximum gap | **167 days** |
| rows crossing the 2-hour override threshold | **249 / 455 (55%)** |

It was rounding every date to whatever bucket YouTube's prose used and collapsing
same-bucket videos into ties for feed ordering. Removed rather than retuned — no
threshold separates "instance sent a bad timestamp" from "prose is less precise
than a timestamp", because the second is true of every row.

**`publishedText` was arriving in Arabic.** "1 السنة منذ", not "1 year ago", on
every list endpoint — and it is shown to the user (comments, upcoming-live panel,
taste onboarding). Invidious resolves a locale per request and the instance sets
no `default_locale`. Fixed by sending `hl` from `fetchJson`, the choke point all
21 Invidious API calls share; `INVIDIOUS_LOCALE` overrides.

**Correction, found while verifying the deploy — `9bb0cec`'s commit message is
too generous to upstream.** It says "trust upstream's timestamp instead of
re-deriving it from prose". That is true of `/api/v1/videos`, but **list
endpoints' `published` is itself derived from the prose**: `VideoRendererParser`
sets `published = decode_date(publishedTimeText)`, i.e. `Time.utc - delta`. So
there was no precise timestamp being discarded on list rows.

Removing the reconciliation is still right, for a sharper reason: `decode_date`
uses **calendar** months and years (Crystal `delta.months` / `delta.years`) while
OwnTube's `parseRelativePublishedToUnix` uses fixed 30- and 365-day spans, so the
override was replacing a calendar-correct derivation with a worse approximation —
and collapsing same-bucket rows into ties on the way.

**What this exposes, and what it does not.** Measured, same channel, list vs
detail for the same ids:

| `publishedText` | list `published` | true date (detail) | gap |
|---|---|---|---|
| "4 days ago" | 2026-07-26 | 2026-07-25 | 36 h |
| "1 month ago" | 2026-06-30 | 2026-06-27 | 84 h |
| "1 month ago" | 2026-06-30 | 2026-06-13 | 420 h |
| "1 month ago" | 2026-06-30 | 2026-05-30 | **756 h** |
| "2 months ago" | 2026-05-30 | 2026-05-02 | 684 h |

Every "1 month ago" row collapses to one instant, though the true dates span four
weeks. **This is an upstream limitation, not an OwnTube inference to delete**:
YouTube does not put exact dates in list renderers, so no amount of parsing
recovers them. Feed ordering is therefore coarse-grained for anything older than
a day, and *was already*, both before and after this phase.

Deliberately **not** fixed here, because it is a new feature rather than a data
gap: precise dates could be backfilled from `/api/v1/videos` for rows where order
matters (the pattern already exists —
`backfillMissingDurationsFromChannelCache`). Worth its own item if list ordering
ever looks wrong; noting it so the limitation is on the record rather than
rediscovered as a bug.

**The sequencing is the interesting part.** `reconcilePublishedAtWithText` was
inert here *only* because Arabic text failed to parse — the parser knows English
and French. Landing the locale fix first would have looked like a clean win and
silently switched on a function that rewrites 55% of timestamps. The removal had
to land first. Worth carrying forward: when a component is dead, establish *why*
before fixing anything nearby, because "dead" and "dead for an accidental reason"
behave very differently under change.

### 3.6-3.7 — remaining gaps
4. ~~**Members-only / paid.**~~ Resolved by deletion — see 3.4 above. Kept here
   because the item as written was wrong: it assumed upstream had the data.
5. ~~**`publishedAt`.**~~ Done — see 3.5 above. Note the item's framing was
   half wrong: two of the four fields never existed, and the reconciliation was
   not arbitrating, it was degrading.
6. **Channel `/videos` parse-error placeholders.** `channel.ts:371` falls back to
   regex-parsing the RSS feed. This is a reliability bug, not a shape gap — worth
   an upstream issue with a reproducer.
7. **Multi-shape pickers** (`pickViewCount`, `pickChannelSubscriberCount`,
   `readStreamHeightPx`, `readPositiveNumberField`) and duration scraped from
   `dur=` (`dash/generate.ts:56`) — clean up opportunistically once shapes are
   stable.

Measure success as lines of inference deleted, not lines added.

## Phase 4 — Maintain the fork deliberately; upstream opportunistically

Running a patched fork for as long as needed is the accepted strategy. Note the
July 23 incident was **not** caused by forking — it was caused by two build trees
and an untracked Dockerfile, so the image was built from plain upstream `master`
and the fork's commits were simply absent. Both causes are fixed (Phase 0), and
the provenance canary is what keeps them fixed.

The real recurring cost of a long-lived fork is **rebase drift**. The model is
therefore: **one tree, one branch, `upstream + our patches`, kept in step by
rebase** — run `nedworks-rebuild.sh` whenever upstream has something you want.
Keeping that cheap:

- **Keep patches small, independent and single-purpose.** The current set is 3
  source files / 105 insertions, which is why it rebases without conflict.
  Resist bundling; one concern per commit.
- **Rebase onto the specific upstream commit you need when adopting a hotfix**
  (`nedworks-rebuild.sh <commit>`), not always onto `master`'s tip — it keeps the
  delta from the previously running image auditable.
- **Let the script enforce the invariants**: clean tree, patch count must not
  drop, and `/api/v1/stats` must report `branch: nedworks/integration` after
  deploy. Never hand-roll the docker build.
- **Never build from `/usr/local/src/invidious-build`** — guarded by
  `DO-NOT-BUILD-FROM-HERE.md`, and redundant anyway since this tree's `origin`
  already tracks upstream for diffing.
- **Expect a patch to land upstream eventually.** When a rebase makes one
  redundant, drop it (`git rebase --skip`) and remove it from the list in the
  compose file — the script's patch-count check will flag the change so it can't
  happen silently.

Upstreaming is then a *cost reduction*, not a safety requirement: each merged PR is
one fewer patch to rebase forever. Worth doing for the generic ones when
convenient, in rough order of value:

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

None of these are blockers. They shrink the permanent rebase burden; the fork is
safe without them as long as the provenance canary is in place.

## Phase 5 — Restructure OwnTube's media routes — **STAGES 1-2 DONE**

Shipped: `def1e99` (extract + mount), `721c46c` (switch generation).
**Stage 3 — delete the `/invidious` alias — is deliberately not done yet;** see
the sequencing note below.

**Two corrections to the plan below, both found in the code.**

1. **The clients do not reference the prefix at all.** The plan said a
   compatibility alias was needed because `/invidious/...` is referenced by "six
   web modules plus the TV and iOS clients". `apps/tv` and `apps/ios` contain
   **zero** occurrences: the TV app builds
   `${OWNTUBE_BASE_URL}/dash/<id>/manifest.mpd` and then simply *follows* the
   segment URLs inside the manifest body. So the prefix was only ever an internal
   detail, and the alias is needed for **cached manifests**, not for client
   releases — a much shorter horizon.
2. **`/media/segment` and `/media/image` were not available.** `/media/[[...parts]]`
   was already the RSS enclosure route (`/media/<videoId>.m4a`). The layout used
   instead is three top-level prefixes: **`/stream`** (byte-range media, HLS
   manifests), **`/image`** (thumbnails, avatars, storyboards) and
   **`/enclosure`** (the RSS target, moved off `/media`). The enclosure move
   would normally need its old URL alive forever, since podcast clients store
   them; it was a clean rename only because there are no subscribers yet
   (owner's decision, 2026-07-30).

**What the split actually bought.** `app/invidious/[[...path]]/route.ts` went
**601 → 35 lines**; the logic lives in `server/media/upstream-proxy.ts` with the
mount prefix as a parameter, which is what lets one handler serve three prefixes.
The routes are now named for what they serve rather than for an upstream.

**Sequencing, and why stage 3 waits.** Recognisers (`hls-same-origin`,
`video-thumbnail-url`, `invidious-proxy`, `player-recovery`) accept *both*
prefixes, so stage 2 was deployable alone: manifests handed out before the deploy
still point at `/invidious` and keep working. Stage 3 removes the alias, and can
only run once nothing in flight references it — bounded by
`STREAMS_DETAIL_CACHE_TTL_MAX_SEC` (3 h) and googlevideo URL expiry on a similar
horizon. Removing it in the same deploy would have broken every already-open
player.

**Stage 3 checklist** (for whoever picks this up):
- Delete `app/invidious/[[...path]]/route.ts` and `LEGACY_PROXY_PREFIX` from
  `server/media/upstream-proxy.ts`.
- Drop the legacy arm from the four recognisers listed above.
- `audio-peak-limiter.test.ts` is currently the only test covering the legacy
  path (`/invidious/videoplayback` through `isSameOriginMediaSrc`) — retarget it.
- Rename `lib/invidious-proxy.ts`; it is now the m3u8/stream-proxy helper and no
  longer upstream-specific.

<details><summary>Original plan (kept; two of its premises were wrong)</summary>


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

</details>

---

## Suggested order

Phases 0, 1 and 2 are done. Remaining, in order:

1. ~~Phase 3.1 — `audioTrack` upstream.~~ **Done** — see Phase 3.1 above,
   including a correction to this item's line-count forecast.
2. ~~Phase 3.2 — the trending list serialiser.~~ **Done** — it turned out to be
   `liveNow` in the *extractor*, not `lengthSeconds` in the serialiser; see 3.2
   above. `UPSTREAM_CHECK_KNOWN_FAILING` is now empty.
3. ~~Phase 3.3 — shorts flag.~~ **Done** — see 3.3 above.
4. ~~Phase 3.4 — members-only flag.~~ **Done by deletion** — the gap was not
   real; see 3.4 above.
5. ~~Phase 3.5 — `publishedAt`.~~ **Done** — see 3.5 above.
6. **Phase 3.6** — channel `/videos` parse-error placeholders. A reliability bug
   upstream, so it needs a reproducing channel before anything else.
7. **Phase 3.7** — multi-shape pickers, plus the dead Piped branches still in
   `pickLiveFlagsFromUpstream`.
8. ~~Phase 0's last box~~ — **Done**; `proxy.types.ts` now tags provenance per
   field. See Phase 0 above.
9. **Phase 5** — stages 1-2 done (`/stream`, `/image`, `/enclosure`). **Stage 3,
   deleting the `/invidious` alias, is the remaining work** and only needs a
   deploy to have been live longer than the 3 h manifest cache. The TV/iOS
   concern in the original plan was unfounded — see Phase 5.
10. **Phase 4 PRs** — opportunistic throughout; each merged one shrinks the
    permanent rebase set. Now five patches deep (`audioTrack`, trending
    `liveNow`, `isShort` + the three pre-existing), so the rebase surface has
    grown — the `liveNow` and `isShort` ones are generic bug fixes and the best
    upstream candidates.

## Open items and honest gaps

**The canary is deliberately off (2026-07-30).** The `owntube-upstream-canary`
service is commented out in `/var/data/config/owntube/docker-compose.yml` and its
container removed, **at the owner's explicit request**. This is a decision, not an
oversight — **do not re-enable it without asking.**

Earlier the same day it was found commented out with a dead container and was
restored, on the assumption it had lapsed by accident; that assumption was wrong,
and the restore was reverted. If you find it off, that is the intended state.

What this costs, recorded plainly so the trade is visible rather than forgotten —
this plan elsewhere calls the canary the fork strategy's safety net, and that
reasoning has not changed, only the decision about whether to run it:

- **Provenance is no longer asserted continuously.** The July 23 incident — an
  image built from plain upstream `master`, silently dropping every local patch,
  captions broken for a week — is exactly what the `provenance` check caught in
  one assertion. `nedworks-rebuild.sh` still asserts it at *deploy* time, which
  covers the rebuild path but not drift afterwards.
- **`audioTrack` has no monitored guard.** Phase 3.1 deleted the URL-scraping
  fallback, so if the patch is lost or YouTube withdraws the field, multi-language
  videos degrade to unlabelled rows with nothing reporting it.
- The other checks (captions, byte ranges, extraction) go back to being noticed
  by accident, which is how all three of the original regressions were found.

None of this is an argument to override the decision. The mitigation, if wanted
later, is to run `pnpm check:upstream` by hand after each Invidious rebuild — it
still works and still exits non-zero on a new failure.

Worth keeping from the earlier analysis: a canary that can be switched off without
anything noticing is only half a guard. It has no external heartbeat — nothing
asserts *that it ran*, only what it found when it did. That gap is now moot while
it is off, but it is the first thing to fix if it is ever turned back on.

**The `/dvr` segment route is now verified end to end** (2026-07-30). A
post-live-DVR video was found by scanning 113 candidates across trending and five
live-flavoured searches: `IWqNAUTGK58` ("Just Chatting Stream!", 5258s,
`isPostLiveDvr: true`). Confirmed, both on `localhost:3000` and through the public
media origin:

- `/dash/<id>/manifest.mpd` → 200, 7 representations, every segment URL rewritten
  to a stable `/dvr/<id>/<rep>/<sq>` path, no `<BaseURL>`, and an explicit
  `initialization="/dvr/<id>/140/0"`.
- `/dvr/<id>/140/{0,1,5}` → 200 `audio/mp4`, `/dvr/<id>/133/3` → 200 `video/mp4`.
  Box order `ftyp moov emsg moof mdat` on **every** segment, which is the direct
  evidence for the self-initializing-segment claim: each segment carries its own
  `ftyp`+`moov`, so pointing `initialization` at segment 0 is sound.
- `/dvr/<id>/999/0` → 404 (`no-representation`), i.e. the not-in-manifest case is
  distinguished from a fetch failure as designed.
- Public origin: `Access-Control-Allow-Origin: *`, `Allow-Headers: Range`,
  `Expose-Headers: Content-Range…`, and a `Range: bytes=0-1023` request returns
  **206** with exactly 1024 bytes.

Not covered by the above: the po_token-expiry recovery path
(`invalidateDvrManifest` + retry) needs an actually-expired URL to exercise, so it
remains unexercised live.

**Nothing from the DVR work is outstanding any more — as of 2026-07-30 the whole
chain is verified.**

- **Post-live-DVR playback works on macOS *and* iOS** (user-confirmed against
  `IWqNAUTGK58`, `isPostLiveDvr: true` at the time). This was **the original goal
  of the DVR work** and had been unverified since it started, purely because no
  post-live-DVR video could be found — the previous attempt scanned 110
  candidates and the test video converted to VOD mid-session. Two sweeps on
  2026-07-30 turned up exactly **1 in 272 candidates**, which is the real
  difficulty here: the code was never the blocker, finding a subject was.
- **The Settings "Video source instances" health check works** (user-confirmed).
  The read-only display and health check were the last piece of Phase 1b(b).

Practical note for anyone re-testing this: budget for the *search*, not the test.
The scan that works is many upload-date-sorted searches for stream-flavoured
queries, then `isPostLiveDvr` on each result — trending is nearly useless for it.
And re-check the flag immediately before concluding anything, because a video that
converts to VOD mid-test silently turns the exercise into a VOD test.

**Also worth knowing:**
- **Each OwnTube service builds its own image**, despite sharing a build context:
  `owntube-owntube`, `owntube-owntube-cache-warmer`, `owntube-owntube-publisher`,
  `owntube-owntube-upstream-canary`. They do *not* share one image, so
  `docker compose build owntube` leaves the sidecars on stale code — they need
  `docker compose up -d --build <service>` each. Found on 2026-07-30 with the
  warmer and publisher still running a pre-change build after `owntube` had been
  redeployed.
- `docker-compose.yml` in `/var/data/config/owntube` and
  `/var/data/config/invidious` are **not** committed anywhere — the convention
  there is timestamped `.bak-*` files. The Invidious one now carries
  `SERVER_VERIFY_REQUESTS=true`; rollback is one commented line.
- The cache-warmer could never reach Invidious until this work (missing
  `caddy-media` network) — it had been silently "warming" only rows the main
  container had already cached. Fixed; worth remembering as the class of bug the
  canary exists to catch.


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
