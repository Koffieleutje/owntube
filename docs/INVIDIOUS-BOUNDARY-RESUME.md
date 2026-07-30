# Resume prompt — OwnTube ↔ Invidious boundary work

Paste the block below into a fresh session. Everything it references is on disk or
in git, so it does not depend on any prior conversation.

---

Continue the OwnTube ↔ Invidious boundary work. Read `docs/INVIDIOUS-BOUNDARY-PLAN.md`
first — it has the full analysis, the phase-by-phase plan, a status table, and an
"Open items and honest gaps" section. Phases 0, 1 and 2 are shipped; **start at
Phase 3.1**.

## Phase 3.1 — the task

Invidious already parses structured audio-track data and then drops it. Its own
DASH builder reads it at `src/invidious/routes/api/manifest.cr:71-74`:

    fmt["audioTrack"]["id"]              # language, e.g. "en-US.4"
    fmt["audioTrack"]["audioIsDefault"]  # is this the original audio
    fmt["audioTrack"]["displayName"]     # human label

…but `src/invidious/jsonify/api_v1/video_json.cr:79-150` serialises **zero**
audioTrack fields into `/api/v1/videos` → `adaptiveFormats`.

Because of that, OwnTube reverse-engineers it from googlevideo URL query strings:
`apps/web/src/lib/audio-track-label.ts` (~257 lines) parses `lang=`,
`xtags=acont%3Doriginal%3Alang%3Den-US` and `audioTrackId=.fr.4`, and
`apps/web/src/server/services/proxy/mappers/invidious.ts:133-185` tries seven
shapes before *guessing a track name from `qualityLabel`*. If YouTube changes
`xtags`, audio-track labelling breaks silently.

Do this:
1. Add the three `audioTrack` fields to `adaptiveFormats` in `video_json.cr` on
   the Invidious fork (~5 lines).
2. Rebuild and deploy Invidious **only** via
   `/var/data/config/invidious-build/nedworks-rebuild.sh` (see below).
3. Surface the fields in `proxy.types.ts` + `mappers/invidious.ts`.
4. Delete the URL-scraping path, keeping it as a fallback only if a real video
   still needs it — verify against a genuinely multi-language video before
   deleting anything.

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

- OwnTube source `/usr/local/src/owntube` (fork `mdbraber/owntube`, branch `main`,
  pushed through `6c2c9e3`). Deploy:
  `cd /var/data/config/owntube && docker compose build owntube && docker compose up -d owntube`
  (also `owntube-cache-warmer`, `owntube-publisher`, `owntube-upstream-canary` —
  same image).
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
- The canary runs hourly: `docker logs -f owntube-upstream-canary`. It should
  report **4 PASS + 1 KNOWN** (`listDuration`). If a new check goes red, that is
  a real regression — investigate before continuing.
- `docker-compose.yml` files under `/var/data/config/*` are **not** in git; the
  convention is timestamped `.bak-*` copies before editing.

## Still unverified — please pick these up when possible

- **iPad Safari on a post-live-DVR video** — the original goal of the DVR work,
  never confirmed. The test video converted to VOD and no replacement was found
  (110 candidates scanned). macOS Safari was confirmed working. Find a video with
  `isPostLiveDvr: true` via
  `docker exec owntube node -e "fetch('http://invidious:3000/api/v1/videos/<id>').then(r=>r.json()).then(j=>console.log(j.isPostLiveDvr))"`
  and always re-check the flag before concluding anything — these convert to VOD
  without warning.
- **The `/dvr` segment route end to end** — same blocker.
- **Settings → "Video source instances"** should now be read-only (no editable
  fields) with a working health check. Auth-gated, so it needs a signed-in eyeball.

## Ground rules

Don't take my earlier conclusions on trust — the plan documents its own
corrections, including one place where I overstated a performance win by an order
of magnitude and had to measure it properly. If something in the plan looks wrong,
say so.
