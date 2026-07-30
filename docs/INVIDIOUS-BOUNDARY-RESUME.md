# Resume prompt — OwnTube ↔ Invidious boundary work

Paste the block below into a fresh session. Everything it references is on disk or
in git, so it does not depend on any prior conversation.

---

Continue the OwnTube ↔ Invidious boundary work. Read `docs/INVIDIOUS-BOUNDARY-PLAN.md`
first — it has the full analysis, the phase-by-phase plan, a status table, and an
"Open items and honest gaps" section. Phases 0, 1, 2 and **3.1-3.3** are shipped;
**start at Phase 3.4**.

## Phase 3.4 — the task

Members-only / paid videos are currently guessed from the title
(`titleSuggestsMembersOnlyOrSubscriberOnly`, used in `mappers/invidious.ts` to
drop rows). Find the real upstream signal and stop pattern-matching titles — a
title heuristic both misses renamed videos and false-positives on any video whose
title merely mentions membership.

`isUpstreamMembersOrPaidOnly` in `server/services/proxy/normalize.ts` already
reads *something* from upstream; start by establishing what it actually receives
versus what YouTube sends, the same way 3.2 and 3.3 were established (below).

Then 3.5 `publishedAt` (four candidate fields plus `reconcilePublishedAtWithText`,
which lets a human string arbitrate a numeric timestamp), 3.6 channel
`/videos` parse-error placeholders, 3.7 the multi-shape pickers.

## What Phases 3.1-3.3 established that is worth reusing

- The upstream patch pattern: emit the field Invidious *already parses* for its
  own use, rebuild via `nedworks-rebuild.sh`, then delete OwnTube's guess. Phase
  3.1's Invidious commit is `94911a03`.
- **Add a canary check for anything whose fallback you delete.** Phase 3.1 added
  `audioTracks`; without it, losing the patch would be silent. (The canary is
  currently disabled by choice — see below — but the check still exists and
  `pnpm check:upstream` still runs it on demand.)
- **Expect the new data to expose bugs the old guesses were hiding.** Phase 3.1
  found two (audio rows keyed on the primary subtag merged `zh-Hans` with
  `zh-Hant`, making one dub unreachable in the picker; and upstream `displayName`
  appended unconditionally produced "Chinese (Chinese (Simplified))"). Feed real
  upstream values through the existing consumer *before* assuming the change is
  purely additive.
- **Do not trust this plan's line-count forecasts.** 3.1's was out by more than
  10x: predicted ~300 lines deleted, actual net −23 production lines, because
  most of the module was presentation rather than inference. The plan records the
  correction.
- **Re-measure the premise before fixing it, across more than one endpoint.**
  3.2's stated bug ("the trending list serialiser drops `lengthSeconds`") was
  wrong on both counts — durations were fine, and the real defect was `liveNow`
  in the extractor. One endpoint could not tell "serialiser broken" from "this
  feed is legitimately all livestreams". A permanently-red canary check made the
  wrong diagnosis look confirmed.
- **Fetch the raw InnerTube payload before changing a parser.** 3.2's fix hinged
  on the live marker having moved from `videoRenderer.badges` to
  `thumbnailOverlays[].thumbnailOverlayTimeStatusRenderer.style`. Guessing field
  names here compiles and silently does nothing. `POST
  https://www.youtube.com/youtubei/v1/browse` (or `/search`) with a WEB client
  context works from the owntube container; the companion only proxies
  `/youtubei/v1/player`.
- **The recurring pattern is "upstream parses it, then throws it away."** All
  three phases were that. Grep the extractors for what a parser *reads* and does
  not put on the struct — 3.3's fix was three parsers hardcoding
  `badges: VideoBadges::None` right after proving the item was a Short, one of
  them with a TODO asking for exactly the fix.
- **Ask whether the old signal could ever have worked.** For 3.3 the answer was
  no, and that is the argument for the field: duration is *fabricated* for Shorts
  (all 48 items on a shorts tab report exactly 60s) and the `#shorts` tag is SEO
  (4 of 20 search results carried it while running 8-27 minutes). A heuristic
  that cannot work is worth more urgency than one that is merely ugly.
- **Keep the fallback when cached payloads can predate the field.** 3.1 deleted
  its fallback; 3.3 kept the length/title rules for exactly that reason. Decide
  per field, and say which in the commit.
- **Formatting Crystal in this sandbox:** container writes to bind mounts are
  denied, so `crystal tool format <file>` silently no-ops while `--check` still
  reports a diff. Pipe instead:
  `docker run --rm -i crystallang/crystal:1.14.0-alpine crystal tool format - < file`.
  Also note the formatter aligns consecutive `key: value` pairs in a hash
  literal, so a comment inserted *inside* one breaks the alignment group — put
  explanatory comments above the constructor call.

## Non-negotiables (learned the hard way this session)

