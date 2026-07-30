# owntube-upstream: replacing Invidious with a service we own

Status: **not started — plan only.** Written 2026-07-30.

| stage | state | notes |
|---|---|---|
| detector — SABR early warning | **not started** | ~20 lines; do this first regardless |
| 0 — scaffold + differential harness | **not started** | everything else depends on it |
| 1 — `search`, `trending` | **not started** | thinnest endpoints |
| 2 — `resolveurl`, `playlists` | **not started** | |
| 3 — `channels` | **not started** | **the real test; kill criterion here** |
| 4 — `comments` | **not started** | |
| 5 — `videos` | **not started** | composes companion `/player` |
| 6 — cutover | **not started** | fork goes 8 patches → 0 |
| 7 — SABR connector | **spiked** — see `spikes/sabr-dash/` | conversion, seek and long videos all proven; no po_token needed |

This plan is a sibling of `INVIDIOUS-BOUNDARY-PLAN.md`, which shrank the boundary
from OwnTube's side. This one proposes removing the far side of it.

---

## Why

Two independent pressures, one answer.

**The fork burden.** Phases 3.1-3.3 added three patches to `nedworks/integration`
because upstream didn't emit data it had already parsed. The fork is now **8
patches**, each rebased forever, and the 2026-07-23 incident — an image built from
plain upstream, silently dropping every patch, captions broken for a week — came
from carrying patches without noticing.

**SABR.** Upstream is moving to SABR **client-side only** (iv-org/invidious#5814,
Shaka-based, and it explicitly removes the invidious-companion dependency). That
is a viable answer for Invidious, which *is* a web player. It is not obviously one
for OwnTube, which has an `expo-video` TV client.

Owning the extraction layer answers both.

## What we measured before writing this

Everything below was checked, not assumed.

