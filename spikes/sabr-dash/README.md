# SABR → DASH spike

A throwaway proof that a headless server can pull YouTube's SABR protocol and
re-serve it as ordinary DASH. Not production code, not wired to OwnTube, not
built by CI. It exists to answer questions that were otherwise guesses in
`docs/OWNTUBE-UPSTREAM-PLAN.md` stage 7.

```bash
pnpm install
pnpm exec tsx main.ts dQw4w9WgXcQ        # pull + segment + write dash-out/manifest.mpd
pnpm exec tsx verify-timeline.ts         # check the manifest against the media
pnpm exec tsx resilience-test.ts         # repeat / concurrency / watchdog
pnpm exec tsx resume-test.ts             # snapshot + resume a session
pnpm exec tsx seek-test.ts               # seek attempt (does NOT work — see below)
pnpm exec tsx probe.ts                   # which Innertube clients expose SABR
```

Node 20 + pnpm 9. `pnpm install` pulls `googlevideo`, `youtubei.js`,
`bgutils-js`, `jsdom` — all MIT, so nothing here constrains OwnTube's licence.

## What it proves

**Conversion works, and it is segmentation rather than transcoding.** SABR
delivers `ftyp`+`moov` then repeating `moof`+`mdat`, which *is* DASH's
init-plus-media model. `segmenter.ts` is ~130 lines of box walking. No ffmpeg —
ffmpeg is not even installed on the host this ran on.

**Non-uniform fragments are a non-issue.** Video fragments are irregular (29
distinct durations across 38 fragments; audio has 2). `SegmentTimeline` handles
it, and `verify-timeline.ts` proves the manifest agrees with the media:

```
video: 38 segments checked, 0 mismatches | distinct durations=29 (NON-UNIFORM) | total=213.00s
audio: 22 segments checked, 0 mismatches | distinct durations=2  (NON-UNIFORM) | total=213.00s
TIMELINE EXACT: every segment start matches its media decode time
```

