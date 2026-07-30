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
pnpm exec tsx seek-fork-test.ts          # seek, needs googlevideo-seek.patch applied
pnpm exec tsx seek-test.ts               # earlier failed attempts, kept as evidence
pnpm exec tsx probe.ts                   # which Innertube clients expose SABR
```

Node 20 + pnpm 9. `pnpm install` pulls `googlevideo`, `youtubei.js`,
`bgutils-js`, `jsdom` — all MIT, so nothing here constrains OwnTube's licence.

## Demo server

`server.ts` plays real videos in a browser over SABR→DASH, with captions and
multi-track audio.

```bash
CAPTIONS_PROXY=https://owntube-media.home.nedworks.org pnpm exec tsx server.ts
# then open http://localhost:8899/watch/dQw4w9WgXcQ
```

| route | |
|---|---|
| `/watch/:id[?audio=en,fr]` | dash.js player page with caption `<track>`s |
| `/v/:id/manifest.mpd` | generated manifest (one AdaptationSet per track) |
| `/v/:id/:track/{init.mp4,seg-N.m4s}` | segments |
| `/v/:id/captions/:lang.vtt` | WebVTT |

Verified end to end on `dQw4w9WgXcQ` (213s): manifest built in ~10s (38 video + 22 audio
segments), **ffmpeg decodes the served HTTP manifest to 5,326 frames / 213.04s
with zero warnings**, and captions return real VTT (en 4,263 B, de-DE 3,781 B).

On first request a video is pulled and cut to disk, then served statically —
trading a warm-up delay for free seeking.

### Captions need the companion

Google IP-blocks the `timedtext` `base_url`: HTTP **200 with zero bytes** and
`content-type: text/html`, regardless of `fmt` (vtt/srv3/json3), with or without
a po_token, on every client. `getTranscript()` fails too. So `CAPTIONS_PROXY`
delegates to OwnTube's existing `/captions` route, which works because it goes
through invidious-companion.

**Captions are therefore a reason the companion cannot simply be dropped.**

### Known limitation: long videos stall part-way

**Correction.** An earlier version of this file blamed container/format selection
(“mp4 fails, webm works”). That was wrong, and the mistake is worth recording:
every one of those comparisons aborted the read after 200–400 KB, so they only
ever exercised the first few seconds. Re-probing each itag individually shows
**all six 360p/240p formats work** — mp4/avc1, mp4/av01 and webm/vp9 alike.

The real fault is duration. On `0e3GPea1Tyg` (**1541s**, not the 213s of the
other demo video) the stream advances `0 → 19.5s → 36.5s → 57.2s` and then the
server returns empty responses forever:

```
[DEBUG] Received SABR context update (type: 5, sendByDefault: true)
[DEBUG] Respecting server backoff policy: waiting 4000ms before request
[DEBUG] Starting new segment fetch at playback position: 57187ms
[WARN]  Segment fetch attempt 1/3 failed - No media parts or protocol updates received
```

Established about it:

- **Not our fork.** Stock `googlevideo@4.1.1` fails identically at the same point.
- **Not a missing po_token.** One is attached, bound either way — though see the
  root cause below: the server *escalates* the attestation requirement mid-stream,
  and re-minting on that signal does not clear it.
- **Not the client.** WEB / ANDROID / IOS / TV / ANDROID_VR all stall the same.
- **Not fixed by restarting.** Reopening a session at the stall point (using the
  seek patch) yields exactly one more segment, then stalls again — 13 passes,
  still 57s.
- **Not fixed by honouring the backoff harder.** Re-reading
  `nextRequestPolicy.backoffTimeMs` on every retry, the way yt-dlp's
  `_check_vod_ad_wait` does, changes nothing; the server sends no new policy at
  the stall.
- **yt-dlp downloads the same video completely** (75 MB), so it is solvable.

### Root cause

googlevideo drops unknown UMP parts silently — the dispatcher is
`if (handler) handler(part)` with no `else` — so the interesting half of the
server's answer was invisible. Logging every part received makes the stall
response identical on every retry:

```
STALL DIAGNOSTIC: protectionStatus=2 parts=[47,58,52,53,35]
```

Decoded against yt-dlp's `UMPPartId`:

| id | part | googlevideo |
|---|---|---|
| 47 | `PLAYBACK_START_POLICY` | **ignored** |
| **58** | **`STREAM_PROTECTION_STATUS`** | handled → **status 2** |
| 52 | `REQUEST_IDENTIFIER` | **ignored** |
| 53 | `REQUEST_CANCELLATION_POLICY` | **ignored** |
| 35 | `NEXT_REQUEST_POLICY` | handled |

No media, no cuepoint, no `SABR_SEEK`, no redirect. **The server escalates
attestation mid-stream**: a session that has been served happily for 57s is told
its protection status is now 2, and `SabrStream` treats that as fatal
(`status >= 2` with no media part → throw).

What does **not** clear it: re-minting a fresh po_token on the escalation signal
(tried, forced past the cache, both bindings), and no client avoids it — WEB,
ANDROID, IOS, TV and ANDROID_VR all stop at the same 57s.

The remaining asymmetry with yt-dlp is that **it handles 13 UMP parts googlevideo
ignores**, three of which are in the very response that stalls us
(`PLAYBACK_START_POLICY`, `REQUEST_IDENTIFIER`, `REQUEST_CANCELLATION_POLICY`):

```
ALLOWED_CACHED_FORMATS  CUEPOINT_LIST  LIVE_METADATA  PAUSE_BW_SAMPLING_HINT
PLAYBACK_START_POLICY   PREWARM_CONNECTION  REQUEST_CANCELLATION_POLICY
REQUEST_IDENTIFIER      REQUEST_PIPELINING  SABR_SEEK  SELECTABLE_FORMATS
SNACKBAR_MESSAGE        START_BW_SAMPLING_HINT
```

A client that never acknowledges request identity or cancellation state
plausibly reads as unattested once the server decides to escalate. That is a
hypothesis, not a demonstrated cause — but it is the only structural difference
left between us and an implementation that succeeds on this exact video.

### Next step

Implement handlers for those parts and echo their state back in the following
request, mirroring yt-dlp's processor. That is a targeted change to one known
file rather than more black-box probing.

So the converter is proven on short VOD and **not yet usable for long videos**.
That is the blocker to close before wiring it into anything — almost every real
video is longer than 57s.

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

## Playback — verified with a real DASH client

The output is not merely well-formed; ffmpeg's DASH demuxer consumes it and
decodes every frame.

```
$ ffprobe manifest.mpd
format_name=dash   duration=213.000000   nb_streams=2
  h264  640x360  25/1
  aac   44100Hz  2ch