| claim | evidence |
|---|---|
| youtubei.js covers Invidious' whole read surface | FreeTube's `helpers/api/local.js` — **2,270 lines**, 21.5k★, shipped daily as one of two interchangeable backends. Materialious has a second one. |
| Most of Invidious is not for us | 21,288 Crystal + 2,893 ECR. Web UI routes 3,940 + templates 2,893 + database/user 2,213 ≈ **40% unused**. The value is ~6,120 lines of parsers. |
| We depend on 8 endpoint families | `videos` 7 call sites, `channels` 7, `search` 4, `trending` 3, `resolveurl`, `playlists`, `comments`, `captions`. `/api/manifest/dash` already goes to the companion. |
| Server-side SABR is feasible | `googlevideo` exports **`SabrStream`** for headless use (separate from `SabrStreamingAdapter` for players), with a Node downloader example. yt-dlp has a mature Python implementation (#13515, 220 commits). |
| We do not need SABR yet | Sampled 30 live videos: **23/23 VOD carry byte-range `adaptiveFormats`**. The 7 without are all `liveNow: true`, which is normal. |
| Android TV does **not** force a server-side connector | Materialious ships SABR on Android TV via a **Capacitor WebView** (`LEANBACK_LAUNCHER` + `shaka-player` + `googlevideo/sabr-streaming-adapter`). The constraint is our choice of `expo-video`, not the platform. |

### Corrections to earlier reasoning in this thread

Recorded because they changed the plan:

- **"Android TV structurally can't do SABR"** — wrong. It's a framework consequence.
- **"You'd rediscover SABR's failure modes alone"** — wrong. `SabrStream` already
  handles reload (13 refs), retries (14), redirects/fallback (10), po_token (6),
  `SabrContextUpdate` (18), `nextRequestPolicy` (12), stalls/timeouts (27).
- **"SABR streams carry ads you must strip"** — overstated. yt-dlp's `test_ads.py`
  tests **cuepoints and an ad-*wait* policy**, i.e. `SabrContextUpdate` +
  `nextRequestPolicy` — machinery `SabrStream` implements generically. Media
  continuity is preserved.
- **"Build on kira"** — kira uses `SabrStreamingAdapter` (client/Shaka). A headless
  converter builds on `SabrStream`, its *sibling*. kira is a BotGuard reference.

## Licensing — why this can be MIT

| project | licence | use |
|---|---|---|
| `youtubei.js`, `googlevideo`, `bgutils-js` | **MIT** | **depend on** |
| `shaka-player` | Apache-2.0 | depend on (only if client-side) |
| `LuanRT/kira` | **MIT** | **copy from** |
| FreeTube, Invidious, invidious-companion, Materialious | AGPL-3.0 | **read, never copy** |
| OwnTube | MIT | unaffected |

Because every dependency is MIT, `owntube-upstream` can be MIT and live in this
monorepo, sharing `proxy.types.ts` directly. The AGPL projects stay on the far
side of an HTTP boundary. **Never lift AGPL parsing helpers into `apps/web`.**

## Architecture

`services/owntube-upstream` — Node + TypeScript, same pnpm workspace, same
`tsconfig`/`biome`/`vitest`, its own container.

Named for the role the codebase already uses **302 times** (`upstreamGetText`,
`UpstreamUnavailableError`, `upstream-health.ts`, `check-upstream.ts`).
`owntube-api` collides with the existing tRPC API; `owntube-companion` collides
with 103 uses meaning invidious-companion.

Three layers, built in order, each independently shippable:

1. **Metadata** — youtubei.js behind Invidious-compatible JSON
2. **Streams** — absorb what the companion does
3. **SABR** — only when the detector says so

**Emit Invidious-shaped JSON.** Cutover becomes one env var, `proxy.types.ts` and
the mappers stay untouched, and `check-upstream.ts` becomes the acceptance suite.
Rename `INVIDIOUS_BASE_URL` afterwards as a separate, riskless commit — the same
staging that worked for Phase 5's prefix change.

The companion stays as-is: AGPL, unmodified, doing po_token and streams.

## Stages

**Detector (do first, independent of everything).** ~20 lines in
`check-upstream.ts`: fraction of *non-live* videos lacking `init`/`index`.
Today 0/23. It is the countdown clock for stage 7 and currently does not exist.

**Stage 0 — scaffold + differential harness.** `/api/v1/stats` first, so the
provenance check works. Then a script calling **Invidious and the new service with
identical inputs, diffing the JSON field by field** over a fixed corpus. Build
this before any endpoint: every correct conclusion in the boundary work came from
diffing against a baseline, and every wrong one came from not having one. It also
enables shadow-running against live traffic at zero risk.

**Stage 1 — `search`, `trending`.** Thinnest. Read FreeTube's `local.js` for
continuation handling. Target ~0% divergence on consumed fields.

**Stage 2 — `resolveurl`, `playlists`.** `resolveurl` is `getLocalChannelId`.

**Stage 3 — `channels`.** Four tabs, continuations, and where two of our Crystal
patches live (`lockup`, `collab`).

> **Kill criterion.** If divergence will not drop below a few percent in one
> session, **stop**. Three sessions spent, Invidious still serves everything, and
> we know the trade isn't there. Also stop if youtubei.js needs patching — that is
> the fork burden returning in a different repo.

**Stage 4 — `comments`.** Continuation threading.

**Stage 5 — `videos`.** Metadata from youtubei.js + `adaptiveFormats` from the
companion's `/player`. Last: highest risk, best covered by existing tests.

**Stage 6 — cutover.** Dual-run, watch divergence, flip the env var, keep
Invidious warm for a week, then delete. Fork drops 8 patches → 0.

**Stage 7 — SABR connector.** Only when the detector moves. **A spike now exists:
`spikes/sabr-dash/`** — read its README before planning this.

What the spike settled:

- **Conversion works and is segmentation, not transcoding.** ~130 lines of
  ISO-BMFF box walking; no ffmpeg. Output cross-validated **byte-identical**
  against yt-dlp's independent Python implementation (init segments and media).
- **Non-uniform fragments are fine.** 29 distinct durations across 38 video
  fragments; `SegmentTimeline` covers it, verified segment-by-segment against
  each fragment's own `tfdt` — 0 mismatches, 213.00s exact.
- **Cost is not the problem at our scale.** ~1.4% of one core at realtime.
- **Resilience held**: 6/6 sequential, 4/4 concurrent, watchdog aborts cleanly.
- **It plays.** ffmpeg's DASH demuxer decodes the output: 5,326 video frames and
  9,177 audio frames with zero warnings, A/V agreeing within 0.02s, seeking to
  120s clean, and a real frame extracted at 150s.
- **Seeking works** with a patch to `googlevideo`
  (`spikes/sabr-dash/googlevideo-seek.patch`), which fixes three genuine upstream
  bugs: the requested start position is reset to 0 before any format is
  initialized; `bufferedRanges` advertises only the most recent delta instead of
  everything consumed; and millisecond ticks are labelled with the media
  timescale, understating every range by ~24x.
- **Long videos work, with no po_token.** Three stacked googlevideo/usage bugs
  made videos over ~25 minutes stall at ~60s in a way that looked exactly like an
  attestation demand; all three are fixed in the spike's patch and 25- and
  52-minute videos now pull complete (288/288 and 609/609 fragments). The
  critical design constraint that emerged: **the player response must come from a
  clean per-client innertube call** (a raw ANDROID_VR context borrowing only the
  visitorData) — fetching it through a shared youtubei.js WEB session gets the
  streaming session classified as suspect and cut off. See the spike README's
  "Long videos: SOLVED" section for the full diagnosis.

`SabrStream` cannot seek **as shipped**, and four attempts from outside the
library all failed. The fix had to be inside it, and is now in
`googlevideo-seek.patch` — small enough to offer upstream rather than carry.

Also settled by the spike, and easy to get wrong:
`stream.abort()` never `reader.cancel()`; resume must stay inside one session
(`sabr.media_serving_enforcement_id_error` otherwise); resume does not resend the
init segment; and format *preference* flags do not stop it handing back WebM.

Design note: DASH expects a quality ladder, SABR picks quality per session, so
advertise 2-3 Representations and start a session per rung. Read yt-dlp #13515
for the failure modes and Materialious' `onReloadPlayerResponse` (~25 lines) for
the reload handler.

## What we are deliberately not building

- **Client-side SABR.** Only needed if the TV app moves to a WebView.
- **A companion replacement.** It works; leave it behind HTTP.
- **Anything from `sabr-exoplayer`.** 1★ PoC, and it forces `expo-video` out for
  one client.

## Open questions

- **Does the TV app stay on `expo-video`?** If it ever became a WebView
  (Capacitor/Tauri — iOS is *already* Tauri), stage 7 disappears and all three
  clients converge on one player. That is a larger architectural win than SABR.
  Cheap test: load the OwnTube web player in a WebView on the real TV hardware and
  judge playback.
- **Is server-side SABR CPU-viable here?** The Invidious maintainer's main
  objection, and it is calibrated for public instances serving thousands. We serve
  one household. Measure CPU-seconds per minute of video before believing either
  of us.
- **The canary is off** (owner's request, 2026-07-30). It is this migration's only
  continuous safety net. Not a blocker for stages 0-2; revisit before stage 6.

## Honest risks

- **We would be alone in the server-side SABR approach.** Upstream chose
  client-side, so no shared maintenance and no upstream fixes when YouTube shifts.
  The Invidious maintainer's "may become a nightmare to maintain" is the single
  best counter-argument in this plan and should not be dismissed.
- **googlevideo has 3 test files; yt-dlp has ~13,000 lines of tests.** Implementing
  the protocol is not the same as field-hardening against a year of YouTube
  changes. Mitigated only by googlevideo being exercised via FreeTube, kira,
  Materialious and #5814.
- **Bus factor moves rather than disappearing** — from the Invidious team to
  LuanRT.