**Cross-validated against an independent implementation.** Against yt-dlp's SABR
branch (Python, PR #13515) on the same video and formats:

| | result |
|---|---|
| init segments (video 1229 B, audio 1019 B) | **byte-identical** |
| media bytes | **byte-identical** over the full extent yt-dlp downloaded |
| segment counts | **38 video / 22 audio** — matches its `frag 38/38`, `22/22` |

**Cost is low.** ~7 s wall for a 213 s video (~30× realtime). Earlier yt-dlp
measurement on the same host: 3.03 CPU-seconds for 213 s of video, ≈1.4% of one
core at realtime. The Invidious maintainer's "requires a beefier server" concern
is calibrated for public instances; at single-user scale it does not bite.

**Resilience held up.** 6/6 sequential pulls with no retry, 6/6 with retry (none
needed), 4/4 concurrent in 6.4 s at 239 MB RSS, and the watchdog aborts cleanly
on an impossible stall budget.

## Seeking — solved, via a two-line fix to googlevideo

`googlevideo-seek.patch` adds a `startAtMs` option to `SabrStream` and makes
seeking work headlessly:

```
baseline (no startAtMs)   -> first segment at   0.0s
startAtMs= 30000 ( 30s)   -> first segment at  24.6s  SEEK WORKS
startAtMs= 60000 ( 60s)   -> first segment at  55.4s  SEEK WORKS
startAtMs=120000 (120s)   -> first segment at 114.7s  SEEK WORKS
startAtMs=180000 (180s)   -> first segment at 178.9s  SEEK WORKS
```

Landing slightly *before* each target is correct — the server returns the segment
containing the seek point so a decoder can start from the preceding keyframe.

### The actual bug

```ts
abrState.playerTimeMs = this.mainFormat ? getTotalDownloadedDuration(this.mainFormat) : 0;
```

On the **first** iteration no format is initialized, so `mainFormat` is null and
the position is unconditionally reset to **0** — discarding both `startAtMs` and
a restored state's own position, before the request is even built. Changing the
fallback from `0` to the requested start position is the whole fix.

This is arguably an upstream bug in its own right: it is also why a restored
state only "worked" when its `initializedFormatsMap` happened to make
`mainFormat` non-null.

### The second half

A `playerTimeMs` on its own is *not* a seek instruction — the server serves from
the end of what the client claims to hold. So when `startAtMs` is set on a fresh
session, the patch also synthesises the buffered ranges that justify it:

```ts
formatId: { itag: f.itag, lastModified: f.lastModified, xtags: f.xtags }
```

That `formatId` matters. A `BufferedRange` without one is meaningless, and every
earlier attempt from *outside* the library omitted it — `SabrFormat` has no
`.formatId` property, it carries the FormatId fields inline.

### Why this could not be done from outside

`restoreState` only accepts state it produced itself, and the internal
`downloadedSegments` / `lastMediaHeaders` must agree with any buffered ranges you
assert. Four external attempts are preserved in `seek-test.ts` and
`seek2-test.ts` — including one using *real* indexed segment boundaries — and all
either started at 0 or stalled the server. Being inside the library is what makes
the state coherent.

### Upstreaming

The patch is small, additive and fixes a real bug. Worth offering to
`LuanRT/googlevideo` (MIT) rather than carrying: it is the difference between a
permanent fork and a merged feature. Note the working tree also carries a
`SABR_TRACE` debug log, stripped from this patch.

## Previously: what it did NOT prove — seeking

`SabrStream` cannot seek **as shipped**. Four attempts from outside the library,
all recorded in `seek-test.ts`, `seek2-test.ts` and `resume-test.ts`:

| attempt | result |
|---|---|
| `start({ state: { playerTimeMs } })` | ignored — starts at 0. `restoreState` rejects a partial state |
| snapshot a live session, resume it | works, but lands where the snapshot stopped (20.7 s), not the requested 120 s |
| clear `cachedBufferedRanges` + `downloadedSegments` | starts at 0 |
| synthesise a `cachedBufferedRanges` claiming 0→T buffered | server serves nothing; "Stream stalled 5 times, aborting" |

`grep -c seek` in `SabrStream.d.ts` returns **0**. `playerTimeMs` describes where
a session *is*, not where you want it to go.

Seek lives in the sibling export, `SabrStreamingAdapter` (`lastPlayerTimeSecs`,
driven by a 12-method `SabrPlayerAdapter` whose `getPlayerTime()` is the seek
mechanism). But its own doc says:

> Sets up request/response interceptors so we can send proper SABR requests
> (**UMP response parsing must be done in the player adapter**).

So the two exports trade off exactly the thing a converter needs:

| | UMP parsed for you | seek |
|---|---|---|
| `SabrStream` | yes | **no** |
| `SabrStreamingAdapter` | **no** | yes |

Neither gives headless + seek out of the box. That is the single most important
correction this spike produced.

## Other findings worth keeping

- **`stream.abort()`, never `reader.cancel()`.** Cancelling the reader leaves
  SabrStream writing into a closed controller, which it retries ten times per
  segment. A naive converter hits this immediately.
- **Resume must stay inside one session.** Pairing a captured state with a
  freshly created session fails with `sabr.media_serving_enforcement_id_error`.
  The player response, deciphered URL and state have to be cached together.
- **Resume does not resend the init segment** — the server assumes the client
  still has it. A parser waiting for `ftyp`/`moov` will hang forever.
- **Format preference flags are not enough.** `preferWebM: false` still returned
  `audio/webm; codecs="opus"` (EBML, not ISO-BMFF), which the segmenter cannot
  cut at all. Pass an explicit `audioFormat` selector.
- **Every client exposes SABR** — `probe.ts` shows WEB, ANDROID, IOS, TV, MWEB,
  WEB_EMBEDDED and TV_EMBEDDED all return `server_abr_streaming_url`. There is no
  "SABR video" to hunt for; SABR is available today alongside the byte-range
  formats, which YouTube simply has not withdrawn yet.
- **`getBasicInfo` works where a hand-rolled NavigationEndpoint call did not** —
  the latter silently returned no `server_abr_streaming_url`.