$ ffmpeg -i manifest.mpd -f null -
frame= 5326 ... time=00:03:33.04     # zero warnings at -v warning
```

| check | result |
|---|---|
| full decode | **5,326 video frames, 0 warnings**, 213.04s |
| audio decode | **9,177 AAC frames** = 213.06s — A/V agree within 0.02s |
| seek to 120s, decode 5s | clean, no warnings — exercises the non-uniform `SegmentTimeline` |
| extract a frame at 150s | a real 203 KB PNG of actual video content |

Caveat worth stating: ffmpeg's DASH demuxer is *a* DASH client, not *the* one you
ship to. dash.js, Shaka and ExoPlayer each have their own strictness, so this
does not guarantee browser or TV playback. But it is an independent
implementation reading the manifest, fetching init + segments, and decoding —
which is a far stronger claim than the structural validation that preceded it.

Reproduce with `apt-get install ffmpeg`, then run ffprobe/ffmpeg **from inside**
`dash-out/` — relative segment URLs resolve against the working directory.

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

## po_token is not required (here, today)

`potoken-test.ts` runs SABR with and without BotGuard attestation:

```
WEB           no po_token: WORKS  2 segments, init=true
ANDROID       no po_token: WORKS  2 segments, init=true
IOS           no po_token: WORKS  2 segments, init=true
TV            no po_token: WORKS  2 segments, init=true
MWEB          no po_token: WORKS  2 segments, init=true
WEB_EMBEDDED  no po_token: WORKS  2 segments, init=true
WEB         WITH po_token: WORKS  2 segments, init=true
```

Three caveats, all of which matter more than the result:

- **This is one IP.** po_token enforcement tracks IP reputation, and datacenter
  ranges are treated far more harshly than a home connection. "Not needed here"
  is not "not needed anywhere".
- **It can change without notice.** YouTube tightens this periodically; yt-dlp's
  SABR branch still documents a PO Token as required for `web`.
- **Only short unauthenticated VOD pulls were tested** (2 segments). Longer
  sessions may trip `streamProtectionStatus`, which `SabrStream` tracks and this
  test did not inspect.

So: do not build po_token in as mandatory, but keep the ability to mint one and
attach it lazily when the server objects. `SabrStream.setPoToken()` exists for
exactly that, and attestation is cheap anyway — **263ms**, then cacheable.

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