**Never build Invidious by hand.** One tree, one branch:
`/var/data/config/invidious-build`, branch `nedworks/integration` = upstream + our
patches, kept in step by rebase. Always use `./nedworks-rebuild.sh` — it refuses a
dirty tree, aborts if the patch count drops, and asserts `/api/v1/stats` reports
`branch: nedworks/integration` after deploy. Building from
`/usr/local/src/invidious-build` (plain upstream) once silently dropped every
local patch and captions stayed broken for a week.

**Verification gates, every time.** Establish baselines *first*, then diff:
- `cd apps/web && ./node_modules/.bin/tsc --noEmit | sort > /tmp/tsc-baseline.txt`
  — expect **8 pre-existing errors** (missing local packages: `cacache`,
  `undici`, `@base-ui/react/drawer`, `@owntube/brand-icon`). Diff against this,
  never read the raw count.
- `./node_modules/.bin/vitest run` — expect **463 passing**; 3 test *files* fail
  to collect on those same missing packages.
- biome: capture the file list before your change and `comm -13` against it;
  the repo has ~33 pre-existing findings.
- Then build + deploy + smoke test.

**Editing method.** Removing whole named functions with brace matching and letting
tsc enumerate the fallout is safe — it fails loudly. Regex over *signatures* fails
silently into code that still parses; it cost two abandoned attempts this session.
Signature changes = whole-line deletions or hand edits, tsc after each file.

**Commit in reviewable units.** A 39-file blob was unreviewable and unrecoverable
when one step went wrong. Split by concern; each commit independently green.

## Environment

- OwnTube source `/usr/local/src/owntube` (fork `mdbraber/owntube`, branch `main`).
  **`71fa2f4`..`efa69da` are committed but NOT pushed.** Deploy:
  `cd /var/data/config/owntube && docker compose build owntube && docker compose up -d owntube`
  — but the sidecars (`owntube-cache-warmer`, `owntube-publisher`,
  `owntube-upstream-canary`) each build their **own** image, so that command
  leaves them on stale code. Use `docker compose up -d --build <service>` for
  each. The warmer on old code means old-shaped rows in the shared cache.
- Invidious fork `/var/data/config/invidious-build` @ `nedworks/integration`,
  running image reports `branch: nedworks/integration`.
- Companion image `nedworks/invidious-companion:2026.07.29-dvrfix-captionfix`.
  **Preserve its captionfix and DVR fixes** — they are not upstream.
  `SERVER_VERIFY_REQUESTS=true` is on, so any new companion route OwnTube calls
  must be signed with `withCompanionCheck()` from
  `apps/web/src/server/services/companion.ts` (`/videoplayback` is exempt).
- Internal companion address: `INVIDIOUS_COMPANION_INTERNAL_URL`
  (`http://invidious-companion:8282`). Use it for server-side fetches; only use
  the public base for URLs the browser must reach.
- **The canary is deliberately disabled** (2026-07-30, owner's request):
  commented out of compose, container removed. **Do not re-enable it without
  asking** — it was restored once that day on the assumption it had lapsed by
  accident, and that was wrong. Run it by hand instead when you need it:
  `docker exec owntube node_modules/.bin/tsx /path/to/check-upstream.ts`, or
  `pnpm check:upstream` in `apps/web`. It should report **7 PASS + 1 SKIP**
  (`listDuration` skips when every sampled trending item is live) and **no KNOWN
  failures** — `UPSTREAM_CHECK_KNOWN_FAILING` is empty since 3.2. Worth running
  after any Invidious rebuild, since nothing is watching provenance continuously
  any more.
- `docker-compose.yml` files under `/var/data/config/*` are **not** in git; the
  convention is timestamped `.bak-*` copies before editing.

## Previously unverified — all now closed (2026-07-30)

Nothing from the DVR work is outstanding. Don't re-open these:

- **Post-live-DVR playback works on macOS and iOS** — the original goal, confirmed
  against `IWqNAUTGK58`. The `/dvr` segment route is verified end to end too (real
  fMP4, 206 on Range, CORS, public origin).
- **Settings → "Video source instances"** — read-only display and health check
  both confirmed working.

If you ever need to re-test DVR: the hard part is finding a subject, not the test.
Two sweeps on 2026-07-30 found **1 post-live-DVR video in 272 candidates**. What
works is many upload-date-sorted searches for stream-flavoured queries, then
`isPostLiveDvr` on each hit; trending is nearly useless. Re-check the flag right
before concluding — these convert to VOD without warning, which silently turns a
DVR test into a VOD test:
`docker exec owntube node -e "fetch('http://invidious:3000/api/v1/videos/<id>').then(r=>r.json()).then(j=>console.log(j.isPostLiveDvr))"`

## Ground rules

Don't take my earlier conclusions on trust — the plan documents its own
corrections, including one place where I overstated a performance win by an order
of magnitude and had to measure it properly. If something in the plan looks wrong,
say so.
