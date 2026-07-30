# Resume prompt — OwnTube ↔ Invidious boundary work

Paste the block below into a fresh session. Everything it references is on disk or
in git, so it does not depend on any prior conversation.

---

Continue the OwnTube ↔ Invidious boundary work. Read `docs/INVIDIOUS-BOUNDARY-PLAN.md`
first — it has the full analysis, the phase-by-phase plan, a status table, and an
"Open items and honest gaps" section. Phases 0, 1, 2, **3.1 and 3.2** are shipped;
**start at Phase 3.3**.

## Phase 3.3 — the task

`short-video.ts` detects Shorts by looking for `#shorts` in the title. Find a
reliable upstream signal and delete the heuristic.

**Do not assume 3.2 unblocked this.** The original plan claimed Shorts detection
was collateral damage from trending dropping `lengthSeconds`. That was a
misdiagnosis — durations were never dropped (see 3.2 in the plan), so this needs
its own answer rather than a re-measurement of the same thing.

Worth knowing before you start: `videoRenderer` already encodes Shorts in the
thumbnail overlay — `thumbnailOverlayTimeStatusRenderer.text == "SHORTS"`, which
Invidious' extractor special-cases by approximating the length to 60s
(`extractors.cr`, the `length_seconds` branch). That is a signal being *read and
then thrown away*, which is the same shape as 3.1 and 3.2 and the most likely
place to start.

## What Phase 3.1 established that is worth reusing

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
  https://www.youtube.com/youtubei/v1/browse` with a WEB client context works
  from the owntube container; the companion only proxies `/youtubei/v1/player`.

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
  `pnpm check:upstream` in `apps/web`. It should report **6 PASS + 1 SKIP**
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
